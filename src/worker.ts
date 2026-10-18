/**
 * Single in-process worker over the durable `tasks` table.
 *  - kinds: advance (pact), quote_job (job), sweep (checkout deadlines)
 *  - one row per (subject, kind) in flight; re-enqueue reuses the row
 *  - per-pact lock shared with the approve route and the webhook receiver
 *  - startup recovery re-queues running rows and any in-flight pact without a task
 */
import { appendEvent, now, type Db } from "./db";
import { expireCheckouts } from "./payments/checkout";
import { advance, TERMINAL, type StageDeps } from "./pact/stages";
import type { PactRow } from "./pact/types";

export type TaskKind = "advance" | "quote_job" | "sweep";

export interface TaskRow {
  id: number;
  subject_id: string;
  kind: TaskKind;
  status: "queued" | "running" | "done" | "failed";
  run_after: string;
  attempts: number;
  last_error: string | null;
}

const MAX_ATTEMPTS = 5;

export function enqueue(db: Db, subjectId: string, kind: TaskKind, delayMs = 0): TaskRow {
  const runAfter = new Date(Date.now() + delayMs).toISOString();
  const tx = db.transaction(() => {
    const existing = db
      .query<TaskRow, [string, string]>("SELECT * FROM tasks WHERE subject_id = ? AND kind = ? AND status IN ('queued', 'running')")
      .get(subjectId, kind);
    if (existing) {
      if (existing.status === "queued" && existing.run_after > runAfter) db.run("UPDATE tasks SET run_after = ?, updated_at = ? WHERE id = ?", [runAfter, now(), existing.id]);
      return db.query<TaskRow, [number]>("SELECT * FROM tasks WHERE id = ?").get(existing.id)!;
    }
    db.run("INSERT INTO tasks (subject_id, kind, status, run_after, attempts, created_at, updated_at) VALUES (?, ?, 'queued', ?, 0, ?, ?)", [subjectId, kind, runAfter, now(), now()]);
    return db.query<TaskRow, []>("SELECT * FROM tasks WHERE id = last_insert_rowid()").get()!;
  });
  return tx();
}

export function listTasks(db: Db, subjectId: string): TaskRow[] {
  return db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE subject_id = ? ORDER BY id").all(subjectId);
}

// ---------- per-pact lock ----------
const locks = new Map<string, Promise<unknown>>();
/** Serialize all actions on one pact (worker stage, approve route, webhook). */
export async function withPactLock<T>(pactId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(pactId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(pactId, run.catch(() => undefined));
  try {
    return await run;
  } finally {
    if (locks.get(pactId) === run.catch(() => undefined)) locks.delete(pactId);
  }
}

export interface WorkerDeps extends StageDeps {
  /** Produce quotes for an open job (market). */
  quoteJob?: (jobId: string) => Promise<void>;
  /** Called after a pact reaches a terminal status (e.g. to reopen its job). */
  onTerminal?: (pact: PactRow) => void;
  sweepMs?: number;
}

export class Worker {
  private running = false;
  private loop: Promise<void> | null = null;
  constructor(
    private db: Db,
    private deps: WorkerDeps,
  ) {}

  /** Re-queue anything that was mid-flight when the process died, then make sure every live pact has a task. */
  recover(): { requeued: number; pacts: string[] } {
    const db = this.db;
    const requeued = db.run("UPDATE tasks SET status = 'queued', updated_at = ? WHERE status = 'running'", [now()]).changes;
    const live = db
      .query<{ id: string; status: string; kind: string; order_id: string | null }, []>(
        `SELECT id, status, kind, order_id FROM pacts WHERE status NOT IN (${TERMINAL.map((s) => `'${s}'`).join(",")}) AND NOT (status = 'SETTLED' AND settlement_kind = 'void')`,
      )
      .all();
    const pacts: string[] = [];
    for (const p of live) {
      const waitingOnBuyer = p.kind === "market" && ["DRAFT", "OFFERED", "AGREED"].includes(p.status);
      if (waitingOnBuyer) continue;
      enqueue(db, p.id, "advance");
      pacts.push(p.id);
    }
    enqueue(db, "*", "sweep");
    return { requeued, pacts };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let did = false;
        try {
          did = await this.tick();
        } catch (e) {
          console.error("worker tick failed", e);
        }
        if (!did) await Bun.sleep(400);
      }
    })();
  }

  async stop() {
    this.running = false;
    await this.loop;
  }

  /** Claim and run one due task. Returns false when nothing was due. */
  async tick(): Promise<boolean> {
    const db = this.db;
    const claim = db.transaction(() => {
      const t = db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE status = 'queued' AND run_after <= ? ORDER BY run_after, id LIMIT 1").get(now());
      if (!t) return null;
      db.run("UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", [now(), t.id]);
      return { ...t, attempts: t.attempts + 1 };
    });
    const task = claim();
    if (!task) return false;
    try {
      const delay = await this.run(task);
      if (delay === null) db.run("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?", [now(), task.id]);
      else db.run("UPDATE tasks SET status = 'queued', run_after = ?, attempts = 0, updated_at = ? WHERE id = ?", [new Date(Date.now() + delay).toISOString(), now(), task.id]);
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500);
      if (task.attempts >= MAX_ATTEMPTS) {
        db.run("UPDATE tasks SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [msg, now(), task.id]);
        if (task.kind === "advance") {
          appendEvent(db, task.subject_id, "run.error", { message: msg, attempts: task.attempts });
          appendEvent(db, task.subject_id, "run.finished", { status: "error" });
        }
      } else {
        const backoff = Math.min(60_000, 1000 * 2 ** task.attempts);
        db.run("UPDATE tasks SET status = 'queued', run_after = ?, last_error = ?, updated_at = ? WHERE id = ?", [new Date(Date.now() + backoff).toISOString(), msg, now(), task.id]);
        if (task.kind === "advance") appendEvent(db, task.subject_id, "run.retry", { message: msg, attempt: task.attempts, inMs: backoff });
      }
    }
    return true;
  }

  /** Returns the delay (ms) before the task should run again, or null when it is finished. */
  private async run(task: TaskRow): Promise<number | null> {
    switch (task.kind) {
      case "advance":
        return withPactLock(task.subject_id, async () => {
          const next = await advance(this.deps, task.subject_id);
          if ("again" in next) return next.again;
          if ("done" in next) {
            const p = this.db.query<PactRow, [string]>("SELECT * FROM pacts WHERE id = ?").get(task.subject_id);
            if (p) this.deps.onTerminal?.(p);
          }
          return null;
        });
      case "quote_job":
        await this.deps.quoteJob?.(task.subject_id);
        return null;
      case "sweep": {
        const expired = await expireCheckouts(this.deps.flow);
        for (const id of expired) {
          const p = this.db.query<PactRow, [string]>("SELECT * FROM pacts WHERE id = ?").get(id);
          if (p) this.deps.onTerminal?.(p);
        }
        return this.deps.sweepMs ?? 60_000;
      }
    }
  }
}
