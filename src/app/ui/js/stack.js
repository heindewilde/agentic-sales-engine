// Stack: where everything lives and runs. Five places, their parts with live status, and how they connect.
import { $, $$, day, esc, get, openSheet } from "./ui.js";

/** Who talks to whom (hover a part to see its links). */
const LINKS = [
  ["plugin", "cli"], ["plugin", "engine-repo"], ["cli", "workspace"], ["runner", "subscription"], ["runner", "workspace"], ["app", "cli"], ["app", "runner"],
  ["runner", "exa"], ["runner", "firecrawl"], ["workspace", "workspace-repo"], ["secrets", "runner"],
  ["managed", "workspace-repo"], ["managed", "engine-repo"], ["managed", "exa"], ["managed", "firecrawl"], ["app", "managed"],
  ["runner", "langfuse"], ["runner", "langsmith"], ["runner", "braintrust"], ["managed", "braintrust"],
];
const DOT = { ok: "on", warn: "warn", off: "off" };
let data = null;

export async function stackPage(view) {
  view.innerHTML = `<p class="muted">Loading…</p>`;
  data = await get("/api/stack");
  view.innerHTML = `
    <section class="intro"><div><h1>Where everything lives and runs</h1>
      <p>Five places make up the engine. Hover a part to see what it connects to; click it for the details. Status comes from local settings; nothing is contacted until you ask.</p></div>
      <div class="legend"><span><i style="background:var(--good)"></i>set up</span><span><i style="background:var(--warning)"></i>check</span><span><i style="background:var(--line-2)"></i>not set up</span></div></section>
    <div class="stack" id="stack">${data.places.map((p) => `<section class="place"><header><h3>${esc(p.name)}</h3><p>${esc(p.note)}</p></header>
      ${p.items.map((i) => `<button class="part" data-part="${esc(i.id)}"><i class="dot ${DOT[i.status] ?? "off"}"></i><span><b>${esc(i.name)}</b><small>${esc(i.role)}</small></span></button>`).join("")}</section>`).join("")}</div>
    ${data.bench ? `<p class="muted foot">Latest quality bench: ${esc(data.bench.label)} (${esc(data.bench.at)})</p>` : ""}`;
  requestAnimationFrame(drawLinks);
  const host = $("#stack");
  host.addEventListener("mouseover", (e) => { const p = e.target.closest("[data-part]"); if (p) light(p.dataset.part); });
  host.addEventListener("mouseleave", () => light(null));
  host.addEventListener("click", (e) => { const p = e.target.closest("[data-part]"); if (p) details(p.dataset.part); });
}

function drawLinks() {
  const host = $("#stack");
  if (!host) return;
  host.querySelector("svg")?.remove();
  const base = host.getBoundingClientRect();
  const box = (id) => host.querySelector(`[data-part="${id}"]`)?.getBoundingClientRect();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "stack-links");
  svg.setAttribute("width", host.scrollWidth);
  svg.setAttribute("height", host.scrollHeight);
  for (const [a, b] of LINKS) {
    const ra = box(a), rb = box(b);
    if (!ra || !rb) continue;
    const [l, r] = ra.left <= rb.left ? [ra, rb] : [rb, ra];
    const same = Math.abs(l.left - r.left) < 4;
    const x1 = same ? l.left - base.left + 4 : l.right - base.left, y1 = l.top - base.top + l.height / 2;
    const x2 = same ? r.left - base.left + 4 : r.left - base.left, y2 = r.top - base.top + r.height / 2;
    const d = same ? `M${x1},${y1} C${x1 - 26},${y1} ${x2 - 26},${y2} ${x2},${y2}` : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
    svg.insertAdjacentHTML("beforeend", `<path d="${d}" data-a="${a}" data-b="${b}"/>`);
  }
  host.prepend(svg);
}

function light(id) {
  const host = $("#stack");
  host.classList.toggle("dim", Boolean(id));
  const near = new Set(id ? [id, ...LINKS.filter(([a, b]) => a === id || b === id).flat()] : []);
  $$("[data-part]", host).forEach((p) => p.classList.toggle("hl", near.has(p.dataset.part)));
  $$("path", host).forEach((p) => p.classList.toggle("hl", Boolean(id) && (p.dataset.a === id || p.dataset.b === id)));
}

function details(id) {
  const item = data.places.flatMap((p) => p.items.map((i) => ({ ...i, place: p.name }))).find((i) => i.id === id);
  if (!item) return;
  const links = LINKS.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a));
  const name = (x) => data.places.flatMap((p) => p.items).find((i) => i.id === x)?.name ?? x;
  const s = openSheet(`<span class="who">${esc(item.place)}</span><h2>${esc(item.name)}</h2><p>${esc(item.role)}</p>
    <h4 style="margin-top:20px">Details</h4><table class="facts">${Object.entries(item.facts ?? {}).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v == null || v === "" ? "–" : /\d{4}-\d{2}-\d{2}T/.test(String(v)) ? day(v) : v)}</td></tr>`).join("")}</table>
    ${links.length ? `<h4 style="margin-top:20px">Connects to</h4><div class="tags">${links.map((l) => `<button class="tag" data-part-go="${esc(l)}">${esc(name(l))}</button>`).join("")}</div>` : ""}
    ${item.check ? `<p style="margin-top:22px"><button class="btn" id="check">Check the connection</button> <span class="muted" id="check-r"></span></p>` : ""}`);
  s.onclick = (e) => { const g = e.target.closest("[data-part-go]"); if (g) details(g.dataset.partGo); };
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

window.addEventListener("resize", () => { if (location.pathname === "/stack") drawLinks(); });
