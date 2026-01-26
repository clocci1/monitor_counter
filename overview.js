import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://wndlmkjhzgqdwsfylvmh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sf8tAbDNmRLtCGu9xsesSQ_JWmIyQHI";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const $ = (id) => document.getElementById(id);
const logEl = $("log");

const PAUSE_THRESHOLD_SEC = 30 * 60;   // > 30 min => pausa
const SLOT_MINUTES = 30;               // sequenza 30m

let currentUser = null;
let cachedEvents = [];                 // events in range (effective view)
let currentRange = { start: null, end: null };
let currentOperator = null;
let currentIntervals = [];             // raw intervals
let currentBlocks = [];                // grouped blocks

function log(...args) {
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(isBusy, msg="") {
  $("btnApply").disabled = isBusy;
  $("btnRefresh").disabled = isBusy;
  $("btnReset").disabled = isBusy;
  $("btnViewDetail").disabled = isBusy;
  $("btnViewSequence").disabled = isBusy;
  $("btnExportCsv").disabled = isBusy;
  $("busyLabel").textContent = msg;
}

function setAuthUI(ok, statusText, userId) {
  $("authStatus").textContent = statusText;
  $("userId").textContent = userId ?? "-";
  const dot = $("authDot");
  dot.classList.remove("ok","bad");
  dot.classList.add(ok ? "ok" : "bad");
}

function parseDT(s) {
  if (!s) return null;
  const iso = String(s).includes("T") ? String(s) : String(s).replace(" ", "T");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDT(d) {
  if (!d) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  const hh = String(d.getHours()).padStart(2,"0");
  const mi = String(d.getMinutes()).padStart(2,"0");
  const ss = String(d.getSeconds()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function secToHHMM(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

async function ensureAnonymousSession() {
  setAuthUI(false, "checking session...", "-");
  const { data: s } = await supabase.auth.getSession();
  if (s?.session?.user) {
    setAuthUI(true, "signed-in (anon)", s.session.user.id);
    return s.session.user;
  }
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  setAuthUI(true, "signed-in (anon)", data.user?.id);
  return data.user;
}

async function resetSession() {
  setBusy(true, "reset session...");
  const { error } = await supabase.auth.signOut();
  if (error) log("❌ signOut:", error.message);
  else log("✅ signed out");
  setAuthUI(false, "signed-out", "-");
  setBusy(false, "");
  location.reload();
}

// ---------------------------------------------
// Range selection: Days/Weeks/Month + End date
// ---------------------------------------------
function computeRangeFromUI() {
  const type = $("rangeType").value;
  const val = Math.max(1, Number($("rangeValue").value || 1));
  const endDate = $("endDate").value; // yyyy-mm-dd

  const end = endDate ? new Date(`${endDate}T23:59:59`) : new Date();
  let days = val;

  if (type === "weeks") days = val * 7;
  if (type === "months") days = val * 30;

  const start = new Date(end.getTime() - (days * 24 * 3600 * 1000));
  start.setHours(0,0,0,0);

  return { start, end };
}

function rangeToFilter(range) {
  // PostgREST accetta ISO string
  const start = fmtDT(range.start).replace(" ", "T");
  const end = fmtDT(range.end).replace(" ", "T");
  return { start, end };
}

// ---------------------------------------------
// Fetch events in range (effective view)
// ---------------------------------------------
async function fetchEvents(range) {
  const { start, end } = rangeToFilter(range);

  const { data, error } = await supabase
    .from("v_operator_events_effective")
    .select("source,event_dt,operator_code,operator_original,warehouse_order,bin_from,bin_to,category,created_by,counter")
    .gte("event_dt", start)
    .lte("event_dt", end)
    .order("operator_code", { ascending: true })
    .order("event_dt", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------
// Category mapping for time analysis
// (WT Other = Pick Mvmt IPL)
// ---------------------------------------------
function mapCatForUI(ev) {
  if (ev.source === "PI") {
    if (ev.category === "Pick") return "PI Pick";
    if (ev.category === "Bulk") return "PI Bulk";
    return "PI Other";
  }
  // WT
  if (ev.category === "Pick to Pick") return "P2P";
  if (ev.category === "Clean Pick") return "Clean PICK";
  return "WT Other";
}

// ---------------------------------------------
// Build raw intervals per operator:
// duration between event[i] and event[i+1] is assigned to NEXT event category.
// If duration > 30 min => PAUSA.
// ---------------------------------------------
function buildIntervalsForOperator(events) {
  const out = [];
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i];
    const b = events[i + 1];

    const da = parseDT(a.event_dt);
    const db = parseDT(b.event_dt);
    if (!da || !db) continue;

    const dtSec = Math.floor((db.getTime() - da.getTime()) / 1000);
    if (dtSec <= 0) continue;

    let cat = mapCatForUI(b); // NEXT event category
    if (dtSec > PAUSE_THRESHOLD_SEC) cat = "PAUSA";

    out.push({
      start: da,
      end: db,
      sec: dtSec,
      category: cat,

      // per dettaglio: legamiamo al "next event"
      nextEvent: b,
    });
  }
  return out;
}

// Group consecutive intervals with same category (blocks)
function groupBlocks(intervals) {
  const blocks = [];
  let cur = null;

  for (const it of intervals) {
    if (!cur || cur.category !== it.category) {
      cur = {
        category: it.category,
        start: it.start,
        end: it.end,
        sec: it.sec,
        endEvents: [it.nextEvent],
      };
      blocks.push(cur);
    } else {
      cur.end = it.end;
      cur.sec += it.sec;
      cur.endEvents.push(it.nextEvent);
    }
  }
  return blocks;
}

// ---------------------------------------------
// Aggregations per operator
// ---------------------------------------------
function computeOperatorStats(opEvents) {
  const intervals = buildIntervalsForOperator(opEvents);

  const time = {
    work: 0,
    pause: 0,
    piPick: 0,
    piBulk: 0,
    p2p: 0,
    clean: 0,
    wtOther: 0,
  };

  for (const it of intervals) {
    if (it.category === "PAUSA") {
      time.pause += it.sec;
      continue;
    }
    time.work += it.sec;

    if (it.category === "PI Pick") time.piPick += it.sec;
    else if (it.category === "PI Bulk") time.piBulk += it.sec;
    else if (it.category === "P2P") time.p2p += it.sec;
    else if (it.category === "Clean PICK") time.clean += it.sec;
    else if (it.category === "WT Other") time.wtOther += it.sec;
  }

  // Counts from events (not intervals)
  const piPickBins = opEvents.filter(e => e.source === "PI" && e.category === "Pick").length;
  const piBulkBins = opEvents.filter(e => e.source === "PI" && e.category === "Bulk").length;

  const selfCount = opEvents.filter(e => {
    if (e.source !== "PI") return false;
    const c = String(e.counter ?? "").trim().toUpperCase();
    const cr = String(e.created_by ?? "").trim().toUpperCase();
    return c && cr && c === cr;
  }).length;

  const woP2P = uniq(opEvents.filter(e => e.source === "WT" && e.category === "Pick to Pick").map(e => e.warehouse_order)).length;
  const woClean = uniq(opEvents.filter(e => e.source === "WT" && e.category === "Clean Pick").map(e => e.warehouse_order)).length;
  const woOther = uniq(opEvents.filter(e => e.source === "WT" && e.category === "Pick Mvmt IPL").map(e => e.warehouse_order)).length;

  // Support flag: se almeno un evento ha operator_original != operator_code
  const hasSupportRemap = opEvents.some(e => (e.operator_original ?? "") !== (e.operator_code ?? ""));

  return {
    time,
    piPickBins,
    piBulkBins,
    selfCount,
    woP2P,
    woClean,
    woOther,
    intervalsCount: intervals.length,
    hasSupportRemap,
  };
}

function buildOperatorMap(events) {
  const map = new Map();
  for (const e of events) {
    const op = e.operator_code ?? "-";
    if (!map.has(op)) map.set(op, []);
    map.get(op).push(e);
  }
  return map;
}

// ---------------------------------------------
// Render tables
// ---------------------------------------------
function renderSummary(rows) {
  const tb = $("tblSummary").querySelector("tbody");
  tb.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>
        <button class="btn ${r.hasSupportRemap ? "primary" : ""}" data-support="${escapeHtml(r.operator)}">
          Supporto
        </button>
      </td>
      <td><span class="link" data-op="${escapeHtml(r.operator)}">${escapeHtml(r.operator)}</span></td>
      <td class="mono">${secToHHMM(r.time.work)}</td>
      <td class="mono">${secToHHMM(r.time.piPick)}</td>
      <td class="mono">${secToHHMM(r.time.piBulk)}</td>
      <td class="mono">${secToHHMM(r.time.p2p)}</td>
      <td class="mono">${secToHHMM(r.time.clean)}</td>
      <td class="mono">${secToHHMM(r.time.pause)}</td>
    `;
    tb.appendChild(tr);
  }

  // click operator -> drilldown
  tb.querySelectorAll("[data-op]").forEach(el => {
    el.addEventListener("click", () => openDrilldown(el.getAttribute("data-op")));
  });

  // support button -> modal
  tb.querySelectorAll("[data-support]").forEach(btn => {
    btn.addEventListener("click", () => openSupportModal(btn.getAttribute("data-support")));
  });
}

function renderKpi(rows) {
  const tb = $("tblKpi").querySelector("tbody");
  tb.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="link" data-op="${escapeHtml(r.operator)}">${escapeHtml(r.operator)}</span></td>
      <td class="mono">${secToHHMM(r.time.work)}</td>

      <td class="mono">${secToHHMM(r.time.piPick)}</td>
      <td class="mono">${r.piPickBins}</td>

      <td class="mono">${secToHHMM(r.time.piBulk)}</td>
      <td class="mono">${r.piBulkBins}</td>

      <td class="mono">${secToHHMM(r.time.p2p)}</td>
      <td class="mono">${r.woP2P}</td>

      <td class="mono">${secToHHMM(r.time.clean)}</td>
      <td class="mono">${r.woClean}</td>

      <td class="mono">${secToHHMM(r.time.wtOther)}</td>
      <td class="mono">${r.woOther}</td>

      <td class="mono">${secToHHMM(r.time.pause)}</td>
      <td class="mono">${r.selfCount}</td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-op]").forEach(el => {
    el.addEventListener("click", () => openDrilldown(el.getAttribute("data-op")));
  });
}

// ---------------------------------------------
// Drilldown render
// ---------------------------------------------
function renderBlocks(blocks) {
  const tb = $("tblBlocks").querySelector("tbody");
  tb.innerHTML = "";

  for (const b of blocks) {
    const endEvents = b.endEvents || [];
    const bins = endEvents.filter(e => e.source === "PI").length;
    const wos = uniq(endEvents.filter(e => e.source === "WT").map(e => e.warehouse_order)).length;

    // Note basilare: puoi arricchirla dopo
    const note = (b.category === "PAUSA") ? `Gap > 30 min` : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(fmtDT(b.start))}</td>
      <td class="mono">${escapeHtml(fmtDT(b.end))}</td>
      <td>${escapeHtml(b.category)}</td>
      <td class="mono">${secToHHMM(b.sec)}</td>
      <td class="mono">${bins}</td>
      <td class="mono">${wos}</td>
      <td>${escapeHtml(note)}</td>
    `;
    tb.appendChild(tr);
  }
}

function renderIntervals(intervals) {
  const tb = $("tblIntervals").querySelector("tbody");
  tb.innerHTML = "";

  for (const it of intervals) {
    const e = it.nextEvent;
    const bins = e?.source === "PI" ? 1 : 0;
    const wo = e?.source === "WT" ? (e.warehouse_order ?? "") : "";

    const note = (it.category === "PAUSA") ? "Gap > 30 min" : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(fmtDT(it.start))}</td>
      <td class="mono">${escapeHtml(fmtDT(it.end))}</td>
      <td>${escapeHtml(it.category)}</td>
      <td class="mono">${secToHHMM(it.sec)}</td>
      <td class="mono">${bins}</td>
      <td class="mono">${escapeHtml(wo)}</td>
      <td>${escapeHtml(note)}</td>
    `;
    tb.appendChild(tr);
  }
}

function renderSequence30m(intervals, range) {
  const wrap = $("seqList");
  wrap.innerHTML = "";

  const colors = {
    "PI Pick": "rgba(91,140,255,.60)",
    "PI Bulk": "rgba(91,140,255,.35)",
    "P2P": "rgba(60,210,140,.55)",
    "Clean PICK": "rgba(50,160,255,.25)",
    "WT Other": "rgba(90,120,255,.20)",
    "PAUSA": "rgba(220,75,85,.60)",
    "MIX": "rgba(255,255,255,.12)",
  };

  const slotMs = SLOT_MINUTES * 60 * 1000;
  let t = new Date(range.start.getTime());
  const end = range.end;

  while (t < end) {
    const slotStart = new Date(t.getTime());
    const slotEnd = new Date(Math.min(t.getTime() + slotMs, end.getTime()));

    // overlap durations per category
    const acc = new Map();
    for (const it of intervals) {
      const a = it.start.getTime();
      const b = it.end.getTime();
      const s = slotStart.getTime();
      const e = slotEnd.getTime();
      const overlap = Math.max(0, Math.min(b, e) - Math.max(a, s));
      if (overlap <= 0) continue;
      acc.set(it.category, (acc.get(it.category) || 0) + overlap);
    }

    const cats = Array.from(acc.keys());
    let label = "—";
    let bg = colors["MIX"];

    if (cats.length === 0) {
      label = "—";
      bg = "rgba(255,255,255,.06)";
    } else if (cats.length === 1) {
      label = cats[0];
      bg = colors[label] || colors["MIX"];
    } else {
      // mixed
      label = "MIX";
      bg = colors["MIX"];
    }

    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "120px 1fr 60px";
    row.style.gap = "10px";
    row.style.alignItems = "center";

    row.innerHTML = `
      <div class="mono" style="color:rgba(255,255,255,.70)">${escapeHtml(fmtDT(slotStart).slice(11,16))}–${escapeHtml(fmtDT(slotEnd).slice(11,16))}</div>
      <div style="height:14px;border-radius:999px;border:1px solid rgba(255,255,255,.10);background:${bg}"></div>
      <div class="mono" style="text-align:right;color:rgba(255,255,255,.55)">${SLOT_MINUTES}m</div>
    `;

    wrap.appendChild(row);
    t = new Date(t.getTime() + slotMs);
  }
}

function openDrilldown(operator) {
  currentOperator = operator;

  const opEvents = cachedEvents.filter(e => e.operator_code === operator);
  opEvents.sort((a,b) => parseDT(a.event_dt) - parseDT(b.event_dt));

  currentIntervals = buildIntervalsForOperator(opEvents);
  currentBlocks = groupBlocks(currentIntervals);

  // changes
  let changes = 0;
  for (let i=1; i<currentBlocks.length; i++) {
    if (currentBlocks[i].category !== currentBlocks[i-1].category) changes++;
  }

  $("drilldownBody").style.display = "block";
  $("ddInfo").textContent = `Operatore: ${operator} | Intervalli: ${currentIntervals.length} | Cambi: ${changes}`;

  renderBlocks(currentBlocks);
  renderIntervals(currentIntervals);

  // default view detail
  $("seqPanel").style.display = "none";
}

function exportIntervalsCsv() {
  if (!currentOperator || currentIntervals.length === 0) return;

  const lines = [];
  lines.push(["operator","start","end","category","duration_hhmm","warehouse_order"].join(","));

  for (const it of currentIntervals) {
    const wo = it.nextEvent?.warehouse_order ?? "";
    lines.push([
      currentOperator,
      fmtDT(it.start),
      fmtDT(it.end),
      it.category,
      secToHHMM(it.sec),
      String(wo).replaceAll(",", " ")
    ].join(","));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `intervals_${currentOperator}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------
// Support modal (insert/delete ranges)
// ---------------------------------------------
let supportAccountOpen = null;

function openSupportModal(supportAccount) {
  supportAccountOpen = supportAccount;

  $("supportTitle").textContent = `Supporto account: ${supportAccount}`;
  $("supportSubtitle").textContent = `Inserisci fasce Start-End per attribuire attività a supporti reali.`;

  $("realOperator").value = "";
  $("supportStart").value = "";
  $("supportEnd").value = "";

  $("supportOverlay").style.display = "flex";
  loadSupportRanges();
}

function closeSupportModal() {
  $("supportOverlay").style.display = "none";
  supportAccountOpen = null;
}

function dtLocalToTimestamp(val) {
  // val = "YYYY-MM-DDTHH:mm"
  if (!val) return null;
  return val.replace("T", " ") + ":00";
}

async function loadSupportRanges() {
  const tb = $("tblSupportRanges").querySelector("tbody");
  tb.innerHTML = "";

  if (!supportAccountOpen) return;

  const { data, error } = await supabase
    .from("support_assignments")
    .select("id,real_operator,start_dt,end_dt")
    .eq("support_account", supportAccountOpen)
    .order("start_dt", { ascending: false });

  if (error) {
    log("❌ loadSupportRanges:", error.message);
    return;
  }

  for (const r of (data ?? [])) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.real_operator)}</td>
      <td class="mono">${escapeHtml(String(r.start_dt))}</td>
      <td class="mono">${escapeHtml(String(r.end_dt))}</td>
      <td><button class="btn danger" data-del="${r.id}">Elimina</button></td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      const { error: delErr } = await supabase.from("support_assignments").delete().eq("id", id);
      if (delErr) log("❌ delete support range:", delErr.message);
      await loadSupportRanges();
    });
  });
}

