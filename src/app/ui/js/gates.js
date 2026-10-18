// The gates: approve an ICP, approve a shortlist, review full scores, and edit/send drafts.
import { $, $$, day, doAct, empty, esc, get, md, me, mdBody, tierPill } from "./ui.js";
import { go } from "./shell.js";

const CHANNEL = { email: "Email", linkedin_connect: "LinkedIn connection note", linkedin_dm: "LinkedIn message", intro_request: "Intro request" };
const channel = (c) => CHANNEL[c] ?? String(c ?? "").replace(/_/g, " ");

const back = `<a class="back" href="/today" data-link>← Today</a>`;
const who = () => me() || "a team member";

export async function icpGate(view, { args }) {
  const icp = decodeURIComponent(args[0]);
  const d = await get(`/api/icp?icp=${encodeURIComponent(icp)}`);
  view.innerHTML = `${back}
    <section class="intro"><div><span class="eyebrow">◆ Gate 1 · your decision</span><h1>Approve the ICP</h1>
      <p>This defines who the engine looks for. Read it through; once approved, finding and scoring companies can start.</p></div>
      <div class="decide">${d.status === "approved" ? `<span class="done">Approved by ${esc(d.approved_by)} on ${esc(d.approved_at)}</span>` : `<button class="btn primary" id="ok">Approve as ${esc(who())}</button>`}</div></section>
    <div class="prose card-pad">${md(d.text)}</div>`;
  $("#ok")?.addEventListener("click", (e) => doAct(e.target, "icp/approve", { icp }, "ICP approved", () => go("/today")));
}

export async function shortlistGate(view, { args }) {
  const icp = decodeURIComponent(args[0]);
  const { pending } = await get(`/api/shortlist?icp=${encodeURIComponent(icp)}`);
  if (!pending) { view.innerHTML = `${back}${empty("No shortlist waiting", "A new proposal appears here after the quick scan.")}`; return; }
  const cost = pending.data.cost ?? {};
  const per = cost.per_account_p50 ?? (cost.total_p50 && pending.accounts ? cost.total_p50 / pending.accounts : null);
  view.innerHTML = `${back}
    <section class="intro"><div><span class="eyebrow">◆ Gate 2 · your decision</span><h1>Which companies get deep research?</h1>
      <p>The engine proposes the best fits from the quick scan. Untick any you don't want; research reads their sites, news and people, and scores them in full.</p></div>
      <div class="decide"><div class="kpi"><b id="n">0</b><span>accounts</span></div><div class="kpi"><b id="cost">–</b><span>estimated cost</span></div>
      <button class="btn primary" id="ok">Approve</button></div></section>
    <table class="grid-table pick"><thead><tr><th class="c"><input type="checkbox" id="all"></th><th>Company</th><th class="r">Light fit</th><th class="r">Upside</th><th class="r">Known</th><th>Why</th><th>Check</th></tr></thead><tbody>
      ${pending.rows.map((r) => `<tr><td class="c"><input type="checkbox" value="${esc(r.domain)}" ${r.ticked ? "checked" : ""}></td>
        <td><b>${esc(r.name)}</b><small><a href="/accounts/${esc(r.domain)}" data-link>${esc(r.domain)}</a></small></td>
        <td class="r num">${esc(r.light)}</td><td class="r num">${esc(r.upside)}</td><td class="r num">${esc(r.coverage)}</td><td class="why">${esc(r.why)}</td><td class="muted">${esc(r.needs_check)}</td></tr>`).join("")}</tbody></table>
    <p class="muted foot">Proposal ${esc(pending.file)}</p>`;
  const picked = () => $$("tbody input:checked", view).map((i) => i.value);
  const sync = () => {
    $("#n").textContent = picked().length;
    $("#cost").textContent = per != null ? `$${(per * picked().length).toFixed(2)}` : "–";
  };
  view.addEventListener("change", (e) => {
    if (e.target.id === "all") $$("tbody input", view).forEach((i) => (i.checked = e.target.checked));
    sync();
  });
  sync();
  $("#ok").addEventListener("click", (e) => {
    if (!picked().length) return;
    doAct(e.target, "shortlist/approve", { icp, file: pending.file, domains: picked() }, (r) => `${r.approved.length} accounts approved for research`, () => go(`/runs?skill=research&icp=${encodeURIComponent(icp)}`));
  });
}

