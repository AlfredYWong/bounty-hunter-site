/* Bounty Hunter web app. Talks only to Supabase with the publishable key; every query is
   limited to the signed-in user's rows by row-level security. Jobs are queued through the
   enqueue_job() database function, which enforces the daily limits. */
"use strict";

const cfg = window.BH_CONFIG;
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  // implicit flow: the emailed link works even if opened in another browser or a mail app's viewer
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
});
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "#");
const TIERS = ["most", "more", "less", "least", "unscored"];
const STARS = { most: "★★★★", more: "★★★☆", less: "★★☆☆", least: "★☆☆☆", unscored: "☆☆☆☆" };
const FLAG_LABEL = {
  us_entity_required: ["US entity", ""], small_business_required: ["Small business", "good"], for_profit_required: ["For-profit", "good"],
  nonprofit_only: ["Nonprofits only", "bad"], academic_only: ["Universities only", "bad"], government_only: ["Government only", "bad"],
  individuals_only: ["Individuals only", "bad"], equity_taken: ["Takes equity", "warn"], cost_share_required: ["Cost share", "warn"],
  partner_required: ["Partner required", "warn"], security_clearance: ["Clearance may be needed", "warn"],
  eligibility_unclear: ["Eligibility unclear", "warn"], open_to_all: ["Open to all", "good"],
};

const S = { user: null, profile: null, opps: [], questions: [], drafts: [], jobs: [], usage: null,
            filter: "rec", query: "", selectedJob: null, selectedDraft: null, pollTimer: null };

