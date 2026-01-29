import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://wndlmkjhzgqdwsfylvmh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sf8tAbDNmRLtCGu9xsesSQ_JWmIyQHI";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const $ = (id) => document.getElementById(id);
const logEl = $("log");

function dt(dateStr, timeStr) {
  return new Date(`${dateStr}T${String(timeStr).slice(0,5)}:00`);
}

function addWindow(map, operator, day, start, end) {
  const key = `${operator}__${day}`;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push({ start, end });
}

function mergeWindows(wins) {
  wins.sort((a,b)=>a.start-b.start);
  const out = [];
  for (const w of wins) {
    if (!out.length || w.start > out[out.length-1].end) out.push({ ...w });
    else out[out.length-1].end = new Date(Math.max(out[out.length-1].end, w.end));
  }
  return out;
}

function buildWindowsMap(sched, supSeg) {
  const map = new Map();

  // schedule -> garantiti
  for (const s of (sched ?? [])) {
    const op = (s.operator_code ?? "").trim();
    if (!op) continue;
    if (s.status !== "present") continue;
    if (!s.start_time || !s.end_time) continue;

    addWindow(map, op, s.work_date, dt(s.work_date, s.start_time), dt(s.work_date, s.end_time));
  }

  // support segments -> persone reali
  for (const seg of (supSeg ?? [])) {
    const real = (seg.real_name ?? "").trim();
    if (!real) continue;

    const a = new Date(seg.start_dt);
    const b = new Date(seg.end_dt);
    const day = a.toISOString().slice(0,10);

    addWindow(map, real, day, a, b);
  }

  for (const [k, wins] of map.entries()) map.set(k, mergeWindows(wins));
  return map;
}

function intervalsFromEventsInWindows(events, windows, pauseThresholdMin=30) {
  const pauseMs = pauseThresholdMin * 60 * 1000;
  const out = [];

  for (const w of windows) {
    const ev = events.filter(e => {
      const t = new Date(e.event_dt);
      return t >= w.start && t <= w.end;
    });
    if (ev.length === 0) continue;

    for (let i=0; i<ev.length; i++) {
      const a = new Date(ev[i].event_dt);
      const aCat = ev[i].category;
      let end = w.end;

      if (i < ev.length-1) {
        const b = new Date(ev[i+1].event_dt);
        if ((b - a) > pauseMs) {
          const pauseEnd = new Date(Math.min(b.getTime(), w.end.getTime()));
          out.push({ start: a, end: pauseEnd, category: "PAUSA", wo: null });
          continue;
        }
        end = new Date(Math.min(b.getTime(), w.end.getTime()));
      }

      if (end > a) {
        out.push({
          start: a,
          end,
          category: aCat,
          wo: ev[i].warehouse_order ?? null
        });
      }
    }
  }
  return out;
}

function hasSchedule(windowsMap, operator, day) {
  return (windowsMap.get(`${operator}__${day}`) ?? []).length > 0;
}

const PAUSE_THRESHOLD_SEC = 30 * 60;

const SHIFTS = {
  AM: { start: "05:00", end: "13:00" },
  C:  { start: "08:00", end: "16:00" },
  PM: { start: "14:00", end: "22:00" },
  OM: { start: "14:00", end: "22:00" }, // compat

};

let currentUser = null;
let cachedEvents = [];          // fetched for base range
let effectiveEvents = [];       // after items + chip filter
let currentOperator = null;

let selectedChipDays = new Set(); // “filtro sul filtro”
let effectiveDayList = [];        // days produced by right sidebar selection
let drillDay = null;              // single day for blocks/detail

let manualActivities = [];
let supportAccountOpen = null;

