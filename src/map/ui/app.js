// Sales engine map: /process (steps left to right, actors as rows, details below) and /brain (every file behind it).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (x) => `$${(x ?? 0).toFixed(2)}`;
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const COLORS = { you: "#0a0a0a", operator: "var(--s1)", "account-researcher": "var(--s2)", "factor-judge": "var(--s3)", "wiki-linter": "var(--s4)", "icp-analyst": "var(--s5)" };
const CATS = [["instructions", "Agent instructions", "var(--c1)"], ["playbook", "Playbook", "var(--c2)"], ["method", "Rules & method", "var(--c3)"], ["knowledge", "Your knowledge", "var(--c4)"], ["data", "Company data", "var(--c5)"]];
const LAYERS = { knowledge: "Your knowledge", method: "Rules & method", template: "Template", playbook: "Playbook", agent: "Agent", data: "Company data" };
const STAGES = ["discovered", "light_scored", "shortlisted", "researched", "scored", "outreach_ready"];
/** What a written path means, in words. */
const OUTPUTS = [
  [/brief\.md$/, "Account brief"], [/signals\//, "Trigger events"], [/^people\//, "People"], [/scores\//, "Scores"], [/company\.md$/, "Company facts"],
  [/drafts\//, "Outreach drafts"], [/callprep\//, "Call prep"], [/win-loss\//, "Win/loss review"], [/learnings\//, "Lessons"], [/events\.jsonl$/, "Outcome log"],
  [/^sync\//, "News check report"], [/icp\.md$/, "ICP"], [/scoring\.yaml$/, "Scoring model"], [/lists\//, "Shortlist"], [/calibration/, "Calibration"],
];
const outName = (p) => OUTPUTS.find(([re]) => re.test(p))?.[1] ?? p;
/** Your own files by what they are to you. */
const MINE = [[/icp\.md$/, "Your ICP"], [/scoring\.yaml$/, "Scoring model"], [/corrections\.md$/, "Corrections you taught it"], [/preferences\.md$/, "Your preferences"],
  [/company\/profile\.md$/, "Your company profile"], [/voice\//, "Your writing voice"], [/warm-matches|connections/, "Your team's connections"], [/known-customers/, "Your known customers"], [/calibration/, "Calibration"]];
const mineName = (label) => MINE.find(([re]) => re.test(label))?.[1] ?? label;

let P = null; // { steps, files, graph, actors, workspace }
let M = null; // live platform data (runs, funnel); arrives later
let sel = { block: null, tab: "overview" };

const allBlocks = () => P.steps.flatMap((s) => s.blocks.map((b) => ({ ...b, step: s })));
const blockById = (id) => allBlocks().find((b) => b.id === id);
const actor = (id) => P.actors.find((a) => a.id === id) ?? { id, name: id, role: "" };
/** Rows in the order work first reaches them: the ICP analyst works before the researcher does. */
const LANE_ORDER = ["you", "operator", "icp-analyst", "account-researcher", "factor-judge", "wiki-linter"];
const lanes = () => [...P.actors].sort((a, b) => LANE_ORDER.indexOf(a.id) - LANE_ORDER.indexOf(b.id));
/** Hand-off order across the funnel (the parallel maintenance step stands apart). */
const sequence = () => P.steps.filter((s) => !s.parallel).flatMap((s) => s.blocks.map((b) => ({ ...b, step: s })));

// ---------- routing ----------
const page = () => (location.pathname.startsWith("/brain") ? "brain" : "process");
function go(path, push = true) {
  if (push) history.pushState(null, "", path);
  route();
}
function route() {
  const p = page();
  $("#page-process").hidden = p !== "process";
  $("#page-brain").hidden = p !== "brain";
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.nav === p));
  document.title = p === "brain" ? "The brain · sales engine" : "Process · sales engine";
  if (!P) return;
  if (p === "process") {
    const q = new URLSearchParams(location.search);
    sel = { block: q.get("block"), tab: q.get("tab") ?? "overview" };
    renderProcess();
    const at = q.get("step") ?? (sel.block && blockById(sel.block)?.step.id);
    if (at) requestAnimationFrame(() => scrollToStep(at));
  } else renderBrain();
}

async function load(fresh = false) {
  P = await (await fetch("/api/process")).json();
  route();
  const m = await (await fetch(fresh ? "/api/refresh" : "/api/model")).json();
  M = m;
  if (page() === "process") { renderFunnel(); renderMap(); renderDetail(); }
}

// ---------- process ----------
function renderProcess() {
  $("#actors").innerHTML = lanes().map((a) => `<span><i style="background:${COLORS[a.id]}"></i>${esc(a.name)}</span>`).join("");
  $("#ctx-legend").innerHTML = `<span><i class="sq" style="background:var(--ink)"></i>Your decision</span><span class="muted">Arrows are hand-offs; dashed ones go to the next step.</span>`;
  renderFunnel();
  renderMap();
  renderDetail();
}

/** Accounts that reached a step (or got past it), from the live funnel. */
function reach(s) {
  const f = M?.funnel?.[0];
  if (!f || !s.stage) return null;
  const i = STAGES.indexOf(s.stage);
  let n = Object.entries(f.stages).filter(([st]) => STAGES.indexOf(st) >= i).reduce((a, [, v]) => a + v, 0);
  if (i <= 1) n += f.stages.excluded ?? 0;
  return n;
}
const stepRuns = (s) => (M ? M.runs.filter((r) => s.blocks.some((b) => (b.runIn ?? b.skills ?? []).includes(r.skill))) : []);

function renderFunnel() {
  const max = Math.max(1, ...P.steps.map((s) => reach(s) ?? 0));
  $("#funnel").innerHTML = P.steps.map((s) => {
    const n = reach(s);
    const gated = s.blocks.some((b) => b.gate);
    return `<button data-step="${esc(s.id)}" title="${esc(s.title)}${gated ? " · needs your decision" : ""}"><span class="fr"><span class="fn">${esc(String(s.n))}</span><span class="ft">${esc(s.short)}</span>${gated ? '<i class="gate"></i>' : ""}<span class="fv">${n ?? ""}</span></span>
      <span class="fbar"><i style="width:${n != null ? (100 * n) / max : 0}%"></i></span></button>`;
  }).join("");
}

/** Columns: each step gets one column per hand-off (parallel steps: per block of the same actor). */
function layout() {
  const cols = [];
  let c = 0;
  for (const s of P.steps) {
    const place = s.parallel
      ? s.blocks.map((b) => ({ b, i: s.blocks.filter((x) => x.by === b.by).indexOf(b) }))
      : s.blocks.map((b, i) => ({ b, i }));
    const width = Math.max(...place.map((p) => p.i)) + 1;
    cols.push({ s, start: c, width, place });
    c += width;
  }
  return { cols, total: c };
}

function blockOut(b) {
  if (b.gate) return "your decision";
  const outs = [...new Set((b.writes ?? []).map(outName))];
  return outs.length ? `→ ${outs.slice(0, 2).join(", ")}` : actor(b.by).name;
}

function renderMap() {
  const { cols, total } = layout();
  const rows = lanes();
  let html = `<div class="grid" style="grid-template-columns: 150px repeat(${total}, auto); grid-template-rows: auto repeat(${rows.length}, auto)">`;
  html += `<div class="corner" style="grid-row:1;grid-column:1"></div>`;
  for (const { s, start, width } of cols) {
    const n = reach(s), runs = stepRuns(s);
    const cost = runs.length ? `${money(runs.reduce((a, r) => a + r.cost, 0) / runs.length)} / run` : "";
    const gated = s.blocks.some((b) => b.gate);
    html += `<div class="step-head ${gated ? "gated" : ""}" id="step-${esc(s.id)}" style="grid-row:1;grid-column:${start + 2} / span ${width}">
      <span class="sn"><span class="num">${esc(String(s.n))}</span><b>${esc(s.short)}</b></span>
      <span class="muted">${[n != null ? `${n} accounts` : "", cost].filter(Boolean).join(" · ") || esc(s.title)}</span></div>`;
  }
  rows.forEach((a, r) => {
    html += `<div class="lane-name" style="grid-row:${r + 2};grid-column:1" title="${esc(a.role)}"><b><i style="background:${COLORS[a.id]}"></i>${esc(a.name)}</b></div>`;
    for (const { s, start, width, place } of cols) {
      for (let i = 0; i < width; i++) {
        const here = place.filter((p) => p.i === i && p.b.by === a.id);
        html += `<div class="cell ${i === 0 ? "first" : ""} ${here.length ? "" : "empty"}" style="grid-row:${r + 2};grid-column:${start + i + 2}">${here.map((p) => blockHtml({ ...p.b, step: s })).join("")}</div>`;
      }
    }
  });
  $("#map").innerHTML = html + "</div>";
  markSelection();
  requestAnimationFrame(drawLinks);
}

function blockHtml(b) {
  return `<div class="blk ${b.gate ? "gate" : ""}" data-block="${esc(b.id)}" style="--a:${COLORS[b.by]}"><div class="l">${esc(b.label)}</div><div class="m">${esc(blockOut(b))}</div></div>`;
}

/** Arrows between consecutive blocks: right edge to left edge, dashed where a step ends. */
function drawLinks() {
  const host = $("#map .grid");
  if (!host) return;
  host.querySelector("svg.links")?.remove();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "links");
  svg.setAttribute("width", host.scrollWidth);
  svg.setAttribute("height", host.scrollHeight);
  svg.innerHTML = `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--line-2)"/></marker></defs>`;
  const base = host.getBoundingClientRect();
  const box = (id) => {
    const r = host.querySelector(`[data-block="${id}"]`).getBoundingClientRect();
    return { l: r.left - base.left, r: r.right - base.left, cy: r.top - base.top + r.height / 2 };
  };
  const seq = sequence();
  for (let i = 1; i < seq.length; i++) {
    const p = box(seq[i - 1].id), q = box(seq[i].id);
    const mx = p.r + (q.l - p.r) / 2;
    const d = Math.abs(p.cy - q.cy) < 2 ? `M${p.r},${p.cy} H${q.l - 2}` : `M${p.r},${p.cy} H${mx} V${q.cy} H${q.l - 2}`;
    svg.insertAdjacentHTML("beforeend", `<path class="${seq[i - 1].step !== seq[i].step ? "x" : ""}" d="${d}" marker-end="url(#ah)"/>`);
  }
  host.prepend(svg);
}

function markSelection() {
  document.querySelectorAll("#map .blk.sel").forEach((n) => n.classList.remove("sel"));
  if (sel.block) document.querySelector(`#map [data-block="${CSS.escape(sel.block)}"]`)?.classList.add("sel");
}
function scrollToStep(id) {
  const head = document.getElementById(`step-${id}`);
  if (head) $("#map").scrollTo({ left: Math.max(0, head.offsetLeft - 180), behavior: "smooth" });
}
function selectBlock(id, tab = "overview") {
  const q = new URLSearchParams();
  if (id) q.set("block", id);
  if (id && tab !== "overview") q.set("tab", tab);
  history.replaceState(null, "", `/process${q.size ? `?${q}` : ""}`);
  const fresh = id !== sel.block;
  sel = { block: id, tab };
  markSelection();
  renderDetail();
  if (id && fresh) $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- details ----------
const blockRuns = (b) => (M ? M.runs.filter((r) => (b.runIn ?? b.skills ?? []).includes(r.skill) && (b.by === "operator" || r.threads.some((t) => t.agent === b.by))) : []);
const actorCost = (r, by) => (by === "operator" ? r.cost : r.threads.filter((t) => t.agent === by).reduce((a, t) => a + t.cost, 0));

function renderDetail() {
  const el = $("#detail");
  const b = sel.block && blockById(sel.block);
  if (!b) { el.hidden = true; return; }
  el.hidden = false;
  const a = actor(b.by);
  const runs = blockRuns(b);
  const tabs = b.gate
    ? [["overview", "Overview"], ["runs", "Runs", runs.length]]
    : [["overview", "Overview"], ["instructions", "Instructions"], ...(b.example ? [["output", "Example output"]] : []), ["runs", "Runs", runs.length], ["reads", "Everything it reads", b.context.length]];
  const avg = runs.length ? runs.reduce((x, r) => x + actorCost(r, b.by), 0) / runs.length : null;
  const last = runs[0];
  const kpis = b.gate ? "" : `<div class="kpis d-kpis">
      <div class="kpi"><b>${runs.length || "–"}</b><span>runs</span></div>
      <div class="kpi"><b>${avg == null ? "–" : money(avg)}</b><span>${b.by === "operator" ? "cost per run" : `${esc(a.name)} cost per run`}</span></div>
      <div class="kpi"><b>${last ? day(last.created_at) : "–"}</b><span>last run${last ? ` · <span class="st ${esc(last.status)}">${esc(last.status.replace("_", " "))}</span>` : ""}</span></div>
    </div>`;
  el.innerHTML = `<div class="d-head"><div><div class="who"><i style="background:${COLORS[b.by]}"></i>${esc(a.name)} · step ${esc(String(b.step.n))}, ${esc(b.step.title)}</div>
      <h2>${esc(b.label)}</h2><p>${esc(b.detail)}</p></div><button class="x" data-close-detail aria-label="Close">×</button></div>
    ${kpis}
    <div class="tabs">${tabs.map(([t, l, c]) => `<button data-tab="${t}" class="${sel.tab === t ? "on" : ""}">${l}${c ? `<span class="c">${c}</span>` : ""}</button>`).join("")}</div>
    <div class="d-body" id="d-body"></div>`;
  const body = $("#d-body");
  ({ overview: () => (body.innerHTML = b.gate ? gateOverview(b, runs) : overview(b, runs)), instructions: () => instructionsTab(body, b), output: () => outputTab(body, b), runs: () => (body.innerHTML = runsTab(b, runs)), reads: () => (body.innerHTML = readsTab(b)) }[sel.tab] ?? (() => (body.innerHTML = overview(b, runs))))();
}

function neighbours(b) {
  const seq = sequence();
  const i = seq.findIndex((x) => x.id === b.id);
  return { prev: i > 0 ? seq[i - 1] : null, next: i >= 0 && i < seq.length - 1 ? seq[i + 1] : null };
}
const blockLink = (x, dir) => (x ? `<button class="item" data-goblock="${esc(x.id)}"><span class="t">${dir === "in" ? "From" : "To"} ${esc(actor(x.by).name)}<small>${esc(x.label)}</small></span><span class="arrow">${dir === "in" ? "←" : "→"}</span></button>` : "");

function overview(b, runs) {
  const { prev, next } = neighbours(b);
  const knowledge = b.context.filter((c) => c.category === "knowledge");
  const outs = [...new Map((b.writes ?? []).map((w) => [outName(w), w])).entries()];
  const follows = [
    ...(b.agent === "operator" ? [["virtual:operator", "Coordinator's instructions"]] : b.agent ? [[`engine:agents/${b.agent}.md`, `${actor(b.agent).name}'s instructions`]] : []),
    ...(b.skills ?? []).map((s) => [`engine:skills/${s}/SKILL.md`, `The ${s} playbook`]),
  ];
  const checks = runs.flatMap((r) => r.checks.map((c) => ({ c, r }))).slice(0, 6);
  return `<div class="cols">
      <div class="col"><h4>Receives</h4><div class="list">
        ${blockLink(prev, "in") || (b.step.parallel ? `<div class="item"><span class="t">On a schedule<small>Runs by itself, alongside the funnel</small></span></div>` : "")}
        ${knowledge.map((x) => itemFile(x.id, mineName(x.label), x.label)).join("")}
      </div>${knowledge.length ? "" : `<p class="muted">Uses none of your own files directly.</p>`}</div>
      <div class="col"><h4>Follows</h4><div class="list">${follows.map(([id, l]) => itemFile(id, l)).join("")}</div>
        ${b.tools?.length ? `<h4 style="margin-top:20px">Uses</h4><div class="tags">${b.tools.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}</div>
      <div class="col"><h4>Hands over</h4><div class="list">
        ${outs.map(([name, path]) => `<div class="item"><span class="t">${esc(name)}<small>${esc(path)}</small></span></div>`).join("")}
        ${blockLink(next, "out")}
      </div>${b.example ? `<p style="margin:12px 0 0"><button class="tag" data-tab="output">See a real example →</button></p>` : ""}</div>
    </div>
    ${checks.length ? `<h4 style="margin-top:28px">Flagged for you to double-check</h4><ul class="checklist">${checks.map(({ c, r }) => `<li><span>${esc(c)} <span class="muted">· ${day(r.created_at)}</span></span></li>`).join("")}</ul>` : ""}`;
}
const itemFile = (id, label, note) => `<button class="item" data-file="${esc(id)}"><span class="t">${esc(label)}${note ? `<small>${esc(note)}</small>` : ""}</span><span class="arrow">↗</span></button>`;

function gateOverview(b, runs) {
  const { prev, next } = neighbours(b);
  return `<div class="cols"><div class="col"><h4>What you check</h4><ol class="checklist">${(b.check ?? []).map((c) => `<li><span>${esc(c)}</span></li>`).join("")}</ol></div>
    <div class="col"><h4>Before and after</h4><div class="list">${blockLink(prev, "in")}${blockLink(next, "out")}</div>
    <p class="muted" style="margin-top:12px">Nothing moves past this point without your approval. Scheduled runs stop here and wait for you.</p></div></div>`;
}

async function instructionsTab(el, b) {
  const docs = [
    ...(b.agent === "operator" ? [["virtual:operator", "Coordinator's instructions", "Who the Coordinator is and how it hands work out"]] : b.agent ? [[`engine:agents/${b.agent}.md`, `${actor(b.agent).name}'s instructions`, actor(b.agent).role]] : []),
    ...(b.skills ?? []).map((s) => [`engine:skills/${s}/SKILL.md`, `The ${s} playbook`, "The step-by-step procedure"]),
    ...b.context.filter((c) => c.category === "method" && c.id.startsWith("engine:")).map((c) => [c.id, c.label, "Rules and method it applies"]),
  ];
  el.innerHTML = `<p class="muted" style="margin:0 0 14px">What ${esc(actor(b.by).name)} is told to do here. Open one to read it in full.</p>
    <div class="docs">${docs.map(([id, t, s]) => `<button class="doc" data-file="${esc(id)}"><b>${esc(t)}</b><em>${esc(s ?? "")}</em><span>${esc(id.replace(/^engine:/, "").replace("virtual:operator", "generated from the engine"))}</span></button>`).join("")}</div>`;
}

async function outputTab(el, b) {
  el.innerHTML = `<p class="muted">Loading…</p>`;
  const f = await (await fetch(`/api/example?pattern=${encodeURIComponent(b.example)}`)).json();
  if (sel.block !== b.id) return;
  el.innerHTML = f.error ? `<p class="empty-note">${esc(f.error)}</p>` : `<p class="muted" style="margin:0 0 14px">The newest real ${esc(outName(f.path).toLowerCase())} in your workspace: <span class="tag mono">${esc(f.path)}</span></p><div class="prose">${render(f.path, f.text)}</div>`;
}

function runsTab(b, runs) {
  if (!M) return `<p class="muted">Loading live data from the platform…</p>`;
  if (!runs.length) return `<p class="empty-note">No runs yet.</p>`;
  return `<table class="runs"><tr><th>Date</th><th>Run</th><th>Status</th><th class="r">${b.by === "operator" ? "Cost" : `${esc(actor(b.by).name)}`}</th><th class="r">Whole run</th></tr>
    ${runs.map((r) => `<tr><td>${day(r.created_at)}</td><td><a href="https://platform.claude.com/sessions/${esc(r.session_id)}" target="_blank" rel="noopener">${esc(r.skill)} ${esc((r.args || "").slice(0, 44))} ↗</a></td><td><span class="st ${esc(r.status)}">${esc(r.status.replace("_", " "))}</span></td><td class="r">${money(actorCost(r, b.by))}</td><td class="r">${money(r.cost)}</td></tr>`).join("")}</table>`;
}

function readsTab(b) {
  const total = Object.values(b.tokens).reduce((x, y) => x + y, 0) || 1;
  const max = Math.max(1, ...b.context.map((c) => c.tokens));
  return `<p class="muted" style="margin:0 0 12px">Everything in ${esc(actor(b.by).name)}'s head for this step before it looks anything up, about ${k(total)} tokens. Click a file to read it.</p>
    <div class="compo">${CATS.map(([c, , col]) => (b.tokens[c] ? `<i style="flex:${b.tokens[c]};background:${col}"></i>` : "")).join("")}</div>
    <div class="legend" style="margin-bottom:18px">${CATS.filter(([c]) => b.tokens[c]).map(([c, l, col]) => `<span><i class="sq" style="background:${col}"></i>${l} ${Math.round((100 * b.tokens[c]) / total)}%</span>`).join("")}</div>
    <div class="cols">${CATS.map(([c, l, col]) => {
      const items = b.context.filter((x) => x.category === c).sort((x, y) => y.tokens - x.tokens);
      if (!items.length) return "";
      return `<div class="col"><h4>${l}</h4>${items.map((x) => {
        const link = /^(engine:|workspace:|data:|virtual:operator)/.test(x.id);
        return `<button class="ctx-row ${link ? "" : "nolink"}" ${link ? `data-file="${esc(x.id)}"` : ""}><span class="t">${esc(x.label)}${x.note ? `<small>${esc(x.note)}</small>` : ""}</span><span class="n">${x.tokens ? k(x.tokens) : "–"}</span><span class="b"><i style="background:${col};width:${(100 * x.tokens) / max}%"></i></span></button>`;
      }).join("")}</div>`;
    }).join("")}</div>`;
}

// ---------- reading sheet ----------
const md = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = m ? text.slice(m[0].length) : text;
  return `${m ? `<details class="fm"><summary>frontmatter</summary><pre class="raw">${esc(m[1])}</pre></details>` : ""}<div class="md">${clean(marked.parse(body))}</div>`;
};
/** Workspace files quote web pages: keep the markdown's formatting, drop anything active. */
function clean(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  t.content.querySelectorAll("script, style, iframe, object, embed, link, meta, form").forEach((n) => n.remove());
  t.content.querySelectorAll("*").forEach((n) => {
    for (const a of [...n.attributes]) if (a.name.startsWith("on") || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
  });
  return t.innerHTML;
}
const render = (path, text, parsed) => {
  if (/\.md$/.test(path) || path === "operator") return md(text);
  if (parsed?.factors) return scoringTable(parsed) + `<details style="margin-top:14px"><summary class="muted">raw YAML</summary><pre class="raw">${esc(text)}</pre></details>`;
  return `<pre class="raw">${esc(text)}</pre>`;
};
/** A scoring model as people read it: groups and weights, then every factor with what each level means. */
function scoringTable(m) {
  const groups = Object.entries(m.groups ?? {}).map(([g, w]) => `<span class="tag">${esc(g)} ${Math.round(w * 100)}%</span>`).join("");
  const tiers = m.tiers ? `<span class="tag">tier A ≥ ${m.tiers.A}</span><span class="tag">tier B ≥ ${m.tiers.B}</span>` : "";
  return `<div class="tags" style="margin-bottom:6px">${groups}${tiers}<span class="tag">version ${esc(String(m.version ?? "?"))}</span></div>` +
    m.factors.map((f) => `<div class="factor"><div class="fh"><b>${esc(f.name ?? f.id)}</b><span class="muted">${esc(f.group)} · weight ${esc(String(f.weight))}${f.light ? " · light" : ""}${f.knockout ? " · knockout" : ""}</span></div>
      ${f.question ? `<div class="muted" style="margin:2px 0 4px">${esc(f.question)}</div>` : ""}
      <ol class="lv">${[0, 1, 2, 3].map((l) => `<li><span>${l}</span>${esc(f.levels?.[l] ?? "")}</li>`).join("")}</ol></div>`).join("");
}
const cleanTitle = (f) => f.title.replace(/\s*\(.*?\)\s*$/, "").replace(/^skills\//, "") || f.path;

async function openFile(id) {
  const f = P.files.find((x) => x.id === id) ?? { id, path: id.split(":").slice(1).join(":") || id, title: id === "virtual:operator" ? "Coordinator's instructions" : id, layer: "agent", tokens: 0, used_by: [] };
  const used = f.used_by.map(blockById).filter(Boolean);
  const sheet = $("#sheet");
  sheet.hidden = false;
  document.body.style.overflow = "hidden";
  sheet.querySelector(".sheet-body").innerHTML = `<div class="sheet-top"><span class="who">${esc(LAYERS[f.layer] ?? "File")}</span><button class="x" data-close aria-label="Close">×</button></div>
    <h2>${esc(cleanTitle(f))}</h2><div class="path">${esc(f.path)}</div>
    <div class="meta">${f.modified ? `<span>changed ${esc(f.modified)}</span>` : ""}${used.length ? `<span>read in ${used.length} block${used.length === 1 ? "" : "s"}</span>` : ""}</div>
    ${used.length ? `<div class="readby"><h4>Used in</h4><div class="tags">${used.map((b) => `<button class="tag" data-goblock="${esc(b.id)}">${esc(String(b.step.n))} · ${esc(b.label)}</button>`).join("")}</div></div>` : ""}
    <div id="sheet-content"><p class="muted">Loading…</p></div>`;
  const res = id.startsWith("data:") ? await fetch(`/api/example?pattern=${encodeURIComponent(id.slice(5))}`) : await fetch(`/api/file?id=${encodeURIComponent(id)}`);
  const j = await res.json();
  const target = $("#sheet-content");
  if (!target) return;
  target.innerHTML = j.error ? `<p class="empty-note">${esc(j.error)}</p>` : `${id.startsWith("data:") ? `<p class="muted">One company's version, as an example: ${esc(j.path)}</p>` : ""}${render(j.path, j.text, j.parsed)}`;
}
function closeSheet() {
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
}

// ---------- the brain ----------
const FLOW_COLS = [["your knowledge", "var(--c4)"], ["rules & method", "var(--c2)"], ["playbooks", "var(--c3)"], ["agents", null], ["process", "var(--ink)"]];
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 999);

/** The brain as a flow: your knowledge → rules & method → playbooks → agents → process steps. */
function renderBrain() {
  const g = P.graph;
  const counts = [0, 1, 2, 3, 4].map((c) => g.nodes.filter((n) => n.col === c).length);
  const tok = (c) => g.nodes.filter((n) => n.col === c).reduce((a, n) => a + (n.tokens ?? 0), 0);
  $("#brain-stats").innerHTML = [["Your knowledge", counts[0], "files"], ["Rules & method", counts[1], "files"], ["Playbooks", counts[2], ""], ["Agents", counts[3], ""], ["Connections", g.edges.length, ""]]
    .map(([l, n]) => `<div class="kpi"><b>${n}</b><span>${l}</span></div>`).join("");
  void tok;
  const host = $("#brain");
  const W = Math.max(980, host.clientWidth - 42), NW = Math.min(214, (W - 40) / 5 - 40), ROW = 32, TOP = 36, H0 = 23;
  const out = new Map();
  for (const e of g.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)).push(e.to);
  // order each column by the earliest step it feeds, then the average (fewest crossings)
  const pos = new Map();
  const col = (c) => g.nodes.filter((n) => n.col === c);
  col(4).forEach((n, i) => pos.set(n.id, i));
  for (const c of [3, 2, 1, 0]) {
    const ns = col(c).map((n) => { const t = (out.get(n.id) ?? []).map((x) => pos.get(x)).filter((x) => x != null); return { n, lo: t.length ? Math.min(...t) : 999, m: avg(t) }; });
    ns.sort((x, y) => x.lo - y.lo || x.m - y.m).forEach(({ n }, i) => pos.set(n.id, i));
  }
  const tallest = Math.max(...counts);
  const H = TOP + tallest * ROW + 10;
  const xOf = (c) => 10 + (c * (W - NW - 20)) / 4;
  const yOf = (n) => TOP + ((tallest - counts[n.col]) * ROW) / 2 + pos.get(n.id) * ROW;
  const at = new Map(g.nodes.map((n) => [n.id, { x: xOf(n.col), y: yOf(n) }]));
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="flow">`;
  FLOW_COLS.forEach(([name], c) => { svg += `<text x="${xOf(c)}" y="14" class="ch">_${name} <tspan class="cnt">${counts[c]}</tspan></text>`; });
  for (const e of g.edges) {
    const a = at.get(e.from), b = at.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + NW, y1 = a.y + H0 / 2, x2 = b.x, y2 = b.y + H0 / 2, mx = (x1 + x2) / 2;
    svg += `<path class="e" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
  }
  for (const n of g.nodes) {
    const { x, y } = at.get(n.id);
    const color = n.col === 3 ? COLORS[n.id.slice(2)] ?? "var(--muted)" : FLOW_COLS[n.col][1];
    const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
    svg += `<g class="n" data-node="${esc(n.id)}" transform="translate(${x},${y})"><title>${esc(n.label)}${n.sub ? ` · ${esc(n.sub)}` : ""}</title>
      <rect width="${NW}" height="${H0}" rx="6" class="box"/><rect x="0" y="6" width="3" height="${H0 - 12}" rx="1.5" style="fill:${color}"/>
      <text x="11" y="15.5" class="nl">${esc(label)}</text></g>`;
  }
  host.innerHTML = svg + "</svg>";
}

