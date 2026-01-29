import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://wndlmkjhzgqdwsfylvmh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sf8tAbDNmRLtCGu9xsesSQ_JWmIyQHI";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const $ = (id) => document.getElementById(id);
const logEl = $("log");

const PAUSE_THRESHOLD_SEC = 30 * 60;
const BREAK_SEC_PER_DAY = 30 * 60;

const ALIAS_MAP = new Map([
  ["S.TAZANOU", "R.SOLL"],
  ["F.SAADANI", "S.FETHIA"],
]);

const SHIFT_TIMES = {
  AM: { start: "05:00", end: "13:00" },
  C:  { start: "08:00", end: "16:00" },
  OM: { start: "14:00", end: "22:00" },
};

let user = null;

let resources = [];
let guaranteed = [];
let supportSegments = [];
let weekSchedule = [];
let weekEvents = [];
let lastActMap = new Map();

let selectedWeekStart = null;
let importPreviewRows = [];
let editingResourceId = null;

// ---------- utils ----------
function log(...args) {
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}
function setAuthUI(ok, statusText, userId) {
  $("authStatus").textContent = statusText;
  $("userId").textContent = userId ?? "-";
  const dot = $("authDot");
  dot.classList.remove("ok","bad");
  dot.classList.add(ok ? "ok" : "bad");
}
function norm(s){ return String(s ?? "").trim().toUpperCase(); }
function canon(code){ const c = norm(code); return ALIAS_MAP.get(c) ?? c; }

function uiShift(db){ // display label
  if (!db) return "";
  return db === "OM" ? "PM" : db;
}
function dbShift(ui){ // stored label
  if (!ui) return null;
  const u = norm(ui);
  return u === "PM" ? "OM" : u;
}

