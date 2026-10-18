// Outcomes: the weekly review (one question per open account), what converts (with honest intervals), and teaching lessons.
import { icon } from "./icons.js";
import { $, card, day, empty, esc, get, initials, me, post, stat, toast } from "./ui.js";
import { logDialog } from "./accounts.js";
import { go } from "./shell.js";

const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);

export async function outcomesPage(view, { state }) {
  const icp = state.icp;
  const d = await get(`/api/outcomes?icp=${encodeURIComponent(icp)}`);
  const s = d.stats;
  view.innerHTML = `
    <header class="ph"><div><span class="ph-eyebrow">${icon("outcomes", 14)} Work · outcomes</span><h1>Outcomes</h1>
      <p class="sub">What happened after outreach. Answer the open questions, so the engine learns which accounts really convert and can tune its scoring.</p></div></header>
    <div class="stats">
      ${stat("mail", "Contacted", s?.accounts_tracked ?? 0, `${s?.in_flight ?? 0} still in flight`)}
      ${stat("review", "Need an update", d.open.filter((o) => o.urgency >= 3).length, `${d.open.length} open in total`, d.open.some((o) => o.urgency >= 3) ? "accent" : "")}
      ${stat("outcomes", "Engaged", pct(s?.overall?.rate), `${s?.overall?.engaged ?? 0} of ${s?.overall?.n ?? 0} resolved`, "good")}
      ${stat("chart", "Ready to recalibrate", s?.recalibration?.ready ? "yes" : "not yet", `${s?.recalibration?.full_scored_resolved ?? 0} of 30 resolved`)}
    </div>
    <div class="grid2"><div>
      ${card("review", "This week's review", d.open.length ? d.open.map((o) => `<div class="todo"><span class="tile ${o.urgency >= 4 ? "drafts" : "outcomes"}">${icon(o.urgency >= 4 ? "alert" : "review", 16)}</span>
          <span><b><a href="/accounts/${esc(o.account)}" data-link style="text-decoration:none">${esc(o.name)}</a></b><small>${esc(o.prompt)} · last touch ${day(o.last_touch)}</small></span>
          <button class="btn sm" data-log="${esc(o.account)}">Answer</button></div>`).join("")
        : empty("Nothing to review", "Accounts appear here once a draft is marked sent.", "check"), { count: d.open.length || "", flush: true })}
      ${card("flag", "Won and lost", d.cases.length ? `<table class="tbl"><thead><tr><th>Company</th><th>Result</th><th class="c">Tier</th><th>Reasons</th></tr></thead><tbody>${d.cases.map((c) => `<tr data-go="/accounts/${esc(c.account)}">
          <td><span class="co"><span class="mono-av">${esc(initials(c.name ?? c.account))}</span><b>${esc(c.name ?? c.account)}</b></span></td>
          <td><span class="pill ${c.won ? "good" : c.engaged ? "accent" : ""}">${esc(c.won ? "won" : c.engaged ? "engaged" : c.derived_no_response ? "no response" : c.status)}</span></td><td class="c">${esc(c.tier ?? "–")}</td>
          <td class="why">${esc([...(c.reasons ?? []), ...(c.notes ?? [])].join(" · "))}</td></tr>`).join("")}</tbody></table>`
        : empty("No resolved outcomes yet", "Wins, losses and silences appear here.", "flag"), { flush: true })}
    </div><div>
      ${card("chart", "What converts", s ? `<h4>By tier</h4>${bars(s.by_tier)}<p class="muted" style="margin:0 0 16px">${esc(s.tier_signal)}</p><h4>By trigger</h4>${bars(s.by_trigger)}<h4 style="margin-top:16px">By channel</h4>${bars(s.by_channel)}
          <p class="muted" style="margin:12px 0 0">The mark is the share that engaged; the grey band is the 95% interval. Wide bands mean too few outcomes to be sure.</p>` : empty("No data", "Pick an ICP.", "chart"))}
      ${card("sparkles", "Teach the engine", `<p class="muted" style="margin:0 0 12px">A correction ("Bunzl has 13 countries, not 18") or a preference ("skip companies under 50 staff"). Every step reads it from now on.</p>
        <div class="lesson"><input id="lesson" placeholder="What should the engine remember?"><button class="btn primary" id="teach">Teach</button></div>`)}
    </div></div>`;
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
  if (!rows.length) return `<p class="muted" style="margin:0 0 12px">No resolved outcomes yet.</p>`;
  return `<div class="bars">${rows.map(([k, b]) => `<div class="bar-row"><span class="bl">${esc(k)}</span>
    <span class="bt"><i class="ci" style="left:${(b.low ?? 0) * 100}%;width:${((b.high ?? 0) - (b.low ?? 0)) * 100}%"></i><i class="pt" style="left:${(b.rate ?? 0) * 100}%"></i></span>
    <span class="bv">${pct(b.rate)} <small>of ${b.n}</small></span></div>`).join("")}</div>`;
}
