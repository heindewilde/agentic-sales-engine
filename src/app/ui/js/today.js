// Today: what's waiting for you, each with the screen that resolves it; then the pipeline and spend.
import { STAGES, STAGE_NAME, empty, esc, get, money } from "./ui.js";

const ICON = { gate: "◆", drafts: "✎", outcomes: "↺", stale: "◷", run: "▶" };

export async function today(view, { state }) {
  view.innerHTML = `<p class="muted">Loading…</p>`;
  const t = await get("/api/today");
  const greeting = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening";
  const items = t.items;
  view.innerHTML = `
    <section class="intro"><div><h1>${greeting}.</h1>
      <p>${items.length ? `${items.length} thing${items.length === 1 ? "" : "s"} ${items.length === 1 ? "is" : "are"} waiting for you.` : "Nothing is waiting for you right now."}</p></div>
      <div class="kpis">
        <div class="kpi"><b>${money(t.spend_week.billed)}</b><span>spent this week</span></div>
        <div class="kpi"><b>${money(t.spend_week.covered_by_plan)}</b><span>covered by your plan</span></div>
      </div></section>
    ${items.length ? `<section class="inbox">${items.map((i) => `<a class="inbox-item ${i.kind}" href="${esc(i.href)}" data-link>
        <span class="ic">${ICON[i.kind] ?? "•"}</span>
        <span class="t"><b>${esc(i.title)}</b><small>${esc(i.detail)}</small></span>
        ${i.icp && state.icps.length > 1 ? `<span class="tag">${esc(i.icp)}</span>` : ""}
        <span class="go">${i.kind === "gate" ? "review" : i.kind === "run" ? "start" : "open"} →</span></a>`).join("")}</section>` : empty("All clear", "New gates, drafts and outcome questions show up here as the engine works.")}
    ${t.problems?.length ? `<section class="note warn"><b>Needs attention</b><ul>${t.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></section>` : ""}
    <h3 class="section">Pipeline</h3>
    ${Object.entries(t.funnel).map(([icp, stages]) => funnel(icp, stages)).join("") || empty("No accounts yet", "Find companies for an approved ICP to start the pipeline.")}
    <p class="muted foot">Claude ${t.billing === "subscription" ? "runs on your subscription" : "is billed per token"} · providers: ${esc(t.tier?.detail ?? t.tier?.tier ?? "")}${t.run ? ` · active run ${esc(t.run.run_id ?? "")}` : ""}</p>`;
}

function funnel(icp, stages) {
  // accounts that reached each stage or got past it
  const reach = STAGES.map((s, i) => STAGES.slice(i).reduce((a, x) => a + (stages[x] ?? 0), 0) + (i <= 1 ? stages.excluded ?? 0 : 0));
  const max = Math.max(1, ...reach);
  return `<div class="pipe"><div class="pipe-head"><b>${esc(icp)}</b>${stages.excluded ? `<span class="muted">${stages.excluded} excluded</span>` : ""}</div>
    <div class="pipe-row">${STAGES.map((s, i) => `<a class="pipe-cell" href="/accounts?stage=${s}" data-link title="${stages[s] ?? 0} at this stage now">
      <span class="pn">${esc(STAGE_NAME[s])}</span><span class="pv">${reach[i]}</span><span class="fbar"><i style="width:${(100 * reach[i]) / max}%"></i></span>
      <span class="muted">${stages[s] ?? 0} here now</span></a>`).join("")}</div></div>`;
}