/* ─── auth ─────────────────────────────────────────────────────────────────── */
$("signinForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("email").value.trim();
  $("signinBtn").disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  $("signinBtn").disabled = false;
  $("signinMsg").className = error ? "err" : "okmsg";
  $("signinMsg").textContent = error ? `Couldn't send the link: ${error.message}` : "Check your inbox and click the link to sign in. You can close this tab.";
});
function showLinkError() {
  const p = new URLSearchParams(location.hash.replace(/^#/, "") || location.search);
  const err = p.get("error_description") || p.get("error");
  if (!err) return;
  $("signinMsg").className = "err";
  $("signinMsg").textContent = `That sign-in link didn't work: ${err.replace(/\+/g, " ")}. Request a new link below; links expire after one use.`;
  history.replaceState(null, "", location.pathname);
}
sb.auth.onAuthStateChange((_evt, session) => setSession(session));
sb.auth.getSession().then(({ data }) => setSession(data.session));

let authReady = false;
function setSession(session) {
  const user = session?.user || null;
  if (authReady && user?.id === S.user?.id) return;   // first call always renders something
  authReady = true;
  S.user = user;
  if (!user) showLinkError();
  $("gate").hidden = !!user; $("app").hidden = !user;
  if (user) { $("whoami").textContent = `Signed in as ${user.email}`; loadAll(true); } else stopPolling();
}
$("signoutBtn").addEventListener("click", () => sb.auth.signOut());

/* ─── data ─────────────────────────────────────────────────────────────────── */
async function loadAll(first = false) {
  const uid = S.user.id;
  const [p, o, q, d, j, u] = await Promise.all([
    sb.from("profiles").select("profile").eq("user_id", uid).maybeSingle(),
    sb.from("opportunities").select("id,tier,status,deadline,row").neq("status", "archived").limit(500),
    sb.from("questions").select("*").order("asked_at", { ascending: true }),
    sb.from("drafts").select("op_id,version,state,markdown,updated_at").order("updated_at", { ascending: false }),
    sb.from("jobs").select("*").order("created_at", { ascending: false }).limit(15),
    sb.rpc("my_usage"),
  ]);
  const firstErr = [p, o, q, d, j, u].find(r => r.error);
  if (firstErr) toast(`Couldn't load everything: ${firstErr.error.message}`);
  S.profile = p.data?.profile || null; S.opps = o.data || []; S.questions = q.data || []; S.drafts = d.data || [];
  S.jobs = j.data || []; S.usage = u.data || null;
  renderAll();
  if (first) {
    if (!S.profile?.entity) { show("profile"); toast("Set up your profile to start"); }
    else restoreView();
  }
  managePolling();
}

function renderAll() { renderHeader(); renderList(); renderJobs(); renderQuestions(); renderDrafts(); fillProfile(); }

/* ─── header ───────────────────────────────────────────────────────────────── */
const pad = n => String(n).padStart(2, "0");
function daysLeft(d) {
  if (!d || d === "unknown" || d === "rolling") return null;
  const t = Date.parse(d + "T23:59:59Z"); return Number.isNaN(t) ? null : Math.ceil((t - Date.now()) / 864e5);
}
function renderHeader() {
  const rec = S.opps.filter(isRecommended), soon = S.opps.filter(o => { const n = daysLeft(o.deadline); return n !== null && n >= 0 && n <= 30 && o.tier !== "least"; });
  const openQ = S.questions.filter(q => q.status === "open");
  $("sRec").textContent = pad(rec.length); $("sSoon").textContent = pad(soon.length); $("sQ").textContent = pad(openQ.length); $("sAll").textContent = pad(S.opps.length);
  $("nOpps").textContent = S.opps.length; $("nRuns").textContent = S.jobs.length; $("nQ").textContent = openQ.length; $("nD").textContent = S.drafts.length;
  $("playerTag").textContent = S.profile?.entity?.name ? `PLAYER: ${S.profile.entity.name}`.toUpperCase() : "FUNDING THAT FITS · NO FAKE LOOT";
  const lim = S.usage?.limits?.sweep ?? 2, used = S.usage?.used?.sweep ?? 0;
  $("creditPips").innerHTML = Array.from({ length: lim }, (_, i) => `<i class="${i < lim - used ? "" : "used"}"></i>`).join("");
  const busy = S.jobs.some(j => j.status === "queued" || j.status === "running");
  $("runBtn").disabled = busy;
  $("runBtn").innerHTML = busy ? "JOB RUNNING…" : '<span class="blink">INSERT COIN</span> · RUN SWEEP';
}

/* ─── opportunities ────────────────────────────────────────────────────────── */
function isRecommended(o) { return (o.tier === "most" || o.tier === "more") && !["needs_human", "skipped", "expired"].includes(o.status); }
function renderList() {
  const q = S.query.toLowerCase();
  const rows = S.opps.filter(o => {
    if (S.filter === "rec" && !isRecommended(o)) return false;
    if (S.filter === "human" && o.status !== "needs_human") return false;
    if (S.filter === "short" && !["shortlisted", "drafting"].includes(o.status)) return false;
    if (S.filter === "all" && o.status === "skipped") return false;
    const r = o.row || {};
    return !q || `${r.title} ${r.funder} ${r.opportunity_id || ""}`.toLowerCase().includes(q);
  }).sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || String(a.deadline).localeCompare(String(b.deadline)));
  const el = $("list");
  if (!S.opps.length) { el.innerHTML = `<div class="empty">NO OPPORTUNITIES YET · ${S.profile?.entity ? "RUN A SWEEP OR ASSESS A LINK" : "SET UP YOUR PROFILE FIRST"}</div>`; return; }
  if (!rows.length) { el.innerHTML = '<div class="empty">NOTHING HERE · TRY ALL TIERS</div>'; return; }
  el.innerHTML = rows.map((o, i) => {
    const r = o.row || {}, n = daysLeft(o.deadline), soon = n !== null && n <= 30;
    const on = n === null ? 10 : Math.max(0, Math.min(10, Math.round(n / 36.5)));
    const pips = Array.from({ length: 10 }, (_, k) => `<i class="${k < on ? "on" : ""}"></i>`).join("");
    const due = n === null ? (o.deadline === "rolling" ? "ROLLING" : "NOT STATED") : n < 0 ? "CLOSED" : `${n} DAY${n === 1 ? "" : "S"}`;
    const why = String(r.tier_rationale || "").split(";").map(s => s.trim()).filter(Boolean);
    const flags = (r.eligibility_flags || []).map(f => FLAG_LABEL[f.split(":")[0]] ? [...FLAG_LABEL[f.split(":")[0]], f.split(":")[1]] : [f, ""]);
    const canDraft = o.tier === "most" || o.tier === "more";
    return `<div class="row" aria-expanded="false">
      <button class="row-head" aria-controls="rb${i}">
        <span class="rank num">${pad(i + 1)}</span>
        <span class="tier t-${esc(o.tier)}"><span class="stars" aria-hidden="true">${STARS[o.tier] || ""}</span><span>${esc(String(o.tier || "").toUpperCase())}</span></span>
        <span><span class="name">${esc(r.title)}</span>
          <span class="meta">${r.opportunity_id ? `<span class="id" title="Found on the cited page"><b>✓</b> ${esc(r.opportunity_id)}</span>` : ""}<span>${esc(r.funder)}</span>${o.status && o.status !== "new" ? `<span class="chip warn">${esc(o.status.replace("_", " "))}</span>` : ""}</span></span>
        <span class="due${soon ? " soon" : ""}"><span class="d num">${due}</span><span class="bar" aria-hidden="true">${pips}</span><span class="date num">${esc(o.deadline)}</span></span>
        <span class="prize">${esc(r.award_amount || "—")}</span>
      </button>
      <div class="row-body" id="rb${i}" hidden>
        <div><h3>WHY THIS TIER</h3><ul class="why">${why.map(w => `<li><span class="k ${/fails|off-profile|not |capped|passed|takes equity/i.test(w) ? "no" : /ambiguous|weak|unclear/i.test(w) ? "meh" : "ok"}">${/fails|off-profile|not |capped|passed|takes equity/i.test(w) ? "✕" : /ambiguous|weak|unclear/i.test(w) ? "~" : "✓"}</span><span>${esc(w)}</span></li>`).join("")}
          ${r.fit_reason ? `<li><span class="k ok">»</span><span>${esc(r.fit_reason)}</span></li>` : ""}</ul>
          <div class="acts">${canDraft ? `<button class="btn" data-act="draft" data-id="${esc(o.id)}">DRAFT IT</button>` : ""}
            <button class="btn alt" data-act="shortlisted" data-id="${esc(o.id)}">SHORTLIST</button><button class="btn alt" data-act="skipped" data-id="${esc(o.id)}">NOT FOR US</button></div></div>
        <div><h3>ELIGIBILITY</h3><p style="margin:0 0 8px">${esc(r.eligibility_summary)}</p>
          <div class="chips">${flags.map(([t, k, p]) => `<span class="chip ${k}">${esc(t)}${p ? " · " + esc(p) : ""}</span>`).join("")}</div>
          <div class="src"><span>${r.source_agent?.startsWith("main:") ? "Read through the " + esc(r.source_agent.slice(5).replace("_", ".")) + " API" : "Found by the web scout and checked against the page it opened"}</span>
            ${(r.repairs || []).map(x => `<span>Fixed: ${esc(x)}</span>`).join("")}
            <a href="${esc(safeUrl(r.source_url))}" target="_blank" rel="noopener noreferrer">${esc(String(r.source_url || "").replace(/^https?:\/\//, ""))}</a></div></div>
      </div></div>`;
  }).join("");
}
$("list").addEventListener("click", async e => {
  const act = e.target.closest("[data-act]");
  if (act) {
    const id = act.dataset.id;
    if (act.dataset.act === "draft") return enqueue("autofill", { op_id: id }, "Drafting started. Watch the Run Log.");
    const { error } = await sb.from("opportunities").update({ status: act.dataset.act }).eq("id", id);
    if (error) return toast(`Couldn't update: ${error.message}`);
    const o = S.opps.find(x => x.id === id); if (o) o.status = act.dataset.act;
    renderAll(); toast(act.dataset.act === "shortlisted" ? "Added to your shortlist" : "Hidden from recommendations");
    return;
  }
  const head = e.target.closest(".row-head"); if (!head) return;
  const row = head.parentElement, body = row.querySelector(".row-body"), open = row.getAttribute("aria-expanded") === "true";
  row.setAttribute("aria-expanded", String(!open)); body.hidden = open;
});
document.querySelectorAll(".filters button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".filters button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  S.filter = b.dataset.f; renderList();
}));
$("q").addEventListener("input", e => { S.query = e.target.value; renderList(); });

