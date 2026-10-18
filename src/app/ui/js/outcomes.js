// Outcomes: the weekly review (one question per open account), what converts (with honest intervals), and teaching lessons.
import { $, day, empty, esc, get, me, post, toast } from "./ui.js";
import { logDialog } from "./accounts.js";
import { go } from "./shell.js";

const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);

export async function outcomesPage(view, { state }) {
  const icp = state.icp;
  const d = await get(`/api/outcomes?icp=${encodeURIComponent(icp)}`);
  const s = d.stats;
  view.innerHTML = `
    <section class="intro"><div><h1>Outcomes</h1><p>What happened after outreach. Answer the open questions so the engine learns which accounts really convert.</p></div>
      ${s ? `<div class="kpis"><div class="kpi"><b>${s.accounts_tracked}</b><span>accounts contacted</span></div><div class="kpi"><b>${s.in_flight}</b><span>still in flight</span></div><div class="kpi"><b>${pct(s.overall?.rate)}</b><span>engaged (${s.overall?.engaged ?? 0} of ${s.overall?.n ?? 0})</span></div></div>` : ""}</section>
    <h3 class="section">This week's review</h3>
    ${d.open.length ? `<div class="inbox">${d.open.map((o) => `<div class="inbox-item review"><span class="ic">${o.urgency >= 4 ? "!" : "↺"}</span>
        <span class="t"><b><a href="/accounts/${esc(o.account)}" data-link>${esc(o.name)}</a></b><small>${esc(o.prompt)}</small></span>
        <span class="muted">${day(o.last_touch)}</span><button class="btn" data-log="${esc(o.account)}">Answer</button></div>`).join("")}</div>`
      : empty("Nothing to review", "Accounts appear here once a draft is marked sent.")}
    ${s ? `<h3 class="section">What converts</h3>
      <div class="cols">
        <div class="col"><h4>By tier</h4>${bars(s.by_tier)}<p class="muted">${esc(s.tier_signal)}</p></div>
        <div class="col"><h4>By trigger</h4>${bars(s.by_trigger)}</div>
        <div class="col"><h4>By channel</h4>${bars(s.by_channel)}</div>
      </div>
      <p class="muted">Bars show the share that engaged, with a 95% interval: wide bars mean too few outcomes to be sure. Recalibrating the scoring needs ${esc(s.recalibration?.needed ?? "")}${s.recalibration?.ready ? ", and you have enough now: run Outcomes analysis from Runs." : "."}</p>` : ""}
    ${d.cases.length ? `<h3 class="section">Won and lost</h3><table class="grid-table"><thead><tr><th>Company</th><th>Result</th><th class="c">Tier</th><th>Reasons</th><th>Notes</th></tr></thead><tbody>${d.cases.map((c) => `<tr data-go="/accounts/${esc(c.account)}">
        <td><b>${esc(c.name ?? c.account)}</b></td><td>${esc(c.won ? "won" : c.engaged ? "engaged" : c.derived_no_response ? "no response" : c.status)}</td><td class="c">${esc(c.tier ?? "–")}</td>
        <td>${esc((c.reasons ?? []).join(", "))}</td><td class="why">${esc((c.notes ?? []).join(" · "))}</td></tr>`).join("")}</tbody></table>` : ""}
    <h3 class="section">Teach the engine</h3>
    <section class="panel"><p class="muted" style="margin:0 0 10px">A correction ("Bunzl has 13 countries, not 18") or a preference ("skip companies under 50 staff"). It is recorded as a lesson every step reads, and fixed in the account if it's about one.</p>
      <div class="form-row"><input class="grow" id="lesson" placeholder="What should the engine remember?"><button class="btn primary" id="teach">Teach</button></div></section>`;
  view.onclick = (e) => {
    const b = e.target.closest("[data-log]");
    if (b) logDialog(b.dataset.log, icp, state, () => outcomesPage(view, { state }));
    const tr = e.target.closest("tr[data-go]");
    if (tr) go(tr.dataset.go);
  };
  $("#teach").onclick = async (e) => {
    const text = $("#lesson").value.trim();
    if (!text) return;
    e.target.disabled = true;
    const j = await post("/api/runs/start", { where: "local", skill: "learn", icp, args: JSON.stringify(text), budget: 0.5, by: me() });
    e.target.disabled = false;
    if (j.error) return toast(j.error, "err");
    toast("The engine is recording the lesson; follow it under Runs");
    $("#lesson").value = "";
  };
}

function bars(groups) {
  const rows = Object.entries(groups ?? {}).filter(([, b]) => b.n);
  if (!rows.length) return `<p class="muted">No resolved outcomes yet.</p>`;
  return `<div class="bars">${rows.map(([k, b]) => `<div class="bar-row"><span class="bl">${esc(k)}</span>
    <span class="bt"><i class="ci" style="left:${(b.low ?? 0) * 100}%;width:${((b.high ?? 0) - (b.low ?? 0)) * 100}%"></i><i class="pt" style="left:${(b.rate ?? 0) * 100}%"></i></span>
    <span class="bv">${pct(b.rate)} <small>of ${b.n}</small></span></div>`).join("")}</div>`;
}
