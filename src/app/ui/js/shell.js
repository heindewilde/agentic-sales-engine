// The app shell: a sidebar with Work and System, who you are, which ICP, and the router.
import { icon } from "./icons.js";
import { $, closeSheet, esc, get, icpPref, me, post, setIcpPref, setMe, toast } from "./ui.js";

const NAV = [
  ["Work", [["/today", "Today", "today"], ["/accounts", "Accounts", "accounts"], ["/runs", "Runs", "runs"], ["/outcomes", "Outcomes", "outcomes"]]],
  ["System", [["/process", "Process", "process"], ["/brain", "Brain", "brain"], ["/stack", "Stack", "stack"]]],
];
const ROUTES = [
  [/^\/(today)?$/, () => import("./today.js").then((m) => m.today)],
  [/^\/today\/icp\/([^/]+)$/, () => import("./gates.js").then((m) => m.icpGate)],
  [/^\/today\/shortlist\/([^/]+)$/, () => import("./gates.js").then((m) => m.shortlistGate)],
  [/^\/today\/scores\/([^/]+)$/, () => import("./gates.js").then((m) => m.scoresGate)],
  [/^\/today\/drafts$/, () => import("./gates.js").then((m) => m.draftsPage)],
  [/^\/accounts$/, () => import("./accounts.js").then((m) => m.accountsPage)],
  [/^\/accounts\/([^/]+)$/, () => import("./accounts.js").then((m) => m.accountPage)],
  [/^\/runs$/, () => import("./runs.js").then((m) => m.runsPage)],
  [/^\/outcomes$/, () => import("./outcomes.js").then((m) => m.outcomesPage)],
  [/^\/process$/, () => import("./system.js").then((m) => m.processPage)],
  [/^\/brain$/, () => import("./system.js").then((m) => m.brainPage)],
  [/^\/stack$/, () => import("./stack.js").then((m) => m.stackPage)],
];

export const state = { meta: null, icps: [], icp: "", badges: {} };

const areaOf = (path) => (/^\/(process|brain|stack)/.test(path) ? "system" : "work");

export function go(path, push = true) {
  if (push && path !== location.pathname + location.search) history.pushState(null, "", path);
  closeSheet();
  closeModal();
  route();
}

function renderNav() {
  const path = location.pathname;
  const on = (href) => path === href || path.startsWith(`${href}/`) || (href === "/today" && path === "/");
  $("#nav").innerHTML = NAV.map(([group, items]) => `<div class="nav-group"><span class="nav-label">${group}</span>${items.map(([href, label, ic]) => `
    <a href="${href}" data-link class="nav-item ${on(href) ? "on" : ""}">${icon(ic, 17)}<span>${label}</span>${state.badges[href] ? `<em class="badge ${state.badges[href].kind ?? ""}">${esc(String(state.badges[href].text))}</em>` : ""}</a>`).join("")}</div>`).join("");
}

/** Counts in the sidebar: what's waiting today, and whether a run is going. */
export async function refreshBadges() {
  try {
    const [t, r] = await Promise.all([get("/api/today"), get("/api/runs")]);
    state.badges = {
      "/today": t.items.length ? { text: t.items.length } : null,
      "/runs": r.jobs.some((j) => j.status === "running") ? { text: "live", kind: "live" } : null,
    };
    renderNav();
  } catch { /* the page itself shows errors */ }
}

async function route() {
  const path = location.pathname;
  document.body.dataset.area = areaOf(path);
  renderNav();
  $("#icp-pick").hidden = state.icps.length < 2;
  const view = $("#view");
  const hit = ROUTES.find(([re]) => re.test(path));
  if (!hit) { view.innerHTML = `<div class="empty"><b>Not found</b><p>${esc(path)}</p></div>`; return; }
  const args = path.match(hit[0]).slice(1);
  view.classList.add("loading");
  try {
    const page = await hit[1]();
    window.scrollTo({ top: 0 });
    await page(view, { args, query: new URLSearchParams(location.search), state });
  } catch (e) {
    view.innerHTML = `<div class="empty"><b>Something went wrong</b><p>${esc(e.message)}</p></div>`;
  } finally {
    view.classList.remove("loading");
  }
}

/** A centred dialog for details that shouldn't push the page around. */
export function openModal(html, wide = false) {
  const m = $("#modal");
  m.hidden = false;
  m.innerHTML = `<div class="modal-bg" data-close-modal></div><div class="modal-box ${wide ? "wide" : ""}" role="dialog" aria-modal="true"><button class="x modal-x" data-close-modal aria-label="Close">${icon("x", 18)}</button><div class="modal-body">${html}</div></div>`;
  document.body.style.overflow = "hidden";
  return m.querySelector(".modal-body");
}
export function closeModal() {
  const m = $("#modal");
  if (m.hidden) return false;
  m.hidden = true;
  m.innerHTML = "";
  document.body.style.overflow = "";
  return true;
}

async function boot() {
  try {
    state.meta = await get("/api/meta");
    const t = await get("/api/today");
    state.icps = t.icps.map((i) => i.slug);
  } catch (e) {
    toast(e.message, "err");
    state.meta = { members: [] };
  }
  const members = state.meta.members ?? [];
  if (!me() && members[0]) setMe(members[0].id);
  $("#me").innerHTML = members.map((m) => `<option value="${esc(m.id)}" ${m.id === me() ? "selected" : ""}>${esc(m.name ?? m.id)}</option>`).join("");
  $("#me").addEventListener("change", (e) => setMe(e.target.value));
  state.icp = state.icps.includes(icpPref()) ? icpPref() : state.icps[0] ?? "";
  $("#icp").innerHTML = state.icps.map((s) => `<option ${s === state.icp ? "selected" : ""}>${esc(s)}</option>`).join("");
  $("#icp").addEventListener("change", (e) => { state.icp = e.target.value; setIcpPref(state.icp); route(); });
  $("#refresh").innerHTML = `${icon("refresh", 15)}<span>Refresh</span>`;
  route();
  refreshBadges();
  setInterval(refreshBadges, 30_000);
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link], a[href^='/']:not([target])");
  if (a && !e.metaKey && !e.ctrlKey && a.origin === location.origin) { e.preventDefault(); go(a.getAttribute("href")); return; }
  if (e.target.closest("[data-close]")) closeSheet();
  if (e.target.closest("[data-close-modal]")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // close only the top-most layer: the reading sheet over a modal first
  if (!$("#sheet").hidden) { closeSheet(); e.preventDefault(); return; }
  closeModal();
});
window.addEventListener("popstate", () => route());
$("#refresh").addEventListener("click", async () => {
  $("#refresh").classList.add("spin");
  await post("/api/refresh").catch(() => null);
  $("#refresh").classList.remove("spin");
  route();
  refreshBadges();
});
boot();