/* ─── jobs ─────────────────────────────────────────────────────────────────── */
async function enqueue(kind, params, okMsg) {
  const { data, error } = await sb.rpc("enqueue_job", { p_kind: kind, p_params: params });
  if (error) return toast(error.message.replace(/^.*?:\s*/, "") || error.message);
  toast(okMsg); S.selectedJob = data.id; await loadAll(); show("runs");
}
$("runBtn").addEventListener("click", () => enqueue("sweep", { scope: "standard" }, "Sweep queued. It starts within a minute or two."));
$("assessForm").addEventListener("submit", e => {
  e.preventDefault();
  enqueue("assess", { url: $("assessUrl").value.trim(), autofill: $("assessDraft").checked }, "Link queued for assessment.");
  $("assessUrl").value = "";
});
const KIND = { sweep: "SWEEP", assess: "ASSESS", autofill: "DRAFT" };
function renderJobs() {
  $("jobs").innerHTML = S.jobs.length ? S.jobs.map(j => `<button class="job" data-job="${esc(j.id)}" aria-pressed="${j.id === S.selectedJob}">
      <span class="st ${esc(j.status)}">${esc(j.status.toUpperCase())}</span>
      <span><span>${KIND[j.kind] || esc(j.kind)} · ${new Date(j.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        <span class="meta" style="margin:0">${esc(j.summary || j.error || (j.kind === "assess" ? j.params?.url : "") || "")}</span></span>
      <span class="num" style="color:var(--muted)">${j.model_calls ? j.model_calls + " calls" : ""}</span></button>`).join("")
    : '<div class="empty">NO RUNS YET</div>';
}
$("jobs").addEventListener("click", e => { const b = e.target.closest("[data-job]"); if (!b) return; S.selectedJob = b.dataset.job; renderJobs(); loadEvents(); });
async function loadEvents() {
  const j = S.jobs.find(x => x.id === S.selectedJob); if (!j) return;
  $("runTitle").textContent = `LEVEL LOG · ${KIND[j.kind] || j.kind} · ${j.status.toUpperCase()}`;
  const { data, error } = await sb.from("run_events").select("ts,step,tool,summary").eq("job_id", j.id).order("id").limit(400);
  if (error) return toast(`Couldn't load the log: ${error.message}`);
  const live = j.status === "running";
  const evs = data || [];
  $("log").innerHTML = evs.length ? evs.map((e, i) => `<li><time class="num">${esc(String(e.ts).slice(11, 19))}</time><span class="p ${e.summary?.startsWith("FAILED") ? "fail" : esc(e.step)}">${esc(String(e.step).toUpperCase())}</span><span class="${live && i === evs.length - 1 ? "cursor" : ""}">${esc(e.summary)}</span></li>`).join("")
    : `<li><span></span><span class="p goal">${j.status === "queued" ? "QUEUED" : "WAIT"}</span><span class="cursor">${j.status === "queued" ? "Waiting for a worker to start…" : "No steps logged."}</span></li>`;
}
function managePolling() {
  const busy = S.jobs.some(j => j.status === "queued" || j.status === "running");
  if (busy && !S.pollTimer) S.pollTimer = setInterval(async () => {
    const before = S.jobs.map(j => j.status).join();
    const { data } = await sb.from("jobs").select("*").order("created_at", { ascending: false }).limit(15);
    S.jobs = data || S.jobs; renderJobs(); renderHeader();
    if (S.selectedJob) loadEvents();
    if (S.jobs.map(j => j.status).join() !== before && !S.jobs.some(j => j.status === "queued" || j.status === "running")) {
      stopPolling(); await loadAll(); toast("Run finished. Results updated.");
    }
  }, 5000);
  if (!busy) stopPolling();
}
function stopPolling() { clearInterval(S.pollTimer); S.pollTimer = null; }