function fmtDT(d) {
  const dd = new Date(d);
  if (isNaN(dd.getTime())) return "";
  const y = dd.getFullYear();
  const m = String(dd.getMonth()+1).padStart(2,"0");
  const da = String(dd.getDate()).padStart(2,"0");
  const hh = String(dd.getHours()).padStart(2,"0");
  const mi = String(dd.getMinutes()).padStart(2,"0");
  return `${y}-${m}-${da} ${hh}:${mi}`;
}
function dayKey(d) {
  const dd = new Date(d);
  const y = dd.getFullYear();
  const m = String(dd.getMonth()+1).padStart(2,"0");
  const da = String(dd.getDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
}
function addDays(yyyy_mm_dd, n) {
  const d = new Date(`${yyyy_mm_dd}T00:00:00`);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}
function getWeekStart(yyyy_mm_dd) {
  const d = new Date(`${yyyy_mm_dd}T00:00:00`);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return dayKey(d);
}
function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}
function secToHHMM(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}
function parseDT(s) {
  if (!s) return null;
  const iso = String(s).includes("T") ? String(s) : String(s).replace(" ", "T");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function timeToSec(hhmm) {
  const [h,m] = hhmm.split(":").map(Number);
  return h*3600 + m*60;
}
function durationSec(startHHMM, endHHMM) {
  return Math.max(0, timeToSec(endHHMM) - timeToSec(startHHMM));
}
function roleUpper(r){
  if (r === "counter") return "COUNTER";
  if (r === "specialist") return "SPECIALIST";
  if (r === "teamleader") return "TEAM LEADER";
  if (r === "support") return "SUPPORT";
  return String(r ?? "").toUpperCase();
}

// ISO week label
function isoWeekInfo(dateStr /* yyyy-mm-dd */) {
  const d = new Date(`${dateStr}T00:00:00`);
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return { year: date.getUTCFullYear(), week: weekNo };
}
function setWeekLabel() {
  const { week } = isoWeekInfo(selectedWeekStart);
  const end = addDays(selectedWeekStart, 6);
  $("weekLabel").textContent = `W${String(week).padStart(2,"0")}  ${selectedWeekStart} → ${end}`;
}

// ---------- auth ----------
async function ensureAnon() {
  setAuthUI(false, "checking session...", "-");
  const { data: s } = await supabase.auth.getSession();
  if (s?.session?.user) {
    setAuthUI(true, "signed-in (anon)", s.session.user.id);
    return s.session.user;
  }
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  setAuthUI(true, "signed-in (anon)", data.user.id);
  return data.user;
}
async function resetSession() {
  await supabase.auth.signOut();
  location.reload();
}

// ---------- load ----------
async function loadResources() {
  const { data, error } = await supabase
    .from("resources")
    .select("id,operator_code,role,current_week_shift,shift_override,active")
    .order("role", { ascending: true })
    .order("operator_code", { ascending: true });

  if (error) throw error;

  resources = (data ?? []).map(r => ({
    ...r,
    operator_code: canon(r.operator_code),
  }));

  guaranteed = resources.filter(r => ["counter","specialist","teamleader"].includes(r.role) && r.active);
}

async function loadSupportSegments(weekStart) {
  const from = `${weekStart}T00:00:00`;
  const to = `${addDays(weekStart, 6)}T23:59:59`;
  const { data, error } = await supabase
    .from("support_work_segments")
    .select("*")
    .gte("start_dt", from)
    .lte("end_dt", to)
    .order("start_dt", { ascending: true });

  if (error) throw error;
  supportSegments = (data ?? []).map(s => ({ ...s, account_used: canon(s.account_used) }));
}

async function loadWeekSchedule(weekStart) {
  const from = weekStart;
  const to = addDays(weekStart, 6);

  const { data, error } = await supabase
    .from("resource_schedule_segments")
    .select("id,operator_code,work_date,segment_no,status,start_time,end_time,shift,raw_text")
    .gte("work_date", from)
    .lte("work_date", to)
    .order("operator_code", { ascending: true })
    .order("work_date", { ascending: true })
    .order("segment_no", { ascending: true });

  if (error) throw error;

  weekSchedule = (data ?? []).map(x => ({
    ...x,
    operator_code: canon(x.operator_code),
  }));
}

async function loadWeekEvents(weekStart) {
  const from = `${weekStart}T00:00:00`;
  const to = `${addDays(weekStart, 6)}T23:59:59`;

  const PAGE = 1000;
  let fromIx = 0;
  let all = [];
  while (true) {
    const { data, error } = await supabase
      .from("v_operator_events_effective")
      .select("source,event_dt,operator_code,created_by,counter,warehouse_order,category")
      .gte("event_dt", from)
      .lte("event_dt", to)
      .order("event_dt", { ascending: true })
      .range(fromIx, fromIx + PAGE - 1);

    if (error) throw error;

    const batch = (data ?? []).map(e => ({
      ...e,
      operator_code: canon(e.operator_code),
      created_by: e.created_by ? canon(e.created_by) : null,
      counter: e.counter ? canon(e.counter) : null,
    }));
    all = all.concat(batch);

    if (batch.length < PAGE) break;
    fromIx += PAGE;
    if (fromIx > 60000) break;
  }

  weekEvents = all;

  lastActMap = new Map();
  for (const e of weekEvents) {
    const dt = parseDT(e.event_dt);
    if (!dt) continue;
    const accs = [e.operator_code, e.created_by, e.counter].filter(Boolean).map(canon);
    for (const a of accs) {
      const prev = lastActMap.get(a);
      if (!prev || dt > prev) lastActMap.set(a, dt);
    }
  }
}

// ---------- schedule -> resources sync ----------
function deriveWeekShiftFromSchedule(operator_code) {
  const acc = canon(operator_code);
  const counts = new Map(); // shift => count
  for (const s of weekSchedule) {
    if (canon(s.operator_code) !== acc) continue;
    if (s.status !== "present") continue;
    if (!s.shift) continue;
    counts.set(s.shift, (counts.get(s.shift) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = null, bestN = -1;
  for (const [sh, n] of counts.entries()) {
    if (n > bestN) { bestN = n; best = sh; }
  }
  return best; // AM/C/OM
}

async function syncWeekShiftsToResources() {
  // aggiorna resources.current_week_shift SOLO se shift_override=false
  const updates = [];
  for (const r of guaranteed) {
    const derived = deriveWeekShiftFromSchedule(r.operator_code);
    if (!derived) continue;
    if (r.shift_override) continue;

    if (r.current_week_shift !== derived) {
      updates.push({ id: r.id, current_week_shift: derived });
    }
  }

  for (const u of updates) {
    const { error } = await supabase.from("resources").update(u).eq("id", u.id);
    if (error) log("❌ sync shift:", error.message);
  }
}

// ---------- support calc ----------
function buildAccountEventsMap() {
  const m = new Map();
  for (const e of weekEvents) {
    const acc = canon(e.operator_code);
    if (!m.has(acc)) m.set(acc, []);
    m.get(acc).push(e);
  }
  for (const [k, arr] of m.entries()) {
    arr.sort((a,b) => parseDT(a.event_dt) - parseDT(b.event_dt));
    m.set(k, arr);
  }
  return m;
}

function computeWorkSecondsForAccount(events) {
  let work = 0;
  for (let i = 0; i < events.length - 1; i++) {
    const a = parseDT(events[i].event_dt);
    const b = parseDT(events[i+1].event_dt);
    if (!a || !b) continue;
    const dt = Math.floor((b - a)/1000);
    if (dt <= 0) continue;
    if (dt > PAUSE_THRESHOLD_SEC) continue;
    work += dt;
  }
  return work;
}

function scheduleExpectedSecondsForAccount(account, days) {
  const acc = canon(account);
  let total = 0;
  let presentDays = 0;

  for (const d of days) {
    const segs = weekSchedule.filter(s => canon(s.operator_code) === acc && s.work_date === d);
    const presentSegs = segs.filter(s => s.status === "present" && s.start_time && s.end_time);

    if (presentSegs.length > 0) {
      let daySec = 0;
      for (const s of presentSegs) {
        daySec += durationSec(String(s.start_time).slice(0,5), String(s.end_time).slice(0,5));
      }
      total += daySec;
      presentDays += 1;
    }
  }

  total -= presentDays * BREAK_SEC_PER_DAY;
  return Math.max(0, total);
}

function allocatedSupportSeconds(account) {
  const acc = canon(account);
  let sec = 0;
  for (const s of supportSegments) {
    if (canon(s.account_used) !== acc) continue;
    const a = parseDT(s.start_dt), b = parseDT(s.end_dt);
    if (!a || !b) continue;
    sec += Math.floor((b - a)/1000);
  }
  return sec;
}

function computeSupportiTable(weekStart) {
  const days = weekDays(weekStart);
  const accEvents = buildAccountEventsMap();

  const set = new Set();
  for (const k of accEvents.keys()) set.add(k);
  for (const r of resources) set.add(canon(r.operator_code));

  const rows = [];
  for (const acc of Array.from(set).sort()) {
    const evs = accEvents.get(acc) ?? [];
    const workSec = computeWorkSecondsForAccount(evs);

    const isGuaranteed = guaranteed.some(r => canon(r.operator_code) === acc);
    const hasAnySchedule = weekSchedule.some(s => canon(s.operator_code) === acc);
    const expectedSec = (isGuaranteed || hasAnySchedule) ? scheduleExpectedSecondsForAccount(acc, days) : 0;

    const overSec = Math.max(0, workSec - expectedSec);
    const allocSec = allocatedSupportSeconds(acc);
    const residualSec = Math.max(0, overSec - allocSec);

    const isSupportAcc = resources.some(r => canon(r.operator_code) === acc && r.role === "support");
    if (overSec > 0 || (isSupportAcc && workSec > 0)) {
      rows.push({ account: acc, overSec, allocSec, residualSec });
    }
  }
  rows.sort((a,b) => b.residualSec - a.residualSec);
  return rows;
}

// ---------- render ----------
function renderKpi(rowsSupporti) {
  $("kpiGuaranteed").textContent = String(guaranteed.length);
  $("kpiCounters").textContent = String(guaranteed.filter(x => x.role === "counter").length);
  $("kpiSpecialist").textContent = String(guaranteed.filter(x => x.role === "specialist").length);

  const absent = weekSchedule.filter(s =>
    guaranteed.some(r => canon(r.operator_code) === canon(s.operator_code)) &&
    ["vacation","permission","absent"].includes(s.status)
  ).length;
  $("kpiAbsent").textContent = String(absent);

  const totResidual = rowsSupporti.reduce((sum,r)=>sum + r.residualSec, 0);
  $("kpiOver").textContent = secToHHMM(totResidual);

  $("kpiSegments").textContent = String(supportSegments.length);
}

function renderResourcesTable() {
  const group = $("resGroup").value;
  let rows = guaranteed.slice();
  if (group !== "all") rows = rows.filter(r => r.role === group);

  const tb = $("tblRes").querySelector("tbody");
  tb.innerHTML = "";

  for (const r of rows) {
    const last = lastActMap.get(canon(r.operator_code));
    const lastTxt = last ? fmtDT(last) : "";

    // shift displayed: se schedule dà un shift, lo mostriamo; fallback a current_week_shift
    const derived = deriveWeekShiftFromSchedule(r.operator_code);
    const shiftDb = derived ?? r.current_week_shift ?? null;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono"><span class="link" data-edit="${r.id}">${escapeHtml(r.operator_code)}</span></td>
      <td>${escapeHtml(roleUpper(r.role))}</td>
      <td class="mono">${escapeHtml(uiShift(shiftDb))}</td>
      <td class="mono">${escapeHtml(lastTxt)}</td>
      <td>
        <select data-man="${r.id}">
          <option value="">—</option>
          <option value="edit">Modifica</option>
          <option value="remove">Rimuovi</option>
        </select>
      </td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-edit]").forEach(el => el.addEventListener("click", () => openResModal(el.getAttribute("data-edit"))));
  tb.querySelectorAll("[data-man]").forEach(sel => {
    sel.addEventListener("change", async () => {
      const id = sel.getAttribute("data-man");
      const val = sel.value;
      sel.value = "";
      if (val === "edit") openResModal(id);
      if (val === "remove") await removeResource(id);
    });
  });
}

function renderSupportiTable(rows) {
  const tb = $("tblSupporti").querySelector("tbody");
  tb.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(r.account)}</td>
      <td class="mono" title="Over - Allocated = Residual">
        ${secToHHMM(r.overSec)} <span style="color:rgba(255,255,255,.55)"> (res ${secToHHMM(r.residualSec)})</span>
      </td>
      <td><button class="btn primary small" data-set="${escapeHtml(r.account)}">Set supporto</button></td>
    `;
    tb.appendChild(tr);
  }
  tb.querySelectorAll("[data-set]").forEach(btn => btn.addEventListener("click", () => openSupportModal(btn.getAttribute("data-set"))));
}

function renderSupportSegmentsTable() {
  const tb = $("tblSupportSeg").querySelector("tbody");
  tb.innerHTML = "";

  for (const s of supportSegments) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(canon(s.account_used))}</td>
      <td>${escapeHtml(s.kind)}</td>
      <td class="mono">${escapeHtml(fmtDT(s.start_dt))}</td>
      <td class="mono">${escapeHtml(fmtDT(s.end_dt))}</td>
      <td>${escapeHtml(s.real_name ?? "")}</td>
      <td><button class="btn danger small" data-del="${s.id}">Del</button></td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      if (!confirm("Eliminare segmento supporto?")) return;
      const { error } = await supabase.from("support_work_segments").delete().eq("id", id);
      if (error) { log("❌ delete segment:", error.message); return; }
      await reloadWeek();
    });
  });
}

function renderWeekTable(weekStart) {
  const days = weekDays(weekStart);
  const head = $("weekHead");
  head.innerHTML = `
    <tr>
      <th>WORKER</th>
      ${days.map((d,i)=>`<th class="mono">${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i]}<br>${d}</th>`).join("")}
    </tr>
  `;

  const body = $("weekBody");
  body.innerHTML = "";

  for (const r of guaranteed) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(r.operator_code)}</td>
      ${days.map(d => {
        const segs = weekSchedule.filter(s => canon(s.operator_code) === canon(r.operator_code) && s.work_date === d);
        let txt = "";
        if (segs.length) {
          const parts = segs.map(s => {
            if (s.status === "present") return `${String(s.start_time).slice(0,5)}-${String(s.end_time).slice(0,5)}`;
            if (s.status === "vacation") return "ferie";
            if (s.status === "permission") return "perm";
            if (s.status === "absent") return "abs";
            return s.raw_text ?? s.status;
          });
          txt = parts.join(" | ");
        }
        return `<td class="mono"><span class="link" data-cell="${escapeHtml(r.operator_code)}|${d}">${escapeHtml(txt)}</span></td>`;
      }).join("")}
    `;
    body.appendChild(tr);
  }

  body.querySelectorAll("[data-cell]").forEach(el => {
    el.addEventListener("click", () => {
      const [acc, d] = el.getAttribute("data-cell").split("|");
      openScheduleCellModal(acc, d);
    });
  });
}

// ---------- resource modal ----------
function openResModal(id = null) {
  editingResourceId = id;

  if (!id) {
    $("resTitle").textContent = "Aggiungi risorsa";
    $("resCode").value = "";
    $("resRole").value = "counter";
    $("resWeekShift").value = "";
  } else {
    const r = guaranteed.find(x => x.id === id);
    if (!r) return;
    $("resTitle").textContent = `Modifica risorsa: ${r.operator_code}`;
    $("resCode").value = r.operator_code;
    $("resRole").value = r.role;

    const derived = deriveWeekShiftFromSchedule(r.operator_code);
    const shiftDb = derived ?? r.current_week_shift ?? "";
    $("resWeekShift").value = uiShift(shiftDb) || "";
  }

  $("resOverlay").style.display = "flex";
}
function closeResModal() {
  $("resOverlay").style.display = "none";
  editingResourceId = null;
}

async function saveResource() {
  const operator_code = canon($("resCode").value);
  const role = $("resRole").value;
  const ui = $("resWeekShift").value || "";
  const current_week_shift = ui ? dbShift(ui) : null;

  if (!operator_code) { log("⚠️ Account richiesto"); return; }

  const payload = {
    user_id: user.id,
    operator_code,
    role,
    current_week_shift,
    active: true,
    // se l’utente imposta shift da qui => override = true
    // se lo lascia vuoto => override = false (torna a seguire schedule)
    shift_override: !!current_week_shift
  };

  if (editingResourceId) payload.id = editingResourceId;

  const { error } = await supabase
    .from("resources")
    .upsert(payload, { onConflict: "user_id,operator_code" });

  if (error) { log("❌ saveResource:", error.message); return; }

  closeResModal();
  await reloadAll();
  log("✅ risorsa salvata");
}

async function removeResource(id) {
  const r = guaranteed.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`Rimuovere ${r.operator_code}?`)) return;

  const { error } = await supabase.from("resources").delete().eq("id", id);
  if (error) { log("❌ removeResource:", error.message); return; }

  await reloadAll();
  log("✅ risorsa rimossa");
}

