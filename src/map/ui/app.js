// Process map: swimlane of every block, an inspector per block or file, and the brain (every file behind it).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (x) => `$${(x ?? 0).toFixed(2)}`;
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const COLORS = { you: "var(--gate)", operator: "var(--s1)", "account-researcher": "var(--s2)", "factor-judge": "var(--s3)", "wiki-linter": "var(--s4)", "icp-analyst": "var(--s5)" };
const CATS = [["instructions", "Agent instructions", "var(--c1)"], ["playbook", "Playbook", "var(--c2)"], ["method", "Rules & method", "var(--c3)"], ["knowledge", "Your knowledge", "var(--c4)"], ["data", "Company data", "var(--c5)"]];
const LAYERS = [["knowledge", "Your knowledge", "From your workspace: who you are, who you sell to, what you've learned"], ["method", "Rules & method", "How the engine thinks"], ["template", "Templates", "The shape of every output"], ["playbook", "Playbooks", "Step-by-step instructions per workflow"], ["agent", "Agents", "Who each specialist is"]];
const STAGES = ["discovered", "light_scored", "shortlisted", "researched", "scored", "outreach_ready"];

let P = null; // { steps, files, actors, workspace }
let M = null; // live platform data (runs, funnel); arrives later
let state = { kind: "intro", id: null, tab: "overview", back: null };
const blockById = () => new Map(P.steps.flatMap((s) => s.blocks.map((b) => [b.id, { ...b, step: s }])));
const actor = (id) => P.actors.find((a) => a.id === id) ?? { id, name: id, role: "" };

async function load(fresh = false) {
  P = await (await fetch("/api/process")).json();
  renderLegend();
  renderLanes();
  renderBrain();
  renderInspector();
  fetch(fresh ? "/api/refresh" : "/api/model").then((r) => r.json()).then((m) => { M = m; renderLanes(); renderInspector(); });
}

function renderLegend() {
  $("#actors").innerHTML = P.actors.map((a) => `<span><i class="dot" style="background:${COLORS[a.id]}"></i>${esc(a.name)}</span>`).join("");
  $("#ctx-legend").innerHTML = `<span class="muted">Context per block:</span>${CATS.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join("")}`;
}

// ---------- swimlane ----------
function stepLive(s) {
  if (!M) return "";
  const runs = M.runs.filter((r) => s.blocks.some((b) => (b.skills ?? []).includes(r.skill)));
  const f = M.funnel?.[0];
  let reach = "";
  if (f && s.stage) {
    const i = STAGES.indexOf(s.stage);
    let n = Object.entries(f.stages).filter(([st]) => STAGES.indexOf(st) >= i).reduce((a, [, v]) => a + v, 0);
    if (i <= 1) n += f.stages.excluded ?? 0;
    reach = `${n} accounts`;
  }
  const cost = runs.length ? `${money(runs.reduce((a, r) => a + r.cost, 0) / runs.length)} / run` : "";
  return [reach, cost, runs.length ? `${runs.length} runs` : ""].filter(Boolean).join("<br>");
}

function renderLanes() {
  const lanes = P.actors;
  const maxTok = Math.max(...P.steps.flatMap((s) => s.blocks.map((b) => Object.values(b.tokens).reduce((x, y) => x + y, 0))));
  let html = `<div class="lane-head"><div></div>${lanes.map((a) => `<div title="${esc(a.role)}"><i class="dot" style="width:9px;height:9px;border-radius:50%;background:${COLORS[a.id]}"></i>${esc(a.name)}</div>`).join("")}</div>`;
  for (const s of P.steps) {
    const gated = s.blocks.some((b) => b.gate);
    // one grid row per block in hand-off order (parallel steps: blocks of a lane stack in one row each)
    const place = s.parallel
      ? s.blocks.map((b) => ({ b, row: s.blocks.filter((x) => x.by === b.by).indexOf(b) + 1 }))
      : s.blocks.map((b, i) => ({ b, row: i + 1 }));
    const rows = Math.max(...place.map((p) => p.row));
    html += `<div class="row ${gated ? "gated" : ""}" data-step="${s.id}" style="grid-template-rows:repeat(${rows}, auto)">
      <div class="gut" style="grid-row:1 / -1"><span class="num">${esc(String(s.n))}</span><b>${esc(s.short)}</b><span class="muted">${stepLive(s)}</span></div>
      ${lanes.map((a, c) => `<div class="cell" style="grid-column:${c + 2};grid-row:1 / -1"></div>`).join("")}
      ${place.map(({ b, row }) => `<div class="place" style="grid-column:${lanes.findIndex((a) => a.id === b.by) + 2};grid-row:${row}">${blockHtml(b, maxTok)}</div>`).join("")}
    </div>`;
  }
  $("#lanes").innerHTML = html;
  applySelection();
  requestAnimationFrame(drawLinks);
}

