// Runs: start one (here on your subscription, or in the cloud on API credits), watch it live, review cloud results, schedules.
import { $, day, empty, esc, get, me, money, openSheet, post, toast } from "./ui.js";

const STATUS = { running: "running", done: "done", failed: "failed", question: "needs an answer", interrupted: "interrupted", idle: "done", terminated: "stopped" };
let streaming = null;

export async function runsPage(view, { query, state }) {
  const r = await get("/api/runs");
  const skills = r.skills;
  const pre = { skill: query.get("skill") ?? "", icp: query.get("icp") ?? state.icp, domains: query.get("domains") ?? "" };
  view.innerHTML = `
    <section class="intro"><div><h1>Runs</h1><p>Start a step of the engine and follow it live. <b>Here</b> uses your Claude subscription on this Mac; <b>cloud</b> runs on Managed Agents from your API credits and comes back as a pull request to review.</p></div></section>
    <section class="panel">
      <h3>Start a run</h3>
      <div class="form-row">
        <label>Step<select id="r-skill">${Object.entries(skills).map(([k, s]) => `<option value="${k}" ${k === pre.skill ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select></label>
        <label>ICP<select id="r-icp">${state.icps.map((i) => `<option ${i === pre.icp ? "selected" : ""}>${esc(i)}</option>`).join("")}</select></label>
        <label class="grow" id="r-dom-wrap">Accounts <span class="muted">(empty = all that are ready for this step)</span><input id="r-domains" placeholder="a.com, b.com" value="${esc(pre.domains.replace(/,/g, ", "))}"></label>
        <label class="narrow">Budget, $<input id="r-budget" type="number" min="0.1" step="0.5" value="3"></label>
      </div>
      <div class="form-row">
        <div class="seg" id="r-where"><button data-w="local" class="on">Here · subscription</button><button data-w="cloud">Cloud · API credits</button></div>
        <span class="grow muted" id="r-plan"></span>
        <button class="btn" id="r-check">Check plan</button><button class="btn primary" id="r-start">Start</button>
      </div>
    </section>
    <div id="live"></div>
    <h3 class="section">Recent runs</h3><div id="jobs"></div>
    <h3 class="section">Cloud results <button class="link small" id="c-load">_check now</button></h3><div id="cloud"><p class="muted">Finished cloud runs and their pull requests. Check now to load them.</p></div>
    <h3 class="section">Schedules</h3><div id="scheds"><p class="muted">Loading…</p></div>`;
  let where = "local";
  const form = () => ({ where, skill: $("#r-skill").value, icp: $("#r-icp").value, domains: $("#r-domains").value.split(/[\s,]+/).filter(Boolean), budget: Number($("#r-budget").value), by: me() });
  const sync = () => {
    const s = skills[$("#r-skill").value];
    $("#r-dom-wrap").style.display = s.perAccount ? "" : "none";
    $("#r-where [data-w=cloud]").disabled = !s.cloud;
    $("#r-plan").textContent = where === "local" && r.busy ? "A local run is going; a new one here waits until it ends." : "";
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
    $("#r-plan").textContent = p.error ? p.error : p.where === "cloud" ? p.note : p.accounts != null ? `${p.accounts} account${p.accounts === 1 ? "" : "s"} in ${p.chunks} session${p.chunks === 1 ? "" : "s"} · ${p.billing === "subscription" ? "on your subscription" : "billed per token"} · stops at $${p.budget}` : `one session · ${p.billing === "subscription" ? "on your subscription" : "billed per token"} · stops at $${p.budget}`;
  };
  $("#r-start").onclick = async (e) => {
    e.target.disabled = true;
    const j = await post("/api/runs/start", form());
    e.target.disabled = false;
    if (j.error) return toast(j.error, "err");
    toast(where === "local" ? "Started here" : "Started in the cloud");
    watch(j.id, view, state);
    jobs(view);
  };
  sync();
  await jobs(view);
  const running = (await get("/api/runs")).jobs.find((j) => j.status === "running");
  if (running) watch(running.id, view, state);
  $("#c-load").onclick = () => cloud(view, true);
  schedules(view);
}

async function jobs(view) {
  const { jobs } = await get("/api/runs");
  $("#jobs", view).innerHTML = jobs.length ? `<table class="grid-table"><thead><tr><th>Started</th><th>Step</th><th>Where</th><th>Status</th><th>Result</th><th class="r">Cost</th></tr></thead><tbody>${jobs.slice(0, 20).map((j) => `<tr data-job="${esc(j.id)}" class="clickable">
    <td>${day(j.started)} ${new Date(j.started).toTimeString().slice(0, 5)}</td><td><b>${esc(j.skill)}</b><small>${esc([j.icp, (j.domains ?? []).join(", ")].filter(Boolean).join(" · "))}</small></td>
    <td>${j.where === "local" ? "here" : "cloud"}</td><td><span class="st ${esc(j.status)}">${esc(STATUS[j.status] ?? j.status)}</span></td>
    <td class="clip">${esc((j.summary ?? "").split("\n")[0])}${j.pr ? ` <a href="${esc(j.pr)}" target="_blank" rel="noopener">PR ↗</a>` : ""}</td><td class="r num">${j.cost != null ? money(j.cost) : "–"}</td></tr>`).join("")}</tbody></table>`
    : empty("No runs from the app yet", "Start one above; runs from the terminal and schedules show under cloud results and in each step's history.");
  $("#jobs", view).onclick = (e) => { const tr = e.target.closest("[data-job]"); if (tr) watch(tr.dataset.job, view); };
}

/** Follow a run: its log so far, then live lines, then the result. */
function watch(id, view) {
  streaming?.close();
  const live = $("#live", view);
  live.innerHTML = `<section class="panel live"><div class="live-head"><h3>Run <span class="muted">${esc(id)}</span></h3><span class="st running" id="l-st">running</span></div><pre class="log" id="log"></pre><div id="l-res"></div></section>`;
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
    $("#l-res", live).innerHTML = `${j.summary ? `<p>${esc(j.summary)}</p>` : ""}${j.checks?.length ? `<h4>Flagged to double-check</h4><ul class="checks">${j.checks.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}${j.pr ? `<p><button class="btn" data-pr="${esc(j.pr)}">Review the pull request</button></p>` : ""}`;
    jobs(view);
  });
  es.onerror = () => es.close();
}

