import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://wndlmkjhzgqdwsfylvmh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sf8tAbDNmRLtCGu9xsesSQ_JWmIyQHI";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const $ = (id) => document.getElementById(id);
const logEl = $("log");

let user = null;

let resources = [];
let aliases = [];
let accountsFound = [];

let editingResId = null;
let editingAliasId = null;

let schedulePreview = []; // rows ready to upsert

function log(...args) {
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function normalizeCode(s) {
  return String(s ?? "").trim().toUpperCase();
}

function setAuthUI(ok, statusText, userId) {
  $("authStatus").textContent = statusText;
  $("userId").textContent = userId ?? "-";
  const dot = $("authDot");
  dot.classList.remove("ok","bad");
  dot.classList.add(ok ? "ok" : "bad");
}

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

// ---------------------- Loaders ----------------------
async function loadResources() {
  const { data, error } = await supabase
    .from("resources")
    .select("*")
    .order("role", { ascending: true })
    .order("operator_code", { ascending: true });

  if (error) throw error;
  resources = (data ?? []).map(r => ({ ...r, operator_code: normalizeCode(r.operator_code) }));
}

async function loadAliases() {
  const { data, error } = await supabase
    .from("resource_aliases")
    .select("*")
    .order("alias_code", { ascending: true });

  if (error) throw error;
  aliases = (data ?? []).map(a => ({
    ...a,
    alias_code: normalizeCode(a.alias_code),
    canonical_code: normalizeCode(a.canonical_code),
  }));
}

async function loadAccountsFound() {
  // NB: view v_all_operator_accounts non ha RLS, ma legge da v_operator_events_effective (già usata in overview)
  // paginazione simple
  const PAGE = 1000;
  let from = 0;
  let all = [];
  while (true) {
    const { data, error } = await supabase
      .from("v_all_operator_accounts")
      .select("account")
      .range(from, from + PAGE - 1);
    if (error) throw error;

    const batch = (data ?? []).map(x => normalizeCode(x.account)).filter(Boolean);
    all = all.concat(batch);

    if (batch.length < PAGE) break;
    from += PAGE;
    if (from > 50000) break;
  }
  accountsFound = Array.from(new Set(all)).sort();
}

// ---------------------- Render helpers ----------------------
function roleLabel(r) {
  if (r === "counter") return "Counter";
  if (r === "specialist") return "Specialist";
  if (r === "support") return "Supporto";
  if (r === "teamleader") return "Teamleader";
  return r;
}

function renderResources() {
  const roleFilter = $("roleFilter").value;
  const q = normalizeCode($("qFilter").value);

  const tb = $("tblResources").querySelector("tbody");
  tb.innerHTML = "";

  const rows = resources.filter(r => {
    if (roleFilter && r.role !== roleFilter) return false;
    if (q && !normalizeCode(r.operator_code).includes(q) && !normalizeCode(r.display_name).includes(q)) return false;
    return true;
  });

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono"><span class="link" data-edit="${r.id}">${r.operator_code}</span></td>
      <td>${roleLabel(r.role)}</td>
      <td>${r.active ? "✅" : "—"}</td>
      <td>${r.support_dept ?? ""}</td>
      <td>${r.default_shift ?? ""}</td>
      <td>${r.default_resource_used ?? ""}</td>
      <td>
        <button class="btn" data-edit="${r.id}">Edit</button>
        <button class="btn danger" data-del="${r.id}">Del</button>
      </td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => editResource(btn.getAttribute("data-edit")));
  });

  tb.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => deleteResource(btn.getAttribute("data-del")));
  });
}

function renderAliases() {
  const tb = $("tblAliases").querySelector("tbody");
  tb.innerHTML = "";

  for (const a of aliases) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono"><span class="link" data-edit="${a.id}">${a.alias_code}</span></td>
      <td class="mono">${a.canonical_code}</td>
      <td>${a.note ?? ""}</td>
      <td>
        <button class="btn" data-edit="${a.id}">Edit</button>
        <button class="btn danger" data-del="${a.id}">Del</button>
      </td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => editAlias(btn.getAttribute("data-edit")));
  });
  tb.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => deleteAlias(btn.getAttribute("data-del")));
  });
}

