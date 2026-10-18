// Agent map UI: graph (Cytoscape) + detail panel + flags and runs tabs. Read-only; data from /api/model.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (x) => `$${(x ?? 0).toFixed(2)}`;
const day = (iso) => (iso ? iso.slice(0, 10) : "");
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const console_ = (id) => `https://platform.claude.com/sessions/${id}`;
const BAD = new Set(["budget_reached", "retries_exhausted", "failed", "terminated"]);

let model = null;
let cy = null;

async function load(fresh = false) {
  $("#loading").style.display = "block";
  model = await (await fetch(fresh ? "/api/refresh" : "/api/model")).json();
  $("#loading").style.display = "none";
  renderStats();
  renderGraph();
  renderFlags();
  renderRuns();
}

function renderStats() {
  const m = model.month;
  const next = model.schedules.map((s) => `${s.skill} (${s.cron})`).join(", ");
  $("#stats").innerHTML = [
    `<div class="stat"><b>${money(m.credits_usd)}</b><span>credits this month</span></div>`,
    `<div class="stat"><b>${m.runs}</b><span>runs</span></div>`,
    `<div class="stat ${m.failed ? "bad" : ""}"><b>${m.failed}</b><span>failed</span></div>`,
    `<div class="stat ${m.capped ? "bad" : ""}"><b>${m.capped}</b><span>hit a budget cap</span></div>`,
    `<div class="stat"><b>${m.questions}</b><span>waiting on you</span></div>`,
    `<div class="stat"><span>scheduled: ${esc(next) || "none"}</span></div>`,
  ].join("");
}

// ---------- graph ----------

function nodeData() {
  const show = Object.fromEntries([...document.querySelectorAll("#filters input")].map((i) => [i.dataset.kind, i.checked]));
  const recentBad = (runs) => runs.some((r) => BAD.has(r.status));
  const nodes = [];
  for (const s of model.schedules) nodes.push({ id: s.key, label: `⏱ ${s.skill}\n${s.cron}`, kind: "schedule" });
  for (const a of model.agents) {
    if (a.kind === "agent" && !show.agent) continue;
    const runs = model.runs.filter((r) => r.threads.some((t) => t.agent === a.name));
    nodes.push({ id: a.key, label: `${a.name}\nv${a.current.version} · ${money(a.cost_total)}`, kind: a.kind, bad: recentBad(runs.slice(0, 5)) });
  }
  if (show.skill) for (const s of model.skills) {
    const runs = model.runs.filter((r) => r.skill === s.name);
    const flags = runs.reduce((n, r) => n + r.checks.length, 0);
    const per = s.runs ? money(s.cost_total / s.runs) : "–";
    nodes.push({ id: s.key, label: `${s.name}\n${s.runs} runs · ${per}/run${flags ? ` · ⚑${flags}` : ""}`, kind: "skill", bad: recentBad(runs.slice(0, 3)) });
  }
  for (const d of model.docs) if ((d.scope === "engine" && show.engine) || (d.scope === "workspace" && show.workspace)) nodes.push({ id: d.key, label: d.path, kind: d.scope });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.kind !== "uses-skill").map((e, i) => ({ id: `e${i}`, source: e.from, target: e.to, kind: e.kind }));
  return [...nodes.map((data) => ({ data })), ...edges.map((data) => ({ data }))];
}

