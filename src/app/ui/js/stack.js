// Stack: where everything lives and runs. One architecture diagram (zones, parts, labelled flows), then every part in detail.
import { icon } from "./icons.js";
import { $, $$, card, day, esc, get, openSheet } from "./ui.js";

const W = 1160, H = 590, NW = 196, NH = 54;
/** Zones of the diagram and where each part sits in it. */
const ZONES = [
  { id: "mac", name: "Your Mac", x: 20, y: 96, w: 476, h: 474 },
  { id: "anthropic", name: "Anthropic", x: 560, y: 96, w: 250, h: 200 },
  { id: "github", name: "GitHub", x: 560, y: 340, w: 250, h: 230 },
  { id: "providers", name: "Data providers", x: 890, y: 96, w: 250, h: 200 },
  { id: "observability", name: "Tracing & evals", x: 890, y: 340, w: 250, h: 230 },
];
const POS = {
  you: [196, 14], app: [42, 138], plugin: [276, 138], cli: [42, 236], runner: [276, 236], workspace: [42, 386], secrets: [276, 486],
  subscription: [587, 140], managed: [587, 220], "workspace-repo": [587, 386], "engine-repo": [587, 476],
  exa: [917, 140], firecrawl: [917, 220], langfuse: [917, 372], langsmith: [917, 438], braintrust: [917, 504],
};
const SHORT = { plugin: "Claude Code + plugin", cli: "The engine (ase)", runner: "Batch runner", app: "This app", workspace: "Workspace files", secrets: "Credentials", subscription: "Claude subscription", managed: "Managed Agents", "workspace-repo": "Workspace repo", "engine-repo": "Engine repo" };
const SUB = { you: "you decide, review, send", app: "screens for daily work", plugin: "skills, agents, hooks", cli: "every change, validated", runner: "headless Claude sessions", workspace: "accounts, briefs, scores", secrets: "API keys, never in git", subscription: "pays for runs here", managed: "cloud runs, schedules", "workspace-repo": "your data, synced", "engine-repo": "the engine's code", exa: "search, people, news", firecrawl: "reading pages", langfuse: "traces + scores", langsmith: "traces + scores", braintrust: "traces + experiments" };
/** Flows: from, to, label, cloud (dashed). */
const FLOWS = [
  ["you", "app", "you work here"], ["you", "plugin", "or in Claude Code"],
  ["app", "cli", "every change"], ["plugin", "cli", "skills call it"], ["cli", "workspace", "reads & writes"],
  ["app", "runner", "runs here"], ["runner", "subscription", "on your plan"], ["secrets", "runner", "keys"],
  ["app", "managed", "runs in the cloud", true], ["workspace", "workspace-repo", "git sync"],
  ["managed", "workspace-repo", "pull request", true], ["managed", "engine-repo", "checks out", true],
  ["runner", "zone:providers", "lookups"], ["managed", "zone:providers", "", true],
  ["runner", "zone:observability", "traces"], ["managed", "zone:observability", "", true],
];
const DOT = { ok: "var(--good)", warn: "var(--warning)", off: "var(--line-2)" };
let data = null;