/** The flow nodes a block touches: its agent, its playbooks, the files in its context and its step. */
function blockNodes(b) {
  const ids = (b.skills ?? []).map((sk) => `p:${sk}`);
  if (b.agent) ids.push(`a:${b.agent}`);
  ids.push(`s:${b.step.id}`);
  for (const c of b.context) ids.push(`f:${c.id}`);
  const known = new Set(P.graph.nodes.map((n) => n.id));
  return ids.filter((i) => known.has(i));
}
/** Light the chains through the blocks a node is part of; following blocks keeps a trace honest. */
function lightNode(id) {
  const host = $("#brain");
  if (!id) { host.classList.remove("dim"); return; }
  const onlyFile = id.startsWith("f:") ? id : null;
  const sets = allBlocks().filter((b) => blockNodes(b).includes(id)).map((b) => new Set(blockNodes(b).filter((n) => !onlyFile || !n.startsWith("f:") || n === onlyFile)));
  const keep = new Set(sets.flatMap((s) => [...s]));
  host.classList.add("dim");
  host.querySelectorAll(".n").forEach((n) => n.classList.toggle("hl", keep.has(n.dataset.node) || n.dataset.node === id));
  host.querySelectorAll(".e").forEach((e) => e.classList.toggle("hl", sets.some((s) => s.has(e.dataset.from) && s.has(e.dataset.to))));
}