function log(...args) {
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(isBusy, msg="") {
  $("btnApply").disabled = isBusy;
  $("btnRefresh").disabled = isBusy;
  $("btnReset").disabled = isBusy;
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

function dayKey(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
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

function parseTimeToDay(day, hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(`${day}T00:00:00`);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function categoryToRowClass(cat) {
  if (cat === "PI Pick") return "row-pick";
  if (cat === "PI Bulk") return "row-bulk";
  if (cat === "P2P") return "row-p2p";
  if (cat === "CLP") return "row-clp";
  if (cat === "PAUSA") return "row-pause";
  return "";
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
  setBusy(true);
  await supabase.auth.signOut();
  setBusy(false);
  location.reload();
}

// -------------------- Right sidebar filter (type + items) --------------------
function dateRangeList(fromDay, toDay) {
  const out = [];
  const a = new Date(`${fromDay}T00:00:00`);
  const b = new Date(`${toDay}T00:00:00`);
  for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    out.push(dayKey(d));
  }
  return out;
}

function isoWeekKey(d) {
  // ISO week key like 2026-W04
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,"0")}`;
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

function rebuildRangeItems() {
  const type = $("rangeType").value;
  const from = $("fromDate").value;
  const to = $("toDate").value;
  const sel = $("rangeItems");

  sel.innerHTML = "";
  if (!from || !to) return;

  const days = dateRangeList(from, to);

  let items = [];
  if (type === "days") {
    items = days;
  } else if (type === "weeks") {
    items = uniq(days.map(x => isoWeekKey(new Date(`${x}T00:00:00`)))).sort();
  } else {
    items = uniq(days.map(x => monthKey(new Date(`${x}T00:00:00`)))).sort();
  }

  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it;
    opt.textContent = it;
    sel.appendChild(opt);
  }
}

function getSelectedOptions(selectEl) {
  return Array.from(selectEl.selectedOptions).map(o => o.value);
}

function computeEffectiveDays() {
  const type = $("rangeType").value;
  const from = $("fromDate").value;
  const to = $("toDate").value;
  const picked = getSelectedOptions($("rangeItems"));

  if (!from || !to) return [];

  // 1) Schedule (turni) nel range
const { data: sched, error: schedErr } = await supabase
  .from("resource_schedule_segments")
  .select("operator_code, work_date, status, start_time, end_time, shift")
  .gte("work_date", from)
  .lte("work_date", to);

if (schedErr) throw schedErr;

// 2) Support segments reali nel range
const { data: supSeg, error: supErr } = await supabase
  .from("support_work_segments")
  .select("account_used, real_name, start_dt, end_dt, kind")
  .gte("start_dt", from + "T00:00:00")
  .lte("end_dt", to + "T23:59:59")
  .eq("kind", "support");

if (supErr) throw supErr;

// 3) Build windows map (turni effettivi per persona)
const windowsMap = buildWindowsMap(sched, supSeg);


  const baseDays = dateRangeList(from, to);

  if (picked.length === 0) return baseDays;

  if (type === "days") {
    return picked.filter(d => baseDays.includes(d)).sort();
  }

  if (type === "weeks") {
    return baseDays.filter(d => picked.includes(isoWeekKey(new Date(`${d}T00:00:00`))));
  }

  // months
  return baseDays.filter(d => picked.includes(monthKey(new Date(`${d}T00:00:00`))));
}

// -------------------- Fetch ALL events for base range (pagination) --------------------
async function fetchEventsAll(fromDay, toDay) {
  const start = `${fromDay}T00:00:00`;
  const end = `${toDay}T23:59:59`;

  const PAGE = 1000;
  let from = 0;
  let all = [];

  while (true) {
    const to = from + PAGE - 1;

    const { data, error } = await supabase
      .from("v_operator_events_effective_plus_support")
      .select("event_dt, source, category, warehouse_order, operator_code_effective, operator_base, operator_code")
      .gte("event_dt", start)
      .lte("event_dt", end)
      .order("operator_code", { ascending: true })
      .order("event_dt", { ascending: true })
      .range(from, to);

    if (error) throw error;

    const batch = data ?? [];
    all = all.concat(batch);

    if (batch.length < PAGE) break;
    from += PAGE;
    if (from > 100000) break;
  }

events.forEach(e => {
  e.operator = (e.operator_code_effective ?? e.operator_code ?? "").trim();
  e.account_used = (e.operator_base ?? e.operator_code ?? "").trim(); // account realmente usato
});


  // tieni anche la base (account usato)
  e.operator_base = String(e.operator_base ?? e.operator_original ?? "").trim();
});


  return all;
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

// Duration between event[i] and event[i+1] assigned to NEXT event category, >30 min = PAUSA
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
      cur = { category: it.category, start: it.start, end: it.end, sec: it.sec, events: [] };
      blocks.push(cur);
    } else {
      cur.end = it.end;
      cur.sec += it.sec;
    }

    // per conteggi: NON contare eventi dentro PAUSA
    if (it.category !== "PAUSA") cur.events.push(it.nextEvent);
  }

  return blocks;
}

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
  const map = new Map();
  for (const e of events) {
    const op = String(e.operator_code ?? "-").trim() || "-";
    if (!map.has(op)) map.set(op, []);
    map.get(op).push(e);
  }
  return map;
}

// -------------------- Date chips strip --------------------
function attachStripArrows(leftBtnId, rightBtnId, scrollId) {
  const left = $(leftBtnId);
  const right = $(rightBtnId);
  const sc = $(scrollId);

  left.addEventListener("click", () => sc.scrollBy({ left: -220, behavior: "smooth" }));
  right.addEventListener("click", () => sc.scrollBy({ left: 220, behavior: "smooth" }));
}

function renderDayChips(scrollId, days, multiSelect, selectedSet, onToggle) {
  const sc = $(scrollId);
  sc.innerHTML = "";

  for (const d of days) {
    const b = document.createElement("button");
    b.className = "chip" + (selectedSet.has(d) ? " on" : "");
    b.textContent = d.slice(5); // MM-DD
    b.title = d;

    b.addEventListener("click", () => {
      if (!multiSelect) {
        selectedSet.clear();
        selectedSet.add(d);
      } else {
        if (selectedSet.has(d)) selectedSet.delete(d);
        else selectedSet.add(d);
      }
      onToggle();
    });

    sc.appendChild(b);
  }
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

    const events = b.events || [];
    const binCount = events.filter(e => e?.source === "PI").length;
    const woCount = uniq(events.filter(e => e?.source === "WT").map(e => e.warehouse_order)).length;

    tr.innerHTML = `
      <td class="mono">${escapeHtml(fmtDT(b.start))}</td>
      <td class="mono">${escapeHtml(fmtDT(b.end))}</td>
      <td>${escapeHtml(b.category)}</td>
      <td class="mono">${secToHHMM(b.sec)}</td>
      <td class="mono">${binCount}</td>
      <td class="mono">${woCount}</td>
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

// -------------------- Filters application --------------------
function applyChipFilter(events) {
  if (selectedChipDays.size === 0) return events;
  return events.filter(e => selectedChipDays.has(dayKey(parseDT(e.event_dt))));
}

function applyEffectiveDayList(events) {
  const set = new Set(effectiveDayList);
  return events.filter(e => set.has(dayKey(parseDT(e.event_dt))));
}

// -------------------- Manual activities --------------------
async function fetchManualActivities(operator, fromDay, toDay) {
  const start = `${fromDay}T00:00:00`;
  const end = `${toDay}T23:59:59`;

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

// -------------------- Drilldown: timeline continuous + multi-day --------------------
function sliceIntervalsToDay(intervals, day) {
  const dayStart = new Date(`${day}T00:00:00`);
  const dayEnd = new Date(`${day}T23:59:59`);

  const out = [];
  for (const it of intervals) {
    const s = new Date(Math.max(it.start.getTime(), dayStart.getTime()));
    const e = new Date(Math.min(it.end.getTime(), dayEnd.getTime()));
    const ms = e.getTime() - s.getTime();
    if (ms <= 0) continue;
    out.push({ ...it, start: s, end: e, sec: Math.floor(ms/1000) });
  }
  return out;
}

function buildSegmentsForDayShift(intervals, day, shiftKey) {
  const sh = SHIFTS[shiftKey];
  const shiftStart = parseTimeToDay(day, sh.start);
  const shiftEnd = parseTimeToDay(day, sh.end);
  const totalMs = shiftEnd.getTime() - shiftStart.getTime();

  // overlaps
  const chunks = [];
  for (const it of intervals) {
    const a = Math.max(it.start.getTime(), shiftStart.getTime());
    const b = Math.min(it.end.getTime(), shiftEnd.getTime());
    if (b <= a) continue;
    chunks.push({
      category: it.category,
      start: new Date(a),
      end: new Date(b),
      ms: b - a,
    });
  }
  chunks.sort((x,y) => x.start - y.start);

  // merge consecutive same category
  const merged = [];
  for (const c of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.category === c.category && last.end.getTime() === c.start.getTime()) {
      last.end = c.end;
      last.ms += c.ms;
    } else {
      merged.push({ ...c });
    }
  }

  // fill holes with NONE segments (optional) to show empty time
  const filled = [];
  let cursor = shiftStart.getTime();
  for (const seg of merged) {
    if (seg.start.getTime() > cursor) {
      filled.push({
        category: "NONE",
        start: new Date(cursor),
        end: new Date(seg.start.getTime()),
        ms: seg.start.getTime() - cursor,
      });
    }
    filled.push(seg);
    cursor = seg.end.getTime();
  }
  if (cursor < shiftEnd.getTime()) {
    filled.push({
      category: "NONE",
      start: new Date(cursor),
      end: shiftEnd,
      ms: shiftEnd.getTime() - cursor,
    });
  }

  return { filled, shiftStart, shiftEnd, totalMs };
}

function renderMultiDayTimeline(intervals, days, shiftKey) {
  const wrap = $("timelineMulti");
  wrap.innerHTML = "";

  for (const day of days) {
    const { filled, shiftStart, shiftEnd, totalMs } = buildSegmentsForDayShift(intervals, day, shiftKey);

    const row = document.createElement("div");
    row.className = "barRow";

    const label = document.createElement("div");
    label.className = "barLabel mono";
    label.textContent = `${day}  ${fmtDT(shiftStart).slice(11,16)}–${fmtDT(shiftEnd).slice(11,16)}`;

    const bar = document.createElement("div");
    bar.className = "timeBar";

    // build widths (%) – last segment closes remaining
    let used = 0;
    for (let i = 0; i < filled.length; i++) {
      const s = filled[i];
      const div = document.createElement("div");

      const pct = (i === filled.length - 1)
        ? Math.max(0, 100 - used)
        : Math.round((s.ms / totalMs) * 1000) / 10; // 0.1%
      used += pct;

      div.className = "seg" + (s.category === "NONE" ? " none" : "");
      div.style.width = `${pct}%`;
      div.style.background = (s.category === "NONE") ? "rgba(255,255,255,.06)" : categoryToCssBg(s.category);
      div.title = `${fmtDT(s.start).slice(11,16)}–${fmtDT(s.end).slice(11,16)} | ${s.category}`;

      // click su PAUSA -> inserisci attività indiretta (segmento reale)
      if (s.category === "PAUSA") {
        div.addEventListener("click", () => openActivityModal(s.start, s.end));
      }

      bar.appendChild(div);
    }

    row.appendChild(label);
    row.appendChild(bar);
    wrap.appendChild(row);
  }
}

// -------------------- Drilldown open/render --------------------
function getDrillDays() {
  // se l’utente ha selezionato chips: quelle; altrimenti tutti i giorni effettivi
  const base = (selectedChipDays.size > 0) ? Array.from(selectedChipDays) : [...effectiveDayList];
  base.sort();
  return base;
}

function renderDrillDayChips(days) {
  const sc = $("ddScroll");
  sc.innerHTML = "";

  for (const d of days) {
    const b = document.createElement("button");
    b.className = "chip" + (drillDay === d ? " on" : "");
    b.textContent = d.slice(5);
    b.title = d;

    b.addEventListener("click", () => {
      drillDay = d;
      // re-render drill tables (blocks/intervals) per quella data
      renderDrillTablesForDay();
      // refresh chips UI
      renderDrillDayChips(days);
    });

    sc.appendChild(b);
  }
}

function renderDrillTablesForDay() {
  if (!currentOperator || !drillDay) return;

  const opEvents = effectiveEvents
    .filter(e => String(e.operator_code ?? "-").trim() === currentOperator)
    .sort((a,b) => parseDT(a.event_dt) - parseDT(b.event_dt));

  const intervalsAll = buildIntervalsForOperator(opEvents);
  const intervalsDay = sliceIntervalsToDay(intervalsAll, drillDay);

  const blocks = groupBlocks(intervalsDay);

  renderBlocks(blocks);
  renderIntervals(intervalsDay);
}

async function openDrilldown(operator) {
  currentOperator = operator;

  $("drilldownSection").style.display = "block";
  $("ddInfo").textContent = `Operatore: ${operator}`;

  // giorni drill = chips selezionati o giorni effettivi
  const days = getDrillDays();
  drillDay = days[0] ?? null;

  renderDrillDayChips(days);

  const fromDay = $("fromDate").value;
  const toDay = $("toDate").value;
  manualActivities = await fetchManualActivities(operator, fromDay, toDay);

  // timeline multi-day (tutti i giorni filtrati)
  const opEvents = effectiveEvents
    .filter(e => String(e.operator_code ?? "-").trim() === operator)
    .sort((a,b) => parseDT(a.event_dt) - parseDT(b.event_dt));
  const intervalsAll = buildIntervalsForOperator(opEvents);

  renderMultiDayTimeline(intervalsAll, days, $("shiftSelect").value);

  // tables per giorno singolo (drillDay)
  renderDrillTablesForDay();

  // scroll down to drill section
  $("drilldownSection").scrollIntoView({ behavior: "smooth", block: "start" });
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

// -------------------- Manual activity modal --------------------
function openActivityModal(startDt, endDt) {
  if (!currentOperator) return;

  $("activityTitle").textContent = `Attività indiretta — ${currentOperator}`;
  $("activitySubtitle").textContent = `${fmtDT(startDt)} → ${fmtDT(endDt)}`;

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

  // reload
  manualActivities = await fetchManualActivities(currentOperator, $("fromDate").value, $("toDate").value);

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
      // refresh drill timeline
      if (currentOperator) {
        const days = getDrillDays();
        const opEvents = effectiveEvents.filter(e => e.operator_code === currentOperator).sort((a,b)=>parseDT(a.event_dt)-parseDT(b.event_dt));
        renderMultiDayTimeline(buildIntervalsForOperator(opEvents), days, $("shiftSelect").value);
      }
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
  log("✅ Activity saved");
}

// -------------------- Main load/render --------------------
function recomputeFromCached() {
  // 1) effective days from right sidebar selection
  effectiveDayList = computeEffectiveDays();

  // 2) filter cached events to effective day list
  const dayFiltered = applyEffectiveDayList(cachedEvents);

  // 3) chips selection (filtro sul filtro)
  effectiveEvents = applyChipFilter(dayFiltered);

  // chips list shown on panels must be the effective day list (not chip-selected)
  renderDayChips("sumScroll", effectiveDayList, true, selectedChipDays, () => recomputeFromCached());
  renderDayChips("kpiScroll", effectiveDayList, true, selectedChipDays, () => recomputeFromCached());

  // compute tables on effectiveEvents
  const opMap = buildOperatorMap(effectiveEvents);
  const rows = [];
  for (const [operator, evs] of opMap.entries()) {
    const stats = computeOperatorStats(evs);
    rows.push({ operator, ...stats });
  }
  rows.sort((a,b) => b.time.work - a.time.work);

  renderSummary(rows);
  renderKpi(rows);

  // se il filtro cambia, non “sporchiamo” la vista: chiudiamo drilldown (utente riclicca)
  currentOperator = null;
  $("drilldownSection").style.display = "none";
}

async function loadBaseRangeAndRender() {
  const fromDay = $("fromDate").value;
  const toDay = $("toDate").value;
  if (!fromDay || !toDay) return;

  setBusy(true);
  try {
    cachedEvents = await fetchEventsAll(fromDay, toDay);
    log(`Loaded events (base range): ${cachedEvents.length}`);
    recomputeFromCached();
  } catch (e) {
    log("❌ load error:", e?.message ?? String(e));
  } finally {
    setBusy(false);
  }
}

// -------------------- CSV export --------------------
function exportIntervalsCsv() {
  if (!currentOperator || !drillDay) return;

  const opEvents = effectiveEvents
    .filter(e => e.operator_code === currentOperator)
    .sort((a,b) => parseDT(a.event_dt) - parseDT(b.event_dt));

  const intervalsAll = buildIntervalsForOperator(opEvents);
  const intervalsDay = sliceIntervalsToDay(intervalsAll, drillDay);

  const lines = [];
  lines.push(["operator","day","start","end","category","duration_hhmm","warehouse_order"].join(","));
  for (const it of intervalsDay) {
    const wo = it.nextEvent?.warehouse_order ?? "";
    lines.push([
      currentOperator,
      drillDay,
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
  a.download = `intervals_${currentOperator}_${drillDay}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// -------------------- Init --------------------
(async function init() {
  log("Init overview...");

  try {
    currentUser = await ensureAnonymousSession();
    log("✅ Session:", currentUser.id);

    // strip arrows
    attachStripArrows("sumLeft","sumRight","sumScroll");
    attachStripArrows("kpiLeft","kpiRight","kpiScroll");
    attachStripArrows("ddLeft","ddRight","ddScroll");

    // default date range: last 7 days
    const now = new Date();
    const to = dayKey(now);
    const fromD = new Date(now);
    fromD.setDate(fromD.getDate() - 6);
    const from = dayKey(fromD);

    $("fromDate").value = from;
    $("toDate").value = to;

    // build items
    rebuildRangeItems();

    $("rangeType").addEventListener("change", () => {
      rebuildRangeItems();
    });
    $("fromDate").addEventListener("change", rebuildRangeItems);
    $("toDate").addEventListener("change", rebuildRangeItems);

    $("btnApply").addEventListener("click", async () => {
      // reset chip filter when applying a new range selection
      selectedChipDays.clear();
      await loadBaseRangeAndRender();
    });

    $("btnRefresh").addEventListener("click", loadBaseRangeAndRender);
    $("btnReset").addEventListener("click", resetSession);

    // support modal
    $("btnCloseSupport").addEventListener("click", closeSupportModal);
    $("btnAddSupport").addEventListener("click", addSupportRange);
    $("btnRecalc").addEventListener("click", async () => {
      closeSupportModal();
      await loadBaseRangeAndRender();
    });

    // activity modal
    $("btnCloseActivity").addEventListener("click", closeActivityModal);
    $("btnCloseActivity2").addEventListener("click", closeActivityModal);
    $("btnAddActivity").addEventListener("click", addManualActivity);

    // shift change re-renders drill timeline (if open)
    $("shiftSelect").addEventListener("change", () => {
      if (!currentOperator) return;
      const days = getDrillDays();
      const opEvents = effectiveEvents.filter(e => e.operator_code === currentOperator).sort((a,b)=>parseDT(a.event_dt)-parseDT(b.event_dt));
      renderMultiDayTimeline(buildIntervalsForOperator(opEvents), days, $("shiftSelect").value);
    });

    $("btnExportCsv").addEventListener("click", exportIntervalsCsv);

    // initial load
    await loadBaseRangeAndRender();
  } catch (e) {
    log("❌ init failed:", e?.message ?? String(e));
    setAuthUI(false, "AUTH ERROR", "-");
  }
})();
