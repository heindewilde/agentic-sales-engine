// Agent map: live data (/api/model) + the process story (/api/story) → dashboard. Read-only.
const $ = (s) => document.querySelector(s);
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const consoleUrl = (id) => `https://platform.claude.com/sessions/${id}`;
const CRON_DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const human = (cron) => {
  if (!cron) return "";
  const [m, h, dom, , dow] = cron.split(" ");
  const at = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  if (dow !== "*") return `${CRON_DAYS[Number(dow)]} ${at}`;
  if (dom !== "*") return `${dom === "1" ? "1st" : dom} of the month ${at}`;
  return `daily ${at}`;
};
const MAINT = { n: "↻", id: "maintenance", short: "Maintenance", title: "Scheduled maintenance", parallel: true };
const STAGES = [["discovered", "Found"], ["light_scored", "Quick-scanned"], ["shortlisted", "Shortlisted"], ["researched", "Researched"], ["scored", "Scored"], ["outreach_ready", "Outreach ready"]];

let model, story;
const modelName = (id) => id.replace(/^claude-/, "").replace(/^(\w)(\w*)-(\d+)-(\d+)$/, (_, a, b, x, y) => `${a.toUpperCase()}${b} ${x}.${y}`);

async function load(fresh = false) {
  const [m, s] = await Promise.all([fetch(fresh ? "/api/refresh" : "/api/model").then((r) => r.json()), story ?? fetch("/api/story").then((r) => r.json())]);
  model = m;
  story = s;
  render();
}

/** Accounts that reached at least each stage (excluded ones were light-scored first). */
function funnelRows() {
  const f = model.funnel[0];
  if (!f) return [];
  const st = f.stages;
  const idx = (k) => STAGES.findIndex(([s]) => s === k);
  const rows = STAGES.map(([stage, label], i) => {
    let n = Object.entries(st).filter(([k]) => idx(k) >= i).reduce((a, [, v]) => a + v, 0);
    if (i <= 1) n += st.excluded ?? 0;
    return { stage, label, n };
  });
  return rows.map((r, i) => ({ ...r, conv: i ? (rows[i - 1].n ? Math.round((100 * r.n) / rows[i - 1].n) : 0) : null, note: i === 1 && st.excluded ? `${st.excluded} excluded as a clear misfit` : "" }));
}

/** The journey with live numbers, plus a maintenance row from the schedules. */
function steps() {
  const reached = funnelRows();
  const avg = (runs) => (runs.length ? `${money(runs.reduce((a, r) => a + r.cost, 0) / runs.length)} per run` : "");
  const out = story.journey.map((s) => {
    const runs = model.runs.filter((r) => s.skills.includes(r.skill));
    const row = reached.find((r) => r.stage === s.stage);
    return { ...s, runs, metric: row ? `${row.n} accounts` : runs.length ? `${runs.length} runs` : "", cost: avg(runs) };
  });
  const mskills = story.maintenance.jobs.map((j) => j.skill);
  const acts = story.maintenance.jobs.map((j) => {
    const sc = model.schedules.find((x) => x.skill === j.skill);
    return { by: "operator", label: `${j.title} · ${sc ? human(sc.cron) : "manual"}` };
  });
  const runs = model.runs.filter((r) => mskills.includes(r.skill));
  out.push({ ...MAINT, what: story.maintenance.what, skills: mskills, acts: [...acts, { by: "wiki-linter", label: "Deep audit · on demand" }], runs, metric: `${model.schedules.length} scheduled`, cost: avg(runs) });
  return out;
}