export async function scoresGate(view, { args }) {
  const icp = decodeURIComponent(args[0]);
  const { rows } = await get(`/api/scores?icp=${encodeURIComponent(icp)}`);
  view.innerHTML = `${back}
    <section class="intro"><div><span class="eyebrow">◆ Gate 3 · your decision</span><h1>Do these scores look right?</h1>
      <p>Researched and scored in full. Confirm the companies worth approaching; the engine then finds ways in and drafts outreach for them. Open one to see how each factor was judged.</p></div>
      <div class="decide"><div class="kpi"><b id="n">0</b><span>confirmed</span></div><button class="btn primary" id="ok">Confirm</button></div></section>
    ${rows.length ? `<table class="grid-table pick"><thead><tr><th class="c"></th><th>Company</th><th class="c">Tier</th><th class="r">Score</th><th>Timing</th><th>Check</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.reviewed_by ? "done-row" : ""}"><td class="c">${r.reviewed_by ? `<span title="reviewed by ${esc(r.reviewed_by)}">✓</span>` : `<input type="checkbox" value="${esc(r.domain)}" ${r.tier === "A" || r.tier === "B" ? "checked" : ""}>`}</td>
        <td><b>${esc(r.name)}</b><small>${esc(r.domain)}</small></td><td class="c">${tierPill(r.tier)}</td><td class="r num">${Math.round(r.total)}<small class="muted"> / ${Math.round(r.upside)}</small></td>
        <td>${esc(r.timing ?? "")}</td><td class="muted">${esc((r.needs_check ?? []).join(", "))}</td><td><a href="/accounts/${esc(r.domain)}?tab=score" data-link>how →</a></td></tr>`).join("")}</tbody></table>`
      : empty("Nothing scored yet", "Full scores appear here after research.")}`;
  const picked = () => $$("tbody input:checked", view).map((i) => i.value);
  const sync = () => ($("#n").textContent = picked().length);
  view.addEventListener("change", sync);
  sync();
  $("#ok").addEventListener("click", (e) => {
    if (!picked().length) return;
    doAct(e.target, "scores/review", { icp, domains: picked() }, (r) => `${r.reviewed.length} confirmed`, (r) => go(`/runs?skill=ways-in&icp=${encodeURIComponent(icp)}&domains=${r.reviewed.join(",")}`));
  });
}

export async function draftsPage(view, { query }) {
  const { rows } = await get("/api/drafts");
  const path = query.get("path") ?? rows[0]?.path;
  view.innerHTML = `${back}
    <section class="intro"><div><span class="eyebrow">✎ Draft review</span><h1>Drafts to edit and send</h1>
      <p>The engine never sends anything. Edit a draft here, send it yourself, then mark it sent: that starts outcome tracking, and your edits teach the engine your voice.</p></div></section>
    ${rows.length || path ? `<div class="split"><aside class="list">${rows.map((r) => `<a class="item ${r.path === path ? "on" : ""}" href="/today/drafts?path=${encodeURIComponent(r.path)}" data-link>
        <span class="t">${esc(r.account)}<small>${esc(channel(r.channel))} · ${esc(r.person_name ?? "")}</small></span><span class="stage">${esc(r.status)}</span></a>`).join("")}</aside>
      <section id="editor"></section></div>` : empty("No drafts waiting", "Drafts appear here once accounts have a way in.")}`;
  if (path) await editor($("#editor"), path, view);
}

async function editor(el, path, view) {
  const d = await get(`/api/draft?path=${encodeURIComponent(path)}`);
  const limit = d.data.channel === "linkedin_connect" ? 300 : null;
  el.innerHTML = `<div class="ed-head"><div><h2>${esc(channel(d.data.channel))} to ${esc(d.person?.name ?? d.data.person ?? "")}</h2>
      ${d.person?.title ? `<p class="muted" style="margin:0 0 2px">${esc(d.person.title)}</p>` : ""}
      <p class="muted"><a href="/accounts/${esc(d.data.account)}" data-link>${esc(d.data.account)}</a> · ${esc(d.data.way_in ?? "")} · ${day(d.data.created)} · ${esc(d.data.status)}</p></div></div>
    <textarea id="body" spellcheck="true">${esc(d.body.trim())}</textarea>
    <div class="ed-bar"><span class="muted" id="len"></span><span class="grow"></span>
      <button class="btn ghost" id="discard">Discard</button><button class="btn" id="save">Save</button><button class="btn primary" id="sent">Mark sent</button></div>
    ${d.ways_in ? `<details class="ways" open><summary>Ways in, from the brief</summary><div class="prose">${mdBody(d.ways_in)}</div></details>` : ""}`;
  const ta = $("#body", el);
  const len = () => {
    const text = ta.value.replace(/\[\^[^\]]+\]:.*$/gm, "").replace(/\[\^[^\]]+\]/g, "").trim();
    $("#len", el).textContent = limit ? `${text.length} / ${limit} characters${text.length > limit ? " — too long for a connection note" : ""}` : `${text.split(/\s+/).filter(Boolean).length} words`;
  };
  ta.addEventListener("input", len);
  len();
  const reload = () => draftsPage(view, { query: new URLSearchParams({ path }) });
  $("#save", el).onclick = (e) => doAct(e.target, "draft/save", { path, body: ta.value }, "Saved");
  $("#sent", el).onclick = async (e) => {
    if (ta.value.trim() !== d.body.trim()) await doAct(null, "draft/save", { path, body: ta.value }, "Saved");
    await doAct(e.target, "draft/mark", { path, status: "sent" }, "Marked sent: outcome tracking started", () => go("/today/drafts"));
  };
  $("#discard", el).onclick = (e) => doAct(e.target, "draft/mark", { path, status: "discarded" }, "Discarded", () => go("/today/drafts"));
  void reload;
}