function renderGraph() {
  const color = { schedule: css("--schedule"), operator: css("--operator"), agent: css("--agent"), skill: css("--skill"), engine: css("--engine"), workspace: css("--workspace") };
  if (cy) cy.destroy();
  cy = cytoscape({
    container: $("#cy"),
    elements: nodeData(),
    wheelSensitivity: 0.25,
    style: [
      { selector: "node", style: { label: "data(label)", "text-wrap": "wrap", "font-size": 10, color: css("--ink"), "text-valign": "bottom", "text-margin-y": 4, width: 18, height: 18, "background-color": (n) => color[n.data("kind")] } },
      { selector: "node[kind = 'operator']", style: { width: 34, height: 34, "font-size": 12, "font-weight": 600 } },
      { selector: "node[kind = 'agent']", style: { width: 26, height: 26, shape: "round-rectangle", "font-size": 11 } },
      { selector: "node[kind = 'schedule']", style: { shape: "diamond", width: 22, height: 22 } },
      { selector: "node[kind = 'engine'], node[kind = 'workspace']", style: { shape: "rectangle", width: 10, height: 10, "font-size": 8, color: css("--muted") } },
      { selector: "node[?bad]", style: { "border-width": 3, "border-color": css("--bad") } },
      { selector: "node:selected", style: { "border-width": 3, "border-color": css("--ink") } },
      { selector: "edge", style: { width: 1, "line-color": css("--line"), "target-arrow-shape": "triangle", "target-arrow-color": css("--line"), "curve-style": "bezier", "arrow-scale": 0.6 } },
      { selector: "edge[kind = 'subagent'], edge[kind = 'calls']", style: { "line-color": css("--agent"), "target-arrow-color": css("--agent"), width: 1.5 } },
      { selector: ".faded", style: { opacity: 0.15 } },
    ],
    // rings: the operator in the middle, then agents and schedules, then skills, documents outside
    layout: { name: "concentric", concentric: (n) => ({ operator: 5, agent: 4, schedule: 4, skill: 3, engine: 2, workspace: 1 })[n.data("kind")] ?? 1, levelWidth: () => 1, minNodeSpacing: 34, padding: 30, startAngle: -Math.PI / 2 },
  });
  cy.on("tap", "node", (e) => {
    const n = e.target;
    cy.elements().addClass("faded");
    n.closedNeighborhood().removeClass("faded");
    show(n.id());
  });
  cy.on("tap", (e) => { if (e.target === cy) cy.elements().removeClass("faded"); });
}

// ---------- detail panel ----------

const kindBadge = (k) => `<span class="kind" style="background:${css(`--${k === "doc" ? "engine" : k}`)}">${k}</span>`;
const chips = (items, link = false) => `<div class="chips">${items.map((x) => (link ? `<span class="chip link" data-go="${esc(x.key)}">${esc(x.label)}</span>` : `<span class="chip">${esc(x)}</span>`)).join("") || '<span class="muted">none</span>'}</div>`;
const runRows = (runs) => runs.length ? `<table><tr><th>Date</th><th>Run</th><th>Status</th><th class="num">Cost</th></tr>${runs.map((r) => `<tr><td>${day(r.created_at)}</td><td><a href="${console_(r.session_id)}" target="_blank">${esc((r.args || r.skill).slice(0, 60))}</a></td><td class="status-${r.status}">${esc(r.status)}</td><td class="num">${money(r.cost)}</td></tr>`).join("")}</table>` : '<p class="muted">No runs yet.</p>';
const flagList = (flags) => flags.length ? flags.map((f) => `<div class="flag">${esc(f.text)}<div class="meta">${day(f.created_at)} · <a href="${console_(f.session_id)}" target="_blank">session</a>${f.skill ? ` · ${esc(f.skill)}` : ""}</div></div>`).join("") : '<p class="muted">Nothing flagged.</p>';

