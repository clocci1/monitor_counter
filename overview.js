import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://wndlmkjhzgqdwsfylvmh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sf8tAbDNmRLtCGu9xsesSQ_JWmIyQHI";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const $ = (id) => document.getElementById(id);
const logEl = $("log");

const PAUSE_THRESHOLD_SEC = 30 * 60; // > 30 min => pausa
const SLOT_MINUTES = 30;

const SHIFTS = {
  AM: { start: "05:00", end: "13:00" },
  C:  { start: "08:00", end: "16:00" },
  OM: { start: "14:00", end: "22:00" },
};

let currentUser = null;
let cachedEvents = [];
let currentRange = { start: null, end: null };

let currentOperator = null;
let currentIntervals = [];
let currentBlocks = [];
let operatorDayList = [];

let supportAccountOpen = null;
let manualActivities = [];

function log(...args) {
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(isBusy, msg="") {
  $("btnApply").disabled = isBusy;
  $("btnRefresh").disabled = isBusy;
  $("btnReset").disabled = isBusy;
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

function categoryToRowClass(cat) {
  if (cat === "PI Pick") return "row-pick";
  if (cat === "PI Bulk") return "row-bulk";
  if (cat === "P2P") return "row-p2p";
  if (cat === "CLP") return "row-clp";
  if (cat === "PAUSA") return "row-pause";
  return "row-mix";
}

function categoryToCssBg(cat) {
  if (cat === "PI Pick") return "var(--c-pick)";
  if (cat === "PI Bulk") return "var(--c-bulk)";
  if (cat === "P2P") return "var(--c-p2p)";
  if (cat === "CLP") return "var(--c-clp)";
  if (cat === "PAUSA") return "var(--c-pause)";
  return "var(--c-mix)";
}

// -------------------- Auth --------------------
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
  await supabase.auth.signOut();
  setAuthUI(false, "signed-out", "-");
  setBusy(false, "");
  location.reload();
}

// -------------------- Range selection --------------------
function computeRangeFromUI() {
  const type = $("rangeType").value;
  const val = Math.max(1, Number($("rangeValue").value || 1));
  const endDate = $("endDate").value;

  const end = endDate ? new Date(`${endDate}T23:59:59`) : new Date();
  let days = val;
  if (type === "weeks") days = val * 7;
  if (type === "months") days = val * 30;

  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  start.setHours(0,0,0,0);
  return { start, end };
}

function rangeToFilter(range) {
  const start = fmtDT(range.start).replace(" ", "T");
  const end = fmtDT(range.end).replace(" ", "T");
  return { start, end };
}

// -------------------- Fetch ALL events (pagination) --------------------
// Fix "operatori mancanti": la API può limitare le righe per request.
// Con questa funzione paginiamo finché non finisce.
async function fetchEventsAll(range) {
  const { start, end } = rangeToFilter(range);

  const PAGE = 1000;
  let from = 0;
  let all = [];

  while (true) {
    const to = from + PAGE - 1;

    const { data, error } = await supabase
      .from("v_operator_events_effective")
      .select("source,event_dt,operator_code,operator_original,warehouse_order,category,created_by,counter")
      .gte("event_dt", start)
      .lte("event_dt", end)
      .order("operator_code", { ascending: true })
      .order("event_dt", { ascending: true })
      .range(from, to);

    if (error) throw error;

    const batch = data ?? [];
    all = all.concat(batch);

    if (batch.length < PAGE) break; // finito
    from += PAGE;

    // safety per evitare runaway
    if (from > 50000) break;
  }

  return all;
}

async function fetchManualActivities(operator, range) {
  const { start, end } = rangeToFilter(range);

  const { data, error } = await supabase
    .from("manual_activity_segments")
    .select("id,operator_code,start_dt,end_dt,label,color")
    .eq("operator_code", operator)
    .gte("start_dt", start)
    .lte("end_dt", end)
    .order("start_dt", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// -------------------- Category mapping --------------------
function mapCatForUI(ev) {
  if (ev.source === "PI") {
    if (ev.category === "Pick") return "PI Pick";
    if (ev.category === "Bulk") return "PI Bulk";
    return "PI Pick";
  }
  if (ev.category === "Pick to Pick") return "P2P";
  if (ev.category === "Clean Pick") return "CLP";
  return "CLP";
}

// -------------------- Intervals logic --------------------
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

    let cat = mapCatForUI(b);
    if (dtSec > PAUSE_THRESHOLD_SEC) cat = "PAUSA";

    out.push({ start: da, end: db, sec: dtSec, category: cat, nextEvent: b });
  }
  return out;
}

function groupBlocks(intervals) {
  const blocks = [];
  let cur = null;

  for (const it of intervals) {
    if (!cur || cur.category !== it.category) {
      cur = { category: it.category, start: it.start, end: it.end, sec: it.sec };
      blocks.push(cur);
    } else {
      cur.end = it.end;
      cur.sec += it.sec;
    }
  }
  return blocks;
}

// -------------------- Aggregations --------------------
function computeOperatorStats(opEvents) {
  const intervals = buildIntervalsForOperator(opEvents);

  const time = { work: 0, pause: 0, pick: 0, bulk: 0, p2p: 0, clp: 0 };
  for (const it of intervals) {
    if (it.category === "PAUSA") { time.pause += it.sec; continue; }
    time.work += it.sec;
    if (it.category === "PI Pick") time.pick += it.sec;
    else if (it.category === "PI Bulk") time.bulk += it.sec;
    else if (it.category === "P2P") time.p2p += it.sec;
    else if (it.category === "CLP") time.clp += it.sec;
  }

  const piPickBins = opEvents.filter(e => e.source === "PI" && e.category === "Pick").length;
  const piBulkBins = opEvents.filter(e => e.source === "PI" && e.category === "Bulk").length;

  const selfCount = opEvents.filter(e => {
    if (e.source !== "PI") return false;
    const c = String(e.counter ?? "").trim().toUpperCase();
    const cr = String(e.created_by ?? "").trim().toUpperCase();
    return c && cr && c === cr;
  }).length;

  const woP2P = uniq(opEvents.filter(e => e.source === "WT" && e.category === "Pick to Pick").map(e => e.warehouse_order)).length;
  const woCLP = uniq(opEvents.filter(e => e.source === "WT" && e.category === "Clean Pick").map(e => e.warehouse_order)).length;

  const hasSupportRemap = opEvents.some(e => (e.operator_original ?? "") !== (e.operator_code ?? ""));
  return { time, piPickBins, piBulkBins, selfCount, woP2P, woCLP, hasSupportRemap };
}

function buildOperatorMap(events) {
  // trim per evitare operatori “splittati” per spazi/refusi
  const map = new Map();
  for (const e of events) {
    const op = String(e.operator_code ?? "-").trim() || "-";
    if (!map.has(op)) map.set(op, []);
    map.get(op).push(e);
  }
  return map;
}

// -------------------- Render tables --------------------
function renderSummary(rows) {
  const tb = $("tblSummary").querySelector("tbody");
  tb.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><button class="btn ${r.hasSupportRemap ? "primary" : ""}" data-support="${escapeHtml(r.operator)}">Supporto</button></td>
      <td><span class="link" data-op="${escapeHtml(r.operator)}">${escapeHtml(r.operator)}</span></td>
      <td class="mono">${secToHHMM(r.time.work)}</td>
      <td class="mono">${secToHHMM(r.time.pick)}</td>
      <td class="mono">${secToHHMM(r.time.bulk)}</td>
      <td class="mono">${secToHHMM(r.time.p2p)}</td>
      <td class="mono">${secToHHMM(r.time.clp)}</td>
      <td class="mono">${secToHHMM(r.time.pause)}</td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-op]").forEach(el => el.addEventListener("click", () => openDrilldown(el.getAttribute("data-op"))));
  tb.querySelectorAll("[data-support]").forEach(btn => btn.addEventListener("click", () => openSupportModal(btn.getAttribute("data-support"))));
}