function blockHtml(b, maxTok) {
  const total = Object.values(b.tokens).reduce((x, y) => x + y, 0);
  const files = b.context.length;
  const bar = total ? `<span class="ctxbar" style="width:${Math.max(12, (100 * total) / maxTok)}%">${CATS.map(([c, , col]) => (b.tokens[c] ? `<i style="flex:${b.tokens[c]};background:${col}"></i>` : "")).join("")}</span>` : "";
  const meta = b.gate ? "your decision" : `${files} sources · ${k(total)} tokens`;
  return `<div class="blk ${b.gate ? "gate" : ""}" data-block="${b.id}" style="--a:${COLORS[b.by]}"><div class="l">${esc(b.label)}</div>${bar ? `<div class="bw">${bar}</div>` : ""}<div class="m">${meta}</div></div>`;
}

/** Arrows between consecutive blocks (hand-offs), within a step and on to the next. */
function drawLinks() {
  const host = $("#lanes");
  host.style.position = "relative";
  host.querySelector("svg.links")?.remove();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "links");
  svg.setAttribute("width", host.scrollWidth);
  svg.setAttribute("height", host.scrollHeight);
  svg.innerHTML = `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--axis)"/></marker></defs>`;
  const base = host.getBoundingClientRect();
  const box = (id) => {
    const r = host.querySelector(`[data-block="${id}"]`).getBoundingClientRect();
    return { cx: r.left - base.left + host.scrollLeft + r.width / 2, top: r.top - base.top + host.scrollTop, bottom: r.bottom - base.top + host.scrollTop };
  };
  const seq = P.steps.filter((s) => !s.parallel).flatMap((s) => s.blocks.map((b) => ({ b, s })));
  for (let i = 1; i < seq.length; i++) {
    const p = box(seq[i - 1].b.id), q = box(seq[i].b.id);
    const mid = p.bottom + (q.top - p.bottom) / 2;
    const d = Math.abs(p.cx - q.cx) < 2 ? `M${p.cx},${p.bottom} V${q.top - 2}` : `M${p.cx},${p.bottom} V${mid} H${q.cx} V${q.top - 2}`;
    const between = seq[i - 1].s !== seq[i].s;
    svg.insertAdjacentHTML("beforeend", `<path d="${d}" fill="none" stroke="var(--axis)" stroke-width="1.3" ${between ? 'stroke-dasharray="3 4"' : ""} marker-end="url(#ah)"/>`);
  }
  host.prepend(svg);
}

// ---------- the brain ----------
const FLOW_COLS = [["Your knowledge", "var(--c4)"], ["Rules & method", "var(--c3)"], ["Playbooks", "var(--c2)"], ["Agents", null], ["Process", "var(--gate)"]];