function isKnownResource(code) {
  return resources.some(r => normalizeCode(r.operator_code) === normalizeCode(code));
}
function isKnownAlias(code) {
  return aliases.some(a => normalizeCode(a.alias_code) === normalizeCode(code));
}

function renderAccountsFound() {
  const tb = $("tblAccounts").querySelector("tbody");
  tb.innerHTML = "";

  for (const acc of accountsFound) {
    const knownRes = isKnownResource(acc);
    const knownAlias = isKnownAlias(acc);

    let status = "NEW";
    if (knownRes) status = "IN RESOURCES";
    else if (knownAlias) status = "IN ALIASES";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${acc}</td>
      <td>${status}</td>
      <td>
        <button class="btn" data-addres="${acc}">+ Risorsa</button>
        <button class="btn" data-addalias="${acc}">+ Alias</button>
      </td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-addres]").forEach(btn => {
    btn.addEventListener("click", () => {
      clearResForm();
      $("resCode").value = btn.getAttribute("data-addres");
      $("resRole").value = "support"; // default
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  tb.querySelectorAll("[data-addalias]").forEach(btn => {
    btn.addEventListener("click", () => {
      clearAliasForm();
      $("alAlias").value = btn.getAttribute("data-addalias");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

async function reloadAll() {
  await Promise.all([loadResources(), loadAliases(), loadAccountsFound()]);
  renderResources();
  renderAliases();
  renderAccountsFound();
}

// ---------------------- Resource CRUD ----------------------
function clearResForm() {
  editingResId = null;
  $("resCode").value = "";
  $("resRole").value = "counter";
  $("resName").value = "";
  $("resDept").value = "";
  $("resShift").value = "";
  $("resUsed").value = "";
  $("resActive").checked = true;
  $("resNotes").value = "";
}

function editResource(id) {
  const r = resources.find(x => x.id === id);
  if (!r) return;
  editingResId = id;

  $("resCode").value = r.operator_code ?? "";
  $("resRole").value = r.role ?? "counter";
  $("resName").value = r.display_name ?? "";
  $("resDept").value = r.support_dept ?? "";
  $("resShift").value = r.default_shift ?? "";
  $("resUsed").value = r.default_resource_used ?? "";
  $("resActive").checked = !!r.active;
  $("resNotes").value = r.notes ?? "";
}

async function saveResource() {
  const operator_code = normalizeCode($("resCode").value);
  if (!operator_code) { log("⚠️ operator_code richiesto"); return; }

  const payload = {
    user_id: user.id,
    operator_code,
    display_name: $("resName").value.trim() || operator_code,
    role: $("resRole").value,
    active: $("resActive").checked,
    support_dept: $("resDept").value || null,
    default_shift: $("resShift").value || null,
    default_resource_used: $("resUsed").value.trim() || null,
    notes: $("resNotes").value.trim() || null
  };

  if (editingResId) payload.id = editingResId;

  const { error } = await supabase
    .from("resources")
    .upsert(payload, { onConflict: "user_id,operator_code" });

  if (error) { log("❌ saveResource:", error.message); return; }

  clearResForm();
  await reloadAll();
  log("✅ Risorsa salvata");
}

async function deleteResource(id) {
  const r = resources.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`Eliminare risorsa ${r.operator_code}?`)) return;

  const { error } = await supabase.from("resources").delete().eq("id", id);
  if (error) { log("❌ deleteResource:", error.message); return; }
  await reloadAll();
  log("✅ Risorsa eliminata");
}

// ---------------------- Alias CRUD ----------------------
function clearAliasForm() {
  editingAliasId = null;
  $("alAlias").value = "";
  $("alCanon").value = "";
  $("alNote").value = "";
}

function editAlias(id) {
  const a = aliases.find(x => x.id === id);
  if (!a) return;
  editingAliasId = id;

  $("alAlias").value = a.alias_code ?? "";
  $("alCanon").value = a.canonical_code ?? "";
  $("alNote").value = a.note ?? "";
}

async function saveAlias() {
  const alias_code = normalizeCode($("alAlias").value);
  const canonical_code = normalizeCode($("alCanon").value);
  if (!alias_code || !canonical_code) { log("⚠️ alias + canonico richiesti"); return; }

  const payload = {
    user_id: user.id,
    alias_code,
    canonical_code,
    note: $("alNote").value.trim() || null
  };

  if (editingAliasId) payload.id = editingAliasId;

  const { error } = await supabase
    .from("resource_aliases")
    .upsert(payload, { onConflict: "user_id,alias_code" });

  if (error) { log("❌ saveAlias:", error.message); return; }

  clearAliasForm();
  await reloadAll();
  log("✅ Alias salvato");
}

async function deleteAlias(id) {
  const a = aliases.find(x => x.id === id);
  if (!a) return;
  if (!confirm(`Eliminare alias ${a.alias_code} -> ${a.canonical_code}?`)) return;

  const { error } = await supabase.from("resource_aliases").delete().eq("id", id);
  if (error) { log("❌ deleteAlias:", error.message); return; }
  await reloadAll();
  log("✅ Alias eliminato");
}

// ---------------------- Seed defaults ----------------------
async function seedDefaults() {
  const { data, error } = await supabase.rpc("seed_default_resources");
  if (error) { log("❌ seed:", error.message); return; }
  log("✅ seed:", data);
  await reloadAll();
}

// ---------------------- Schedule parsing (paste / xlsx) ----------------------
function parseDateToken(tok) {
  // supports: 26-1-2026, 26/1/2026, 26-01-2026
  const t = String(tok ?? "").trim();
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  const dd = m[1].padStart(2,"0");
  const mm = m[2].padStart(2,"0");
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

function parseTimeRange(cell) {
  // matches: 05:00-13:00 (with optional spaces)
  const t = String(cell ?? "").trim();
  const m = t.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (!m) return null;
  const start = m[1].padStart(5,"0");
  const end = m[2].padStart(5,"0");
  return { start, end };
}

function inferShift(startTime) {
  if (!startTime) return null;
  const s = startTime.slice(0,5);
  if (s.startsWith("05:")) return "AM";
  if (s.startsWith("08:") || s.startsWith("09:")) return "C";
  if (s.startsWith("14:")) return "OM";
  return null;
}

function resolveCanonical(code) {
  const c = normalizeCode(code);
  const a = aliases.find(x => normalizeCode(x.alias_code) === c);
  return a ? normalizeCode(a.canonical_code) : c;
}

function parseScheduleTSV(tsv) {
  const lines = String(tsv ?? "")
    .split(/\r?\n/)
    .map(l => l.replace(/\u00A0/g, " "))
    .filter(l => l.trim().length > 0);

  const grid = lines.map(l => l.split("\t"));
  if (grid.length < 3) return { dates: [], rows: [], preview: [] };

  // Find the row containing dates: at least 3 date tokens
  let dateRow = -1;
  for (let r = 0; r < grid.length; r++) {
    const parsed = grid[r].map(parseDateToken).filter(Boolean);
    if (parsed.length >= 3) { dateRow = r; break; }
  }
  if (dateRow === -1) return { dates: [], rows: [], preview: [] };

  // Determine dateStartCol and list of dates contiguous
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

  // Skip possible weekday row (dateRow+1)
  let dataStartRow = dateRow + 1;
  if (grid[dataStartRow]) {
    const hasWeekday = grid[dataStartRow].some(x => /mon|tue|wed|thu|fri|sat|sun/i.test(String(x)));
    if (hasWeekday) dataStartRow++;
  }

  const preview = [];

  for (let r = dataStartRow; r < grid.length; r++) {
    const line = grid[r];
    const opRaw = String(line[0] ?? "").trim();
    if (!opRaw) continue;

    const op = normalizeCode(opRaw);
    // second col may be E/A (macro group hint) but optional
    const groupHint = normalizeCode(line[1] ?? "");

    // ignore totally blank “extra rows” where operator cell is something like W05
    if (op.startsWith("W") && op.length <= 5) continue;

    for (let i = 0; i < dates.length; i++) {
      const cell = String(line[startCol + i] ?? "").trim();
      if (!cell) continue; // off => non salva

      const lower = cell.toLowerCase();
      if (lower.includes("ferie")) {
        preview.push({
          operator_code: resolveCanonical(op),
          original_code: op,
          work_date: dates[i],
          segment_no: 1,
          status: "vacation",
          start_time: null,
          end_time: null,
          shift: null,
          raw_text: cell
        });
        continue;
      }

      const tr = parseTimeRange(cell);
      if (tr) {
        preview.push({
          operator_code: resolveCanonical(op),
          original_code: op,
          work_date: dates[i],
          segment_no: 1,
          status: "present",
          start_time: tr.start,
          end_time: tr.end,
          shift: inferShift(tr.start),
          raw_text: cell,
          group_hint: groupHint
        });
        continue;
      }

      // fallback: mark as "other"
      preview.push({
        operator_code: resolveCanonical(op),
        original_code: op,
        work_date: dates[i],
        segment_no: 1,
        status: "other",
        start_time: null,
        end_time: null,
        shift: null,
        raw_text: cell,
        group_hint: groupHint
      });
    }
  }

  return { dates, preview };
}

function fillImportDatesFromParsed(dates) {
  if (!dates || dates.length === 0) return;
  $("impFrom").value = dates[0];
  $("impTo").value = dates[dates.length - 1];
}

async function parseFromPaste() {
  const tsv = $("pasteBox").value;
  const { dates, preview } = parseScheduleTSV(tsv);

  schedulePreview = preview;
  $("btnSaveSchedule").disabled = schedulePreview.length === 0;

  if (dates.length) fillImportDatesFromParsed(dates);

  log(`Preview rows: ${schedulePreview.length}`);
  // Quick log sample
  log(schedulePreview.slice(0, 5));
}

async function parseFromXlsx(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // convert to TSV-like
  const tsv = XLSX.utils.sheet_to_csv(ws, { FS: "\t" });
  $("pasteBox").value = tsv;
  await parseFromPaste();
}

// ---------------------- Schedule save/view/edit ----------------------
function resourceByCode(code) {
  const c = normalizeCode(code);
  return resources.find(r => normalizeCode(r.operator_code) === c) || null;
}

async function saveSchedulePreview() {
  if (schedulePreview.length === 0) return;

  // Enrich support default fields (dept/used/shift) when status present and missing
  const rows = schedulePreview.map(p => {
    const r = resourceByCode(p.operator_code);
    const isSupport = r?.role === "support";

    return {
      user_id: user.id,
      operator_code: p.operator_code,
      work_date: p.work_date,
      segment_no: p.segment_no,
      status: p.status,
      start_time: p.start_time,
      end_time: p.end_time,
      shift: p.shift || (isSupport ? r.default_shift : null),
      support_dept: isSupport ? (r.support_dept ?? null) : null,
      used_resource: isSupport ? (r.default_resource_used ?? null) : null,
      raw_text: p.raw_text ?? null
    };
  });

  const { error } = await supabase
    .from("resource_schedule_segments")
    .upsert(rows, { onConflict: "user_id,operator_code,work_date,segment_no" });

  if (error) { log("❌ save schedule:", error.message); return; }

  log(`✅ saved schedule rows: ${rows.length}`);
  await loadScheduleViewer();
}

async function loadScheduleViewer() {
  const from = $("viewFrom").value;
  const to = $("viewTo").value;
  if (!from || !to) { log("⚠️ Set viewFrom/viewTo"); return; }

  const { data, error } = await supabase
    .from("resource_schedule_segments")
    .select("*")
    .gte("work_date", from)
    .lte("work_date", to)
    .order("work_date", { ascending: true })
    .order("operator_code", { ascending: true })
    .order("segment_no", { ascending: true });

  if (error) { log("❌ load schedule:", error.message); return; }

  const tb = $("tblSchedule").querySelector("tbody");
  tb.innerHTML = "";

  for (const s of (data ?? [])) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${s.operator_code}</td>
      <td class="mono">${s.work_date}</td>
      <td class="mono">${s.segment_no}</td>
      <td>${s.status}</td>
      <td class="mono">${s.start_time ?? ""}</td>
      <td class="mono">${s.end_time ?? ""}</td>
      <td>${s.shift ?? ""}</td>
      <td>${s.support_dept ?? ""}</td>
      <td>${s.used_resource ?? ""}</td>
      <td>
        <button class="btn" data-edit="${s.id}">Edit</button>
        <button class="btn danger" data-del="${s.id}">Del</button>
      </td>
    `;
    tb.appendChild(tr);
  }

  tb.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      if (!confirm("Eliminare segmento schedule?")) return;
      await supabase.from("resource_schedule_segments").delete().eq("id", id);
      await loadScheduleViewer();
    });
  });

  tb.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-edit");
      const seg = (data ?? []).find(x => x.id === id);
      if (!seg) return;

      // inline edit minimale via prompt
      const status = prompt("status (present/vacation/absent/other):", seg.status) || seg.status;
      let start_time = seg.start_time, end_time = seg.end_time;
      if (status === "present") {
        start_time = prompt("start_time (HH:MM):", seg.start_time ?? "08:30") || seg.start_time;
        end_time = prompt("end_time (HH:MM):", seg.end_time ?? "16:30") || seg.end_time;
      } else {
        start_time = null; end_time = null;
      }

      const { error } = await supabase
        .from("resource_schedule_segments")
        .update({
          status,
          start_time,
          end_time,
          shift: (status === "present" ? inferShift(start_time) : null),
        })
        .eq("id", id);

      if (error) log("❌ update schedule:", error.message);
      await loadScheduleViewer();
    });
  });

  log(`Loaded schedule segments: ${(data ?? []).length}`);
}

// ---------------------- Init ----------------------
(async function init() {
  try {
    user = await ensureAnon();
    log("✅ user:", user.id);

    // default viewer range: last 7 days
    const now = new Date();
    const to = now.toISOString().slice(0,10);
    const fromD = new Date(now);
    fromD.setDate(fromD.getDate() - 6);
    const from = fromD.toISOString().slice(0,10);

    $("viewFrom").value = from;
    $("viewTo").value = to;

    $("btnReset").addEventListener("click", resetSession);
    $("btnSeed").addEventListener("click", seedDefaults);

    $("btnSaveRes").addEventListener("click", saveResource);
    $("btnClearRes").addEventListener("click", () => { clearResForm(); });
    $("roleFilter").addEventListener("change", renderResources);
    $("qFilter").addEventListener("input", renderResources);

    $("btnSaveAlias").addEventListener("click", saveAlias);
    $("btnClearAlias").addEventListener("click", clearAliasForm);
    $("btnClearAliasForm").addEventListener("click", clearAliasForm);

    $("btnReloadAccounts").addEventListener("click", async () => {
      await loadAccountsFound();
      renderAccountsFound();
      log("✅ accounts reloaded");
    });

    $("btnParse").addEventListener("click", parseFromPaste);
    $("btnSaveSchedule").addEventListener("click", saveSchedulePreview);

    $("xlsxFile").addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      await parseFromXlsx(f);
    });

    $("btnLoadSchedule").addEventListener("click", loadScheduleViewer);

    clearResForm();
    clearAliasForm();

    await reloadAll();
    await loadScheduleViewer();
  } catch (e) {
    log("❌ init:", e?.message ?? String(e));
    setAuthUI(false, "AUTH ERROR", "-");
  }
})();