function renderKpi(rows) {
  const tb = $("tblKpi").querySelector("tbody");
  tb.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="link" data-op="${escapeHtml(r.operator)}">${escapeHtml(r.operator)}</span></td>
      <td class="mono">${secToHHMM(r.time.work)}</td>

      <td class="mono">${secToHHMM(r.time.pick)}</td>
      <td class="mono">${r.piPickBins}</td>

      <td class="mono">${secToHHMM(r.time.bulk)}</td>
      <td class="mono">${r.piBulkBins}</td>

      <td class="mono">${secToHHMM(r.time.p2p)}</td>
      <td class="mono">${r.woP2P}</td>

      <td class="mono">${secToHHMM(r.time.clp)}</td>
      <td class="mono">${r.woCLP}</td>

      <td class="mono">${secToHHMM(r.time.pause)}</td>
      <td class="mono">${r.selfCount}</td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-op]").forEach(el => el.addEventListener("click", () => openDrilldown(el.getAttribute("data-op"))));
}

function renderBlocks(blocks) {
  const tb = $("tblBlocks").querySelector("tbody");
  tb.innerHTML = "";

  let prev = null;
  for (const b of blocks) {
    const tr = document.createElement("tr");
    tr.className = categoryToRowClass(b.category);
    const changeText = prev ? `${prev} → ${b.category}` : "—";
    prev = b.category;

    tr.innerHTML = `
      <td class="mono">${escapeHtml(fmtDT(b.start))}</td>
      <td class="mono">${escapeHtml(fmtDT(b.end))}</td>
      <td>${escapeHtml(b.category)}</td>
      <td class="mono">${secToHHMM(b.sec)}</td>
      <td class="mono">${escapeHtml(changeText)}</td>
    `;
    tb.appendChild(tr);
  }
}