function show(key) {
  const panel = $("#detail");
  const agent = model.agents.find((a) => a.key === key);
  const skill = model.skills.find((s) => s.key === key);
  const doc = model.docs.find((d) => d.key === key);
  const sched = model.schedules.find((s) => s.key === key);
  const label = (k) => ({ key: k, label: k.replace(/^[a-z]+:/, "") });
  if (agent) {
    const v = agent.current;
    const runs = model.runs.filter((r) => r.threads.some((t) => t.agent === agent.name));
    const threads = runs.flatMap((r) => r.threads.filter((t) => t.agent === agent.name));
    const usedBy = model.edges.filter((e) => e.to === key && e.kind !== "reads").map((e) => label(e.from));
    panel.innerHTML = `${kindBadge(agent.kind)}<h2>${esc(agent.name)}</h2>
      <div class="muted">${esc(v.model)} · version ${v.version} of ${agent.versions.length} · in ${agent.runs} runs · ${money(agent.cost_total)} in its own threads${agent.kind === "operator" ? " (subagents not included; see per-version cost of whole runs below)" : ""}</div>
      <p>${esc(agent.description)}</p>
      <h3>Tools</h3>${chips(v.tools)}
      ${v.subagents.length ? `<h3>Subagents</h3>${chips(v.subagents.filter((s) => s !== agent.name).map((s) => ({ key: `agent:${s}`, label: s })), true)}` : ""}
      ${agent.kind === "operator" ? `<h3>Skills attached (${v.skills.length})</h3>${chips(v.skills.map((s) => ({ key: `skill:${s}`, label: s })), true)}` : ""}
      ${usedBy.length ? `<h3>Used by</h3>${chips(usedBy, true)}` : ""}
      <h3>Documents in its prompt</h3>${chips(model.edges.filter((e) => e.from === key && e.kind === "reads").map((e) => label(e.to)), true)}
      <h3>Versions</h3>${versionTable(agent)}
      <div id="diff"></div>
      <h3>System prompt (v${v.version})</h3><pre>${esc(v.system)}</pre>
      <h3>Recent runs</h3>${runRows(runs.slice(0, 12))}`;
  } else if (skill) {
    const runs = model.runs.filter((r) => r.skill === skill.name);
    const out = Object.entries(skill.outcomes).map(([k, n]) => `<span class="chip ${BAD.has(k) ? "bad" : k === "done" ? "good" : ""}">${esc(k)} ${n}</span>`).join("");
    const refs = model.edges.filter((e) => e.from === key).map((e) => label(e.to));
    const by = model.edges.filter((e) => e.to === key && e.kind !== "attached").map((e) => label(e.from));
    panel.innerHTML = `${kindBadge("skill")}<h2>${esc(skill.name)}</h2>
      <div class="muted">${skill.runs} runs · ${money(skill.cost_total)} total${skill.runs ? ` · ${money(skill.cost_total / skill.runs)} per run` : ""}${skill.schedule ? ` · scheduled ${esc(skill.schedule)}` : ""}</div>
      <p>${esc(skill.description)}</p>
      <h3>Outcomes</h3><div class="chips">${out || '<span class="muted">no runs</span>'}</div>
      <h3>Calls and reads</h3>${chips(refs, true)}
      ${by.length ? `<h3>Used by</h3>${chips(by, true)}` : ""}
      <h3>Flags from its runs</h3>${flagList(skill.checks.slice(0, 15))}
      <h3>Runs</h3>${runRows(runs)}
      <h3>Versions</h3>${skillVersions(skill)}<div id="diff"></div>
      <details><summary>Skill text (current version)</summary><pre>${esc(skill.text)}</pre></details>`;
  } else if (doc) {
    panel.innerHTML = `${kindBadge("doc")}<h2 style="font-size:15px">${esc(doc.path)}</h2>
      <div class="muted">${doc.scope === "engine" ? "Engine document (same for every workspace)" : "Workspace file (per account / ICP; the pattern as the prompts name it)"}</div>
      <h3>Referenced by</h3>${chips([...new Set(doc.referenced_by)].map(label), true)}
      ${doc.scope === "engine" ? '<h3>Text</h3><pre id="doctext">Loading…</pre>' : ""}`;
    if (doc.scope === "engine") fetch(`/api/doc?path=${encodeURIComponent(doc.path)}`).then((r) => r.json()).then((j) => { $("#doctext").textContent = j.text ?? "(not found in the repo)"; });
  } else if (sched) {
    const runs = model.runs.filter((r) => r.skill === sched.skill);
    panel.innerHTML = `${kindBadge("schedule")}<h2>${esc(sched.skill)}</h2>
      <div class="muted">${esc(sched.cron)} (${esc(sched.timezone)}) · cap ${sched.cap_usd != null ? money(sched.cap_usd) : "none"} per run · operator v${sched.operator_version ?? "?"}${sched.paused ? " · paused" : ""}</div>
      <p><code>${esc(sched.description)}</code></p>
      <h3>Skill</h3>${chips([{ key: `skill:${sched.skill}`, label: sched.skill }], true)}
      <h3>Runs of this skill</h3>${runRows(runs)}`;
  }
  panel.scrollTop = 0;
}

function versionTable(agent) {
  const rows = agent.versions.map((v, i) => {
    const prev = agent.versions[i + 1];
    return `<tr><td>v${v.version}</td><td>${day(v.created_at)}</td><td class="num">${v.runs}</td><td class="num">${v.runs ? money(v.cost / v.runs) : "–"}</td><td class="num">${v.checks || ""}</td><td>${prev ? `<button data-diff="agent|${esc(agent.key)}|${prev.version}|${v.version}">diff v${prev.version}</button>` : ""}</td></tr>`;
  }).join("");
  return `<table><tr><th>Version</th><th>Created</th><th class="num">Runs</th><th class="num">${agent.kind === "operator" ? "Run cost" : "Own cost"}</th><th class="num">⚑</th><th></th></tr>${rows}</table>`;
}