async function addSupportRange() {
  if (!supportAccountOpen) return;

  const realOperator = $("realOperator").value.trim();
  const start = dtLocalToTimestamp($("supportStart").value);
  const end = dtLocalToTimestamp($("supportEnd").value);

  if (!realOperator || !start || !end) {
    log("⚠️ Compila Supporto reale + Start + End");
    return;
  }

  const { error } = await supabase.from("support_assignments").insert({
    user_id: currentUser.id,
    support_account: supportAccountOpen,
    real_operator: realOperator,
    start_dt: start,
    end_dt: end,
  });

  if (error) {
    log("❌ insert support range:", error.message);
    return;
  }

  await loadSupportRanges();
  log("✅ Support range saved");
}

// ---------------------------------------------
// Main: load + compute
// ---------------------------------------------
async function recompute() {
  setBusy(true, "caricamento eventi...");
  try {
    currentRange = computeRangeFromUI();
    cachedEvents = await fetchEvents(currentRange);

    log(`Loaded events: ${cachedEvents.length}`);

    const opMap = buildOperatorMap(cachedEvents);
    const rows = [];

    for (const [operator, evs] of opMap.entries()) {
      const stats = computeOperatorStats(evs);
      rows.push({ operator, ...stats });
    }

    // sort by work time desc
    rows.sort((a,b) => b.time.work - a.time.work);

    renderSummary(rows);
    renderKpi(rows);

    // reset drilldown
    currentOperator = null;
    $("drilldownBody").style.display = "none";
    $("ddInfo").textContent = "Seleziona un operatore…";
  } catch (e) {
    log("❌ recompute error:", e?.message ?? String(e));
  } finally {
    setBusy(false, "");
  }
}

