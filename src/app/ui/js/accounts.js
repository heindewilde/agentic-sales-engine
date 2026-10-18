// Accounts: a filterable table, and one page per account (brief, score, people, signals, drafts, outcomes + actions).
import { icon } from "./icons.js";
import { $, STAGES, STAGE_NAME, card, day, doAct, empty, esc, get, initials, mdBody, tierPill } from "./ui.js";
import { go } from "./shell.js";

export async function accountsPage(view, { query, state }) {
  const f = { icp: state.icp, stage: query.get("stage") ?? "", tier: query.get("tier") ?? "", q: query.get("q") ?? "" };
  const t = await get("/api/today");
  const stages = t.funnel[state.icp] ?? {};
  const total = Object.values(stages).reduce((a, b) => a + b, 0);
  view.innerHTML = `
    <header class="ph"><div><span class="ph-eyebrow">${icon("accounts", 14)} ${esc(state.icp)}</span><h1>Accounts</h1>
      <p class="sub">Every company the engine knows for this ICP, best fit first. Click one for its brief, score and people.</p></div>
      <div class="ph-actions"><a class="btn" href="/runs?skill=discover&icp=${encodeURIComponent(state.icp)}" data-link>${icon("search", 14)} Find more companies</a></div></header>
    <section class="card">
      <div class="toolbar"><div class="chips" id="f-stage">
        <button class="chip ${f.stage ? "" : "on"}" data-stage="">All<em>${total}</em></button>
        ${[...STAGES, "excluded"].filter((s) => stages[s]).map((s) => `<button class="chip ${s === f.stage ? "on" : ""}" data-stage="${s}">${esc(STAGE_NAME[s])}<em>${stages[s]}</em></button>`).join("")}
      </div></div>
      <div class="toolbar">
        <label class="search">${icon("search", 15)}<input id="f-q" type="search" placeholder="Search names, briefs, people…" value="${esc(f.q)}"></label>
        <div class="chips" id="f-tier">${["", "A", "B", "C", "X"].map((x) => `<button class="chip ${x === f.tier ? "on" : ""}" data-tier="${x}">${x ? `Tier ${x}` : "Any tier"}</button>`).join("")}</div>
        <span class="muted" id="count" style="margin-left:auto"></span>
      </div>
      <div id="table"></div>
    </section>`;
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    const shown = new URLSearchParams(Object.entries(f).filter(([k, v]) => v && k !== "icp"));
    history.replaceState(null, "", `/accounts${shown.size ? `?${shown}` : ""}`);
    const { rows } = await get(`/api/accounts?${qs}`);
    $("#count").textContent = `${rows.length} account${rows.length === 1 ? "" : "s"}`;
    $("#table").innerHTML = rows.length ? `<table class="tbl"><thead><tr><th>Company</th><th>Stage</th><th class="c">Tier</th><th class="r">Score</th><th>Country</th><th>Updated</th></tr></thead><tbody>
      ${rows.map((r) => {
        const sc = r.score ?? r.light_score;
        return `<tr data-go="/accounts/${esc(r.domain)}"><td><span class="co"><span class="mono-av">${esc(initials(r.name ?? r.domain))}</span><span><b>${esc(r.name ?? r.domain)}</b><small>${esc(r.domain)}${r.industry ? ` · ${esc(r.industry)}` : ""}</small></span></span></td>
          <td><span class="stage s-${esc(r.stage)}">${esc(STAGE_NAME[r.stage] ?? r.stage)}</span></td><td class="c">${tierPill(r.tier)}</td>
          <td class="r">${sc != null ? `<span class="scorebar" title="${r.score != null ? "full score" : "light score"}"><span><i style="width:${sc}%;${r.score == null ? "background:var(--c3)" : ""}"></i></span><b class="num">${Math.round(sc)}</b></span>` : "–"}</td>
          <td>${esc(r.hq_country ?? "")}</td><td class="muted">${day(r.updated)}</td></tr>`;
      }).join("")}</tbody></table>`
      : empty("No accounts match", "Change the filters, or find more companies.", "search");
  };
  let tm;
  $("#f-q").addEventListener("input", (e) => { f.q = e.target.value; clearTimeout(tm); tm = setTimeout(load, 220); });
  $("#f-stage").addEventListener("click", (e) => { const b = e.target.closest("[data-stage]"); if (!b) return; f.stage = b.dataset.stage; view.querySelectorAll("#f-stage .chip").forEach((c) => c.classList.toggle("on", c === b)); load(); });
  $("#f-tier").addEventListener("click", (e) => { const b = e.target.closest("[data-tier]"); if (!b) return; f.tier = b.dataset.tier; view.querySelectorAll("#f-tier .chip").forEach((c) => c.classList.toggle("on", c === b)); load(); });
  view.addEventListener("click", (e) => { const tr = e.target.closest("tr[data-go]"); if (tr) go(tr.dataset.go); });
  await load();
}