/** The brain as a flow: your knowledge → rules & method → playbooks → agents → process steps. */
function renderBrain() {
  const g = P.graph;
  const host = $("#brain");
  const W = Math.max(860, host.clientWidth), NW = Math.min(196, (W - 40) / 5 - 34), ROW = 31, TOP = 34, H0 = 22;
  const out = new Map(), inn = new Map();
  for (const e of g.edges) { (out.get(e.from) ?? out.set(e.from, []).get(e.from)).push(e.to); (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)).push(e.from); }
  // order each column by the average position of what it feeds (fewest crossings), starting from the fixed process order
  const pos = new Map();
  const col = (c) => g.nodes.filter((n) => n.col === c);
  col(4).forEach((n, i) => pos.set(n.id, i));
  for (const c of [3, 2, 1, 0]) {
    // first by the earliest thing it feeds (so the columns follow the process order), then by the average
    const ns = col(c).map((n) => { const t = (out.get(n.id) ?? []).map((x) => pos.get(x)).filter((x) => x != null); return { n, lo: t.length ? Math.min(...t) : 999, m: avg(t) }; });
    ns.sort((x, y) => x.lo - y.lo || x.m - y.m).forEach(({ n }, i) => pos.set(n.id, i));
  }
  const counts = [0, 1, 2, 3, 4].map((c) => col(c).length);
  const tallest = Math.max(...counts);
  const H = TOP + tallest * ROW + 10;
  const xOf = (c) => 10 + (c * (W - NW - 20)) / 4;
  const yOf = (n) => TOP + ((tallest - counts[n.col]) * ROW) / 2 + pos.get(n.id) * ROW;
  const at = new Map(g.nodes.map((n) => [n.id, { x: xOf(n.col), y: yOf(n) }]));
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="flow">`;
  FLOW_COLS.forEach(([name], c) => { svg += `<text x="${xOf(c)}" y="14" class="ch">${name} <tspan class="cnt">${counts[c]}</tspan></text>`; });
  for (const e of g.edges) {
    const a = at.get(e.from), b = at.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + NW, y1 = a.y + H0 / 2, x2 = b.x, y2 = b.y + H0 / 2, mx = (x1 + x2) / 2;
    svg += `<path class="e" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
  }
  for (const n of g.nodes) {
    const { x, y } = at.get(n.id);
    const color = n.col === 3 ? COLORS[n.id.slice(2)] ?? "var(--muted)" : FLOW_COLS[n.col][1];
    const label = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
    svg += `<g class="n" data-node="${esc(n.id)}" transform="translate(${x},${y})"><title>${esc(n.label)}${n.sub ? ` · ${esc(n.sub)}` : ""}</title>
      <rect width="${NW}" height="${H0}" rx="5" class="box"/><rect width="4" height="${H0}" rx="2" style="fill:${color}"/>
      <text x="11" y="15" class="nl">${esc(label)}</text>${n.tokens ? `<text x="${NW - 7}" y="15" class="nt">${k(n.tokens)}</text>` : ""}</g>`;
  }
  host.innerHTML = svg + "</svg>";
  $("#brain-sub").textContent = `${g.nodes.filter((n) => n.col < 3).length} files · ${g.edges.length} connections`;
  applySelection();
}
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 999);

/**
 * Light the chains of some blocks: per block its files, playbooks, agent and step, and only the lines between them.
 * Following blocks (not the graph) keeps a trace honest: a file reaches a step only through a block that reads it.
 */