function renderIntervals(intervals) {
  const tb = $("tblIntervals").querySelector("tbody");
  tb.innerHTML = "";

  for (const it of intervals) {
    const wo = it.nextEvent?.warehouse_order ?? "";
    const tr = document.createElement("tr");
    tr.className = categoryToRowClass(it.category);

    tr.innerHTML = `
      <td class="mono">${escapeHtml(fmtDT(it.start))}</td>
      <td class="mono">${escapeHtml(fmtDT(it.end))}</td>
      <td>${escapeHtml(it.category)}</td>
      <td class="mono">${secToHHMM(it.sec)}</td>
      <td class="mono">${escapeHtml(wo)}</td>
    `;
    tb.appendChild(tr);
  }
}

// -------------------- Day + shift helpers --------------------
function dayKey(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseTimeToDay(day, hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(`${day}T00:00:00`);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function buildDayListForOperator(opEvents) {
  const days = uniq(opEvents.map(e => dayKey(parseDT(e.event_dt)))).sort();
  return days;
}

function chooseDefaultDayShift(intervals, days) {
  let bestDay = days[0] ?? null;
  let bestSec = -1;

  for (const day of days) {
    const dayStart = new Date(`${day}T00:00:00`);
    const dayEnd = new Date(`${day}T23:59:59`);
    let sec = 0;

    for (const it of intervals) {
      const overlap = Math.max(0, Math.min(it.end, dayEnd) - Math.max(it.start, dayStart));
      if (overlap > 0 && it.category !== "PAUSA") sec += overlap / 1000;
    }
    if (sec > bestSec) { bestSec = sec; bestDay = day; }
  }

  let bestShift = "AM";
  let bestShiftSec = -1;

  for (const shiftKey of Object.keys(SHIFTS)) {
    const sh = SHIFTS[shiftKey];
    const shStart = parseTimeToDay(bestDay, sh.start);
    const shEnd = parseTimeToDay(bestDay, sh.end);
    let sec = 0;

    for (const it of intervals) {
      const overlap = Math.max(0, Math.min(it.end, shEnd) - Math.max(it.start, shStart));
      if (overlap > 0 && it.category !== "PAUSA") sec += overlap / 1000;
    }
    if (sec > bestShiftSec) { bestShiftSec = sec; bestShift = shiftKey; }
  }

  return { day: bestDay, shift: bestShift };
}

function fillDaySelect(days) {
  const sel = $("daySelect");
  sel.innerHTML = "";
  for (const d of days) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    sel.appendChild(opt);
  }
}

// -------------------- Manual overlay on PAUSA (visual) --------------------
function findManualActivityForSlot(slotStart, slotEnd) {
  for (const a of manualActivities) {
    const as = parseDT(a.start_dt);
    const ae = parseDT(a.end_dt);
    if (!as || !ae) continue;
    const overlap = Math.max(0, Math.min(ae, slotEnd) - Math.max(as, slotStart));
    if (overlap > 0) return a;
  }
  return null;
}

// -------------------- Timeline full width (grid) --------------------
function renderAxisAndTicks(day, shiftKey) {
  const sh = SHIFTS[shiftKey];
  $("axisLeft").textContent = `${day} ${sh.start}`;
  $("axisRight").textContent = `${day} ${sh.end}`;

  // 8 hours => 9 ticks (inclusive)
  const startH = Number(sh.start.split(":")[0]);
  const endH = Number(sh.end.split(":")[0]);

  const ticks = $("timelineTicks");
  ticks.innerHTML = "";

  const hours = endH - startH;
  const tickCount = hours + 1; // 9
  for (let i = 0; i < tickCount; i++) {
    const h = String(startH + i).padStart(2,"0");
    const span = document.createElement("span");
    span.textContent = `${h}:00`;
    ticks.appendChild(span);
  }
}

function renderTimelineForShift(intervals, day, shiftKey) {
  const sh = SHIFTS[shiftKey];
  const shiftStart = parseTimeToDay(day, sh.start);
  const shiftEnd = parseTimeToDay(day, sh.end);

  renderAxisAndTicks(day, shiftKey);

  const row = $("timelineRow");
  row.innerHTML = "";

  const slotMs = SLOT_MINUTES * 60 * 1000;
  const slotCount = Math.round((shiftEnd.getTime() - shiftStart.getTime()) / slotMs);

  // grid full width: repeat(slotCount, 1fr)
  row.style.gridTemplateColumns = `repeat(${slotCount}, 1fr)`;

  for (let i = 0; i < slotCount; i++) {
    const slotStart = new Date(shiftStart.getTime() + i * slotMs);
    const slotEnd = new Date(slotStart.getTime() + slotMs);

    // overlap durations per category
    const acc = new Map();
    for (const it of intervals) {
      const overlap = Math.max(0, Math.min(it.end, slotEnd) - Math.max(it.start, slotStart));
      if (overlap <= 0) continue;
      acc.set(it.category, (acc.get(it.category) || 0) + overlap);
    }

    const cats = Array.from(acc.keys());
    let cat = "—";
    if (cats.length === 0) cat = "—";
    else if (cats.length === 1) cat = cats[0];
    else cat = "MIX";

    const manual = findManualActivityForSlot(slotStart, slotEnd);
    const displayLabel = (manual && cat === "PAUSA") ? manual.label : cat;

    const seg = document.createElement("div");
    seg.className = "seg";
    seg.style.background = categoryToCssBg(cat === "MIX" ? "MIX" : cat);
    seg.title = `${fmtDT(slotStart).slice(11,16)}–${fmtDT(slotEnd).slice(11,16)} | ${displayLabel}`;

    seg.addEventListener("click", () => {
      if (cat !== "PAUSA") return;
      openActivityModal(slotStart, slotEnd);
    });

    row.appendChild(seg);
  }
}

// -------------------- Drilldown --------------------
async function openDrilldown(operator) {
  currentOperator = operator;

  const opEvents = cachedEvents
    .filter(e => String(e.operator_code ?? "-").trim() === operator)
    .sort((a,b) => parseDT(a.event_dt) - parseDT(b.event_dt));

  currentIntervals = buildIntervalsForOperator(opEvents);
  currentBlocks = groupBlocks(currentIntervals);

  operatorDayList = buildDayListForOperator(opEvents);
  fillDaySelect(operatorDayList);

  const { day, shift } = chooseDefaultDayShift(currentIntervals, operatorDayList);
  $("daySelect").value = day ?? "";
  $("shiftSelect").value = shift ?? "AM";

  manualActivities = await fetchManualActivities(operator, currentRange);

  const changes = Math.max(0, currentBlocks.length - 1);
  $("ddInfo").textContent = `Operatore: ${operator} | Intervalli: ${currentIntervals.length} | Cambi: ${changes}`;

  renderBlocks(currentBlocks);
  renderIntervals(currentIntervals);

  if (day) renderTimelineForShift(currentIntervals, day, shift);
}

// -------------------- CSV Export --------------------
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
      String(wo).replaceAll(",", " "),
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

// -------------------- Support modal --------------------
function openSupportModal(supportAccount) {
  supportAccountOpen = supportAccount;

  $("supportTitle").textContent = `Supporto account: ${supportAccount}`;
  $("supportSubtitle").textContent = `Assegna fasce Start-End a un operatore reale.`;

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

  if (error) { log("❌ loadSupportRanges:", error.message); return; }

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
      await supabase.from("support_assignments").delete().eq("id", id);
      await loadSupportRanges();
    });
  });
}