const TABS = [["brief", "Brief", "file"], ["score", "Score", "chart"], ["people", "People", "users"], ["signals", "Signals", "zap"], ["drafts", "Drafts", "draft"], ["outcomes", "Outcomes", "outcomes"]];
/** What a person would do next with an account at this stage. */
const NEXT = {
  discovered: ["Quick scan", "A quick scan reads the homepage and gives a light score.", "enrich-light"],
  light_scored: ["Shortlist", "Light-scored; the shortlist decides whether it gets deep research.", "shortlist"],
  shortlisted: ["Deep research", "Approved for research: site, news, people, then a full score.", "research"],
  researched: ["Full score", "Researched; the full score comes next.", "score"],
  scored: ["Review the score", "Scored in full. Confirm it to move on to ways in.", null],
  outreach_ready: ["Write and send", "Has a way in. Edit the draft and send it yourself.", null],
  excluded: ["Excluded", "Out of scope for this ICP.", null],
};

export async function accountPage(view, { args, query, state }) {
  const domain = decodeURIComponent(args[0]);
  const a = await get(`/api/account?domain=${encodeURIComponent(domain)}`);
  const icp = state.icp && a.company.icp_status?.[icp0(a, state)] ? icp0(a, state) : Object.keys(a.company.icp_status ?? {})[0];
  const st = a.company.icp_status?.[icp] ?? {};
  const tab = query.get("tab") ?? "brief";
  const name = a.company.name ?? domain;
  const score = a.scores[icp];
  const val = st.score ?? st.light_score;
  const facts = a.company.facts ?? {};
  const [nextTitle, nextText, nextSkill] = NEXT[st.stage] ?? ["", "", null];
  view.innerHTML = `
    <a class="back" href="/accounts" data-link>${icon("back", 14)} Accounts</a>
    <header class="ph"><div class="acc-head"><span class="acc-av">${esc(initials(name))}</span><div>
        <h1 style="margin:0">${esc(name)}</h1>
        <div class="acc-meta"><a href="https://${esc(domain)}" target="_blank" rel="noopener"><span>${icon("globe", 13)}${esc(domain)}</span></a>
          ${facts.industry ? `<span>${icon("accounts", 13)}${esc(facts.industry.value)}</span>` : ""}
          ${facts.hq_country ? `<span>${icon("flag", 13)}${esc(facts.hq_country.value)}</span>` : ""}
          ${facts.employees ? `<span>${icon("users", 13)}${esc(String(facts.employees.value))} people</span>` : ""}
          ${a.blocked ? `<span class="pill bad">${icon("ban", 12)} do not contact</span>` : ""}${a.watched ? `<span class="pill">${icon("eye", 12)} watched</span>` : ""}</div></div></div>
      <div class="ph-actions">${ring(val, st.score != null)}<div><div>${tierPill(st.tier)} <span class="stage s-${esc(st.stage)}">${esc(STAGE_NAME[st.stage] ?? st.stage ?? "")}</span></div>
        <div class="muted" style="margin-top:6px">${st.score != null ? "full score" : "light score"}${score?.timing ? ` · timing ${esc(score.timing)}` : ""}${st.reviewed_by ? ` · reviewed by ${esc(st.reviewed_by)}` : ""}</div></div></div></header>
    <div class="grid2"><div><section class="card">
      <div class="tabs">${TABS.map(([t, l, ic]) => `<a href="/accounts/${esc(domain)}?tab=${t}" data-link class="${t === tab ? "on" : ""}">${icon(ic, 14)}${l}${count(a, t) ? `<span class="c">${count(a, t)}</span>` : ""}</a>`).join("")}</div>
      <div class="card-b" id="tb"></div></section></div>
    <div>
      ${nextTitle ? card("arrow", "Next step", `<p style="margin:0 0 12px"><b>${esc(nextTitle)}</b><br><span class="muted" style="font-size:13px">${esc(nextText)}</span></p>${nextSkill ? `<a class="btn primary sm" href="/runs?skill=${nextSkill}&icp=${encodeURIComponent(icp)}&domains=${encodeURIComponent(domain)}" data-link>${icon("play", 12)} Run ${esc(nextTitle.toLowerCase())}</a>` : st.stage === "scored" ? `<a class="btn primary sm" href="/today/scores/${encodeURIComponent(icp)}" data-link>${icon("gate", 12)} Review scores</a>` : st.stage === "outreach_ready" && a.drafts.length ? `<a class="btn primary sm" href="/today/drafts?path=${encodeURIComponent(a.drafts[0].path)}" data-link>${icon("draft", 12)} Open the draft</a>` : ""}`) : ""}
      ${card("zap", "Actions", `<div class="actions">
        <button class="btn" data-a="log">${icon("outcomes", 14)} Log an outcome</button>
        <button class="btn" data-a="watch">${icon("eye", 14)} ${a.watched ? "Stop watching" : "Watch for news"}</button>
        ${st.stage && st.stage !== "excluded" ? `<button class="btn ghost" data-a="exclude">${icon("x", 14)} Exclude</button>` : ""}
        ${a.blocked ? "" : `<button class="btn ghost danger" data-a="block">${icon("ban", 14)} Never contact</button>`}</div>`)}
      ${score ? card("chart", "Score by group", groups(score)) : ""}
      ${Object.keys(facts).length ? card("file", "Key facts", `<div class="facts-list">${Object.entries(facts).slice(0, 10).map(([k, v]) => `<div><span>${esc(k.replace(/_/g, " "))}</span><span>${esc(String(v.value))}</span></div>`).join("")}</div>`) : ""}
    </div></div>
    <div id="dlg"></div>`;
  $("#tb").innerHTML = ({ brief, score: scoreTab, people, signals, drafts, outcomes })[tab]?.(a, icp) ?? "";
  view.querySelector(".actions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const reload = () => accountPage(view, { args, query, state });
    if (b.dataset.a === "watch") doAct(b, "account/watch", { domain, icp, on: !a.watched }, a.watched ? "No longer watched" : "Watched: news will show up in the next refresh", reload);
    if (b.dataset.a === "exclude") dialog(`Exclude ${name}?`, `<label>Why<input id="d-reason" placeholder="e.g. too small, competitor, wrong market"></label>`, "Exclude", (btn) => doAct(btn, "account/stage", { domain, icp, to: "excluded", reason: $("#d-reason").value || "excluded by hand" }, "Excluded", reload));
    if (b.dataset.a === "block") dialog(`Never contact ${name}?`, `<p>Adds ${esc(domain)} to the do-not-contact list: it is skipped everywhere and never researched again.</p><label>Reason<select id="d-r"><option value="opted_out">They opted out</option><option value="customer">Existing customer</option><option value="competitor">Competitor</option><option value="partner">Partner</option><option value="legal">Legal</option><option value="other">Other</option></select></label>`, "Add to do-not-contact", (btn) => doAct(btn, "account/block", { domain, reason: $("#d-r").value }, "Added to do-not-contact", reload), true);
    if (b.dataset.a === "log") logDialog(domain, icp, state, reload);
  });
}
const icp0 = (a, state) => state.icp;