// ---------- support modal ----------
function showHideSupportFields() {
  const kind = $("supKind").value;
  const isSupport = kind === "support";
  $("supRealWrap").classList.toggle("hidden", !isSupport);
  $("supUsedWrap").classList.toggle("hidden", !isSupport);
}

function openSupportModal(account) {
  $("supAccount").value = canon(account);
  $("supTitle").textContent = `Set supporto — ${canon(account)}`;

  $("supDay").value = selectedWeekStart;
  $("supStart").value = "";
  $("supEnd").value = "";
  $("supKind").value = "support";
    $("supReal").value = "";
  $("supDept").value = "";
  $("supUsed").value = "";
  $("supNote").value = "";
  showHideSupportFields();

  renderSupportSegmentsForAccount(canon(account));
  $("supOverlay").style.display = "flex";
}

function closeSupportModal() {
  $("supOverlay").style.display = "none";
}

function renderSupportSegmentsForAccount(account) {
  const tb = $("tblSupSeg").querySelector("tbody");
  tb.innerHTML = "";

  const rows = supportSegments.filter(s => canon(s.account_used) === canon(account));
  for (const s of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(s.kind)}</td>
      <td class="mono">${escapeHtml(fmtDT(s.start_dt))}</td>
      <td class="mono">${escapeHtml(fmtDT(s.end_dt))}</td>
      <td>${escapeHtml(s.real_name ?? "")}</td>
      <td><button class="btn danger small" data-del="${s.id}">Del</button></td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      if (!confirm("Eliminare segmento supporto?")) return;
      const { error } = await supabase.from("support_work_segments").delete().eq("id", id);
      if (error) { log("❌ delete segment:", error.message); return; }
      await reloadWeek();
      renderSupportSegmentsForAccount(account);
    });
  });
}