function render() {
  const S = steps();
  const m = model.month;
  const waiting = (model.funnel[0]?.gates.length ?? 0) + m.questions;
  $("#tiles").innerHTML = `
    <div class="tile"><div class="k">API credits this month</div><div class="v">${money(m.credits_usd)}<small>of $100</small></div><div class="meter"><i style="width:${Math.min(100, m.credits_usd)}%"></i></div></div>
    <div class="tile"><div class="k">Runs this month</div><div class="v">${m.runs}</div><div class="note">${m.failed} failed · ${m.capped} hit a budget cap</div></div>
    <div class="tile ${waiting ? "alert" : ""}"><div class="k">Waiting on you</div><div class="v">${waiting}</div><div class="note">${waiting ? "approvals and reviews" : "nothing open"}</div></div>
    <div class="tile"><div class="k">Scheduled</div><div class="v">${model.schedules.length}</div><div class="note">${model.schedules.map((x) => `${escH(x.skill)} · ${human(x.cron)}`).join("<br>") || "none"}</div></div>`;

  $("#lane-legend").innerHTML = `<span><i style="background:var(--gate)"></i>Your decision</span><span class="muted">Click a step or agent for details</span>`;
  drawSwimlane($("#swimlane"), S, openStep, openAgent);

  const fr = funnelRows();
  $("#funnel-sub").textContent = model.funnel[0]?.icp ?? "";
  if (fr.length) drawFunnel($("#funnel"), fr);
  else $("#funnel").innerHTML = '<p class="muted">Start the map with <code>--workspace &lt;dir&gt;</code> for live numbers.</p>';

  const AG = ["operator", "account-researcher", "factor-judge", "wiki-linter", "icp-analyst"];
  const costRows = S.map((s) => {
    const by = Object.fromEntries(AG.map((a) => [a, 0]));
    for (const r of s.runs) for (const t of r.threads) if (t.agent in by) by[t.agent] += t.cost;
    for (const a of AG) by[a] /= s.runs.length || 1;
    return { label: s.short, by, total: AG.reduce((x, a) => x + by[a], 0), runs: s.runs.length };
  });
  const used = AG.filter((a) => costRows.some((r) => r.by[a] > 0));
  $("#cost-legend").innerHTML = used.map((a) => `<span><i style="background:${actor(a).color}"></i>${actor(a).name}</span>`).join("");
  drawCost($("#cost"), costRows, used);

  drawSequence($("#sequence"));

  $("#agents").innerHTML = `<table><tr><th>Agent</th><th>Model</th><th class="n">Version</th><th class="n">Runs</th><th class="n">Cost</th></tr>${story.roles.map((r) => {
    const a = model.agents.find((x) => x.name === r.agent);
    if (!a) return "";
    return `<tr class="click" data-agent="${r.agent}"><td><span class="sw" style="background:${actor(r.agent).color}"></span><b>${escH(actor(r.agent).name)}</b><div class="muted">${escH(r.oneLiner)}</div></td><td>${escH(modelName(a.current.model))}</td><td class="n">v${a.current.version}</td><td class="n">${a.runs}</td><td class="n">${money(a.cost_total)}</td></tr>`;
  }).join("")}</table>`;

  $("#status-legend").innerHTML = ["done", "question", "budget_reached", "failed"].map((k) => `<span><i class="round" style="background:${STATUS[k].color}"></i>${STATUS[k].icon} ${STATUS[k].label}</span>`).join("");
  const tlRows = S.map((s) => ({ label: s.short, skills: s.skills })).concat([{ label: "Other", skills: story.maintenance.other }]);
  drawTimeline($("#timeline"), tlRows, model.runs, openRun);
}

// ---------- drawer ----------
function drawer(html) {
  $("#drawer-body").innerHTML = html;
  document.body.classList.add("open");
  $("#drawer").scrollTop = 0;
}
const closeDrawer = () => document.body.classList.remove("open");
const runTable = (runs) => runs.length
  ? `<table><tr><th>Date</th><th>Run</th><th>Status</th><th class="n">Cost</th></tr>${runs.map((r) => `<tr><td>${day(r.created_at)}</td><td><a href="${consoleUrl(r.session_id)}" target="_blank">${escH((r.args || r.skill).slice(0, 48))}</a></td><td><span class="st ${r.status}">${statusOf(r.status).label}</span></td><td class="n">${money(r.cost)}</td></tr>`).join("")}</table>`
  : '<p class="muted">No runs yet.</p>';

function openStep(s) {
  const checks = s.runs.flatMap((r) => r.checks.map((c) => ({ c, r })));
  drawer(`<h3>${escH(String(s.n))}. ${escH(s.title)}</h3><p class="muted">${escH(s.what)}</p>
    ${s.input ? `<dl><dt>In</dt><dd>${escH(s.input)}</dd><dt>Out</dt><dd>${escH(s.output)}</dd><dt>You</dt><dd>${escH(s.you.text)}</dd><dt>When</dt><dd>${escH(s.when)}</dd></dl>` : ""}
    ${s.how ? `<h4>Hand-offs</h4><ol>${s.how.map((h) => `<li>${escH(h)}</li>`).join("")}</ol>` : ""}
    <h4>Runs</h4>${runTable(s.runs)}
    ${checks.length ? `<h4>To double-check</h4><ol>${checks.slice(0, 12).map(({ c, r }) => `<li>${escH(c)} <span class="muted">${day(r.created_at)}</span></li>`).join("")}</ol>` : ""}
    <h4>Playbooks</h4>${s.skills.map(skillDetails).join("")}`);
}