function ring(v, full) {
  if (v == null) return "";
  const r = 27, c = 2 * Math.PI * r;
  return `<span class="ring" title="${full ? "full" : "light"} score"><svg width="64" height="64"><circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--soft-2)" stroke-width="6"/><circle cx="32" cy="32" r="${r}" fill="none" stroke="${full ? "var(--ink)" : "var(--c4)"}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(c * v) / 100} ${c}"/></svg><b>${Math.round(v)}</b></span>`;
}

/** Per group (fit, intent, access): share of the best possible level reached, from the judged factors. */
function groups(s) {
  const gs = [...new Set(s.factors.map((f) => f.group ?? "other"))];
  return `<div class="bars">${gs.map((g) => {
    const fs = s.factors.filter((f) => (f.group ?? "other") === g);
    const known = fs.filter((f) => f.level != null);
    const w = (f) => f.weight ?? 1;
    const got = known.reduce((a, f) => a + w(f) * f.level, 0), max = fs.reduce((a, f) => a + w(f) * 3, 0) || 1;
    return `<div class="bar-row"><span class="bl">${esc(g)}</span><span class="bt"><i class="ci" style="left:0;width:${(100 * known.reduce((a, f) => a + w(f) * 3, 0)) / max}%"></i><i class="pt" style="left:${(100 * got) / max}%"></i></span><span class="bv">${Math.round((100 * got) / max)}% <small>${known.length}/${fs.length}</small></span></div>`;
  }).join("")}</div><p class="muted" style="margin:6px 0 0">The mark is the score reached; the grey band shows how much is known.</p>`;
}