function lightBlocks(blocks, onlyFile = null) {
  const host = $("#brain");
  const sets = blocks.map((b) => new Set(blockNodes(b).filter((n) => !onlyFile || !n.startsWith("f:") || n === onlyFile)));
  const keep = new Set(sets.flatMap((s) => [...s]));
  host.classList.toggle("dim", blocks.length > 0);
  host.querySelectorAll(".n").forEach((n) => n.classList.toggle("hl", keep.has(n.dataset.node)));
  host.querySelectorAll(".e").forEach((e) => e.classList.toggle("hl", sets.some((s) => s.has(e.dataset.from) && s.has(e.dataset.to))));
}
/** Hover or select a node: the blocks it's part of. */
function lightNode(id) {
  if (!id) return lightBlocks([]);
  const blocks = allBlocks().filter((b) => blockNodes(b).includes(id));
  lightBlocks(blocks, id.startsWith("f:") ? id : null);
}
const allBlocks = () => P.steps.flatMap((s) => s.blocks.map((b) => ({ ...b, step: s })));
const lightFlow = (ids) => lightNode(ids[0]);
/** The flow nodes a block touches: its agent, its playbooks, the files in its context and its step. */
function blockNodes(b) {
  const ids = (b.skills ?? []).map((sk) => `p:${sk}`);
  if (b.agent) ids.push(`a:${b.agent}`);
  ids.push(`s:${b.step.id}`);
  for (const c of b.context) ids.push(`f:${c.id}`);
  const known = new Set(P.graph.nodes.map((n) => n.id));
  return ids.filter((i) => known.has(i));
}
const cleanTitle = (f) => f.title.replace(/\s*\(.*?\)\s*$/, "").replace(/^skills\//, "") || f.path;

// ---------- selection ----------
function select(kind, id, tab = "overview") {
  state = { kind, id, tab, back: kind === "file" && state.kind === "block" ? { ...state } : null };
  applySelection();
  renderInspector();
}
function applySelection() {
  const lanes = $("#lanes");
  document.querySelectorAll("#lanes .sel, #lanes .hl").forEach((n) => n.classList.remove("sel", "hl"));
  lanes.classList.remove("dim");
  if (!P) return;
  if (!state.id) return lightFlow([]);
  if (state.kind === "block") {
    const b = blockById().get(state.id);
    lanes.querySelector(`[data-block="${state.id}"]`)?.classList.add("sel");
    if (b) lightBlocks([b]);
  } else if (state.kind === "file" || state.kind === "node") {
    const node = P.graph.nodes.find((n) => n.id === state.id || n.ref === state.id);
    lightNode(node?.id);
    const blocks = node ? blocksOfNode(node.id) : [];
    if (blocks.length) {
      lanes.classList.add("dim");
      for (const id of blocks) lanes.querySelector(`[data-block="${id}"]`)?.classList.add("hl");
    }
  }
}
/** Blocks that use a flow node directly: its file is in their context, they follow that playbook, are that agent, or sit in that step. */
const blocksOfNode = (id) => allBlocks().filter((b) => blockNodes(b).includes(id)).map((b) => b.id);

// ---------- inspector ----------
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
  if (/\.(md)$/.test(path) || path === "operator") return md(text);
  if (parsed?.factors) return scoringTable(parsed) + `<details><summary class="muted">raw YAML</summary><pre class="raw">${esc(text)}</pre></details>`;
  return `<pre class="raw">${esc(text)}</pre>`;
};
/** A scoring model as people read it: groups and weights, then every factor with what each level means. */
function scoringTable(m) {
  const groups = Object.entries(m.groups ?? {}).map(([g, w]) => `<span class="chip">${esc(g)} ${Math.round(w * 100)}%</span>`).join("");
  const tiers = m.tiers ? `<span class="chip">tier A ≥ ${m.tiers.A}</span><span class="chip">tier B ≥ ${m.tiers.B}</span>` : "";
  const tf = m.tier_from ? `<span class="chip">tier from ${esc(m.tier_from.join(" + "))}</span>` : "";
  return `<div class="chips" style="margin-bottom:10px">${groups}${tiers}${tf}<span class="chip">version ${esc(String(m.version ?? "?"))}</span></div>` +
    m.factors.map((f) => `<div class="factor"><div class="fh"><b>${esc(f.name ?? f.id)}</b><span class="muted">${esc(f.group)} · weight ${esc(String(f.weight))}${f.light ? " · light" : ""}${f.knockout ? " · knockout" : ""}</span></div>
      ${f.question ? `<div class="muted" style="margin:2px 0 4px">${esc(f.question)}</div>` : ""}
      <ol class="lv" start="0">${[0, 1, 2, 3].map((l) => `<li><span>${l}</span>${esc(f.levels?.[l] ?? "")}</li>`).join("")}</ol></div>`).join("");
}