function skillVersions(skill) {
  return `<table><tr><th>Version</th><th>Created</th><th></th></tr>${skill.versions.map((v, i) => {
    const prev = skill.versions[i + 1];
    return `<tr><td>${esc(v.id.slice(-6))}</td><td>${day(v.created_at)}</td><td>${prev && v.text && prev.text ? `<button data-diff="skill|${esc(skill.key)}|${prev.id}|${v.id}">diff</button>` : ""}</td></tr>`;
  }).join("")}</table>`;
}

document.addEventListener("click", async (e) => {
  const go = e.target.closest("[data-go]");
  if (go) {
    const key = go.dataset.go;
    const n = cy.getElementById(key);
    if (n.nonempty()) { cy.elements().addClass("faded"); n.closedNeighborhood().removeClass("faded"); n.select(); }
    return show(key);
  }
  const d = e.target.closest("[data-diff]");
  if (d) {
    const [kind, id, from, to] = d.dataset.diff.split("|");
    const j = await (await fetch(`/api/diff?kind=${kind}&id=${encodeURIComponent(id)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json();
    const config = j.config?.length ? `<div class="chips" style="margin-bottom:6px">${j.config.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>` : "";
    $("#diff").innerHTML = j.lines ? `<h3>Changes v${esc(from)} → v${esc(to)}</h3>${config}<div class="diff">${j.lines.map((l) => `<div class="${l.op === "+" ? "p" : l.op === "-" ? "m" : l.op === "…" ? "e" : ""}">${esc(l.op === "…" ? `… ${l.text}` : `${l.op} ${l.text}`)}</div>`).join("")}</div>` : `<p class="muted">${esc(j.error)}</p>`;
    $("#diff").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const t = e.target.closest("nav [data-tab]");
  if (t) {
    document.querySelectorAll("nav [data-tab]").forEach((b) => b.classList.toggle("active", b === t));
    document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === t.dataset.tab));
    $("#filters").style.visibility = t.dataset.tab === "map" ? "visible" : "hidden";
    if (t.dataset.tab === "map") cy?.resize();
  }
});
document.querySelectorAll("#filters input").forEach((i) => i.addEventListener("change", renderGraph));
$("#refresh").addEventListener("click", () => load(true));

// ---------- flags and runs tabs ----------

function renderFlags() {
  const flags = model.runs.flatMap((r) => r.checks.map((text) => ({ text, created_at: r.created_at, session_id: r.session_id, skill: r.skill })));
  const bySkill = {};
  for (const f of flags) (bySkill[f.skill] ??= []).push(f);
  $("#flags").innerHTML = flags.length
    ? Object.entries(bySkill).map(([s, fs]) => `<h3>${esc(s)} (${fs.length})</h3>${flagList(fs)}`).join("")
    : '<p class="muted">No run has flagged anything to double-check yet.</p>';
}

function renderRuns() {
  $("#runs").innerHTML = `<table><tr><th>Date</th><th>Skill</th><th>Arguments</th><th>Status</th><th>Agents</th><th class="num">Minutes</th><th class="num">Cost</th><th class="num">⚑</th></tr>${model.runs.map((r) => {
    const per = {};
    for (const t of r.threads) per[t.agent] = (per[t.agent] ?? 0) + t.cost;
    return `<tr><td>${day(r.created_at)}</td><td>${esc(r.skill)}</td><td><a href="${console_(r.session_id)}" target="_blank">${esc((r.args || "").slice(0, 70))}</a>${r.archived ? ' <span class="muted">(archived)</span>' : ""}</td><td class="status-${r.status}">${esc(r.status)}</td><td>${Object.entries(per).map(([a, c]) => `${esc(a)} ${money(c)}`).join("<br>")}</td><td class="num">${r.active_minutes}</td><td class="num">${money(r.cost)}</td><td class="num">${r.checks.length || ""}</td></tr>`;
  }).join("")}</table>`;
}

load();
