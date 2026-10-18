// Accounts: a filterable table, and one page per account (brief, score, people, signals, drafts, outcomes + actions).
import { $, STAGES, STAGE_NAME, day, doAct, empty, esc, get, mdBody, tierPill } from "./ui.js";
import { go } from "./shell.js";

export async function accountsPage(view, { query, state }) {
  const f = { icp: state.icp, stage: query.get("stage") ?? "", tier: query.get("tier") ?? "", q: query.get("q") ?? "" };
  view.innerHTML = `
    <section class="intro"><div><h1>Accounts</h1><p>Every company the engine knows for ${esc(state.icp || "your ICPs")}, best fit first.</p></div></section>
    <div class="filters">
      <input id="f-q" type="search" placeholder="Search names, briefs, people…" value="${esc(f.q)}">
      <select id="f-stage"><option value="">All stages</option>${[...STAGES, "excluded"].map((s) => `<option value="${s}" ${s === f.stage ? "selected" : ""}>${STAGE_NAME[s]}</option>`).join("")}</select>
      <select id="f-tier"><option value="">All tiers</option>${["A", "B", "C", "X"].map((t) => `<option ${t === f.tier ? "selected" : ""}>${t}</option>`).join("")}</select>
      <span class="muted" id="count"></span>
    </div>
    <div id="table"></div>`;
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    history.replaceState(null, "", `/accounts${qs.size ? `?${new URLSearchParams(Object.entries(f).filter(([k, v]) => v && k !== "icp"))}` : ""}`);
    const { rows } = await get(`/api/accounts?${qs}`);
    $("#count").textContent = `${rows.length} account${rows.length === 1 ? "" : "s"}`;
    $("#table").innerHTML = rows.length ? `<table class="grid-table"><thead><tr><th>Company</th><th>Stage</th><th class="c">Tier</th><th class="r">Score</th><th>Industry</th><th class="r">People</th><th>Updated</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-go="/accounts/${esc(r.domain)}"><td><b>${esc(r.name ?? r.domain)}</b><small>${esc(r.domain)}${r.hq_country ? ` · ${esc(r.hq_country)}` : ""}</small></td>
        <td><span class="stage s-${esc(r.stage)}">${esc(STAGE_NAME[r.stage] ?? r.stage)}</span></td><td class="c">${tierPill(r.tier)}</td>
        <td class="r num">${r.score != null ? Math.round(r.score) : r.light_score != null ? `<span class="muted" title="light score">${Math.round(r.light_score)}</span>` : "–"}</td>
        <td class="clip">${esc(r.industry ?? "")}</td><td class="r num">${r.employees != null ? esc(String(r.employees)) : ""}</td><td class="muted">${day(r.updated)}</td></tr>`).join("")}</tbody></table>`
      : empty("No accounts match", "Change the filters, or find companies from the Runs page.");
  };
  let t;
  $("#f-q").addEventListener("input", (e) => { f.q = e.target.value; clearTimeout(t); t = setTimeout(load, 220); });
  $("#f-stage").addEventListener("change", (e) => { f.stage = e.target.value; load(); });
  $("#f-tier").addEventListener("change", (e) => { f.tier = e.target.value; load(); });
  view.addEventListener("click", (e) => { const tr = e.target.closest("tr[data-go]"); if (tr) go(tr.dataset.go); });
  await load();
}

const TABS = [["brief", "Brief"], ["score", "Score"], ["people", "People"], ["signals", "Signals"], ["drafts", "Drafts"], ["outcomes", "Outcomes"]];

export async function accountPage(view, { args, query, state }) {
  const domain = decodeURIComponent(args[0]);
  const a = await get(`/api/account?domain=${encodeURIComponent(domain)}`);
  const icp = state.icp && a.company.icp_status?.[state.icp] ? state.icp : Object.keys(a.company.icp_status ?? {})[0];
  const st = a.company.icp_status?.[icp] ?? {};
  const tab = query.get("tab") ?? "brief";
  const name = a.company.name ?? domain;
  const score = a.scores[icp];
  view.innerHTML = `
    <a class="back" href="/accounts" data-link>← Accounts</a>
    <section class="acc-head">
      <div><h1>${esc(name)}</h1>
        <p class="muted"><a href="https://${esc(domain)}" target="_blank" rel="noopener">${esc(domain)} ↗</a>${a.company.facts?.industry ? ` · ${esc(a.company.facts.industry.value)}` : ""}${a.company.facts?.hq_country ? ` · ${esc(a.company.facts.hq_country.value)}` : ""}${a.blocked ? ` · <b class="warn-text">do not contact</b>` : ""}</p></div>
      <div class="kpis">
        <div class="kpi"><b>${tierPill(st.tier)}</b><span>tier</span></div>
        <div class="kpi"><b>${st.score != null ? Math.round(st.score) : st.light_score != null ? Math.round(st.light_score) : "–"}</b><span>${st.score != null ? "full score" : "light score"}</span></div>
        <div class="kpi"><b class="kpi-text">${esc(STAGE_NAME[st.stage] ?? st.stage ?? "–")}</b><span>stage${st.reviewed_by ? ` · reviewed by ${esc(st.reviewed_by)}` : ""}</span></div>
        ${score?.timing ? `<div class="kpi"><b class="kpi-text">${esc(score.timing)}</b><span>timing</span></div>` : ""}
      </div>
    </section>
    <div class="actions">
      <button class="btn" data-a="watch">${a.watched ? "Stop watching" : "Watch for news"}</button>
      <button class="btn" data-a="log">Log an outcome</button>
      ${st.stage && st.stage !== "excluded" ? `<button class="btn ghost" data-a="exclude">Exclude</button>` : ""}
      ${a.blocked ? "" : `<button class="btn ghost danger" data-a="block">Do not contact</button>`}
    </div>
    <div class="tabs">${TABS.map(([t, l]) => `<a href="/accounts/${esc(domain)}?tab=${t}" data-link class="${t === tab ? "on" : ""}">${l}${count(a, t) ? `<span class="c">${count(a, t)}</span>` : ""}</a>`).join("")}</div>
    <div class="tab-body" id="tb"></div>
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