async function cloud(view, fresh) {
  const el = $("#cloud", view);
  el.innerHTML = `<p class="muted">Asking the platform… (this opens pull requests for runs that finished)</p>`;
  try {
    const { runs } = await get(`/api/cloud${fresh ? "?fresh=1" : ""}`);
    el.innerHTML = runs.length ? `<table class="grid-table"><thead><tr><th>Status</th><th>Summary</th><th class="r">Cost</th><th></th></tr></thead><tbody>${runs.map((c) => `<tr>
      <td><span class="st ${esc(c.status)}">${esc(STATUS[c.status] ?? c.status)}</span></td>
      <td class="why">${esc((c.message ?? "").split("\n")[0].slice(0, 180))}${c.checks?.length ? `<small>${c.checks.length} point${c.checks.length === 1 ? "" : "s"} to double-check</small>` : ""}</td>
      <td class="r num">${c.cost_usd != null ? money(c.cost_usd) : "–"}</td>
      <td class="r">${c.pr ? `<button class="btn" data-pr="${esc(c.pr)}">Review</button>` : `<span class="muted">${c.status === "question" ? "waiting for an answer" : "no changes"}</span>`}</td></tr>`).join("")}</tbody></table>`
      : empty("No cloud runs in the last two weeks", "Scheduled runs and cloud runs started here appear once they finish.");
  } catch (e) {
    el.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

/** A cloud run's pull request: what it changes, then merge (and pull into your workspace). */
async function review(pr, view) {
  const s = openSheet(`<p class="muted">Loading the pull request…</p>`);
  try {
    const d = await get(`/api/cloud/pr?url=${encodeURIComponent(pr)}`);
    s.innerHTML = `<div class="sheet-top"><span class="who">Cloud run · pull request</span><button class="x" data-close aria-label="Close">×</button></div>
      <h2>${esc(d.title)}</h2><div class="path"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)} ↗</a></div>
      <div class="meta"><span>${esc(d.state.toLowerCase())}</span><span>+${d.additions} −${d.deletions}</span><span>${d.files.length} files</span></div>
      ${d.state === "OPEN" ? `<p><button class="btn primary" id="merge">Merge into your workspace</button></p>` : ""}
      <h4>Files</h4><div class="list">${d.files.map((f) => `<div class="item"><span class="t">${esc(f.path)}</span><span class="n">+${f.additions} −${f.deletions}</span></div>`).join("")}</div>
      <h4 style="margin-top:20px">Summary</h4><div class="prose">${window.marked ? `<div class="md">${window.marked.parse(d.body ?? "")}</div>` : esc(d.body)}</div>`;
    $("#merge", s)?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      const r = await post("/api/cloud/merge", { pr });
      e.target.disabled = false;
      if (r.error) return toast(r.error, "err");
      toast(r.note);
      review(pr, view);
    });
  } catch (e) {
    s.innerHTML = `<div class="sheet-top"><span></span><button class="x" data-close>×</button></div><p class="empty-note">${esc(e.message)}</p>`;
  }
}

async function schedules(view) {
  const el = $("#scheds", view);
  const { schedules } = await get("/api/schedules");
  el.innerHTML = schedules.length ? `<table class="grid-table"><thead><tr><th>What</th><th>When</th><th>Next run</th><th class="r">Cap</th><th></th></tr></thead><tbody>${schedules.map((s) => `<tr>
    <td><b>${esc(s.skill)}</b><small>${esc(s.args)}</small></td><td>${esc(cronText(s.cron))}<small>${esc(s.timezone)}</small></td>
    <td>${s.paused ? `<span class="muted">paused</span>` : s.next_run ? `${day(s.next_run)} ${new Date(s.next_run).toTimeString().slice(0, 5)}` : "–"}</td>
    <td class="r num">${s.cap_usd != null ? money(s.cap_usd) : "–"}</td>
    <td class="r"><button class="btn ghost" data-sched="${esc(s.id)}" data-act="${s.paused ? "unpause" : "pause"}">${s.paused ? "Resume" : "Pause"}</button><button class="btn" data-sched="${esc(s.id)}" data-act="run">Run now</button></td></tr>`).join("")}</tbody></table>`
    : empty("No schedules", "Schedules are created with the managed CLI; they show up here to pause, resume or run.");
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

/** The three cron shapes the engine uses, in words; anything else as written. */
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