export async function stackPage(view) {
  data = await get("/api/stack");
  const status = Object.fromEntries(data.places.flatMap((p) => p.items.map((i) => [i.id, i.status])));
  const names = Object.fromEntries(data.places.flatMap((p) => p.items.map((i) => [i.id, i.name])));
  view.innerHTML = `
    <header class="ph"><div><span class="ph-eyebrow">${icon("stack", 14)} System · the stack</span><h1>How it all works together</h1>
      <p class="sub">You work in this app or in Claude Code. Every change goes through the engine into your workspace files, which git keeps in sync with GitHub. Steps run here on your Claude plan, or in the cloud on Managed Agents, which come back as pull requests. Hover a part to trace its flows; click it for the details.</p></div>
      <div class="legend"><span><i style="background:var(--good)"></i>set up</span><span><i style="background:var(--line-2)"></i>not set up</span><span><svg width="26" height="8"><path d="M1 4H25" stroke="#8a8a86" stroke-width="1.5" stroke-dasharray="5 4"/></svg>cloud route</span></div></header>
    <section class="card"><div class="arch" id="arch">${diagram(status, names)}</div></section>
    <h4 style="margin:26px 0 12px">Every part</h4>
    <div class="stack-cols">${data.places.map((p) => `<section class="place"><header><h3>${icon(PLACE_ICON[p.id] ?? "info", 15)}${esc(p.name)}</h3><p>${esc(p.note)}</p></header>
      ${p.items.map((i) => `<button class="part" data-part="${esc(i.id)}"><i class="dot ${i.status === "ok" ? "on" : i.status === "warn" ? "warn" : "off"}"></i><span><b>${esc(i.name)}</b><small>${esc(i.role)}</small></span></button>`).join("")}</section>`).join("")}</div>
    ${data.bench ? `<p class="muted foot">${icon("chart", 13)} Latest quality bench: ${esc(data.bench.label)} (${esc(data.bench.at)})</p>` : ""}`;
  const arch = $("#arch");
  arch.addEventListener("mouseover", (e) => { const n = e.target.closest("[data-node]"); light(n?.dataset.node ?? null); });
  arch.addEventListener("mouseleave", () => light(null));
  view.addEventListener("click", (e) => {
    const n = e.target.closest("[data-node], [data-part]");
    const id = n?.dataset.node ?? n?.dataset.part;
    if (id && id !== "you") details(id);
  });
}
const PLACE_ICON = { mac: "laptop", github: "github", anthropic: "sparkles", providers: "globe", observability: "activity" };

function diagram(status, names) {
  const box = (id) => {
    if (id.startsWith("zone:")) { const z = ZONES.find((x) => x.id === id.slice(5)); return { x: z.x, y: z.y + (z.id === "providers" ? 76 : 40), w: z.w, h: z.id === "providers" ? 60 : 160 }; }
    return { x: POS[id][0], y: POS[id][1], w: id === "you" ? 160 : NW, h: id === "you" ? 46 : ["langfuse", "langsmith", "braintrust"].includes(id) ? 48 : NH };
  };
  let edges = "", labels = "";
  for (const [a, b, label, cloud] of FLOWS) {
    const p = box(a), q = box(b);
    let x1, y1, x2, y2, d;
    if (q.x >= p.x + p.w - 4) { // left to right
      x1 = p.x + p.w; y1 = p.y + p.h / 2; x2 = q.x; y2 = q.y + q.h / 2;
      const mx = (x1 + x2) / 2;
      d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    } else if (q.y >= p.y + p.h) { // downwards
      x1 = p.x + p.w / 2; y1 = p.y + p.h; x2 = q.x + q.w / 2; y2 = q.y;
      const my = (y1 + y2) / 2;
      d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    } else { // upwards
      x1 = p.x + p.w / 2; y1 = p.y; x2 = q.x + q.w / 2; y2 = q.y + q.h;
      const my = (y1 + y2) / 2;
      d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    }
    edges += `<path class="edge ${cloud ? "cloud" : ""}" data-a="${a}" data-b="${b}" d="${d}" marker-end="url(#arr)"/>`;
    if (label) labels += `<text class="el" data-a="${a}" data-b="${b}" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle">${esc(label)}</text>`;
  }
  const zones = ZONES.map((z) => `<rect class="zone" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="16"/><text class="zone-t" x="${z.x + 16}" y="${z.y + 24}">${esc(z.name)}</text>`).join("");
  const nodes = Object.keys(POS).map((id) => {
    const b = box(id);
    const title = id === "you" ? "You" : SHORT[id] ?? names[id] ?? id;
    return `<g class="node" data-node="${id}" transform="translate(${b.x},${b.y})"><rect width="${b.w}" height="${b.h}" rx="11" ${id === "you" ? 'style="fill:var(--ink);stroke:var(--ink)"' : ""}/>
      ${id === "you" ? "" : `<circle class="sd" cx="${b.w - 14}" cy="14" r="5" style="fill:${DOT[status[id]] ?? DOT.off}"/>`}
      <text class="nt" x="14" y="${b.h / 2 - 3}" ${id === "you" ? 'style="fill:#fff"' : ""}>${esc(title)}</text><text class="ns" x="14" y="${b.h / 2 + 13}" ${id === "you" ? 'style="fill:#ffffffb0"' : ""}>${esc(SUB[id] ?? "")}</text></g>`;
  }).join("");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#a8a8a3"/></marker></defs>${zones}${edges}${nodes}${labels}</svg>`;
}