async function addSupportRange() {
  if (!supportAccountOpen) return;

  const realOperator = $("realOperator").value.trim();
  const start = dtLocalToTimestamp($("supportStart").value);
  const end = dtLocalToTimestamp($("supportEnd").value);

  if (!realOperator || !start || !end) { log("⚠️ Compila Supporto reale + Start + End"); return; }

  const { error } = await supabase.from("support_assignments").insert({
    user_id: currentUser.id,
    support_account: supportAccountOpen,
    real_operator: realOperator,
    start_dt: start,
    end_dt: end,
  });

  if (error) { log("❌ insert support:", error.message); return; }
  await loadSupportRanges();
  log("✅ Support range saved");
}

// -------------------- Manual Activity Modal (click pausa) --------------------
function openActivityModal(startDt, endDt) {
  if (!currentOperator) return;

  $("activityTitle").textContent = `Attività indiretta — ${currentOperator}`;
  $("activitySubtitle").textContent = `${fmtDT(startDt)} → ${fmtDT(endDt)} (slot ${SLOT_MINUTES}m)`;

  $("activityLabel").value = "";
  $("activityStart").value = dtToLocal(startDt);
  $("activityEnd").value = dtToLocal(endDt);

  $("activityOverlay").style.display = "flex";
  loadActivitiesTable();
}

