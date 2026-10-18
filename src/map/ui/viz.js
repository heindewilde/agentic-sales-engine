// SVG renderers for the agent map: swimlane, funnel, cost per step, sequence diagram, activity timeline. No library.
const NS = "http://www.w3.org/2000/svg";
const ACTORS = [
  { id: "you", name: "You", color: "var(--gate)" },
  { id: "operator", name: "Coordinator", color: "var(--s1)" },
  { id: "account-researcher", name: "Researcher", color: "var(--s2)" },
  { id: "factor-judge", name: "Judge", color: "var(--s3)" },
  { id: "wiki-linter", name: "Auditor", color: "var(--s4)" },
  { id: "icp-analyst", name: "ICP analyst", color: "var(--s5)" },
];
const actor = (id) => ACTORS.find((a) => a.id === id) ?? { id, name: id, color: "var(--muted)" };
const STATUS = {
  done: { label: "Done", color: "var(--good)", icon: "✓" },
  question: { label: "Waiting on you", color: "var(--warning)", icon: "?" },
  budget_reached: { label: "Hit budget cap", color: "var(--serious)", icon: "!" },
  failed: { label: "Failed", color: "var(--critical)", icon: "✕" },
};
const statusOf = (s) => STATUS[s] ?? (s === "retries_exhausted" || s === "terminated" ? STATUS.failed : STATUS.question);
const money = (x) => `$${(x ?? 0).toFixed(2)}`;
const escH = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function svg(w, h, parent) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s.setAttribute("width", w);
  s.setAttribute("height", h);
  parent.replaceChildren(s);
  const defs = el("defs", {}, s);
  const m = el("marker", { id: "arr", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
  el("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--axis)" }, m);
  return s;
}
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}
function text(parent, x, y, str, attrs = {}) {
  // a fill goes in style: the stylesheet's `svg text { fill }` would win over a presentation attribute
  const { fill, ...rest } = attrs;
  const t = el("text", { x, y, "font-size": 12, ...rest, ...(fill ? { style: `fill:${fill}` } : {}) }, parent);
  t.textContent = str;
  return t;
}
/** Wrap words into at most `lines` lines of ~maxChars. */
function wrap(str, maxChars, lines = 2) {
  const words = str.split(" ");
  const out = [""];
  for (const w of words) {
    if ((out.at(-1) + " " + w).trim().length > maxChars && out.at(-1)) {
      if (out.length === lines) { out[lines - 1] += "…"; break; }
      out.push(w);
    } else out[out.length - 1] = (out.at(-1) + " " + w).trim();
  }
  return out;
}