/* ─── questions ────────────────────────────────────────────────────────────── */
function renderQuestions() {
  const qs = S.questions.filter(q => q.status !== "applied");
  $("qlist").innerHTML = qs.length ? qs.map(q => `<div class="q"><div class="meta"><span class="id">${esc(q.id)}</span><span>${esc(q.section || "General")}</span></div>
      <label for="a-${esc(q.id)}">${esc(q.question)}</label>
      ${q.status === "answered" ? `<span class="saved">SAVED · APPLIED ON THE NEXT DRAFT RUN</span>`
        : `<textarea id="a-${esc(q.id)}" maxlength="2000" placeholder="> your answer"></textarea><div><button class="btn" data-q="${esc(q.id)}">SAVE</button></div>`}</div>`).join("")
    : '<div class="empty">NO QUESTIONS · ALL CLEAR</div>';
  const applied = S.questions.filter(q => q.status === "applied");
  $("qsummary").innerHTML = applied.length ? applied.map(q => `<div class="slot"><div><div>${esc(q.field || q.id)}</div><div class="note">${esc(q.answer || "")}</div></div><span class="st" style="color:var(--lime)">IN MEMORY</span></div>`).join("")
    : '<p style="margin:0;color:var(--muted)">Answers you give show up here once a draft run has used them.</p>';
}
$("qlist").addEventListener("click", async e => {
  const b = e.target.closest("[data-q]"); if (!b) return;
  const id = b.dataset.q, v = $("a-" + id).value.trim();
  if (!v) return toast("Type an answer first");
  const { error } = await sb.from("questions").update({ answer: v, status: "answered", answered_at: new Date().toISOString() }).eq("id", id);
  if (error) return toast(`Couldn't save: ${error.message}`);
  const q = S.questions.find(x => x.id === id); q.answer = v; q.status = "answered";
  renderQuestions(); renderHeader(); toast("Saved. Refill the draft to use it.");
});