async function saveSupportSegment() {
  const account = canon($("supAccount").value);
  const kind = $("supKind").value;

  const day = $("supDay").value;
  const startT = $("supStart").value;
  const endT = $("supEnd").value;

  if (!account || !day || !startT || !endT) { log("⚠️ account/giorno/start/end richiesti"); return; }

  const payload = {
    user_id: user.id,
    account_used: account,
    kind,
    start_dt: `${day} ${startT}:00`,
    end_dt: `${day} ${endT}:00`,
    note: $("supNote").value.trim() || null,
    real_name: null,
    dept: null,
    used_resource: null,
  };

  if (kind === "support") {
    payload.real_name = $("supReal").value.trim() || null;
    payload.dept = $("supDept").value || null;
    payload.used_resource = $("supUsed").value.trim() || null;
  }

  const { error } = await supabase.from("support_work_segments").insert(payload);
  if (error) { log("❌ save support segment:", error.message); return; }

  await reloadWeek();
  renderSupportSegmentsForAccount(account);
  log("✅ support segment salvato");
}

// ---------- schedule cell edit ----------
function parseTimeRange(cell) {
  const t = String(cell ?? "").trim();
  const m = t.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (!m) return null;
  const start = m[1].padStart(5,"0");
  const end = m[2].padStart(5,"0");
  return { start, end };
}