function renderInspector() {
  const el = $("#inspector");
  if (!P) return;
  if (state.kind === "block") return inspectBlock(el, blockById().get(state.id));
  if (state.kind === "node") return inspectStep(el, P.steps.find((x) => `s:${x.id}` === state.id));
  if (state.kind === "file") return inspectFile(el, P.files.find((f) => f.id === state.id) ?? { id: state.id, path: state.id.split(":")[1], title: state.id, layer: "data", tokens: 0, used_by: [] });
  const totals = Object.fromEntries(CATS.map(([c]) => [c, 0]));
  el.innerHTML = `<h3>Select a block</h3><p class="lead">Every block is one actor doing one thing. Click it to see exactly what it does, what it reads, what it follows, what it produces and what it costs.</p>
    <h4>Reading the map</h4><ul class="check"><li>Rows are steps, top to bottom; columns are who does the work.</li><li>Black blocks are decisions only you make.</li><li>The small bar in each block is its context: what goes into that agent's head.</li><li>Below, the brain: every file behind it. Click one to read it.</li></ul>
    <h4>Context, by source</h4>${CATS.map(([, l, c]) => `<div class="legend" style="margin:4px 0"><span><i style="background:${c}"></i>${l}</span></div>`).join("")}`;
  void totals;
}

function inspectBlock(el, b) {
  if (!b) return;
  const a = actor(b.by);
  const tabs = b.gate ? [["overview", "Overview"]] : [["overview", "Overview"], ["context", "Context"], ["instructions", "Instructions"], ...(b.example ? [["output", "Output"]] : []), ["runs", "Runs"]];
  const head = `<div class="ins-who"><i style="background:${COLORS[b.by]}"></i>${esc(a.name)} · step ${esc(String(b.step.n))} ${esc(b.step.title)}</div><h3>${esc(b.label)}</h3><p class="lead">${esc(b.detail)}</p>
    <div class="tabs">${tabs.map(([t, l]) => `<button data-tab="${t}" class="${state.tab === t ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const body = {
    overview: () => overview(b),
    context: () => contextTab(b),
    instructions: () => "<p class='muted'>Loading…</p>",
    output: () => "<p class='muted'>Loading…</p>",
    runs: () => runsTab(b),
  }[state.tab]?.() ?? "";
  el.innerHTML = head + `<div id="tab">${body}</div>`;
  if (state.tab === "instructions") instructionsTab(b);
  if (state.tab === "output") outputTab(b);
}

