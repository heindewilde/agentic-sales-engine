// Runs: start one (here on your subscription, or in the cloud on API credits), watch it live, review cloud results, schedules.
import { icon } from "./icons.js";
import { $, card, day, empty, esc, get, me, money, openSheet, post, stat, toast } from "./ui.js";
import { refreshBadges } from "./shell.js";

const STATUS = { running: "running", done: "done", failed: "failed", question: "needs an answer", interrupted: "interrupted", idle: "done", terminated: "stopped" };
let streaming = null;

export async function runsPage(view, { query, state }) {
  const r = await get("/api/runs");
  const skills = r.skills;
  const pre = { skill: query.get("skill") ?? "", icp: query.get("icp") ?? state.icp, domains: query.get("domains") ?? "" };
  const week = r.jobs.filter((j) => Date.parse(j.started) > Date.now() - 7 * 86_400_000);
  view.innerHTML = `
    <header class="ph"><div><span class="ph-eyebrow">${icon("runs", 14)} Work · runs</span><h1>Runs</h1>
      <p class="sub">Start a step of the engine and follow it live: here on this Mac with your Claude subscription, or in the cloud on Managed Agents, where the result comes back as a pull request to review.</p></div></header>
    <div class="stats">
      ${stat("activity", "Runs this week", week.length, `${week.filter((j) => j.where === "cloud").length} in the cloud`)}
      ${stat("play", "Running now", r.jobs.filter((j) => j.status === "running").length, r.busy ? "a local run is going" : "nothing local going", r.busy ? "good" : "")}
      ${stat("zap", "Model cost this week", money(week.reduce((a, j) => a + (j.cost ?? 0), 0)), "API-equivalent for local runs")}
      ${stat("alert", "Failed this week", week.filter((j) => j.status === "failed").length, "open a run to see why")}
    </div>
    <div class="grid2"><div>
      ${card("plus", "Start a run", `
        <div class="form-grid">
          <label>Step<select id="r-skill">${Object.entries(skills).map(([k, s]) => `<option value="${k}" ${k === pre.skill ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select></label>
          <label>ICP<select id="r-icp">${state.icps.map((i) => `<option ${i === pre.icp ? "selected" : ""}>${esc(i)}</option>`).join("")}</select></label>
          <label id="r-dom-wrap">Accounts <span class="muted">(empty = all ready for this step)</span><input id="r-domains" placeholder="a.com, b.com" value="${esc(pre.domains.replace(/,/g, ", "))}"></label>
          <label>Budget, $<input id="r-budget" type="number" min="0.1" step="0.5" value="3"></label>
        </div>
        <div class="where" id="r-where">
          <button data-w="local" class="on"><span class="tile run">${icon("laptop", 16)}</span><span><b>Here, on this Mac</b><small>your Claude subscription · one at a time</small></span></button>
          <button data-w="cloud"><span class="tile outcomes">${icon("cloud", 16)}</span><span><b>In the cloud</b><small>Managed Agents · API credits · ends as a pull request</small></span></button>
        </div>
        <div class="run-bar"><span class="grow" id="r-plan"></span><button class="btn" id="r-check">Check plan</button><button class="btn primary" id="r-start">${icon("play", 12)} Start</button></div>`)}
      <div id="live"></div>
      ${card("activity", "Recent runs", `<div id="jobs"></div>`, { flush: true })}
    </div><div>
      ${card("clock", "Schedules", `<div id="scheds"><p class="muted">Loading…</p></div>`, { flush: true })}
      ${card("merge", "Cloud results", `<div id="cloud"><div class="card-b"><p class="muted" style="margin:0 0 12px">Finished cloud runs and their pull requests. Checking opens pull requests for runs that just finished.</p><button class="btn sm" id="c-load">${icon("refresh", 12)} Check now</button></div></div>`, { flush: true })}
    </div></div>`;
  let where = "local";
  const form = () => ({ where, skill: $("#r-skill").value, icp: $("#r-icp").value, domains: $("#r-domains").value.split(/[\s,]+/).filter(Boolean), budget: Number($("#r-budget").value), by: me() });
  const sync = () => {
    const s = skills[$("#r-skill").value];
    $("#r-dom-wrap").style.visibility = s.perAccount ? "visible" : "hidden";
    $("#r-where [data-w=cloud]").disabled = !s.cloud;
    $("#r-plan").textContent = where === "local" && r.busy ? "A local run is going; start this one in the cloud or wait." : "";
  };
  $("#r-skill").onchange = sync;
  $("#r-where").onclick = (e) => {
    const b = e.target.closest("[data-w]");
    if (!b || b.disabled) return;
    where = b.dataset.w;
    view.querySelectorAll("#r-where button").forEach((x) => x.classList.toggle("on", x === b));
    sync();
  };
  $("#r-check").onclick = async () => {
    const p = await post("/api/runs/plan", form());
    $("#r-plan").textContent = p.error ? p.error : p.where === "cloud" ? p.note : p.accounts != null ? `${p.accounts} account${p.accounts === 1 ? "" : "s"} in ${p.chunks} session${p.chunks === 1 ? "" : "s"} · ${p.billing === "subscription" ? "on your subscription" : "billed per token"} · stops at $${p.budget}` : `One session · ${p.billing === "subscription" ? "on your subscription" : "billed per token"} · stops at $${p.budget}`;
  };
  $("#r-start").onclick = async (e) => {
    e.target.disabled = true;
    const j = await post("/api/runs/start", form());
    e.target.disabled = false;
    if (j.error) return toast(j.error, "err");
    toast(where === "local" ? "Started here" : "Started in the cloud");
    watch(j.id, view);
    jobs(view);
    refreshBadges();
  };
  sync();
  await jobs(view);
  const running = r.jobs.find((j) => j.status === "running");
  if (running) watch(running.id, view);
  $("#c-load").onclick = () => cloud(view, true);
  schedules(view);
}

async function jobs(view) {
  const { jobs } = await get("/api/runs");
  $("#jobs", view).innerHTML = jobs.length ? `<table class="tbl"><thead><tr><th>Step</th><th>Where</th><th>Status</th><th>Result</th><th class="r">Cost</th></tr></thead><tbody>${jobs.slice(0, 20).map((j) => `<tr data-job="${esc(j.id)}" class="clickable">
    <td><b>${esc(j.skill)}</b><small>${day(j.started)} ${new Date(j.started).toTimeString().slice(0, 5)}${j.icp ? ` · ${esc(j.icp)}` : ""}${(j.domains ?? []).length ? ` · ${esc(j.domains.join(", "))}` : ""}</small></td>
    <td><span class="pill">${icon(j.where === "local" ? "laptop" : "cloud", 12)} ${j.where === "local" ? "here" : "cloud"}</span></td><td><span class="st ${esc(j.status)}">${esc(STATUS[j.status] ?? j.status)}</span></td>
    <td class="clip">${esc((j.summary ?? "").split("\n")[0])}</td><td class="r num">${j.cost != null ? money(j.cost) : "–"}</td></tr>`).join("")}</tbody></table>`
    : empty("No runs from the app yet", "Start one above. Scheduled and terminal runs show under cloud results.", "runs");
  $("#jobs", view).onclick = (e) => { const tr = e.target.closest("[data-job]"); if (tr) watch(tr.dataset.job, view); };
}

/** Follow a run: its log so far, then live lines, then the result. */
function watch(id, view) {
  streaming?.close();
  const live = $("#live", view);
  live.innerHTML = card("terminal", "Run", `<pre class="log" id="log"></pre><div id="l-res"></div>`).replace('<h3>', `<h3 data-run="${esc(id)}">`).replace("</h3>", ` <span class="st running" id="l-st">running</span></h3>`);
  const log = $("#log", live);
  const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream`);
  streaming = es;
  es.addEventListener("line", (e) => {
    log.textContent += `${JSON.parse(e.data)}\n`;
    log.scrollTop = log.scrollHeight;
  });
  es.addEventListener("end", (e) => {
    const j = JSON.parse(e.data);
    es.close();
    $("#l-st", live).className = `st ${j.status}`;
    $("#l-st", live).textContent = STATUS[j.status] ?? j.status;
    $("#l-res", live).innerHTML = `${j.summary ? `<p style="margin:14px 0 0">${esc(j.summary)}</p>` : ""}${j.checks?.length ? `<h4 style="margin-top:14px">Flagged to double-check</h4><ul class="checks">${j.checks.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}${j.pr ? `<p><button class="btn" data-pr="${esc(j.pr)}">${icon("merge", 14)} Review the pull request</button></p>` : ""}`;
    jobs(view);
    refreshBadges();
  });
  es.onerror = () => es.close();
}

async function cloud(view, fresh) {
  const el = $("#cloud", view);
  el.innerHTML = `<div class="card-b"><p class="muted" style="margin:0">Asking the platform…</p></div>`;
  try {
    const { runs } = await get(`/api/cloud${fresh ? "?fresh=1" : ""}`);
    el.innerHTML = runs.length ? `<div class="list pad">${runs.map((c) => `<div class="item"><span class="t"><span class="st ${esc(c.status)}">${esc(STATUS[c.status] ?? c.status)}</span> ${c.cost_usd != null ? `<span class="muted">· ${money(c.cost_usd)}</span>` : ""}<small>${esc((c.message ?? "").split("\n")[0].slice(0, 120))}</small></span>
      ${c.pr ? `<button class="btn sm" data-pr="${esc(c.pr)}">Review</button>` : `<span class="muted">${c.status === "question" ? "needs an answer" : "no changes"}</span>`}</div>`).join("")}</div>`
      : empty("No cloud runs in two weeks", "Results appear once cloud runs finish.", "cloud");
  } catch (e) {
    el.innerHTML = `<div class="card-b"><p class="muted" style="margin:0">${esc(e.message)}</p></div>`;
  }
}

/** A cloud run's pull request: what it changes, then merge (and pull into your workspace). */
async function review(pr, view) {
  const s = openSheet(`<p class="muted">Loading the pull request…</p>`);
  try {
    const d = await get(`/api/cloud/pr?url=${encodeURIComponent(pr)}`);
    s.innerHTML = `<div class="sheet-top"><span class="who">${icon("merge", 14)} Cloud run · pull request</span><button class="x" data-close aria-label="Close">${icon("x", 18)}</button></div>
      <h2>${esc(d.title)}</h2><div class="path"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)} ↗</a></div>
      <div class="meta"><span class="pill ${d.state === "OPEN" ? "accent" : d.state === "MERGED" ? "good" : ""}">${esc(d.state.toLowerCase())}</span><span>+${d.additions} −${d.deletions}</span><span>${d.files.length} files</span></div>
      ${d.state === "OPEN" ? `<p><button class="btn primary" id="merge">${icon("merge", 14)} Merge into your workspace</button></p>` : ""}
      <h4>Files</h4><div class="list">${d.files.map((f) => `<div class="item"><span class="t">${esc(f.path)}</span><span class="n">+${f.additions} −${f.deletions}</span></div>`).join("")}</div>
      <h4 style="margin-top:20px">Summary</h4><div class="prose"><div class="md">${window.marked.parse(d.body ?? "")}</div></div>`;
    $("#merge", s)?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      const r = await post("/api/cloud/merge", { pr });
      e.target.disabled = false;
      if (r.error) return toast(r.error, "err");
      toast(r.note);
      review(pr, view);
    });
  } catch (e) {
    s.innerHTML = `<div class="sheet-top"><span></span><button class="x" data-close>${icon("x", 18)}</button></div><p class="empty-note">${esc(e.message)}</p>`;
  }
}

async function schedules(view) {
  const el = $("#scheds", view);
  const { schedules } = await get("/api/schedules");
  el.innerHTML = schedules.length ? `<div class="list pad">${schedules.map((s) => `<div class="item"><span class="co"><span class="tile ${s.paused ? "" : "outcomes"}" style="width:32px;height:32px">${icon(s.paused ? "pause" : "clock", 15)}</span><span class="t">${esc(s.skill)} <span class="muted">${esc(s.args.replace(/--icp \S+/, "").trim())}</span>
      <small>${esc(cronText(s.cron))} · ${s.paused ? "paused" : s.next_run ? `next ${day(s.next_run)} ${new Date(s.next_run).toTimeString().slice(0, 5)}` : ""}${s.cap_usd != null ? ` · cap ${money(s.cap_usd)}` : ""}</small></span></span>
      <span style="display:flex;gap:4px"><button class="btn sm ghost" data-sched="${esc(s.id)}" data-act="${s.paused ? "unpause" : "pause"}" title="${s.paused ? "Resume" : "Pause"}">${icon(s.paused ? "play" : "pause", 13)}</button><button class="btn sm" data-sched="${esc(s.id)}" data-act="run">Run now</button></span></div>`).join("")}</div>`
    : empty("No schedules", "They're created with the managed CLI and show up here.", "clock");
  el.onclick = async (e) => {
    const b = e.target.closest("[data-sched]");
    if (!b) return;
    b.disabled = true;
    const r = await post(`/api/schedules/${b.dataset.sched}/${b.dataset.act}`);
    if (r.error) toast(r.error, "err");
    else toast(b.dataset.act === "run" ? "Started in the cloud" : b.dataset.act === "pause" ? "Paused" : "Resumed");
    schedules(view);
  };
}

/** The cron shapes the engine uses, in words; anything else as written. */
function cronText(c) {
  const [m, h, dom, , dow] = c.split(" ");
  const t = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (dom === "*" && dow !== "*") return `every ${days[Number(dow)] ?? dow} at ${t}`;
  if (dom !== "*" && dow === "*") return `day ${dom} of each month at ${t}`;
  if (dom === "*" && dow === "*") return `every day at ${t}`;
  return c;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-pr]");
  if (b && location.pathname === "/runs") review(b.dataset.pr, document.getElementById("view"));
});
