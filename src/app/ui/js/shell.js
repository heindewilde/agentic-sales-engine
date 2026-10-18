// The app shell: Work | System areas, the sub-nav, who you are, which ICP, and the router.
import { $, $$, closeSheet, esc, get, icpPref, me, setIcpPref, setMe, toast } from "./ui.js";

const AREAS = {
  work: [["/today", "_today"], ["/accounts", "_accounts"], ["/runs", "_runs"], ["/outcomes", "_outcomes"]],
  system: [["/process", "_process"], ["/brain", "_brain"], ["/stack", "_stack"]],
};
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

export const state = { meta: null, icps: [], icp: "" };

const areaOf = (path) => (/^\/(process|brain|stack)/.test(path) ? "system" : "work");

export function go(path, push = true) {
  if (push && path !== location.pathname + location.search) history.pushState(null, "", path);
  closeSheet();
  route();
}

async function route() {
  const path = location.pathname;
  const area = areaOf(path);
  $$(".area a").forEach((a) => a.classList.toggle("on", a.dataset.area === area));
  $("#subnav").innerHTML = AREAS[area].map(([href, label]) => `<a href="${href}" data-link class="${path === href || path.startsWith(`${href}/`) || (href === "/today" && path === "/") ? "on" : ""}">${label}</a>`).join("");
  $("#system-band").hidden = area !== "system";
  $("#icp-pick").hidden = area !== "work" || state.icps.length < 2;
  document.body.dataset.area = area;
  const view = $("#view");
  const hit = ROUTES.find(([re]) => re.test(path));
  if (!hit) { view.innerHTML = `<div class="empty"><b>Not found</b><p>${esc(path)}</p></div>`; return; }
  const args = path.match(hit[0]).slice(1);
  try {
    const page = await hit[1]();
    window.scrollTo({ top: 0 });
    await page(view, { args, query: new URLSearchParams(location.search), state });
  } catch (e) {
    view.innerHTML = `<div class="empty"><b>Something went wrong</b><p>${esc(e.message)}</p></div>`;
  }
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
  // who you are: approvals and outcomes record a team member
  const members = state.meta.members ?? [];
  if (!me() && members[0]) setMe(members[0].id);
  $("#me").innerHTML = members.map((m) => `<option value="${esc(m.id)}" ${m.id === me() ? "selected" : ""}>${esc(m.name ?? m.id)}</option>`).join("");
  $("#me").addEventListener("change", (e) => setMe(e.target.value));
  state.icp = state.icps.includes(icpPref()) ? icpPref() : state.icps[0] ?? "";
  $("#icp").innerHTML = state.icps.map((s) => `<option ${s === state.icp ? "selected" : ""}>${esc(s)}</option>`).join("");
  $("#icp").addEventListener("change", (e) => { state.icp = e.target.value; setIcpPref(state.icp); route(); });
  route();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link], a[href^='/']:not([target])");
  if (a && !e.metaKey && !e.ctrlKey && a.origin === location.origin) { e.preventDefault(); go(a.getAttribute("href")); return; }
  if (e.target.closest("[data-close]")) closeSheet();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });
window.addEventListener("popstate", () => route());
$("#refresh").addEventListener("click", async () => {
  $("#refresh").textContent = "_refreshing…";
  const { post } = await import("./ui.js");
  await post("/api/refresh").catch(() => null);
  $("#refresh").textContent = "_refresh";
  route();
});
boot();