// ---------- events ----------
document.addEventListener("click", (e) => {
  const nav = e.target.closest("a[data-nav]");
  if (nav) { e.preventDefault(); closeSheet(); return go(nav.getAttribute("href")); }
  if (e.target.closest("[data-close]")) return closeSheet();
  if (e.target.closest("[data-close-detail]")) return selectBlock(null);
  const gb = e.target.closest("[data-goblock]");
  if (gb) { closeSheet(); if (page() !== "process") go(`/process?block=${gb.dataset.goblock}`); else selectBlock(gb.dataset.goblock); return; }
  const f = e.target.closest("[data-file]");
  if (f) return openFile(f.dataset.file);
  const t = e.target.closest("[data-tab]");
  if (t) return selectBlock(sel.block, t.dataset.tab);
  const b = e.target.closest("#map [data-block]");
  if (b) return selectBlock(b.dataset.block === sel.block ? null : b.dataset.block);
  const st = e.target.closest("#funnel [data-step]");
  if (st) return scrollToStep(st.dataset.step);
  const n = e.target.closest("#brain [data-node]");
  if (n) {
    const node = P.graph.nodes.find((x) => x.id === n.dataset.node);
    if (node?.ref) return openFile(node.ref);
    if (node?.id.startsWith("s:")) return go(`/process?step=${node.id.slice(2)}`);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#sheet").hidden) return closeSheet();
  if (page() === "process") selectBlock(null);
});
document.addEventListener("mouseover", (e) => { const n = e.target.closest?.("#brain [data-node]"); if (n) lightNode(n.dataset.node); });
document.addEventListener("mouseout", (e) => { if (e.target.closest?.("#brain [data-node]") && !e.relatedTarget?.closest?.("#brain [data-node]")) lightNode(null); });
window.addEventListener("popstate", () => route());
$("#refresh").addEventListener("click", () => load(true));
let rt;
window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => (page() === "process" ? drawLinks() : renderBrain()), 120); });
load();