// ---------- tooltip ----------
const tipEl = () => document.getElementById("tip");
function tip(e, html) {
  const t = tipEl();
  t.innerHTML = html;
  t.style.opacity = 1;
  const x = Math.min(e.clientX + 14, window.innerWidth - t.offsetWidth - 10);
  const y = Math.min(e.clientY + 14, window.innerHeight - t.offsetHeight - 10);
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
const untip = () => (tipEl().style.opacity = 0);
function hover(node, html) {
  node.addEventListener("mousemove", (e) => tip(e, typeof html === "function" ? html() : html));
  node.addEventListener("mouseleave", untip);
}

// ---------- process swimlane (actors as columns, steps as rows) ----------
function drawSwimlane(host, steps, onStep, onActor) {
  const lanes = ACTORS;
  const W = Math.max(900, host.clientWidth);
  const G = 200; // step gutter
  const laneW = (W - G) / lanes.length;
  const HEAD = 40, ACT = 46, PADB = 14;
  const boxW = Math.min(170, laneW - 20), boxH = 34;
  let y = HEAD;
  const bands = steps.map((s) => {
    const h = s.acts.length * ACT + PADB + 8;
    const b = { s, top: y, h };
    y += h;
    return b;
  });
  const s = svg(W, y + 6, host);
  const laneX = (id) => G + lanes.findIndex((l) => l.id === id) * laneW + laneW / 2;

  // lane headers and dividers
  lanes.forEach((l, i) => {
    const x = G + i * laneW;
    if (i) el("line", { x1: x, y1: 8, x2: x, y2: y, stroke: "var(--grid)" }, s);
    const g = el("g", { class: "hit" }, s);
    el("circle", { cx: x + laneW / 2 - 6 - l.name.length * 3.3, cy: 21, r: 5, fill: l.color }, g);
    text(g, x + laneW / 2 + 4, 25, l.name, { "text-anchor": "middle", "font-weight": 600, "font-size": 12.5 });
    if (l.id !== "you") g.addEventListener("click", () => onActor(l.id));
  });
  el("line", { x1: 0, y1: HEAD - 4, x2: W, y2: HEAD - 4, stroke: "var(--axis)" }, s);

  const boxes = [];
  bands.forEach((b, bi) => {
    if (bi) el("line", { x1: 0, y1: b.top, x2: W, y2: b.top, stroke: "var(--grid)" }, s);
    // gutter: number, name, live metric
    const g = el("g", { class: "hit" }, s);
    el("rect", { x: 0, y: b.top, width: G - 8, height: b.h, fill: "transparent" }, g);
    const gate = b.s.acts.some((a) => a.gate);
    el("rect", { x: 8, y: b.top + 12, width: 24, height: 24, rx: 12, fill: gate ? "var(--gate)" : "var(--raise)", stroke: gate ? "none" : "var(--grid)" }, g);
    text(g, 20, b.top + 28, String(b.s.n), { "text-anchor": "middle", "font-weight": 600, fill: gate ? "var(--gate-ink)" : "var(--ink)" });
    text(g, 42, b.top + 25, b.s.short, { "font-weight": 600, "font-size": 13 });
    if (b.s.metric) text(g, 42, b.top + 42, b.s.metric, { class: "muted" });
    if (b.s.cost) text(g, 42, b.top + 57, b.s.cost, { class: "muted" });
    g.addEventListener("click", () => onStep(b.s));
    hover(g, `<b>${escH(b.s.title)}</b>${escH(b.s.what)}`);

    b.s.acts.forEach((a, i) => {
      const cx = laneX(a.by);
      const top = b.top + 10 + i * ACT;
      const ac = actor(a.by);
      const box = el("g", { class: "hit" }, s);
      const fill = a.gate ? "var(--gate)" : "var(--surface)";
      el("rect", { class: "box", x: cx - boxW / 2, y: top, width: boxW, height: boxH, rx: 6, fill, stroke: a.gate ? "none" : "var(--grid)" }, box);
      if (!a.gate) el("rect", { x: cx - boxW / 2, y: top, width: 4, height: boxH, rx: 2, fill: ac.color }, box);
      const lines = wrap((a.gate ? "◆ " : "") + a.label, Math.floor(boxW / 6.4));
      lines.forEach((ln, k) => text(box, cx - boxW / 2 + (a.gate ? 10 : 12), top + (lines.length === 1 ? 21 : 15 + k * 13), ln, { "font-size": 11.5, fill: a.gate ? "var(--gate-ink)" : "var(--ink)" }));
      box.addEventListener("click", () => onStep(b.s));
      hover(box, `<b>${escH(ac.name)}</b>${escH(a.label)}${a.gate ? "<br><i>Your decision</i>" : ""}`);
      boxes.push({ band: bi, i, cx, top, bottom: top + boxH, parallel: b.s.parallel });
    });
  });

  // hand-offs: within a step (solid) and from one step to the next (dashed)
  const link = (p, q, dashed) => {
    const midY = p.bottom + (q.top - p.bottom) / 2;
    const d = p.cx === q.cx ? `M${p.cx},${p.bottom} L${q.cx},${q.top - 1}` : `M${p.cx},${p.bottom} L${p.cx},${midY} L${q.cx},${midY} L${q.cx},${q.top - 1}`;
    el("path", { d, fill: "none", stroke: "var(--axis)", "stroke-width": 1.4, "stroke-dasharray": dashed ? "3 4" : "none", "marker-end": "url(#arr)" }, s);
  };
  for (let k = 1; k < boxes.length; k++) {
    const p = boxes[k - 1], q = boxes[k];
    if (q.parallel || p.parallel) continue;
    link(p, q, p.band !== q.band);
  }
}

// ---------- funnel (accounts that reached each stage) ----------
function drawFunnel(host, rows) {
  const W = Math.max(380, host.clientWidth), L = 116, R = 92, ROW = 34;
  const H = rows.length * ROW + 8;
  const s = svg(W, H, host);
  const max = Math.max(1, ...rows.map((r) => r.n));
  rows.forEach((r, i) => {
    const y = i * ROW + 6;
    const w = Math.max(r.n ? 3 : 0, ((W - L - R) * r.n) / max);
    text(s, L - 10, y + 15, r.label, { "text-anchor": "end", class: "ink2" });
    el("line", { x1: L, y1: y + 22, x2: W - R, y2: y + 22, stroke: "var(--grid)" }, s);
    const g = el("g", {}, s);
    el("path", { d: `M${L},${y + 2} h${Math.max(0, w - 4)} a4,4 0 0 1 4,4 v12 a4,4 0 0 1 -4,4 h${-Math.max(0, w - 4)} z`, fill: "var(--bar)" }, g);
    el("rect", { x: L, y, width: W - L - R + 80, height: 24, fill: "transparent" }, g);
    text(s, L + w + 8, y + 16, r.n.toLocaleString(), { "font-weight": 600 });
    if (r.conv != null) text(s, W - 8, y + 16, `${r.conv}%`, { "text-anchor": "end", class: "muted" });
    hover(g, `<b>${escH(r.label)}</b>${r.n} accounts reached this stage${r.conv != null ? `<br>${r.conv}% of the previous stage` : ""}${r.note ? `<br>${escH(r.note)}` : ""}`);
  });
}

// ---------- cost per run, by step, stacked by agent ----------
function drawCost(host, rows, agents) {
  const W = Math.max(380, host.clientWidth), L = 92, R = 64, ROW = 30;
  const H = rows.length * ROW + 8;
  const s = svg(W, H, host);
  const max = Math.max(0.01, ...rows.map((r) => r.total));
  rows.forEach((r, i) => {
    const y = i * ROW + 6;
    text(s, L - 10, y + 14, r.label, { "text-anchor": "end", class: "ink2" });
    if (!r.total) { text(s, L, y + 14, "no runs yet", { class: "muted" }); return; }
    let x = L;
    const segs = agents.filter((a) => r.by[a] > 0);
    segs.forEach((a, k) => {
      const w = ((W - L - R) * r.by[a]) / max;
      const last = k === segs.length - 1;
      const gw = Math.max(1, w - (last ? 0 : 2));
      const d = last ? `M${x},${y} h${Math.max(0, gw - 4)} a4,4 0 0 1 4,4 v12 a4,4 0 0 1 -4,4 h${-Math.max(0, gw - 4)} z` : `M${x},${y} h${gw} v20 h${-gw} z`;
      const seg = el("path", { d, fill: actor(a).color }, s);
      hover(seg, `<b>${escH(r.label)} · ${escH(actor(a).name)}</b>${money(r.by[a])} per run (${Math.round((100 * r.by[a]) / r.total)}%)<br>${r.runs} run${r.runs === 1 ? "" : "s"}`);
      x += w;
    });
    text(s, x + 8, y + 14, money(r.total), { "font-weight": 600 });
  });
}

// ---------- sequence: research and scoring hand-off ----------
function drawSequence(host) {
  const P = [
    { id: "you", name: "You" }, { id: "operator", name: "Coordinator" }, { id: "account-researcher", name: "Researcher ×N" },
    { id: "factor-judge", name: "Judge ×N" }, { id: "pr", name: "Pull request" },
  ];
  const M = [
    ["you", "operator", "Run research"], ["operator", "account-researcher", "Research company"], ["account-researcher", "account-researcher", "Site · news · people"],
    ["account-researcher", "operator", "Brief + sources"], ["operator", "factor-judge", "Evidence pack"], ["factor-judge", "operator", "Factor scores"],
    ["operator", "pr", "Scores + checks"], ["pr", "you", "Review & merge"],
  ];
  const W = Math.max(520, host.clientWidth), colW = W / P.length, TOP = 44, STEP = 34;
  const H = TOP + M.length * STEP + 18;
  const s = svg(W, H, host);
  const x = (id) => (P.findIndex((p) => p.id === id) + 0.5) * colW;
  // parallel frame around the per-company part
  el("rect", { x: x("operator") + 8, y: TOP + STEP * 1 - 14, width: x("factor-judge") - x("operator") + colW / 2 - 14, height: STEP * 5 - 2, rx: 6, fill: "none", stroke: "var(--grid)", "stroke-dasharray": "4 4" }, s);
  text(s, x("factor-judge") + colW / 2 - 12, TOP + STEP - 2, "per company, in parallel", { "text-anchor": "end", class: "muted" });
  P.forEach((p) => {
    const c = p.id === "pr" ? "var(--muted)" : actor(p.id).color;
    el("line", { x1: x(p.id), y1: 30, x2: x(p.id), y2: H - 6, stroke: "var(--grid)", "stroke-dasharray": "2 3" }, s);
    el("rect", { x: x(p.id) - 52, y: 4, width: 104, height: 24, rx: 5, fill: "var(--surface)", stroke: "var(--grid)" }, s);
    el("rect", { x: x(p.id) - 52, y: 4, width: 4, height: 24, rx: 2, fill: c }, s);
    text(s, x(p.id) + 2, 20, p.name, { "text-anchor": "middle", "font-size": 11.5, "font-weight": 600 });
  });
  M.forEach(([a, b, label], i) => {
    const y = TOP + 8 + i * STEP;
    if (a === b) {
      el("path", { d: `M${x(a)},${y} h26 v12 h-24`, fill: "none", stroke: "var(--axis)", "stroke-width": 1.4, "marker-end": "url(#arr)" }, s);
      text(s, x(a) + 32, y + 10, label, { "font-size": 11.5, class: "ink2" });
    } else {
      const dir = x(b) > x(a) ? 1 : -1;
      el("line", { x1: x(a), y1: y + 6, x2: x(b) - dir * 3, y2: y + 6, stroke: "var(--axis)", "stroke-width": 1.4, "marker-end": "url(#arr)" }, s);
      text(s, (x(a) + x(b)) / 2, y + 1, label, { "text-anchor": "middle", "font-size": 11.5, class: "ink2" });
    }
    text(s, 10, y + 10, String(i + 1), { class: "muted" });
  });
}

// ---------- activity: runs over time, one row per step ----------
function drawTimeline(host, rows, runs, onRun) {
  const W = Math.max(700, host.clientWidth), L = 120, R = 16, ROW = 26, TOP = 8, AX = 24;
  const H = TOP + rows.length * ROW + AX;
  const s = svg(W, H, host);
  if (!runs.length) { text(s, L, 30, "No runs yet", { class: "muted" }); return; }
  const t = runs.map((r) => Date.parse(r.created_at));
  const pad = 3600_000;
  const t0 = Math.min(...t) - pad, t1 = Math.max(...t) + pad;
  const X = (ms) => L + ((W - L - R) * (ms - t0)) / (t1 - t0);
  rows.forEach((r, i) => {
    const y = TOP + i * ROW + ROW / 2;
    el("line", { x1: L, y1: y, x2: W - R, y2: y, stroke: "var(--grid)" }, s);
    text(s, L - 10, y + 4, r.label, { "text-anchor": "end", class: "ink2" });
  });
  // date ticks
  const span = t1 - t0, stepMs = span > 3 * 86400_000 ? 86400_000 : span > 86400_000 ? 6 * 3600_000 : 2 * 3600_000;
  for (let k = Math.ceil(t0 / stepMs) * stepMs; k <= t1; k += stepMs) {
    const d = new Date(k);
    const lab = stepMs >= 86400_000 ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    el("line", { x1: X(k), y1: TOP, x2: X(k), y2: H - AX + 4, stroke: "var(--grid)" }, s);
    text(s, X(k), H - 6, lab, { "text-anchor": "middle", class: "muted" });
  }
  for (const r of runs) {
    const ri = rows.findIndex((row) => row.skills.includes(r.skill));
    const y = TOP + (ri < 0 ? rows.length - 1 : ri) * ROW + ROW / 2;
    const st = statusOf(r.status);
    const g = el("g", { class: "hit" }, s);
    el("circle", { cx: X(Date.parse(r.created_at)), cy: y, r: 7, fill: "var(--surface)" }, g);
    el("circle", { cx: X(Date.parse(r.created_at)), cy: y, r: 5, fill: st.color }, g);
    el("circle", { cx: X(Date.parse(r.created_at)), cy: y, r: 11, fill: "transparent" }, g);
    hover(g, `<b>${escH(r.skill)}${r.args ? ` · ${escH(r.args.slice(0, 50))}` : ""}</b>${st.icon} ${st.label} · ${money(r.cost)}<br>${new Date(r.created_at).toLocaleString()}${r.checks.length ? `<br>${r.checks.length} to double-check` : ""}`);
    g.addEventListener("click", () => onRun(r));
  }
}