/* ─── drafts ───────────────────────────────────────────────────────────────── */
function renderDrafts() {
  $("draftList").innerHTML = S.drafts.length ? S.drafts.map(d => {
    const secs = Object.values(d.state?.sections || {});
    const c = k => secs.filter(s => s.status === k).length;
    const title = S.opps.find(o => o.id === d.op_id)?.row?.title || d.op_id;
    return `<button class="slot job" data-draft="${esc(d.op_id)}" aria-pressed="${d.op_id === S.selectedDraft}" style="grid-template-columns:1fr auto">
      <span><span>${esc(title)}</span><span class="note" style="display:block">v${esc(d.version)} · ${c("filled")} filled · ${c("needs_review")} to review · ${c("needs_human")} need you</span></span>
      <span class="st" style="color:${c("needs_human") ? "var(--amber)" : "var(--lime)"}">${c("needs_human") ? "NEEDS YOU" : "READY TO REVIEW"}</span></button>`;
  }).join("") : '<div class="empty">NO DRAFTS YET · PICK “DRAFT IT” ON AN OPPORTUNITY</div>';
  showDraft();
}
$("draftList").addEventListener("click", e => { const b = e.target.closest("[data-draft]"); if (!b) return; S.selectedDraft = b.dataset.draft; renderDrafts(); });
function showDraft() {
  const d = S.drafts.find(x => x.op_id === S.selectedDraft);
  $("refillBtn").hidden = !d;
  if (!d) return;
  $("draftTitle").textContent = `DRAFT v${d.version}`;
  $("draftBody").innerHTML = mdToHtml(d.markdown || "");
}
$("refillBtn").addEventListener("click", () => S.selectedDraft && enqueue("autofill", { op_id: S.selectedDraft }, "Refilling the draft with your answers."));
function mdToHtml(md) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>").replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
  return md.replace(/<sub>(.*?)<\/sub>/g, "_$1_").split(/\n{2,}/).map(block => {
    const b = block.trim(); if (!b) return "";
    if (b.startsWith("## ")) return `<h2>${inline(b.slice(3))}</h2>`;
    if (b.startsWith("# ")) return `<h1>${inline(b.slice(2))}</h1>`;
    if (b.startsWith("> ")) return `<blockquote>${inline(b.replace(/^> ?/gm, ""))}</blockquote>`;
    return `<p>${inline(b).replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

/* ─── profile ──────────────────────────────────────────────────────────────── */
const list = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 12);
function fillProfile() {
  const p = S.profile || {}, e = p.entity || {}, o = p.offering || {}, f = p.funding || {}, m = p.market || {};
  const set = (id, v) => { const el = $(id); if (el.type === "checkbox") el.checked = !!v; else el.value = v ?? ""; };
  set("p_name", e.name); set("p_type", e.type || "c_corp"); set("p_juris", e.jurisdiction); set("p_size", e.size); set("p_founded", e.founded);
  set("p_stage", e.stage); set("p_small", e.small_business ?? true); set("p_one", o.one_liner); set("p_tech", o.technology); set("p_problem", o.problem);
  set("p_dev", o.stage_of_development); set("p_customers", m.customers); set("p_verticals", (p.verticals || []).join(", "));
  set("p_keywords", (p.keywords || []).join(", ")); set("p_geos", (p.geographies || []).join(", ")); set("p_min", f.target_min); set("p_max", f.target_max);
  set("p_equity", f.accepts_equity);
}
$("profileForm").addEventListener("submit", async e => {
  e.preventDefault();
  const num = id => ($(id).value === "" ? 0 : Number($(id).value));
  const profile = {
    keywords: list($("p_keywords").value), verticals: list($("p_verticals").value), geographies: list($("p_geos").value.toUpperCase()), exclusions: [],
    entity: { name: $("p_name").value.trim(), type: $("p_type").value, jurisdiction: $("p_juris").value.trim().toUpperCase(), small_business: $("p_small").checked,
              stage: $("p_stage").value.trim(), size: num("p_size"), founded: num("p_founded") },
    offering: { one_liner: $("p_one").value.trim(), technology: $("p_tech").value.trim(), problem: $("p_problem").value.trim(), stage_of_development: $("p_dev").value.trim() },
    funding: { target_min: num("p_min"), target_max: num("p_max"), currency: "USD", accepts_equity: $("p_equity").checked },
    market: { customers: $("p_customers").value.trim() },
  };
  if (!profile.verticals.length || !profile.geographies.length) return msg("profileMsg", "Add at least one field and one region.", true);
  const { error } = await sb.from("profiles").upsert({ user_id: S.user.id, profile, updated_at: new Date().toISOString() });
  if (error) return msg("profileMsg", `Couldn't save: ${error.message}`, true);
  S.profile = profile; renderHeader(); msg("profileMsg", "Saved. Run a sweep to find opportunities.");
});
function msg(id, t, bad) { $(id).className = bad ? "err" : "okmsg"; $(id).textContent = t; }
$("deleteBtn").addEventListener("click", () => { $("deleteConfirm").hidden = false; });
$("deleteNo").addEventListener("click", () => { $("deleteConfirm").hidden = true; });
$("deleteYes").addEventListener("click", async () => {
  const { error } = await sb.rpc("delete_my_data");
  if (error) return toast(`Couldn't delete: ${error.message}`);
  toast("All your data was deleted."); await sb.auth.signOut();
});