const count = (a, t) => ({ people: a.people.length, signals: a.signals.length, drafts: a.drafts.length, outcomes: a.outcomes.length })[t] ?? 0;

function brief(a) {
  if (!a.brief) return `<p class="empty-note">No brief yet. It is written by the quick scan and filled in by research.</p>`;
  return `<div class="prose brief">${mdBody(a.brief)}</div>`;
}

function scoreTab(a, icp) {
  const s = a.scores[icp];
  if (!s) return `<p class="empty-note">Not scored for ${esc(icp)} yet.</p>`;
  const groups = [...new Set(s.factors.map((f) => f.group ?? "other"))];
  return `<p class="muted" style="margin:0 0 16px">${s.mode === "full" ? "Full" : "Light"} score ${Math.round(s.total)} of 100 · upside ${Math.round(s.upside)} if every unknown turned out best · ${Math.round(s.coverage * 100)}% of the evidence known · scored ${day(s.scored_at)}</p>
    ${s.knocked_out?.length ? `<div class="note warn">Knocked out by ${esc(s.knocked_out.join(", "))}</div>` : ""}
    ${groups.map((g) => `<h4>${esc(g)}</h4>${s.factors.filter((f) => (f.group ?? "other") === g).map((f) => `<div class="factor-row">
      <div class="lvl l${f.level ?? "n"}">${f.level ?? "?"}</div>
      <div><b>${esc(f.name)}</b>${f.weight ? `<span class="muted"> · weight ${esc(String(f.weight))}</span>` : ""}
        <p>${f.level == null ? `<span class="muted">Unknown: no evidence yet${f.question ? ` (${esc(f.question)})` : ""}</span>` : esc(f.level_text ?? "")}</p>
        ${(f.evidence ?? []).slice(0, 2).map((e) => `<blockquote>“${esc(e.quote)}”${e.source_url ? ` <a href="${esc(e.source_url)}" target="_blank" rel="noopener">source ↗</a>` : ""}</blockquote>`).join("")}
        ${f.rationale ? `<p class="muted">${esc(f.rationale)}</p>` : ""}</div></div>`).join("")}`).join("")}`;
}

function people(a) {
  if (!a.people.length) return `<p class="empty-note">No people found yet. Research looks for one person per buyer persona.</p>`;
  const warm = new Map(a.warm.map((w) => [w.person_id, w]));
  return `<table class="grid-table"><thead><tr><th>Name</th><th>Title</th><th>Persona</th><th>Warm path</th></tr></thead><tbody>${a.people.map((p) => `<tr>
    <td><b>${esc(p.name)}</b>${p.linkedin_url ? `<small><a href="${esc(p.linkedin_url)}" target="_blank" rel="noopener">LinkedIn ↗</a></small>` : ""}</td><td>${esc(p.title ?? "")}</td><td>${esc(p.persona ?? "")}</td>
    <td>${warm.get(p.id) ? `${esc(warm.get(p.id).member)} knows them` : `<span class="muted">none</span>`}</td></tr>`).join("")}</tbody></table>`;
}

function signals(a) {
  if (!a.signals.length) return `<p class="empty-note">No trigger events found yet.</p>`;
  return `<div class="timeline">${a.signals.map((s) => `<div class="ev"><span class="d">${day(s.date)}</span><span><b>${esc(s.title)}</b><small>${esc(s.type)} · ${esc(s.status)}${s.source_url ? ` · <a href="${esc(s.source_url)}" target="_blank" rel="noopener">source ↗</a>` : ""}</small></span></div>`).join("")}</div>`;
}

function drafts(a) {
  if (!a.drafts.length) return `<p class="empty-note">No drafts yet. They are written once the account has a way in.</p>`;
  return `<div class="list">${a.drafts.map((d) => `<a class="item" href="/today/drafts?path=${encodeURIComponent(d.path)}" data-link><span class="t">${esc(d.channel)} to ${esc(d.person ?? "?")}<small>${day(d.created)}</small></span><span class="stage">${esc(d.status)}</span></a>`).join("")}</div>`;
}

function outcomes(a) {
  if (!a.outcomes.length) return `<p class="empty-note">Nothing logged yet.</p>`;
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