function openScheduleCellModal(account, date) {
  const currentSegs = weekSchedule.filter(s => canon(s.operator_code)===canon(account) && s.work_date===date);
  const curTxt = currentSegs.map(s => s.status==="present"
    ? `${String(s.start_time).slice(0,5)}-${String(s.end_time).slice(0,5)}`
    : (s.status==="vacation"?"ferie":(s.status==="permission"?"perm":s.status))
  ).join(" | ");

  const val = prompt(
    `Imposta turno per ${account} @ ${date}\n`+
    `Esempi: AM | C | PM | ferie | perm | 08:30-16:30 | (vuoto per cancellare)\n\nAttuale: ${curTxt}`,
    curTxt
  );
  if (val === null) return;

  saveScheduleCell(account, date, String(val).trim());
}

async function saveScheduleCell(account, date, val) {
  const acc = canon(account);

  // delete existing segments for (acc,date) for simplicity
  const toDel = weekSchedule.filter(s => canon(s.operator_code)===acc && s.work_date===date);
  for (const s of toDel) await supabase.from("resource_schedule_segments").delete().eq("id", s.id);

  if (!val) {
    await reloadWeek();
    return;
  }

  const v = val.trim().toLowerCase();

  let row = {
    user_id: user.id,
    operator_code: acc,
    work_date: date,
    segment_no: 1,
    status: "present",
    start_time: null,
    end_time: null,
    shift: null,
    raw_text: null
  };

  if (v === "ferie") {
    row.status = "vacation";
    row.raw_text = "ferie";
  } else if (v === "perm") {
    row.status = "permission";
    row.raw_text = "perm";
  } else if (["am","c","pm","om"].includes(v)) {
    const sh = (v === "pm") ? "OM" : v.toUpperCase();
    row.status = "present";
    row.shift = sh;
    row.start_time = SHIFT_TIMES[sh].start;
    row.end_time = SHIFT_TIMES[sh].end;
    row.raw_text = `${row.start_time}-${row.end_time}`;
  } else {
    const tr = parseTimeRange(val);
    if (tr) {
      row.status = "present";
      row.start_time = tr.start;
      row.end_time = tr.end;
      row.raw_text = `${tr.start}-${tr.end}`;
      row.shift = tr.start.startsWith("05:") ? "AM" : (tr.start.startsWith("14:") ? "OM" : "C");
    } else {
      row.status = "other";
      row.raw_text = val;
    }
  }

  const { error } = await supabase.from("resource_schedule_segments").insert(row);
  if (error) { log("❌ save schedule cell:", error.message); return; }

  await reloadWeek();
}

