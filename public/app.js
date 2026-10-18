/* AgentPact UI: scenario buttons, SSE transcript, status tiles, AG Grid item ledger. */
(() => {
  const $ = (id) => document.getElementById(id);
  const cents = (c) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  let es = null;
  let current = null;
  let job = null;
  let unitPrice = 0;
  let gridApi = null;
  const rows = new Map();

  // ---------- grid ----------
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = agGrid.themeQuartz.withParams({
    backgroundColor: dark ? "#171a21" : "#ffffff",
    foregroundColor: dark ? "#e6e8ee" : "#14161c",
    headerBackgroundColor: dark ? "#1d212a" : "#f0f2f6",
    borderColor: dark ? "#2a2f3a" : "#dde1ea",
    rowHoverColor: dark ? "#1d212a" : "#f0f2f6",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    fontSize: 13,
    spacing: 6,
  });
  gridApi = agGrid.createGrid($("ledger"), {
    theme,
    columnDefs: [
      { field: "sku", headerName: "SKU", width: 96, minWidth: 96, pinned: "left", cellStyle: { fontFamily: "ui-monospace, Menlo, monospace" } },
      { field: "name", headerName: "Product", minWidth: 140, flex: 1 },
      {
        field: "verdict",
        width: 124,
        minWidth: 124,
        cellRenderer: (p) => `<span class="verdict ${p.value}">${p.value}</span>`,
        filter: true,
      },
      { field: "score", width: 84, minWidth: 84, valueFormatter: (p) => (p.value == null ? "" : p.value.toFixed(2)), type: "numericColumn" },
      { field: "reason", minWidth: 220, flex: 2, tooltipField: "evidence", wrapText: false },
      { field: "amount", headerName: "Charge", width: 96, minWidth: 96, type: "numericColumn", valueFormatter: (p) => (p.value == null ? "" : cents(p.value)) },
    ],
    defaultColDef: { sortable: true, resizable: true },
    rowData: [],
    getRowId: (p) => p.data.sku,
    animateRows: true,
    tooltipShowDelay: 300,
    pinnedBottomRowData: [],
  });

  function resetGrid(skus) {
    rows.clear();
    for (const s of skus) rows.set(s.sku, { sku: s.sku, name: s.facts?.name ?? "", verdict: "pending", score: null, reason: "", evidence: "", amount: null });
    gridApi.setGridOption("rowData", [...rows.values()]);
    totals();
  }
  function setVerdict(v) {
    const r = rows.get(v.sku) ?? { sku: v.sku, name: "" };
    Object.assign(r, { verdict: v.verdict, score: v.score, reason: v.reason, evidence: (v.evidence || []).join("\n"), amount: v.verdict === "accepted" ? unitPrice : 0 });
    rows.set(v.sku, r);
    gridApi.applyTransaction({ update: [r] });
    totals();
  }
  function totals() {
    const all = [...rows.values()];
    const accepted = all.filter((r) => r.verdict === "accepted").length;
    const rejected = all.filter((r) => r.verdict === "rejected").length;
    gridApi.setGridOption("pinnedBottomRowData", [{ sku: "Σ", name: `${accepted} accepted · ${rejected} rejected · ${all.length - accepted - rejected} pending`, verdict: "", score: null, reason: "", amount: accepted * unitPrice }]);
  }

  // ---------- transcript ----------
  const list = $("transcript");
  function clearTranscript() {
    list.innerHTML = "";
  }
  function addMessage(role, text) {
    const li = document.createElement("li");
    li.className = "msg";
    li.dataset.role = role;
    li.innerHTML = `<span class="who">${esc(role[0].toUpperCase())}</span><div class="body"><div class="name">${esc(role)}</div>${esc(text)}</div>`;
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
  }
  function addSys(text, tone = "") {
    const li = document.createElement("li");
    li.className = `sys ${tone}`;
    li.textContent = text;
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
  }

  // ---------- status ----------
  const tone = (status) => (["PAID_OUT", "SETTLED"].includes(status) ? "ok" : ["REJECTED", "HOLD_FAILED", "SETTLEMENT_FAILED", "error"].includes(status) ? "bad" : status === "idle" ? "" : "run");
  function setStatus(status) {
    const pill = $("status-pill");
    pill.textContent = status;
    pill.dataset.tone = tone(status);
  }
  function setRefs(obj) {
    $("refs").innerHTML = Object.entries(obj)
      .filter(([, v]) => v)
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
      .join("");
  }
  async function refresh(id) {
    const r = await fetch(`/api/pacts/${id}`).then((x) => x.json());
    const p = r.pact;
    setStatus(p.status);
    $("t-auth").textContent = cents(p.authorized_cents);
    $("t-charged").textContent = p.status === "SETTLED" || p.status === "PAID_OUT" ? cents(p.charge_cents) : "—";
    $("t-released").textContent = p.status === "SETTLED" || p.status === "PAID_OUT" ? cents((p.authorized_cents ?? 0) - (p.charge_cents ?? 0)) : "—";
    $("t-paid").textContent = r.payout?.status === "SUCCESS" ? cents(r.payout.amount_cents) : r.payout ? `${r.payout.status.toLowerCase()}…` : "—";
    setRefs({
      scenario: (r.events.find((e) => e.type === "run.started") && JSON.parse(r.events.find((e) => e.type === "run.started").payload_json).scenario) || "",
      "unit price": p.unit_price_cents ? cents(p.unit_price_cents) : "",
      order: r.authorization?.order_id,
      authorization: r.authorization ? `${r.authorization.id} · ${r.authorization.status}` : "",
      capture: r.capture ? `${r.capture.id} · ${r.capture.status}` : "",
      payout: r.payout ? `${r.payout.item_id} · ${r.payout.status}` : "",
      "pact hash": p.pact_hash ? p.pact_hash.slice(0, 16) + "…" : "",
    });
    return r;
  }

  // ---------- events ----------
  const EVENT_TYPES = [
    "run.started", "agent.message", "seller.progress", "fault.injected", "verifier.item", "webhook.received", "run.error", "run.finished",
    "pact.offered", "pact.agreed", "pact.rejected", "pact.held", "pact.hold_failed", "pact.delivered", "pact.verified", "pact.settling", "pact.settled", "pact.settlement_failed", "pact.paid_out",
    "mandate.reserved", "mandate.violation", "hold.failed", "hold.unknown", "settle.failed", "settle.unknown", "settle.capture_pending", "payout.sent", "payout.pending", "payout.not_sent",
  ];
  function handle(type, data) {
    switch (type) {
      case "agent.message":
        addMessage(data.role, data.text);
        break;
      case "seller.progress":
        addSys(`seller wrote ${data.skus.join(", ")}`);
        break;
      case "fault.injected":
        $("fault").hidden = false;
        $("fault").textContent = `Fault injection (disclosed): ${data.note}.` + (data.dropped?.length ? ` Dropped ${data.dropped.join(", ")}.` : "") + (data.corrupted?.length ? ` Corrupted ${data.corrupted.map((c) => `${c.sku}.${c.fact}`).join(", ")}.` : "");
        addSys(`fault injected: ${data.note}`, "warn");
        break;
      case "verifier.item":
        setVerdict(data);
        break;
      case "pact.offered":
        unitPrice = data.unitPriceCents;
        setStatus("OFFERED");
        break;
      case "pact.agreed":
        setStatus("AGREED");
        $("t-auth").textContent = cents(data.totalCents);
        break;
      case "pact.held":
        setStatus("HELD");
        addSys(`authorization ${data.authorizationId} created for ${cents(data.amountCents)} (expires ${String(data.expiresAt).slice(0, 10)})`, "ok");
        break;
      case "pact.delivered":
        setStatus("DELIVERED");
        break;
      case "pact.verified":
        setStatus("VERIFIED");
        break;
      case "pact.settling":
        setStatus("SETTLING");
        addSys(`settlement: ${data.kind}, charge ${cents(data.chargeCents)}, release ${cents(data.releasedCents)}`);
        break;
      case "pact.settled":
        setStatus("SETTLED");
        addSys(data.captureId ? `capture ${data.captureId} COMPLETED for ${cents(data.chargeCents)}` : `authorization voided, ${cents(data.releasedCents)} released`, "ok");
        break;
      case "pact.paid_out":
        setStatus("PAID_OUT");
        addSys(`payout ${data.payoutItemId} SUCCESS: ${cents(data.amountCents)} to ${data.receiver}`, "ok");
        break;
      case "pact.rejected":
        setStatus("REJECTED");
        addSys(`rejected${data.enforced ? " (server-enforced)" : ""}: ${data.reason}`, "bad");
        break;
      case "mandate.violation":
      case "hold.failed":
      case "settle.failed":
      case "pact.hold_failed":
      case "pact.settlement_failed":
      case "run.error":
        addSys(`${type}: ${JSON.stringify(data).slice(0, 200)}`, "bad");
        break;
      case "webhook.received":
        addSys(`webhook ${data.type} → ${data.status}`);
        break;
      case "payout.sent":
      case "payout.pending":
      case "settle.capture_pending":
        addSys(`${type}: ${data.status ?? data.itemStatus ?? ""}`);
        break;
      case "run.finished":
        addSys(`run finished: ${data.status}`, data.status === "error" ? "bad" : "ok");
        break;
      default:
        break;
    }
  }

  async function watch(id) {
    if (es) es.close();
    current = id;
    clearTranscript();
    $("fault").hidden = true;
    const r = await refresh(id);
    job = r.job;
    unitPrice = r.pact.unit_price_cents ?? 0;
    resetGrid(job.skus);
    es = new EventSource(`/api/pacts/${id}/events`);
    for (const t of EVENT_TYPES) {
      es.addEventListener(t, (ev) => {
        let data = {};
        try {
          data = JSON.parse(ev.data);
        } catch {}
        handle(t, data);
        if (t === "run.finished" || t === "pact.rejected") {
          es.close();
          es = null;
          refresh(id);
          loadMandate();
          setButtons(false);
          loadHistory();
        }
      });
    }
    es.onerror = () => {
      /* server closes the stream at run end; polling refresh covers the rest */
      refresh(id);
    };
  }

  // ---------- controls ----------
  const buttons = [...document.querySelectorAll(".scenario")];
  function setButtons(disabled) {
    for (const b of buttons) b.disabled = disabled;
  }
  for (const b of buttons) {
    b.addEventListener("click", async () => {
      setButtons(true);
      buttons.forEach((x) => x.classList.toggle("active", x === b));
      const res = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario: b.dataset.scenario }) });
      const j = await res.json();
      if (!res.ok) {
        setButtons(false);
        addSys(`could not start: ${j.error}`, "bad");
        if (j.pactId) watch(j.pactId);
        return;
      }
      setStatus("starting");
      watch(j.pactId);
    });
  }

  async function loadMandate() {
    const m = await fetch("/api/mandate").then((x) => x.json());
    $("mandate-text").textContent = `≤ ${cents(m.max_per_pact_cents)} per pact · ≤ ${cents(m.max_aggregate_cents)} total · reserved ${cents(m.reserved_cents)} · spent ${cents(m.spent_cents)}`;
  }
  async function loadHistory() {
    const pacts = await fetch("/api/pacts").then((x) => x.json());
    const sel = $("pact-select");
    sel.innerHTML = `<option value="">—</option>` + pacts.map((p) => `<option value="${p.id}" ${p.id === current ? "selected" : ""}>${p.created_at.slice(5, 16).replace("T", " ")} · ${p.status} · ${p.settlement_kind ?? ""} ${p.charge_cents != null ? cents(p.charge_cents) : ""}</option>`).join("");
  }
  $("pact-select").addEventListener("change", (e) => {
    if (e.target.value) watch(e.target.value);
  });

  loadMandate();
  loadHistory().then(async () => {
    const h = await fetch("/health").then((x) => x.json());
    if (h.activeRun) {
      setButtons(true);
      watch(h.activeRun);
    }
  });
})();
