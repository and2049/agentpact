/**
 * AgentPact thin client. Hash-routed vanilla JS over the JSON API; every view is
 * a function of API data so the later redesign only replaces this file.
 *   #/            job board        #/post          post a job
 *   #/jobs/:id    job + quotes     #/pacts/:id     pact (transcript, ledger, PayPal approval)
 *   #/agents      agents           #/agents/new    register an agent
 *   #/demo        scenario runs    #/me            account
 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $("#view");
  const cents = (c) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
  const api = async (path, opts = {}) => {
    const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, body: j });
    return j;
  };
  const tone = (s) => (["PAID_OUT", "SETTLED", "OPEN"].includes(s) ? "ok" : ["REJECTED", "HOLD_FAILED", "SETTLEMENT_FAILED", "CHECKOUT_EXPIRED", "error"].includes(s) ? "bad" : s === "AGREED" ? "warn" : "run");
  const pill = (s) => `<span class="pill" data-tone="${tone(s)}">${esc(s)}</span>`;
  const notice = (text, kind = "bad") => `<p class="notice ${kind}">${esc(text)}</p>`;

  let me = null; // current user or null
  let config = { devLogin: false, clientId: "", templates: [] };
  let teardown = null; // view cleanup (SSE, grid)

  // ---------- auth strip ----------
  async function loadMe() {
    me = await fetch("/me").then((r) => (r.ok ? r.json() : { user: null })).then((j) => j.user);
    const el = $("#auth");
    if (me) el.innerHTML = `<span class="muted">${esc(me.name)}</span> <button class="link" id="logout">Log out</button>`;
    else el.innerHTML = `<a class="btn small" href="/auth/paypal/start">Log in with PayPal</a>${config.devLogin ? ` <button class="link" id="devlogin">Dev login</button>` : ""}`;
    $("#logout")?.addEventListener("click", async () => {
      await api("/logout", { method: "POST" });
      await loadMe();
      route();
    });
    $("#devlogin")?.addEventListener("click", async () => {
      const who = prompt("Dev login as: buyer or seller?", "buyer");
      if (!who) return;
      const passcode = prompt("Dev passcode");
      if (!passcode) return;
      try {
        await api("/auth/dev", { method: "POST", body: { who, passcode } });
        await loadMe();
        route();
      } catch (e) {
        alert(e.message);
      }
    });
  }

  // ---------- views ----------
  async function board() {
    const jobs = await api("/api/jobs?status=open");
    view.innerHTML = `
      <section class="panel">
        <div class="row between"><h2>Open jobs <span class="muted">${jobs.length}</span></h2><a class="btn" href="#/post">Post a job</a></div>
        ${jobs.length ? "" : `<p class="muted">No open jobs. Post one, or watch the <a href="#/demo">demo</a>.</p>`}
        <div class="cards">${jobs.map((j) => `
          <a class="card" href="#/jobs/${j.id}">
            <div class="row between"><b>${esc(j.title)}</b>${pill(j.status)}</div>
            <p class="muted clamp">${esc(j.brief)}</p>
            <div class="meta"><span>${j.item_count} items</span><span>max ${cents(j.max_unit_price_cents)}/item</span><span>${j.quote_count} quote${j.quote_count === 1 ? "" : "s"}</span><span>${esc(j.buyer_name)}</span><span>${when(j.created_at)}</span></div>
          </a>`).join("")}</div>
      </section>`;
  }

  function postJob() {
    if (!me) return needLogin("post a job");
    const t = config.templates[0] || { id: "product_descriptions", name: "Product descriptions", rubric: { minWords: 30, maxWords: 90 } };
    const sample = [
      { sku: "TRK-001", facts: { name: "Ridgeline Trekking Pole", material: "carbon fiber", weight_g: 210, color: "slate" } },
      { sku: "TRK-002", facts: { name: "Summit 40 Backpack", material: "ripstop nylon", capacity_l: 40, color: "forest green" } },
      { sku: "TRK-003", facts: { name: "Ember Camp Stove", material: "titanium", weight_g: 85, fuel: "isobutane" } },
    ];
    view.innerHTML = `
      <section class="panel narrow">
        <h2>Post a job</h2>
        <form id="f" class="form">
          <label>Template <select name="template"><option value="${esc(t.id)}">${esc(t.name)}</option></select></label>
          <label>Title <input name="title" required minlength="3" maxlength="120" value="Product descriptions for 3 outdoor-gear SKUs"></label>
          <label>Brief <textarea name="brief" required minlength="10" rows="3">Write one product description per SKU for an online outdoor-gear store. Each description must mention every supplied fact exactly as given. Do not invent specifications or claims. Friendly, concrete tone.</textarea></label>
          <label>Items (JSON, 1–20, each <code>{"sku","facts"}</code>) <textarea name="items" rows="8" class="mono">${esc(JSON.stringify(sample, null, 2))}</textarea></label>
          <div class="row">
            <label>Max price per item (¢) <input name="max" type="number" min="1" max="100000" value="120"></label>
            <label>Min words <input name="minWords" type="number" min="5" value="${t.rubric.minWords}"></label>
            <label>Max words <input name="maxWords" type="number" min="5" value="${t.rubric.maxWords}"></label>
          </div>
          <p class="muted">Eligible seller agents quote automatically. You pick one, approve a PayPal authorization for items × price, and pay only for items the verifier accepts.</p>
          <div id="err"></div>
          <button class="btn" type="submit">Post job</button>
        </form>
      </section>`;
    $("#f").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      let items;
      try {
        items = JSON.parse(f.get("items"));
      } catch {
        return ($("#err").innerHTML = notice("Items must be valid JSON."));
      }
      try {
        const j = await api("/api/jobs", { method: "POST", body: { template: f.get("template"), title: f.get("title"), brief: f.get("brief"), items, maxUnitPriceCents: Number(f.get("max")), minWords: Number(f.get("minWords")), maxWords: Number(f.get("maxWords")) } });
        location.hash = `#/jobs/${j.id}`;
      } catch (e) {
        $("#err").innerHTML = notice([e.message, ...(e.body?.issues || [])].join(" · "));
      }
    });
  }

  async function jobPage(id) {
    const j = await api(`/api/jobs/${id}`);
    const quotes = j.quotes || [];
    view.innerHTML = `
      <section class="panel">
        <div class="row between"><h2>${esc(j.title)}</h2>${pill(j.status)}</div>
        <p>${esc(j.brief)}</p>
        <div class="meta"><span>${j.item_count} items</span><span>max ${cents(j.max_unit_price_cents)}/item</span><span>buyer ${esc(j.buyer_name)}</span><span>${when(j.created_at)}</span></div>
        ${j.pact_id ? `<p><a class="btn small" href="#/pacts/${j.pact_id}">Open pact</a></p>` : ""}
        ${j.restricted ? `<p class="muted">Items and quotes are visible to the buyer and to sellers whose agents quoted.</p>` : `
          <h3>Items</h3>
          <div class="table-wrap"><table class="table"><thead><tr><th>SKU</th><th>Facts</th></tr></thead><tbody>
            ${j.items.map((it) => `<tr><td class="mono">${esc(it.sku)}</td><td>${esc(Object.entries(it.facts).map(([k, v]) => `${k}: ${v}`).join(" · "))}</td></tr>`).join("")}
          </tbody></table></div>
          <h3>Quotes ${j.quoting ? `<span class="muted">agents are quoting…</span>` : `<span class="muted">${quotes.length}</span>`}</h3>
          ${quotes.length ? "" : `<p class="muted">${j.quoting ? "Waiting for eligible agents." : "No eligible agents quoted. Raise the max price or check the agents page."}</p>`}
          <div class="cards">${quotes.map((q) => `
            <div class="card">
              <div class="row between"><b>${esc(q.agent?.name || "agent")}</b>${pill(q.status)}</div>
              <p class="muted">${esc(q.message)}</p>
              <div class="meta"><span class="mono">${cents(q.unit_price_cents)}/item · total ${cents(q.unit_price_cents * j.item_count)}</span><span>ETA ${q.eta_minutes} min</span><span>${esc(q.seller_name)}</span>${q.agent?.stats?.acceptanceRate != null ? `<span>${Math.round(q.agent.stats.acceptanceRate * 100)}% accepted over ${q.agent.stats.settled} pacts</span>` : `<span>no history yet</span>`}</div>
              ${j.mine && j.status === "OPEN" && q.status === "open" ? `<button class="btn small award" data-quote="${q.id}">Award and authorize ${cents(q.unit_price_cents * j.item_count)}</button>` : ""}
            </div>`).join("")}</div>
          <div id="err"></div>`}
      </section>`;
    for (const b of view.querySelectorAll(".award")) {
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const r = await api(`/api/jobs/${id}/award`, { method: "POST", body: { quoteId: b.dataset.quote } });
          location.hash = `#/pacts/${r.pactId}`;
        } catch (e) {
          b.disabled = false;
          $("#err").innerHTML = notice(e.body?.message || e.message);
          if (e.body?.pactId) location.hash = `#/pacts/${e.body.pactId}`;
        }
      });
    }
    if (j.quoting && !j.restricted) {
      const t = setTimeout(() => location.hash === `#/jobs/${id}` && jobPage(id), 3000);
      teardown = () => clearTimeout(t);
    }
  }

  // ---------- pact page: status, transcript, ledger, approval ----------
  async function pactPage(id) {
    let r;
    try {
      r = await api(`/api/pacts/${id}`);
    } catch (e) {
      return (view.innerHTML = `<section class="panel">${notice(e.status === 401 ? "Log in to see this pact." : e.message)}</section>`);
    }
    const p = r.pact;
    let unitPrice = p.unit_price_cents || 0;
    view.innerHTML = `
      <section class="pact-head">
        <div>
          <h2>${esc(r.job.title)} <span class="muted">${p.kind === "demo" ? `demo · ${esc(p.scenario)}` : "marketplace"}</span></h2>
          <div class="meta"><span>${p.item_count} items</span><span>${p.unit_price_cents ? cents(p.unit_price_cents) + "/item" : ""}</span>${p.buyer_name ? `<span>buyer ${esc(p.buyer_name)}</span>` : ""}${p.seller_name ? `<span>seller ${esc(p.seller_name)}${r.agent ? ` · ${esc(r.agent.name)}` : ""}</span>` : ""}${p.job_id ? `<a href="#/jobs/${p.job_id}">job</a>` : ""}</div>
        </div>
        <span class="pill" id="status-pill" data-tone="${tone(p.status)}">${esc(p.status)}</span>
      </section>
      <div id="approve" class="panel approve" hidden></div>
      <main class="grid">
        <section class="panel transcript">
          <h2>Transcript <span class="muted">buyer · seller · verifier · platform</span></h2>
          <ol id="transcript" class="messages"></ol>
        </section>
        <section class="panel status">
          <div class="tiles">
            <div class="tile"><span class="k">Authorized</span><span class="v" id="t-auth">—</span></div>
            <div class="tile"><span class="k">Charged</span><span class="v" id="t-charged">—</span></div>
            <div class="tile"><span class="k">Released</span><span class="v" id="t-released">—</span></div>
            <div class="tile"><span class="k">Paid to seller</span><span class="v" id="t-paid">—</span></div>
          </div>
          <dl class="refs" id="refs"></dl>
          <div class="fault" id="fault" hidden></div>
        </section>
        <section class="panel ledger">
          <h2>Item ledger <span class="muted">one row per SKU · verdict · evidence · amount</span></h2>
          <div id="ledger" class="ag-host"></div>
        </section>
      </main>`;

    // grid
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = agGrid.themeQuartz.withParams({ backgroundColor: dark ? "#171a21" : "#ffffff", foregroundColor: dark ? "#e6e8ee" : "#14161c", headerBackgroundColor: dark ? "#1d212a" : "#f0f2f6", borderColor: dark ? "#2a2f3a" : "#dde1ea", rowHoverColor: dark ? "#1d212a" : "#f0f2f6", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", fontSize: 13, spacing: 6 });
    const rows = new Map();
    const gridApi = agGrid.createGrid($("#ledger"), {
      theme,
      columnDefs: [
        { field: "sku", headerName: "SKU", width: 96, minWidth: 96, pinned: "left", cellStyle: { fontFamily: "ui-monospace, Menlo, monospace" } },
        { field: "name", headerName: "Product", minWidth: 140, flex: 1 },
        { field: "verdict", width: 124, minWidth: 124, cellRenderer: (c) => `<span class="verdict ${c.value}">${c.value}</span>`, filter: true },
        { field: "score", width: 84, minWidth: 84, valueFormatter: (c) => (c.value == null ? "" : c.value.toFixed(2)), type: "numericColumn" },
        { field: "reason", minWidth: 220, flex: 2, tooltipField: "evidence" },
        { field: "amount", headerName: "Charge", width: 96, minWidth: 96, type: "numericColumn", valueFormatter: (c) => (c.value == null ? "" : cents(c.value)) },
      ],
      defaultColDef: { sortable: true, resizable: true },
      rowData: [],
      getRowId: (c) => c.data.sku,
      animateRows: true,
      tooltipShowDelay: 300,
    });
    for (const s of r.job.skus) rows.set(s.sku, { sku: s.sku, name: s.facts?.name ?? "", verdict: "pending", score: null, reason: "", evidence: "", amount: null });
    gridApi.setGridOption("rowData", [...rows.values()]);
    const totals = () => {
      const all = [...rows.values()];
      const acc = all.filter((x) => x.verdict === "accepted").length;
      const rej = all.filter((x) => x.verdict === "rejected").length;
      gridApi.setGridOption("pinnedBottomRowData", [{ sku: "Σ", name: `${acc} accepted · ${rej} rejected · ${all.length - acc - rej} pending`, verdict: "", score: null, reason: "", amount: acc * unitPrice }]);
    };
    const setVerdict = (v) => {
      const row = rows.get(v.sku) ?? { sku: v.sku, name: "" };
      Object.assign(row, { verdict: v.verdict, score: v.score, reason: v.reason, evidence: (v.evidence || []).join("\n"), amount: v.verdict === "accepted" ? unitPrice : 0 });
      rows.set(v.sku, row);
      gridApi.applyTransaction(rows.has(v.sku) ? { update: [row] } : { add: [row] });
      totals();
    };
    for (const it of r.items) setVerdict(it);
    totals();

    // transcript
    const list = $("#transcript");
    const addMessage = (role, text) => {
      const li = document.createElement("li");
      li.className = "msg";
      li.dataset.role = role;
      li.innerHTML = `<span class="who">${esc(role[0].toUpperCase())}</span><div class="body"><div class="name">${esc(role)}</div>${esc(text)}</div>`;
      list.appendChild(li);
      list.scrollTop = list.scrollHeight;
    };
    const addSys = (text, t = "") => {
      const li = document.createElement("li");
      li.className = `sys ${t}`;
      li.textContent = text;
      list.appendChild(li);
      list.scrollTop = list.scrollHeight;
    };
    const setStatus = (s) => {
      const el = $("#status-pill");
      el.textContent = s;
      el.dataset.tone = tone(s);
    };
    const refresh = async () => {
      const x = await api(`/api/pacts/${id}`);
      const q = x.pact;
      unitPrice = q.unit_price_cents || unitPrice;
      setStatus(q.status);
      const settled = q.status === "SETTLED" || q.status === "PAID_OUT";
      $("#t-auth").textContent = cents(q.authorized_cents);
      $("#t-charged").textContent = settled ? cents(q.charge_cents) : "—";
      $("#t-released").textContent = settled ? cents((q.authorized_cents ?? 0) - (q.charge_cents ?? 0)) : "—";
      $("#t-paid").textContent = x.payout?.status === "SUCCESS" ? cents(x.payout.amount_cents) : x.payout ? `${x.payout.status.toLowerCase()}…` : "—";
      $("#refs").innerHTML = Object.entries({
        order: q.order_id || x.authorization?.order_id,
        authorization: x.authorization ? `${x.authorization.id} · ${x.authorization.status}` : "",
        capture: x.capture ? `${x.capture.id} · ${x.capture.status}` : "",
        payout: x.payout ? `${x.payout.item_id} · ${x.payout.status} · ${x.payout.receiver}` : "",
        "pact hash": q.pact_hash ? q.pact_hash.slice(0, 16) + "…" : "",
        "checkout deadline": q.status === "AGREED" && q.checkout_deadline ? when(q.checkout_deadline) : "",
      }).filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
      renderApprove(x);
      return x;
    };

    // PayPal approval (buyer, market pact in AGREED with an order)
    let sdkSession = null;
    async function renderApprove(x) {
      const box = $("#approve");
      if (!x.can_approve) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      if (sdkSession) return;
      const total = (x.pact.unit_price_cents || 0) * x.pact.item_count;
      box.innerHTML = `<div><b>Approve a ${cents(total)} authorization</b><p class="muted">PayPal holds the amount; nothing is captured until the verifier accepts items. Unaccepted items are released. Deadline ${when(x.pact.checkout_deadline)}.</p></div><div><paypal-button type="pay" id="pp"></paypal-button><div id="pp-log" class="muted"></div></div>`;
      const log = (m) => ($("#pp-log").textContent = m);
      try {
        await loadScript("https://www.sandbox.paypal.com/web-sdk/v6/core");
        const sdk = await window.paypal.createInstance({ clientId: config.clientId, components: ["paypal-payments"], pageType: "checkout" });
        sdkSession = sdk.createPayPalOneTimePaymentSession({
          async onApprove(data) {
            log("Approved. Recording the authorization…");
            try {
              const res = await api(`/api/pacts/${id}/approve`, { method: "POST", body: { orderId: data.orderId } });
              log(`Authorization recorded (${res.status}).`);
            } catch (e) {
              log(`Could not authorize: ${e.body?.error || e.message}`);
            }
            refresh();
          },
          onCancel() {
            log("Cancelled in PayPal. You can try again before the deadline.");
          },
          onError(e) {
            log(`PayPal error: ${e?.message || e}`);
          },
        });
        $("#pp").addEventListener("click", async () => {
          try {
            await sdkSession.start({ presentationMode: "auto" }, Promise.resolve({ orderId: x.pact.order_id }));
          } catch (e) {
            log(`start error: ${e?.message || e}`);
          }
        });
      } catch (e) {
        log(`SDK error: ${e?.message || e}`);
      }
    }

    // events (replay + tail over SSE)
    const EVENT_TYPES = ["run.started", "agent.message", "seller.progress", "fault.injected", "verifier.item", "webhook.received", "run.error", "run.retry", "run.finished", "pact.offered", "pact.agreed", "pact.rejected", "pact.held", "pact.hold_failed", "pact.checkout_expired", "pact.delivered", "pact.verified", "pact.settling", "pact.settled", "pact.settlement_failed", "pact.paid_out", "mandate.reserved", "mandate.violation", "checkout.order_created", "checkout.failed", "hold.failed", "hold.unknown", "settle.failed", "settle.unknown", "settle.capture_pending", "payout.sent", "payout.pending", "payout.not_sent"];
    const handle = (type, d) => {
      switch (type) {
        case "agent.message": return addMessage(d.role, d.text);
        case "seller.progress": return addSys(`seller wrote ${d.skus.join(", ")}`);
        case "fault.injected":
          $("#fault").hidden = false;
          $("#fault").textContent = `Fault injection (disclosed): ${d.note}.` + (d.dropped?.length ? ` Dropped ${d.dropped.join(", ")}.` : "") + (d.corrupted?.length ? ` Corrupted ${d.corrupted.map((c) => `${c.sku}.${c.fact}`).join(", ")}.` : "");
          return addSys(`fault injected: ${d.note}`, "warn");
        case "verifier.item": return setVerdict(d);
        case "pact.offered": unitPrice = d.unitPriceCents; return setStatus("OFFERED");
        case "pact.agreed": setStatus("AGREED"); $("#t-auth").textContent = cents(d.totalCents); return;
        case "checkout.order_created": return addSys(`PayPal order ${d.orderId} created for ${cents(d.amountCents)}; waiting for buyer approval`);
        case "pact.held": setStatus("HELD"); return addSys(`authorization ${d.authorizationId} created for ${cents(d.amountCents)}${d.via ? ` via ${d.via}` : ""}`, "ok");
        case "pact.delivered": return setStatus("DELIVERED");
        case "pact.verified": return setStatus("VERIFIED");
        case "pact.settling": setStatus("SETTLING"); return addSys(`settlement: ${d.kind}, charge ${cents(d.chargeCents)}, release ${cents(d.releasedCents)}`);
        case "pact.settled": setStatus("SETTLED"); return addSys(d.captureId ? `capture ${d.captureId} COMPLETED for ${cents(d.chargeCents)}` : `authorization voided, ${cents(d.releasedCents)} released`, "ok");
        case "pact.paid_out": setStatus("PAID_OUT"); return addSys(`payout ${d.payoutItemId} SUCCESS: ${cents(d.amountCents)} to ${d.receiver}`, "ok");
        case "pact.rejected": setStatus("REJECTED"); return addSys(`rejected${d.enforced ? " (server-enforced)" : ""}: ${d.reason}`, "bad");
        case "pact.checkout_expired": setStatus("CHECKOUT_EXPIRED"); return addSys("checkout deadline passed; reservation released, job reopened", "bad");
        case "mandate.violation": case "hold.failed": case "settle.failed": case "pact.hold_failed": case "pact.settlement_failed": case "run.error": case "checkout.failed":
          return addSys(`${type}: ${JSON.stringify(d).slice(0, 200)}`, "bad");
        case "run.retry": return addSys(`retrying after an error (attempt ${d.attempt}): ${d.message}`, "warn");
        case "webhook.received": return addSys(`webhook ${d.type} → ${d.status}`);
        case "payout.sent": case "payout.pending": case "settle.capture_pending": return addSys(`${type}: ${d.status ?? d.itemStatus ?? ""}`);
        case "run.finished": return addSys(`run finished: ${d.status}`, d.status === "error" ? "bad" : "ok");
      }
    };
    let es = null;
    const connect = () => {
      es = new EventSource(`/api/pacts/${id}/events`);
      for (const t of EVENT_TYPES) {
        es.addEventListener(t, (ev) => {
          let d = {};
          try { d = JSON.parse(ev.data); } catch {}
          handle(t, d);
          if (t === "run.finished" || t === "pact.rejected") { es.close(); es = null; refresh(); }
          if (t === "pact.held" || t === "pact.settled" || t === "pact.paid_out" || t === "pact.checkout_expired") refresh();
        });
      }
      es.onerror = () => refresh();
    };
    await refresh();
    connect();
    teardown = () => { es?.close(); gridApi.destroy(); };
  }

  async function agentsPage() {
    const agents = await api("/api/agents");
    view.innerHTML = `
      <section class="panel">
        <div class="row between"><h2>Seller agents <span class="muted">${agents.length}</span></h2><a class="btn" href="#/agents/new">Register an agent</a></div>
        <p class="muted">Hosted agents quote open jobs automatically within their price band. The platform runs them on the seller's key, verifies every item on its own model, and pays the seller's PayPal only for accepted items.</p>
        <div class="cards">${agents.map((a) => `
          <div class="card">
            <div class="row between"><b>${esc(a.name)}</b>${pill(a.status)}</div>
            <p class="muted">${esc(a.description)}</p>
            <div class="meta"><span>${esc(a.provider)}${a.model ? ` · ${esc(a.model)}` : ""}</span><span>${cents(a.min_unit_price_cents)}–${cents(a.max_unit_price_cents)}/item</span><span>≤ ${a.max_items_per_job} items/job</span><span>${a.stats.settled ? `${Math.round((a.stats.acceptanceRate || 0) * 100)}% accepted · earned ${cents(a.stats.earnedCents)}` : "no history yet"}</span></div>
          </div>`).join("")}</div>
      </section>`;
  }

  function newAgent() {
    if (!me) return needLogin("register an agent");
    view.innerHTML = `
      <section class="panel narrow">
        <h2>Register an agent</h2>
        <form id="f" class="form">
          <label>Name <input name="name" required minlength="2" maxlength="60"></label>
          <label>Description <input name="description" maxlength="500" placeholder="What it is good at"></label>
          <div class="row">
            <label>Provider <select name="provider"><option value="opencode">OpenCode Go</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option>${me.provider === "dev" ? `<option value="platform">platform (seeded)</option>` : ""}</select></label>
            <label>Model <input name="model" placeholder="e.g. glm-5.3" maxlength="80"></label>
          </div>
          <label>API key <input name="apiKey" type="password" autocomplete="off" maxlength="400" placeholder="stored encrypted; never shown again">${config.keyCustody ? "" : `<span class="muted">Key custody is not configured on this server; only platform agents can be created.</span>`}</label>
          <label>Style notes for the agent (optional) <textarea name="systemPrompt" rows="2" maxlength="2000"></textarea></label>
          <div class="row">
            <label>Min price (¢/item) <input name="min" type="number" min="1" value="60"></label>
            <label>Max price (¢/item) <input name="max" type="number" min="1" value="200"></label>
            <label>Max items per job <input name="maxItems" type="number" min="1" max="20" value="20"></label>
          </div>
          <p class="muted">Payouts go to the PayPal email on your account (${esc(me.email)}). Sandbox only.</p>
          <div id="err"></div>
          <button class="btn" type="submit">Register</button>
        </form>
      </section>`;
    $("#f").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        await api("/api/agents", { method: "POST", body: { name: f.get("name"), description: f.get("description"), provider: f.get("provider"), model: f.get("model"), apiKey: f.get("apiKey") || undefined, systemPrompt: f.get("systemPrompt"), minUnitPriceCents: Number(f.get("min")), maxUnitPriceCents: Number(f.get("max")), maxItemsPerJob: Number(f.get("maxItems")) } });
        location.hash = "#/me";
      } catch (e) {
        $("#err").innerHTML = notice([e.message, ...(e.body?.issues || [])].join(" · "));
      }
    });
  }

  async function demoPage() {
    const [pacts, active] = await Promise.all([api("/api/pacts"), api("/api/demo/active")]);
    const demos = pacts.filter((p) => p.kind === "demo");
    view.innerHTML = `
      <section class="panel">
        <h2>Demo mode <span class="muted">seeded buyer agent + seeded seller agent, sandbox card hold, disclosed fault injection</span></h2>
        <div class="scenarios">
          <button class="scenario" data-scenario="good"><b>Good delivery</b><span>Seller does the work. Expect full capture.</span></button>
          <button class="scenario" data-scenario="partial"><b>Partial delivery</b><span>5 items dropped, 3 facts corrupted. Expect partial capture.</span></button>
          <button class="scenario" data-scenario="broken"><b>Broken delivery</b><span>Malformed artifact. Expect void, nothing charged.</span></button>
        </div>
        <div id="err"></div>
        ${active.pactId ? `<p>A demo run is in progress: <a href="#/pacts/${active.pactId}">open it</a>.</p>` : ""}
        <h3>Past demo runs</h3>
        <div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Scenario</th><th>Status</th><th>Accepted</th><th>Charged</th></tr></thead><tbody>
          ${demos.map((p) => `<tr><td><a href="#/pacts/${p.id}">${when(p.created_at)}</a></td><td>${esc(p.scenario)}</td><td>${pill(p.status)}</td><td>${p.accepted_count ?? "—"}/${p.item_count}</td><td>${p.charge_cents != null ? cents(p.charge_cents) : "—"}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">none yet</td></tr>`}
        </tbody></table></div>
      </section>`;
    for (const b of view.querySelectorAll(".scenario")) {
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const r = await api("/api/demo/runs", { method: "POST", body: { scenario: b.dataset.scenario } });
          location.hash = `#/pacts/${r.pactId}`;
        } catch (e) {
          b.disabled = false;
          $("#err").innerHTML = notice(e.message);
          if (e.body?.pactId) location.hash = `#/pacts/${e.body.pactId}`;
        }
      });
    }
  }

  async function mePage() {
    if (!me) return needLogin("see your account");
    const d = await api("/api/me");
    const m = d.mandate;
    const pactRows = (ps) => ps.map((p) => `<tr><td><a href="#/pacts/${p.id}">${esc(p.title)}</a></td><td>${pill(p.status)}</td><td>${p.accepted_count ?? "—"}/${p.item_count}</td><td>${p.charge_cents != null ? cents(p.charge_cents) : p.authorized_cents != null ? `held ${cents(p.authorized_cents)}` : "—"}</td><td>${when(p.updated_at)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">none</td></tr>`;
    view.innerHTML = `
      <section class="panel">
        <h2>${esc(me.name)} <span class="muted">${esc(me.email)} · ${esc(me.provider)}</span></h2>
        <div class="two">
          <div>
            <h3>Buying</h3>
            <form id="mandate" class="form inline">
              <span class="muted">Spending mandate, enforced by the server:</span>
              <label>per pact (¢) <input name="per" type="number" min="100" value="${m.max_per_pact_cents}"></label>
              <label>total (¢) <input name="agg" type="number" min="100" value="${m.max_aggregate_cents}"></label>
              <button class="btn small" type="submit">Save</button>
              <span class="muted">reserved ${cents(m.reserved_cents)} · spent ${cents(m.spent_cents)}</span>
            </form>
            <div id="merr"></div>
            <h4>My jobs <a class="btn small" href="#/post">Post</a></h4>
            <div class="table-wrap"><table class="table"><tbody>${d.jobs.map((j) => `<tr><td><a href="#/jobs/${j.id}">${esc(j.title)}</a></td><td>${pill(j.status)}</td><td>${j.quote_count} quotes</td><td>${when(j.created_at)}</td></tr>`).join("") || `<tr><td class="muted">none</td></tr>`}</tbody></table></div>
            <h4>Pacts as buyer</h4>
            <div class="table-wrap"><table class="table"><tbody>${pactRows(d.pacts.asBuyer)}</tbody></table></div>
          </div>
          <div>
            <h3>Selling <span class="muted">earned ${cents(d.earnedCents)}</span></h3>
            <h4>My agents <a class="btn small" href="#/agents/new">Register</a></h4>
            <div class="cards">${d.agents.map((a) => `
              <div class="card">
                <div class="row between"><b>${esc(a.name)}</b>${pill(a.status)}</div>
                <div class="meta"><span>${esc(a.provider)}${a.model ? ` · ${esc(a.model)}` : ""}</span><span>${cents(a.min_unit_price_cents)}–${cents(a.max_unit_price_cents)}</span><span>${a.has_key ? "key stored" : a.provider === "platform" ? "platform key" : "no key (paused)"}</span><span>${a.stats.settled} settled · earned ${cents(a.stats.earnedCents)}</span></div>
                <div class="row">
                  <button class="link toggle" data-id="${a.id}" data-status="${a.status === "active" ? "paused" : "active"}">${a.status === "active" ? "Pause" : "Activate"}</button>
                  ${a.has_key ? `<button class="link delkey" data-id="${a.id}">Delete key</button>` : ""}
                </div>
              </div>`).join("") || `<p class="muted">none</p>`}</div>
            <h4>Pacts as seller</h4>
            <div class="table-wrap"><table class="table"><tbody>${pactRows(d.pacts.asSeller)}</tbody></table></div>
          </div>
        </div>
      </section>`;
    $("#mandate").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        await api("/api/mandate", { method: "PUT", body: { maxPerPactCents: Number(f.get("per")), maxAggregateCents: Number(f.get("agg")) } });
        mePage();
      } catch (e) {
        $("#merr").innerHTML = notice(e.message);
      }
    });
    for (const b of view.querySelectorAll(".toggle")) b.addEventListener("click", async () => { await api(`/api/agents/${b.dataset.id}`, { method: "PATCH", body: { status: b.dataset.status } }); mePage(); });
    for (const b of view.querySelectorAll(".delkey")) b.addEventListener("click", async () => { if (confirm("Delete the stored API key? The agent is paused until a new key is supplied.")) { await api(`/api/agents/${b.dataset.id}/key`, { method: "DELETE" }); mePage(); } });
  }

  function needLogin(what) {
    view.innerHTML = `<section class="panel narrow"><h2>Log in</h2><p>Log in with PayPal to ${esc(what)}. Sandbox accounts only.</p><p><a class="btn" href="/auth/paypal/start">Log in with PayPal</a>${config.devLogin ? ` <button class="btn secondary" onclick="document.getElementById('devlogin').click()">Dev login</button>` : ""}</p></section>`;
  }

  const loaded = new Set();
  const loadScript = (src) => loaded.has(src) ? Promise.resolve() : new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = () => { loaded.add(src); res(); }; s.onerror = rej; document.head.appendChild(s); });

  // ---------- router ----------
  const routes = [
    [/^#\/?$/, board],
    [/^#\/post$/, postJob],
    [/^#\/jobs\/([\w-]+)$/, jobPage],
    [/^#\/pacts\/([\w-]+)$/, pactPage],
    [/^#\/agents$/, agentsPage],
    [/^#\/agents\/new$/, newAgent],
    [/^#\/demo$/, demoPage],
    [/^#\/me$/, mePage],
  ];
  async function route() {
    teardown?.();
    teardown = null;
    const hash = location.hash || "#/";
    for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("active", hash === a.getAttribute("hash") || (a.getAttribute("href") !== "#/" ? hash.startsWith(a.getAttribute("href")) : hash === "#/"));
    for (const [re, fn] of routes) {
      const m = hash.match(re);
      if (m) {
        try {
          await fn(...m.slice(1));
        } catch (e) {
          view.innerHTML = `<section class="panel">${notice(e.message)}</section>`;
        }
        return;
      }
    }
    location.hash = "#/";
  }
  window.addEventListener("hashchange", route);
  (async () => {
    config = await api("/api/config").catch(() => config);
    await loadMe();
    route();
  })();
})();
