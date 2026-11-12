/**
 * Sequential driver over the durable stages (scripts and tests). The hosted
 * server drives the same stages through the worker instead.
 */
import type { Db } from "../db";
import { appendEvent } from "../db";
import type { Scenario } from "../faults";
import { getMandate } from "../mandate";
import { usd } from "../money";
import type { FlowDeps } from "../payments/flow";
import { createPact, getPact } from "./machine";
import { advance, say, type Agents, type StageDeps } from "./stages";
import type { JobSpec, PactRow } from "./types";

export type { Agents } from "./stages";

export interface RunDeps {
  flow: FlowDeps;
  agents: Agents;
  /** Poll interval for pending captures/payouts (ms). Tests set it small. */
  pollMs?: number;
  maxPolls?: number;
}

export interface RunArgs {
  mandateId: string;
  job: JobSpec;
  scenario: Scenario;
  /** Reuse a pact already created by preparePact (so callers can return its id before the run starts). */
  pactId?: string;
}

/** Create the demo pact row and the opening events synchronously; the run itself happens in runPact / the worker. */
export function preparePact(db: Db, args: { mandateId: string; job: JobSpec; scenario: Scenario; buyerId?: string; sellerId?: string }): PactRow {
  const pact = createPact(db, args.mandateId, args.job);
  db.run("UPDATE pacts SET kind = 'demo', scenario = ?, buyer_id = ?, seller_id = ? WHERE id = ?", [args.scenario, args.buyerId ?? null, args.sellerId ?? null, pact.id]);
  appendEvent(db, pact.id, "run.started", { scenario: args.scenario, jobId: args.job.id, itemCount: args.job.skus.length, maxUnitPriceCents: args.job.maxUnitPriceCents });
  say(db, pact.id, "buyer", `Posting job "${args.job.title}": ${args.job.skus.length} items, max ${usd(args.job.maxUnitPriceCents)} each. Payment is per accepted item after verification.`);
  return getPact(db, pact.id)!;
}

export async function runPact(deps: RunDeps, args: RunArgs): Promise<PactRow> {
  const db = deps.flow.db;
  const mandate = getMandate(db, args.mandateId);
  if (!mandate) throw new Error("mandate not found");
  const pact = args.pactId ? getPact(db, args.pactId) : preparePact(db, { mandateId: mandate.id, job: args.job, scenario: args.scenario });
  if (!pact) throw new Error("pact not found");
  const stage: StageDeps = { flow: deps.flow, agentsFor: () => deps.agents, pollMs: deps.pollMs ?? 3000 };
  let polls = 0;
  for (;;) {
    const next = await advance(stage, pact.id);
    if ("done" in next || "wait" in next) break;
    if (next.again > 0) {
      if (++polls > (deps.maxPolls ?? 20)) break;
      await Bun.sleep(next.again);
    }
  }
  return getPact(db, pact.id)!;
}