/* ─── navigation ───────────────────────────────────────────────────────────── */
function show(v) {
  document.querySelectorAll(".nav button").forEach(b => b.dataset.view === v ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  document.querySelectorAll(".view").forEach(s => { s.hidden = s.id !== "view-" + v; });
  if (v === "runs") { if (!S.selectedJob && S.jobs[0]) S.selectedJob = S.jobs[0].id; renderJobs(); loadEvents(); }
  try { localStorage.setItem("bh.view", v); } catch (_) {}
}
function restoreView() { try { const v = localStorage.getItem("bh.view"); if (v && $("view-" + v)) show(v); } catch (_) {} }
document.querySelectorAll(".nav button").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));

/* ─── bits ─────────────────────────────────────────────────────────────────── */
let tt; function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => { t.hidden = true; }, 3200); }
(() => { const c = $("sprite").getContext("2d");
  const M = ["....LLLL....", "..LLPPPPLL..", ".LPPLLLLPPL.", ".LPL....LPL.", "LPL..LL..LPL", "LPL.LPPL.LPL", "LPL.LPPL.LPL", "LPL..LL..LPL", ".LPL....LPL.", ".LPPLLLLPPL.", "..LLPPPPLL..", "....LLLL...."];
  M.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === ".") return; c.fillStyle = ch === "L" ? "#B6FF3B" : "#8A2BE2"; c.fillRect(x, y, 1, 1); })); })();
