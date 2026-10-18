// Shared helpers: DOM, formatting, the API (reads open, writes carry this server's token), markdown, the reading sheet.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const money = (x) => `$${(x ?? 0).toFixed(2)}`;
export const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
export const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "–");
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TOKEN = document.querySelector('meta[name="ase-token"]')?.content ?? "";

export async function get(path) {
  const r = await fetch(path);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j?.error) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j;
}

/** A write: an engine action, signed with the token; errors come back as readable messages. */
export async function act(action, body) {
  const r = await fetch(`/api/act/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "x-ase-token": TOKEN }, body: JSON.stringify({ by: me(), ...body }) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j?.error) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j;
}
export async function post(path, body = {}) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "x-ase-token": TOKEN }, body: JSON.stringify(body) });
  return r.json();
}

// who is acting (approvals name a team member); remembered per browser
export const me = () => { try { return localStorage.getItem("ase-me") || ""; } catch { return ""; } };
export const setMe = (v) => { try { localStorage.setItem("ase-me", v); } catch { /* private window */ } };
export const icpPref = () => { try { return localStorage.getItem("ase-icp") || ""; } catch { return ""; } };
export const setIcpPref = (v) => { try { localStorage.setItem("ase-icp", v); } catch { /* private window */ } };

export function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.classList.add("out"), 3200);
  setTimeout(() => t.remove(), 3700);
}
/** Run a write from a button: busy state, a toast on the outcome, then `after` (usually a re-render). */
export async function doAct(btn, action, body, okMsg, after) {
  btn && (btn.disabled = true);
  try {
    const r = await act(action, body);
    toast(typeof okMsg === "function" ? okMsg(r) : okMsg);
    await after?.(r);
    return r;
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn && (btn.disabled = false);
  }
}

/** Workspace files quote web pages: keep the markdown's formatting, drop anything active. */
export function clean(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  t.content.querySelectorAll("script, style, iframe, object, embed, link, meta, form").forEach((n) => n.remove());
  t.content.querySelectorAll("*").forEach((n) => {
    for (const a of [...n.attributes]) if (a.name.startsWith("on") || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
  });
  t.content.querySelectorAll("a[href^='http']").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
  return t.innerHTML;
}
export const md = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = m ? text.slice(m[0].length) : text;
  return `${m ? `<details class="fm"><summary>frontmatter</summary><pre class="raw">${esc(m[1])}</pre></details>` : ""}<div class="md">${clean(window.marked.parse(body))}</div>`;
};
export const mdBody = (text) => `<div class="md">${clean(window.marked.parse(text.replace(/^---\n[\s\S]*?\n---\n?/, "")))}</div>`;

export function openSheet(html) {
  const sheet = $("#sheet");
  sheet.hidden = false;
  document.body.style.overflow = "hidden";
  $(".sheet-body", sheet).innerHTML = `<div class="sheet-top"><span></span><button class="x" data-close aria-label="Close">×</button></div>${html}`;
  return $(".sheet-body", sheet);
}
export function closeSheet() {
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
}

export const STAGES = ["discovered", "light_scored", "shortlisted", "researched", "scored", "outreach_ready"];
export const STAGE_NAME = { discovered: "Found", light_scored: "Quick-scanned", shortlisted: "Shortlisted", researched: "Researched", scored: "Scored", outreach_ready: "Ready for outreach", excluded: "Excluded" };
export const tierPill = (t) => (t ? `<span class="tier t${esc(t)}">${esc(t)}</span>` : `<span class="tier">–</span>`);
export const empty = (title, text, ic = "info") => `<div class="empty">${iconFn(ic, 22)}<b>${esc(title)}</b><p>${esc(text)}</p></div>`;
import { icon as iconFn } from "./icons.js";
/** A stat card: icon, label, the number, and a line under it. */
export const stat = (ic, label, value, sub = "", tone = "", href = "") => `<${href ? `a href="${href}" data-link` : "div"} class="stat"><span class="stat-h"><span class="stat-ic ${tone}">${iconFn(ic, 14)}</span>${esc(label)}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</${href ? "a" : "div"}>`;
/** A card with an icon header and an optional link on the right. */
export const card = (ic, title, body, { count = "", link = "", linkText = "", flush = false } = {}) => `<section class="card"><div class="card-h"><h3>${iconFn(ic, 16)}${esc(title)}${count !== "" ? ` <span class="count">${esc(String(count))}</span>` : ""}</h3>${link ? `<a href="${link}" data-link>${esc(linkText)} ${iconFn("arrow", 13)}</a>` : ""}</div><div class="card-b ${flush ? "flush" : ""}">${body}</div></section>`;
export const initials = (name) => String(name ?? "?").replace(/^(the|de|het)\s+/i, "").trim().slice(0, 1).toUpperCase();