function closeActivityModal() {
  $("activityOverlay").style.display = "none";
}

function dtToLocal(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  const hh = String(d.getHours()).padStart(2,"0");
  const mi = String(d.getMinutes()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

async function loadActivitiesTable() {
  const tb = $("tblActivities").querySelector("tbody");
  tb.innerHTML = "";
  if (!currentOperator) return;

  manualActivities = await fetchManualActivities(currentOperator, currentRange);

  for (const a of manualActivities) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(a.label)}</td>
      <td class="mono">${escapeHtml(String(a.start_dt))}</td>
      <td class="mono">${escapeHtml(String(a.end_dt))}</td>
      <td><button class="btn danger" data-del="${a.id}">Elimina</button></td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      await supabase.from("manual_activity_segments").delete().eq("id", id);
      await loadActivitiesTable();
      rerenderTimeline();
    });
  });
}

async function addManualActivity() {
  if (!currentOperator) return;

  const label = $("activityLabel").value.trim();
  const start = dtLocalToTimestamp($("activityStart").value);
  const end = dtLocalToTimestamp($("activityEnd").value);

  if (!label || !start || !end) { log("⚠️ Compila Label + Start + End"); return; }

  const { error } = await supabase.from("manual_activity_segments").insert({
    user_id: currentUser.id,
    operator_code: currentOperator,
    start_dt: start,
    end_dt: end,
    label,
  });

  if (error) { log("❌ insert activity:", error.message); return; }

  await loadActivitiesTable();
  rerenderTimeline();
  log("✅ Activity saved");
}