function skillDetails(name) {
  const k = model.skills.find((x) => x.name === name);
  if (!k) return "";
  return `<details><summary><span class="pill">${escH(name)}</span><span class="muted">${k.versions.length} version${k.versions.length === 1 ? "" : "s"}</span></summary><pre>${escH(k.text)}</pre></details>`;
}

function openAgent(id) {
  const r = story.roles.find((x) => x.agent === id);
  const a = model.agents.find((x) => x.name === id);
  if (!a) return;
  const runs = model.runs.filter((x) => x.threads.some((t) => t.agent === id));
  const v = a.current;
  drawer(`<h3><span class="sw" style="background:${actor(id).color}"></span>${escH(actor(id).name)}</h3><p class="muted">${escH(r?.oneLiner ?? a.description)}</p>
    ${r ? `<h4>Does</h4><ol>${r.does.map((d) => `<li>${escH(d)}</li>`).join("")}</ol><p class="muted">${escH(r.never)}</p>` : ""}
    <dl><dt>Model</dt><dd>${escH(v.model)}</dd><dt>Tools</dt><dd>${v.tools.map((t) => `<span class="pill">${escH(t)}</span>`).join("")}</dd>${v.subagents.filter((x) => x !== id).length ? `<dt>Hands work to</dt><dd>${v.subagents.filter((x) => x !== id).map((x) => `<span class="pill">${escH(actor(x).name)}</span>`).join("")}</dd>` : ""}${r ? `<dt>Reads</dt><dd>${escH(r.reads)}</dd>` : ""}</dl>
    <h4>Versions</h4><table><tr><th>Version</th><th>Created</th><th class="n">Runs</th><th class="n">Cost</th><th></th></tr>${a.versions.map((x, i) => `<tr><td>v${x.version}</td><td>${day(x.created_at)}</td><td class="n">${x.runs}</td><td class="n">${money(x.cost)}</td><td>${a.versions[i + 1] ? `<button class="btn" data-diff="${escH(a.key)}|${a.versions[i + 1].version}|${x.version}">changes</button>` : ""}</td></tr>`).join("")}</table>
    <div id="diff"></div>
    <h4>Runs</h4>${runTable(runs.slice(0, 15))}
    <details><summary class="muted">Instructions (v${v.version})</summary><pre>${escH(v.system)}</pre></details>`);
}

function openRun(r) {
  const per = {};
  for (const t of r.threads) per[t.agent] = (per[t.agent] ?? 0) + t.cost;
  drawer(`<h3>${escH(r.skill)}</h3><p class="muted">${escH(r.args)}</p>
    <dl><dt>Started</dt><dd>${new Date(r.created_at).toLocaleString()}</dd><dt>Status</dt><dd><span class="st ${r.status}">${statusOf(r.status).label}</span></dd><dt>Cost</dt><dd>${money(r.cost)} · ${r.active_minutes} min</dd>
    <dt>By agent</dt><dd>${Object.entries(per).map(([a, c]) => `<span class="pill">${escH(actor(a).name)} ${money(c)}</span>`).join("")}</dd><dt>Session</dt><dd><a href="${consoleUrl(r.session_id)}" target="_blank">Open in Console</a></dd></dl>
    ${r.checks.length ? `<h4>To double-check</h4><ol>${r.checks.map((c) => `<li>${escH(c)}</li>`).join("")}</ol>` : ""}`);
}

document.addEventListener("click", async (e) => {
  const row = e.target.closest("[data-agent]");
  if (row) return openAgent(row.dataset.agent);
  const d = e.target.closest("[data-diff]");
  if (d) {
    const [id, from, to] = d.dataset.diff.split("|");
    const j = await (await fetch(`/api/diff?kind=agent&id=${encodeURIComponent(id)}&from=${from}&to=${to}`)).json();
    const changed = (j.lines ?? []).some((l) => l.op === "+" || l.op === "-");
    $("#diff").innerHTML = `<h4>v${from} → v${to}</h4>${(j.config ?? []).map((c) => `<span class="pill">${escH(c)}</span>`).join("")}${changed ? `<div class="diff">${j.lines.map((l) => `<div class="${l.op === "+" ? "p" : l.op === "-" ? "m" : l.op === "…" ? "e" : ""}">${escH(l.op === "…" ? `… ${l.text}` : `${l.op} ${l.text}`)}</div>`).join("")}</div>` : ""}`;
  }
});
$("#close").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());
$("#refresh").addEventListener("click", () => load(true));
let rt;
window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 150); });
load();