// ---------------------------------------------
// Init
// ---------------------------------------------
(async function init() {
  log("Init overview...");

  try {
    currentUser = await ensureAnonymousSession();
    log("✅ Session:", currentUser.id);

    // default endDate = today
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth()+1).padStart(2,"0");
    const dd = String(now.getDate()).padStart(2,"0");
    $("endDate").value = `${yyyy}-${mm}-${dd}`;

    $("btnApply").addEventListener("click", recompute);
    $("btnRefresh").addEventListener("click", recompute);
    $("btnReset").addEventListener("click", resetSession);

    $("btnViewDetail").addEventListener("click", () => {
      $("seqPanel").style.display = "none";
      $("btnViewDetail").classList.add("primary");
      $("btnViewSequence").classList.remove("primary");
    });

    $("btnViewSequence").addEventListener("click", () => {
      if (!currentOperator) return;
      $("seqPanel").style.display = "block";
      $("btnViewSequence").classList.add("primary");
      $("btnViewDetail").classList.remove("primary");
      renderSequence30m(currentIntervals, currentRange);
    });

    $("btnExportCsv").addEventListener("click", exportIntervalsCsv);

    // support modal
    $("btnCloseSupport").addEventListener("click", closeSupportModal);
    $("btnAddSupport").addEventListener("click", addSupportRange);
    $("btnRecalc").addEventListener("click", async () => {
      closeSupportModal();
      await recompute();
    });

    // first load
    await recompute();
  } catch (e) {
    log("❌ init failed:", e?.message ?? String(e));
    setAuthUI(false, "AUTH ERROR", "-");
  }
})();
