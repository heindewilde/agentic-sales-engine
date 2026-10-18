// Today: what's waiting for you (decisions first), then the pipeline, recent runs and your best accounts.
import { icon } from "./icons.js";
import { STAGES, STAGE_NAME, card, day, empty, esc, get, initials, money, stat, tierPill } from "./ui.js";

const KIND = { gate: "gate", drafts: "draft", outcomes: "review", stale: "clock", run: "play" };

export async function today(view, { state }) {
  const [t, runs, best] = await Promise.all([
    get("/api/today"),
    get("/api/runs").catch(() => ({ jobs: [] })),
    get(`/api/accounts?icp=${encodeURIComponent(state.icp)}&stage=outreach_ready`).catch(() => ({ rows: [] })),
  ]);
  const h = new Date().getHours();
  const greeting = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const stages = t.funnel[state.icp] ?? Object.values(t.funnel)[0] ?? {};
  const total = Object.values(stages).reduce((a, b) => a + b, 0);
  const decisions = t.items.filter((i) => i.kind === "gate");
  const todos = t.items.filter((i) => i.kind !== "gate");
  view.innerHTML = `
    <header class="ph"><div><span class="ph-eyebrow">${icon("today", 14)} ${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</span>
      <h1>${greeting}.</h1><p class="sub">${t.items.length ? `${decisions.length ? `${decisions.length} decision${decisions.length === 1 ? "" : "s"} and ` : ""}${todos.length} thing${todos.length === 1 ? "" : "s"} to do. The engine waits for you at the decisions.` : "Nothing is waiting for you. The engine carries on by itself until it needs a decision."}</p></div></header>
    <div class="stats">
      ${stat("flag", "Waiting for you", t.items.length, decisions.length ? `${decisions.length} decision${decisions.length === 1 ? "" : "s"}` : "no decisions open", t.items.length ? "accent" : "")}
      ${stat("accounts", "Accounts", total, `${stages.excluded ?? 0} excluded`, "", "/accounts")}
      ${stat("mail", "Ready for outreach", stages.outreach_ready ?? 0, `${stages.scored ?? 0} scored, awaiting review`, "dark", "/accounts?stage=outreach_ready")}
      ${stat("zap", "Spent this week", money(t.spend_week.billed), `+ ${money(t.spend_week.covered_by_plan)} covered by your plan`)}
    </div>
    <div class="grid2"><div>
      ${card("flag", "Waiting for you", t.items.length ? todoRows(decisions, "Decisions") + todoRows(todos, "To do") : empty("All clear", "New decisions, drafts and outcome questions show up here as the engine works.", "check"), { count: t.items.length || "", flush: true })}
      ${t.problems?.length ? `<div class="note warn">${icon("alert", 16)}<div><b>Needs attention</b><ul>${t.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div></div>` : ""}
      ${card("runs", "Recent runs", recent(runs.jobs), { link: "/runs", linkText: "All runs", flush: true })}
    </div><div>
      ${card("chart", "Pipeline", funnel(stages), { link: "/accounts", linkText: "Accounts" })}
      ${card("mail", "Ready for outreach", bestList(best.rows), { count: best.rows.length || "", link: "/today/drafts", linkText: "Drafts", flush: true })}
      <p class="muted">${icon(t.billing === "subscription" ? "laptop" : "key", 13)} Claude ${t.billing === "subscription" ? "runs on your subscription" : "is billed per token"} · ${esc(t.tier?.detail ?? "")}</p>
    </div></div>`;
  view.querySelectorAll("tr[data-go]").forEach((tr) => tr.addEventListener("click", () => import("./shell.js").then((m) => m.go(tr.dataset.go))));
}

function todoRows(items, label) {
  if (!items.length) return "";
  return `<div class="card-sub">${esc(label)}</div>${items.map((i) => `<a class="todo" href="${esc(i.href)}" data-link><span class="tile ${esc(i.kind)}">${icon(KIND[i.kind] ?? "info", 17)}</span>
      <span><b>${esc(i.title)}</b><small>${esc(i.detail)}</small></span>
      <span class="go">${i.kind === "gate" ? "Review" : i.kind === "run" ? "Start" : "Open"} ${icon("arrow", 13)}</span></a>`).join("")}`;
}

/** How many accounts reached each stage (or got past it), as bars. */
function funnel(stages) {
  if (!Object.keys(stages).length) return empty("No accounts yet", "Find companies for an approved ICP to start.", "accounts");
  const reach = STAGES.map((s, i) => STAGES.slice(i).reduce((a, x) => a + (stages[x] ?? 0), 0) + (i <= 1 ? stages.excluded ?? 0 : 0));
  const max = Math.max(1, ...reach);
  return `<div class="fchart">${STAGES.map((s, i) => `<a class="frow" href="/accounts?stage=${s}" data-link title="${stages[s] ?? 0} at this stage now">
      <span class="fl">${esc(STAGE_NAME[s])}</span><span class="fb"><i style="width:${(100 * reach[i]) / max}%"></i></span><span class="fv">${reach[i]}</span></a>`).join("")}
    ${stages.excluded ? `<div class="frow ex"><span class="fl">Excluded</span><span class="fb"><i style="width:${(100 * stages.excluded) / max}%"></i></span><span class="fv">${stages.excluded}</span></div>` : ""}</div>`;
}

function recent(jobs) {
  if (!jobs.length) return empty("No runs from the app yet", "Start one from Runs.", "runs");
  return `<table class="tbl">${jobs.slice(0, 5).map((j) => `<tr class="clickable" data-go="/runs"><td><b>${esc(j.skill)}</b><small>${esc([j.icp, j.where === "local" ? "here" : "cloud"].filter(Boolean).join(" · "))}</small></td>
    <td><span class="st ${esc(j.status)}">${esc(j.status)}</span></td><td class="muted">${day(j.started)}</td><td class="r num">${j.cost != null ? money(j.cost) : "–"}</td></tr>`).join("")}</table>`;
}

function bestList(rows) {
  if (!rows.length) return empty("None yet", "Accounts appear here once they have a way in.", "mail");
  return `<div class="list pad">${rows.slice(0, 6).map((r) => `<a class="item" href="/accounts/${esc(r.domain)}" data-link><span class="co"><span class="mono-av">${esc(initials(r.name ?? r.domain))}</span><span class="t">${esc(r.name ?? r.domain)}<small>${esc(r.domain)}</small></span></span>${tierPill(r.tier)}</a>`).join("")}</div>`;
}