function light(id) {
  const arch = $("#arch");
  arch.classList.toggle("dim", Boolean(id));
  const zoneOf = (n) => data.places.find((p) => p.items.some((i) => i.id === n))?.id;
  const touches = (b) => b === id || (b.startsWith("zone:") && zoneOf(id) === b.slice(5));
  const flows = id ? FLOWS.filter(([a, b]) => a === id || touches(b)) : [];
  const near = new Set(id ? [id, ...flows.flatMap(([a, b]) => (b.startsWith("zone:") ? [a, ...(data.places.find((p) => p.id === b.slice(5))?.items.map((i) => i.id) ?? [])] : [a, b]))] : []);
  $$("[data-node]", arch).forEach((n) => n.classList.toggle("hl", near.has(n.dataset.node)));
  $$(".edge, .el", arch).forEach((p) => p.classList.toggle("hl", Boolean(id) && flows.some(([a, b]) => p.dataset.a === a && p.dataset.b === b)));
}

function details(id) {
  const item = data.places.flatMap((p) => p.items.map((i) => ({ ...i, place: p.name }))).find((i) => i.id === id);
  if (!item) return;
  const zoneOf = (n) => data.places.find((p) => p.items.some((i) => i.id === n))?.id;
  const flows = FLOWS.filter(([a, b]) => a === id || b === id || (b.startsWith("zone:") && zoneOf(id) === b.slice(5)));
  const name = (x) => (x === "you" ? "You" : x.startsWith("zone:") ? data.places.find((p) => p.id === x.slice(5))?.name ?? x : data.places.flatMap((p) => p.items).find((i) => i.id === x)?.name ?? x);
  const s = openSheet(`<span class="who">${esc(item.place)}</span><h2>${esc(item.name)}</h2><p>${esc(item.role)}</p>
    <h4 style="margin-top:20px">Details</h4><table class="facts">${Object.entries(item.facts ?? {}).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v == null || v === "" ? "–" : /\d{4}-\d{2}-\d{2}T/.test(String(v)) ? day(v) : v)}</td></tr>`).join("")}</table>
    ${flows.length ? `<h4 style="margin-top:20px">Flows</h4><div class="list">${flows.map(([a, b, l, cloud]) => `<div class="item"><span class="t">${a === id ? `→ ${esc(name(b))}` : `← ${esc(name(a))}`}<small>${esc(l || (a === id ? "sends to" : "comes from"))}${cloud ? " · cloud" : ""}</small></span></div>`).join("")}</div>` : ""}
    ${item.check ? `<p style="margin-top:22px"><button class="btn" id="check">${icon("activity", 14)} Check the connection</button> <span class="muted" id="check-r"></span></p>` : ""}`);
  $("#check", s)?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    $("#check-r", s).textContent = "checking…";
    try {
      const r = await get(`/api/stack/check?name=${encodeURIComponent(id)}`);
      $("#check-r", s).textContent = `${r.ok ? "✓ connected" : "✗ failed"} · ${r.detail}`;
    } catch (err) {
      $("#check-r", s).textContent = `✗ ${err.message}`;
    }
    e.target.disabled = false;
  });
}