const count = (a, t) => ({ people: a.people.length, signals: a.signals.length, drafts: a.drafts.length, outcomes: a.outcomes.length })[t] ?? 0;

function brief(a) {
  if (!a.brief) return empty("No brief yet", "It is written by the quick scan and filled in by research.", "file");
  return `<div class="prose brief">${mdBody(a.brief)}</div>`;
}

function scoreTab(a, icp) {
  const s = a.scores[icp];
  if (!s) return empty("Not scored yet", `No score for ${icp} yet.`, "chart");
  const gs = [...new Set(s.factors.map((f) => f.group ?? "other"))];
  return `<p class="muted" style="margin:0 0 6px">${s.mode === "full" ? "Full" : "Light"} score ${Math.round(s.total)} of 100 · up to ${Math.round(s.upside)} if every unknown turned out best · ${Math.round(s.coverage * 100)}% of the evidence known · scored ${day(s.scored_at)}</p>
    ${s.knocked_out?.length ? `<div class="note warn">${icon("alert", 15)}Knocked out by ${esc(s.knocked_out.join(", "))}</div>` : ""}
    ${gs.map((g) => `<h4 style="margin-top:20px">${esc(g)}</h4>${s.factors.filter((f) => (f.group ?? "other") === g).map((f) => `<div class="factor-row">
      <div class="lvl l${f.level ?? "n"}">${f.level ?? "?"}</div>
      <div><b>${esc(f.name)}</b>${f.weight ? `<span class="muted"> · weight ${esc(String(f.weight))}</span>` : ""}
        <p>${f.level == null ? `<span class="muted">Unknown: no evidence yet${f.question ? ` (${esc(f.question)})` : ""}</span>` : esc(f.level_text ?? "")}</p>
        ${(f.evidence ?? []).slice(0, 2).map((e) => `<blockquote>“${esc(e.quote)}”${e.source_url ? ` <a href="${esc(e.source_url)}" target="_blank" rel="noopener">source ↗</a>` : ""}</blockquote>`).join("")}
        ${f.rationale ? `<p class="muted">${esc(f.rationale)}</p>` : ""}</div></div>`).join("")}`).join("")}`;
}