// ---------- import schedule ----------
function parseDateToken(tok) {
  const t = String(tok ?? "").trim();
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  const dd = m[1].padStart(2,"0");
  const mm = m[2].padStart(2,"0");
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

function parseScheduleTSV(tsv) {
  const lines = String(tsv ?? "")
    .split(/\r?\n/)
    .map(l => l.replace(/\u00A0/g, " "))
    .filter(l => l.trim().length > 0);

  const grid = lines.map(l => l.split("\t"));
  if (grid.length < 3) return { dates: [], rows: [] };

  let dateRow = -1;
  for (let r = 0; r < grid.length; r++) {
    const parsed = grid[r].map(parseDateToken).filter(Boolean);
    if (parsed.length >= 3) { dateRow = r; break; }
  }
  if (dateRow === -1) return { dates: [], rows: [] };

  const row = grid[dateRow];
  let startCol = -1;
  for (let c = 0; c < row.length; c++) {
    if (parseDateToken(row[c])) { startCol = c; break; }
  }

  const dates = [];
  for (let c = startCol; c < row.length; c++) {
    const d = parseDateToken(row[c]);
    if (!d) break;
    dates.push(d);
  }

  let dataStartRow = dateRow + 1;
  if (grid[dataStartRow]) {
    const hasWeekday = grid[dataStartRow].some(x => /mon|tue|wed|thu|fri|sat|sun/i.test(String(x)));
    if (hasWeekday) dataStartRow++;
  }

  const out = [];
  for (let r = dataStartRow; r < grid.length; r++) {
    const line = grid[r];
    const opRaw = String(line[0] ?? "").trim();
    if (!opRaw) continue;

    const op = canon(opRaw);
    // import SOLO guaranteed
    if (!guaranteed.some(x => canon(x.operator_code) === op)) continue;

    for (let i = 0; i < dates.length; i++) {
      const cell = String(line[startCol + i] ?? "").trim();
      if (!cell) continue;

      const lower = cell.toLowerCase();

      if (lower.includes("ferie")) {
        out.push({ user_id:user.id, operator_code:op, work_date:dates[i], segment_no:1, status:"vacation", raw_text:"ferie", start_time:null, end_time:null, shift:null });
        continue;
      }
      if (lower.includes("perm")) {
        out.push({ user_id:user.id, operator_code:op, work_date:dates[i], segment_no:1, status:"permission", raw_text:"perm", start_time:null, end_time:null, shift:null });
        continue;
      }

      const tr = parseTimeRange(cell);
      if (tr) {
        const shift = tr.start.startsWith("05:") ? "AM" : (tr.start.startsWith("14:") ? "OM" : "C");
        out.push({ user_id:user.id, operator_code:op, work_date:dates[i], segment_no:1, status:"present", start_time:tr.start, end_time:tr.end, shift, raw_text:`${tr.start}-${tr.end}` });
        continue;
      }

      out.push({ user_id:user.id, operator_code:op, work_date:dates[i], segment_no:1, status:"other", raw_text:cell, start_time:null, end_time:null, shift:null });
    }
  }

  return { dates, rows: out };
}

function openImpModal(){ $("impOverlay").style.display = "flex"; }
function closeImpModal(){ $("impOverlay").style.display = "none"; }

async function parseImportPaste() {
  const tsv = $("impPaste").value;
  const { dates, rows } = parseScheduleTSV(tsv);
  importPreviewRows = rows;

  if (dates.length) {
    selectedWeekStart = getWeekStart(dates[0]);
    setWeekLabel();
  }

  $("btnSaveImp").disabled = importPreviewRows.length === 0;
  log(`Import preview rows: ${importPreviewRows.length}`);
}

async function parseImportXlsx(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const tsv = XLSX.utils.sheet_to_csv(ws, { FS: "\t" });
  $("impPaste").value = tsv;
  await parseImportPaste();
}

async function saveImportRows() {
  if (importPreviewRows.length === 0) return;

  const { error } = await supabase
    .from("resource_schedule_segments")
    .upsert(importPreviewRows, { onConflict: "user_id,operator_code,work_date,segment_no" });

  if (error) { log("❌ save import:", error.message); return; }

  importPreviewRows = [];
  $("btnSaveImp").disabled = true;
  closeImpModal();

  await reloadWeek();
}

// ---------- reload flows ----------
async function recalcSupporti() {
  const rows = computeSupportiTable(selectedWeekStart);
  renderSupportiTable(rows);
  renderSupportSegmentsTable();
  renderKpi(rows);
}

async function reloadWeek() {
  await Promise.all([
    loadWeekSchedule(selectedWeekStart),
    loadWeekEvents(selectedWeekStart),
    loadSupportSegments(selectedWeekStart),
  ]);

  // sync schedule->resources (solo non override)
  await syncWeekShiftsToResources();
  await loadResources(); // ricarico per riflettere sync su current_week_shift

  setWeekLabel();
  renderResourcesTable();
  renderWeekTable(selectedWeekStart);
  await recalcSupporti();
}

async function reloadAll() {
  await loadResources();
  await reloadWeek();
}

// ---------- init ----------
(async function init() {
  try {
    user = await ensureAnon();
    log("✅ user:", user.id);

    $("btnReset").addEventListener("click", resetSession);

    const today = new Date().toISOString().slice(0,10);
    selectedWeekStart = getWeekStart(today);
    setWeekLabel();

    // schedule week arrows
    $("btnPrevWeek").addEventListener("click", async () => {
      selectedWeekStart = addDays(selectedWeekStart, -7);
      await reloadWeek();
    });
    $("btnNextWeek").addEventListener("click", async () => {
      selectedWeekStart = addDays(selectedWeekStart, 7);
      await reloadWeek();
    });

    // resources group filter
    $("resGroup").addEventListener("change", renderResourcesTable);

    // resource modal
    $("btnAddRes").addEventListener("click", () => openResModal(null));
    $("btnCloseRes").addEventListener("click", closeResModal);
    $("btnSaveRes").addEventListener("click", saveResource);

    // support modal
    $("btnCloseSup").addEventListener("click", closeSupportModal);
    $("supKind").addEventListener("change", showHideSupportFields);
    $("btnSaveSupSeg").addEventListener("click", saveSupportSegment);

    // import modal
    $("btnOpenImport").addEventListener("click", openImpModal);
    $("btnCloseImp").addEventListener("click", closeImpModal);
    $("btnParseImp").addEventListener("click", parseImportPaste);
    $("btnSaveImp").addEventListener("click", saveImportRows);
    $("impFile").addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      await parseImportXlsx(f);
    });

    // Supporti panel recalc (se hai ancora il bottone)
    if ($("btnReloadSupporti")) {
      $("btnReloadSupporti").addEventListener("click", reloadWeek);
    }

    await reloadAll();
  } catch (e) {
    log("❌ init:", e?.message ?? String(e));
    setAuthUI(false, "AUTH ERROR", "-");
  }
})();
