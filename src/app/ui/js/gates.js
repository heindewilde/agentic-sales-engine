// The gates: approve an ICP, approve a shortlist, review full scores, and edit/send drafts.
import { icon } from "./icons.js";
import { $, $$, card, day, doAct, empty, esc, get, initials, md, me, mdBody, tierPill } from "./ui.js";
import { go } from "./shell.js";

const CHANNEL = { email: ["Email", "mail"], linkedin_connect: ["LinkedIn connection note", "users"], linkedin_dm: ["LinkedIn message", "users"], intro_request: ["Intro request", "user"] };
const channel = (c) => CHANNEL[c]?.[0] ?? String(c ?? "").replace(/_/g, " ");
const chIcon = (c) => CHANNEL[c]?.[1] ?? "mail";

const back = `<a class="back" href="/today" data-link>${icon("back", 14)} Today</a>`;
const who = () => me() || "a team member";
const gateHead = (n, title, sub, decide) => `<header class="ph"><div><span class="ph-eyebrow gate">${icon("gate", 12)} Gate ${n} · your decision</span><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p></div>${decide}</header>`;

export async function icpGate(view, { args }) {
  const icp = decodeURIComponent(args[0]);
  const d = await get(`/api/icp?icp=${encodeURIComponent(icp)}`);
  view.innerHTML = `${back}
    ${gateHead(1, "Approve the ICP", "This defines who the engine looks for. Read it through; once approved, finding and scoring companies can start.",
      `<div class="decide">${d.status === "approved" ? `<span class="done">${icon("check", 15)} Approved by ${esc(d.approved_by)} on ${esc(d.approved_at)}</span>` : `<button class="btn primary" id="ok">${icon("check", 14)} Approve as ${esc(who())}</button>`}</div>`)}
    ${card("file", d.name ?? icp, `<div class="prose">${md(d.text)}</div>`)}`;
  $("#ok")?.addEventListener("click", (e) => doAct(e.target, "icp/approve", { icp }, "ICP approved", () => go("/today")));
}

export async function shortlistGate(view, { args }) {
  const icp = decodeURIComponent(args[0]);
  const { pending } = await get(`/api/shortlist?icp=${encodeURIComponent(icp)}`);
  if (!pending) { view.innerHTML = `${back}${empty("No shortlist waiting", "A new proposal appears here after the quick scan.", "check")}`; return; }
  const cost = pending.data.cost ?? {};
  const per = cost.per_account_p50 ?? (cost.total_p50 && pending.accounts ? cost.total_p50 / pending.accounts : null);
  view.innerHTML = `${back}
    ${gateHead(2, "Which companies get deep research?", "The engine proposes the best fits from the quick scan. Untick any you don't want; research reads their sites, news and people, and scores them in full.",
      `<div class="decide"><div class="dv"><b id="n">0</b><span>accounts</span></div><span class="sep"></span><div class="dv"><b id="cost">–</b><span>estimated cost</span></div><button class="btn primary" id="ok">${icon("check", 14)} Approve</button></div>`)}
    ${card("accounts", "Proposed for research", `<table class="tbl"><thead><tr><th class="c"><input type="checkbox" id="all"></th><th>Company</th><th class="r">Light fit</th><th class="r">Upside</th><th class="r">Known</th><th>Why</th><th>Check</th></tr></thead><tbody>
      ${pending.rows.map((r) => `<tr><td class="c"><input type="checkbox" value="${esc(r.domain)}" ${r.ticked ? "checked" : ""}></td>
        <td><span class="co"><span class="mono-av">${esc(initials(r.name))}</span><span><b>${esc(r.name)}</b><small><a href="/accounts/${esc(r.domain)}" data-link>${esc(r.domain)}</a></small></span></span></td>
        <td class="r num">${esc(r.light)}</td><td class="r num">${esc(r.upside)}</td><td class="r num">${esc(r.coverage)}</td><td class="why">${esc(r.why)}</td><td class="muted">${esc(r.needs_check)}</td></tr>`).join("")}</tbody></table>`, { count: pending.rows.length, flush: true })}
    <p class="muted foot">${icon("file", 13)} ${esc(pending.file)}</p>`;
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
  const open = rows.filter((r) => !r.reviewed_by);
  view.innerHTML = `${back}
    ${gateHead(3, "Do these scores look right?", "Researched and scored in full. Confirm the companies worth approaching; the engine then finds ways in and drafts outreach for them. Open one to see how each factor was judged.",
      `<div class="decide"><div class="dv"><b id="n">0</b><span>to confirm</span></div><button class="btn primary" id="ok">${icon("check", 14)} Confirm</button></div>`)}
    ${rows.length ? card("chart", "Full scores", `<table class="tbl"><thead><tr><th class="c"></th><th>Company</th><th class="c">Tier</th><th class="r">Score</th><th>Timing</th><th>Still unknown</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.reviewed_by ? "done-row" : ""}"><td class="c">${r.reviewed_by ? `<span title="reviewed by ${esc(r.reviewed_by)}" style="color:var(--good)">${icon("check", 15)}</span>` : `<input type="checkbox" value="${esc(r.domain)}" ${r.tier === "A" || r.tier === "B" ? "checked" : ""}>`}</td>
        <td><span class="co"><span class="mono-av">${esc(initials(r.name))}</span><span><b>${esc(r.name)}</b><small>${esc(r.domain)}</small></span></span></td><td class="c">${tierPill(r.tier)}</td>
        <td class="r"><span class="scorebar"><span><i style="width:${r.total}%"></i></span><b class="num">${Math.round(r.total)}</b></span><small class="muted">up to ${Math.round(r.upside)}</small></td>
        <td>${r.timing ? `<span class="pill ${r.timing === "now" ? "accent" : ""}">${esc(r.timing)}</span>` : ""}</td><td class="muted">${esc((r.needs_check ?? []).join(", "))}</td>
        <td class="r"><a class="btn sm ghost" href="/accounts/${esc(r.domain)}?tab=score" data-link>How ${icon("arrow", 12)}</a></td></tr>`).join("")}</tbody></table>`, { count: `${open.length} open · ${rows.length - open.length} confirmed`, flush: true })
      : empty("Nothing scored yet", "Full scores appear here after research.", "chart")}`;
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
    <header class="ph"><div><span class="ph-eyebrow">${icon("draft", 13)} Draft review</span><h1>Drafts to edit and send</h1>
      <p class="sub">The engine never sends anything. Edit a draft, send it yourself, then mark it sent: that starts outcome tracking, and your edits teach the engine your voice.</p></div></header>
    ${rows.length || path ? `<div class="split"><aside>${card("mail", "Waiting", `<div class="list">${rows.map((r) => `<a class="item ${r.path === path ? "on" : ""}" href="/today/drafts?path=${encodeURIComponent(r.path)}" data-link>
        <span class="co"><span class="mono-av">${icon(chIcon(r.channel), 14)}</span><span class="t">${esc(r.account)}<small>${esc(r.person_name ?? "")}</small></span></span><span class="pill ${r.status === "edited" ? "accent" : ""}">${esc(r.status)}</span></a>`).join("")}</div>`, { count: rows.length })}</aside>
      <section id="editor"></section></div>` : empty("No drafts waiting", "Drafts appear here once accounts have a way in.", "draft")}`;
  if (path) await editor($("#editor"), path);
}