function people(a) {
  if (!a.people.length) return empty("No people yet", "Research looks for one person per buyer persona.", "users");
  const warm = new Map(a.warm.map((w) => [w.person_id, w]));
  return `<div class="list">${a.people.map((p) => `<div class="item"><span class="co"><span class="mono-av">${esc(initials(p.name))}</span><span class="t">${esc(p.name)}<small>${esc(p.title ?? "")}${p.persona ? ` · ${esc(p.persona)}` : ""}</small></span></span>
    <span>${warm.get(p.id) ? `<span class="pill good">${icon("users", 12)} ${esc(warm.get(p.id).member)} knows them</span>` : ""} ${p.linkedin_url ? `<a class="btn sm ghost" href="${esc(p.linkedin_url)}" target="_blank" rel="noopener">LinkedIn ${icon("external", 12)}</a>` : ""}</span></div>`).join("")}</div>`;
}

function signals(a) {
  if (!a.signals.length) return empty("No signals yet", "Trigger events found by research and the news check land here.", "zap");
  return `<div class="timeline">${a.signals.map((s) => `<div class="ev"><span class="d">${day(s.date)}</span><span><b>${esc(s.title)}</b><small>${esc(s.type)} · ${esc(s.status)}${s.source_url ? ` · <a href="${esc(s.source_url)}" target="_blank" rel="noopener">source ↗</a>` : ""}</small></span></div>`).join("")}</div>`;
}

function drafts(a) {
  if (!a.drafts.length) return empty("No drafts yet", "They are written once the account has a way in.", "draft");
  return `<div class="list">${a.drafts.map((d) => `<a class="item" href="/today/drafts?path=${encodeURIComponent(d.path)}" data-link><span class="t">${esc(d.channel.replace(/_/g, " "))}<small>${day(d.created)}</small></span><span class="stage">${esc(d.status)}</span></a>`).join("")}</div>`;
}

function outcomes(a) {
  if (!a.outcomes.length) return empty("Nothing logged yet", "Replies, meetings and results appear here.", "outcomes");
  return `<div class="timeline">${a.outcomes.map((e) => `<div class="ev"><span class="d">${day(e.date)}</span><span><b>${esc(e.type.replace(/_/g, " "))}</b><small>${[e.member, e.channel, e.reason, e.note].filter(Boolean).map(esc).join(" · ")}</small></span></div>`).join("")}</div>`;
}

export function dialog(title, body, okLabel, onOk, danger = false) {
  const host = document.getElementById("dlg") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "dlg" }));
  host.innerHTML = `<div class="dialog-bg"><form class="dialog"><h3>${esc(title)}</h3>${body}<div class="dialog-actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn ${danger ? "danger" : "primary"}">${esc(okLabel)}</button></div></form></div>`;
  const close = () => (host.innerHTML = "");
  host.querySelector("[data-cancel]").onclick = close;
  host.querySelector(".dialog-bg").onclick = (e) => { if (e.target.classList.contains("dialog-bg")) close(); };
  host.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    await onOk(e.submitter);
    close();
  };
  host.querySelector("input, select, textarea")?.focus();
}

export function logDialog(domain, icp, state, after) {
  const types = (state.meta?.event_types ?? []).filter((t) => t !== "sent");
  const reasons = state.meta?.reasons ?? [];
  dialog(`What happened with ${domain}?`, `
    <label>Event<select id="d-type">${types.map((t) => `<option value="${t}">${t.replace(/_/g, " ")}</option>`).join("")}</select></label>
    <label>Reason <span class="muted">(for negative replies, losses and disqualifications)</span><select id="d-reason"><option value="">–</option>${reasons.map((r) => `<option value="${r}">${r.replace(/_/g, " ")}</option>`).join("")}</select></label>
    <label>Note<textarea id="d-note" rows="3" placeholder="What did they say?"></textarea></label>`, "Log it",
  (btn) => doAct(btn, "outcome/log", { domain, icp, type: $("#d-type").value, reason: $("#d-reason").value || undefined, note: $("#d-note").value || undefined }, "Logged", after));
}