function overview(b) {
  if (b.gate) return `<h4>What you check</h4><ol class="check">${(b.check ?? []).map((c) => `<li>${esc(c)}</li>`).join("")}</ol>`;
  const total = Object.values(b.tokens).reduce((x, y) => x + y, 0);
  const runs = blockRuns(b);
  const cost = runs.length ? runs.reduce((a, r) => a + actorCost(r, b.by), 0) / runs.length : null;
  return `<div class="stats"><div class="stat"><b>${b.context.length}</b><span>context sources</span></div><div class="stat"><b>${k(total)}</b><span>tokens of fixed context</span></div><div class="stat"><b>${cost == null ? "–" : money(cost)}</b><span>${esc(actor(b.by).name)} cost / run</span></div></div>
    <h4>Context mix</h4>${compo(b)}
    ${(b.skills ?? []).length ? `<h4>Follows</h4><div class="chips">${b.skills.map((s) => `<button class="chip" data-file="engine:skills/${s}/SKILL.md">${esc(s)} playbook</button>`).join("")}${b.agent && b.agent !== "operator" ? `<button class="chip" data-file="engine:agents/${b.agent}.md">${esc(actor(b.agent).name)} instructions</button>` : b.agent === "operator" ? `<button class="chip" data-file="virtual:operator">Coordinator instructions</button>` : ""}</div>` : ""}
    ${b.tools?.length ? `<h4>Tools</h4><div class="chips">${b.tools.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
    ${b.writes?.length ? `<h4>Produces</h4><div class="chips">${b.writes.map((w) => `<span class="chip">${esc(w)}</span>`).join("")}</div>` : ""}`;
}

const compo = (b) => {
  const total = Object.values(b.tokens).reduce((x, y) => x + y, 0) || 1;
  return `<div class="compo">${CATS.map(([c, , col]) => (b.tokens[c] ? `<i style="flex:${b.tokens[c]};background:${col}" title="${c}"></i>` : "")).join("")}</div>
    <div class="legend">${CATS.filter(([c]) => b.tokens[c]).map(([c, l, col]) => `<span><i style="background:${col}"></i>${l} ${Math.round((100 * b.tokens[c]) / total)}%</span>`).join("")}</div>`;
};

function contextTab(b) {
  const max = Math.max(1, ...b.context.map((c) => c.tokens));
  return `<p class="muted">What goes into ${esc(actor(b.by).name)}'s context for this block, before any web pages it fetches. Click a source to read it.</p>${compo(b)}` +
    CATS.map(([c, l, col]) => {
      const items = b.context.filter((x) => x.category === c).sort((x, y) => y.tokens - x.tokens);
      if (!items.length) return "";
      return `<h4>${l}</h4>${items.map((x) => {
        const link = x.id.startsWith("engine:") || x.id.startsWith("workspace:") || x.id === "virtual:operator" || x.id.startsWith("data:");
        return `<div class="ctxrow ${link ? "" : "nolink"}" ${link ? `data-ctx="${esc(x.id)}"` : ""}><span>${esc(x.label)}</span><span class="n">${x.tokens ? k(x.tokens) : "–"}</span><span class="b" style="background:${col};width:${(100 * x.tokens) / max}%"></span>${x.note ? `<span class="note">${esc(x.note)}</span>` : ""}</div>`;
      }).join("")}`;
    }).join("");
}

async function instructionsTab(b) {
  const ids = [b.agent === "operator" ? "virtual:operator" : b.agent ? `engine:agents/${b.agent}.md` : null, ...(b.skills ?? []).map((s) => `engine:skills/${s}/SKILL.md`)].filter(Boolean);
  const parts = await Promise.all(ids.map((id) => fetch(`/api/file?id=${encodeURIComponent(id)}`).then((r) => r.json())));
  if (state.kind !== "block" || state.id !== b.id) return;
  $("#tab").innerHTML = parts.map((f, i) => `<details ${i === 0 || (b.agent === "operator" && i === 1) ? "open" : ""}><summary><b>${esc(i === 0 && b.agent ? `${actor(b.agent).name} instructions` : `${f.path.split("/")[1]} playbook`)}</b> <span class="muted">${esc(f.path)}</span></summary>${render(f.path, f.text)}</details>`).join("<hr style='border:0;border-top:1px solid var(--grid)'>");
}

async function outputTab(b) {
  const r = await fetch(`/api/example?pattern=${encodeURIComponent(b.example)}`);
  const f = await r.json();
  if (state.kind !== "block" || state.id !== b.id) return;
  $("#tab").innerHTML = f.error ? `<p class="muted">${esc(f.error)}</p>` : `<p class="muted">The newest real output in your workspace: <b>${esc(f.path)}</b></p>${render(f.path, f.text)}`;
}

// runs this block took part in: those of its skills where its actor actually ran (the Judge only when it was called)
const blockRuns = (b) => (M ? M.runs.filter((r) => (b.runIn ?? b.skills ?? []).includes(r.skill) && (b.by === "operator" || r.threads.some((t) => t.agent === b.by))) : []);
const actorCost = (r, by) => r.threads.filter((t) => t.agent === by).reduce((a, t) => a + t.cost, 0);
function runsTab(b) {
  if (!M) return "<p class='muted'>Loading live data from the platform…</p>";
  const runs = blockRuns(b);
  if (!runs.length) return "<p class='muted'>No runs yet.</p>";
  return `<table class="runs"><tr><th>Date</th><th>Run</th><th>Status</th><th class="r">${esc(actor(b.by).name)}</th><th class="r">Run</th></tr>${runs.map((r) => `<tr><td>${day(r.created_at)}</td><td><a href="https://platform.claude.com/sessions/${r.session_id}" target="_blank">${esc((r.args || r.skill).slice(0, 40))}</a></td><td><span class="st ${r.status}">${esc(r.status.replace("_", " "))}</span></td><td class="r">${money(actorCost(r, b.by))}</td><td class="r">${money(r.cost)}</td></tr>`).join("")}</table>
    ${runs.some((r) => r.checks.length) ? `<h4>Flagged to double-check</h4><ol class="check">${runs.flatMap((r) => r.checks.map((c) => `<li>${esc(c)}</li>`)).slice(0, 10).join("")}</ol>` : ""}`;
}

function inspectStep(el, s) {
  if (!s) return;
  el.innerHTML = `<div class="ins-who">Step ${esc(String(s.n))}</div><h3>${esc(s.title)}</h3><p class="lead">${s.blocks.length} block${s.blocks.length === 1 ? "" : "s"}, in hand-off order. Click one to inspect it.</p>
    <div class="chips" style="flex-direction:column;align-items:flex-start">${s.blocks.map((b) => `<button class="chip" data-goblock="${b.id}"><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${COLORS[b.by]};margin-right:6px"></i>${esc(actor(b.by).name)} · ${esc(b.label)}</button>`).join("")}</div>`;
}

async function inspectFile(el, f) {
  const blocks = blockById();
  const back = state.back ? `<button class="back" data-back>← ${esc(blocks.get(state.back.id)?.label ?? "back")}</button>` : "";
  const used = f.used_by.map((id) => blocks.get(id)).filter(Boolean);
  el.innerHTML = `${back}<div class="ins-who">${esc(LAYERS.find(([l]) => l === f.layer)?.[1] ?? "Company data")}${f.modified ? ` · changed ${esc(f.modified)}` : ""} · ${k(f.tokens)} tokens</div><h3>${esc(cleanTitle(f))}</h3><p class="muted" style="margin:0 0 10px">${esc(f.path)}</p>
    ${used.length ? `<h4>Read by</h4><div class="chips">${used.map((b) => `<button class="chip" data-goblock="${b.id}">${esc(String(b.step.n))} · ${esc(b.label)}</button>`).join("")}</div>` : ""}
    <h4>Content</h4><div id="filebody"><p class="muted">Loading…</p></div>`;
  const id = f.id.startsWith("data:") ? null : f.id;
  const res = id ? await fetch(`/api/file?id=${encodeURIComponent(id)}`) : await fetch(`/api/example?pattern=${encodeURIComponent(f.id.slice(5))}`);
  const j = await res.json();
  if (state.id !== f.id) return;
  $("#filebody").innerHTML = j.error ? `<p class="muted">${esc(j.error)}</p>` : `${f.id.startsWith("data:") ? `<p class="muted">One company's version, as an example: ${esc(j.path)}</p>` : ""}${render(j.path, j.text, j.parsed)}`;
}

// ---------- events ----------
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab]");
  if (t) { state.tab = t.dataset.tab; return renderInspector(); }
  const b = e.target.closest("[data-block]");
  if (b) return select("block", b.dataset.block);
  const gb = e.target.closest("[data-goblock]");
  if (gb) return select("block", gb.dataset.goblock);
  const f = e.target.closest("[data-file]");
  if (f) return select("file", f.dataset.file);
  const n = e.target.closest("[data-node]");
  if (n) {
    const node = P.graph.nodes.find((x) => x.id === n.dataset.node);
    return node?.ref ? select("file", node.ref) : select("node", node.id);
  }
  const c = e.target.closest("[data-ctx]");
  if (c) return select("file", c.dataset.ctx);
  if (e.target.closest("[data-back]")) { state = { ...state.back }; applySelection(); return renderInspector(); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") select("intro", null); });
// hovering a node in the brain previews its chain; leaving restores the selection
document.addEventListener("mouseover", (e) => { const n = e.target.closest?.("#brain [data-node]"); if (n) lightFlow([n.dataset.node]); });
document.addEventListener("mouseout", (e) => { if (e.target.closest?.("#brain [data-node]") && !e.relatedTarget?.closest?.("#brain [data-node]")) applySelection(); });
$("#refresh").addEventListener("click", () => load(true));
let rt;
window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { drawLinks(); renderBrain(); }, 120); });
load();