function rerenderTimeline() {
  if (!currentOperator) return;
  const day = $("daySelect").value;
  const shift = $("shiftSelect").value;
  if (day && shift) renderTimelineForShift(currentIntervals, day, shift);
}

// -------------------- Main recompute --------------------
async function recompute() {
  setBusy(true, "caricamento eventi (paginato)...");
  try {
    currentRange = computeRangeFromUI();

    cachedEvents = await fetchEventsAll(currentRange);
    log(`Loaded events: ${cachedEvents.length}`);

    const opMap = buildOperatorMap(cachedEvents);
    const rows = [];

    for (const [operator, evs] of opMap.entries()) {
      const stats = computeOperatorStats(evs);
      rows.push({ operator, ...stats });
    }

    rows.sort((a,b) => b.time.work - a.time.work);

    renderSummary(rows);
    renderKpi(rows);

    // reset drilldown view
    currentOperator = null;
    $("ddInfo").textContent = "Seleziona un operatore…";
    $("tblBlocks").querySelector("tbody").innerHTML = "";
    $("tblIntervals").querySelector("tbody").innerHTML = "";
    $("timelineRow").innerHTML = "";
    $("timelineTicks").innerHTML = "";
    $("axisLeft").textContent = "";
    $("axisRight").textContent = "";
    $("daySelect").innerHTML = "";
  } catch (e) {
    log("❌ recompute error:", e?.message ?? String(e));
  } finally {
    setBusy(false, "");
  }
}

// -------------------- Init --------------------
(async function init() {
  log("Init overview...");
  try {
    currentUser = await ensureAnonymousSession();
    log("✅ Session:", currentUser.id);

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth()+1).padStart(2,"0");
    const dd = String(now.getDate()).padStart(2,"0");
    $("endDate").value = `${yyyy}-${mm}-${dd}`;

    $("btnApply").addEventListener("click", recompute);
    $("btnRefresh").addEventListener("click", recompute);
    $("btnReset").addEventListener("click", resetSession);

    $("btnExportCsv").addEventListener("click", exportIntervalsCsv);

    $("daySelect").addEventListener("change", rerenderTimeline);
    $("shiftSelect").addEventListener("change", rerenderTimeline);
    $("btnViewSequence").addEventListener("click", rerenderTimeline);

    // support modal
    $("btnCloseSupport").addEventListener("click", closeSupportModal);
    $("btnAddSupport").addEventListener("click", addSupportRange);
    $("btnRecalc").addEventListener("click", async () => {
      closeSupportModal();
      await recompute();
    });

    // activity modal
    $("btnCloseActivity").addEventListener("click", closeActivityModal);
    $("btnCloseActivity2").addEventListener("click", closeActivityModal);
    $("btnAddActivity").addEventListener("click", addManualActivity);

    await recompute();
  } catch (e) {
    log("❌ init failed:", e?.message ?? String(e));
    setAuthUI(false, "AUTH ERROR", "-");
  }
})();