async function editor(el, path) {
  const d = await get(`/api/draft?path=${encodeURIComponent(path)}`);
  const limit = d.data.channel === "linkedin_connect" ? 300 : d.data.channel === "email" ? 100 : null;
  const unit = d.data.channel === "linkedin_connect" ? "characters" : "words";
  el.innerHTML = `<section class="card"><div class="card-b">
      <div class="ed-head"><span class="ph-eyebrow">${icon(chIcon(d.data.channel), 13)} ${esc(channel(d.data.channel))}</span>
        <h2>${esc(d.person?.name ?? d.data.person ?? "")}</h2>
        <p class="muted" style="margin:0">${d.person?.title ? `${esc(d.person.title)} · ` : ""}<a href="/accounts/${esc(d.data.account)}" data-link>${esc(d.data.account)}</a> · ${day(d.data.created)}</p>
        ${d.data.way_in ? `<p style="margin:10px 0 0;font-size:13px"><span class="pill">${icon("zap", 12)} ${esc(d.data.way_in)}</span></p>` : ""}</div>
      <textarea id="body" spellcheck="true" style="margin-top:16px">${esc(d.body.trim())}</textarea>
      <div class="ed-bar"><span class="meter" id="len"><span><i></i></span><em></em></span><span class="grow"></span>
        <button class="btn ghost" id="discard">${icon("x", 14)} Discard</button><button class="btn" id="save">Save</button><button class="btn primary" id="sent">${icon("check", 14)} Mark sent</button></div></div></section>
    ${d.ways_in ? card("zap", "Ways in, from the brief", `<div class="prose">${mdBody(d.ways_in)}</div>`) : ""}`;
  const ta = $("#body", el);
  const len = () => {
    const text = ta.value.replace(/\[\^[^\]]+\]:.*$/gm, "").replace(/\[\^[^\]]+\]/g, "").trim();
    const n = unit === "characters" ? text.length : text.split(/\s+/).filter(Boolean).length;
    const m = $("#len", el);
    m.classList.toggle("over", Boolean(limit && n > limit));
    m.querySelector("i").style.width = `${limit ? Math.min(100, (100 * n) / limit) : 0}%`;
    m.querySelector("em").textContent = limit ? `${n} / ${limit} ${unit}${n > limit ? " · too long" : ""}` : `${n} ${unit}`;
  };
  ta.addEventListener("input", len);
  len();
  $("#save", el).onclick = (e) => doAct(e.target, "draft/save", { path, body: ta.value }, "Saved");
  $("#sent", el).onclick = async (e) => {
    if (ta.value.trim() !== d.body.trim()) await doAct(null, "draft/save", { path, body: ta.value }, "Saved");
    await doAct(e.target, "draft/mark", { path, status: "sent" }, "Marked sent: outcome tracking started", () => go("/today/drafts"));
  };
  $("#discard", el).onclick = (e) => doAct(e.target, "draft/mark", { path, status: "discarded" }, "Discarded", () => go("/today/drafts"));
}
