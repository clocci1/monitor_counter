import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://wndlmkjhzgqdwsfylvmh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sf8tAbDNmRLtCGu9xsesSQ_JWmIyQHI";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ---------------------------
// UI helpers
// ---------------------------
const $ = (id) => document.getElementById(id);
const logEl = $("log");

function log(...args) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(isBusy, msg = "") {
  $("btnImportAll").disabled = isBusy;
  $("btnImportPI").disabled = isBusy;
  $("btnImportWT").disabled = isBusy;
  $("btnPreview").disabled = isBusy;
  $("btnSignOut").disabled = isBusy;
  $("btnClearPI").disabled = isBusy;
  $("btnClearWT").disabled = isBusy;
  $("filePI").disabled = isBusy;
  $("fileWT").disabled = isBusy;
  $("busyLabel").textContent = msg;
}

function setAuthUI(ok, statusText, userId) {
  $("authStatus").textContent = statusText;
  $("userId").textContent = userId ?? "-";
  const dot = $("authDot");
  dot.classList.remove("ok", "bad");
  dot.classList.add(ok ? "ok" : "bad");
}

// ---------------------------
// Selected files state (multi-file)
// ---------------------------
let selectedPI = [];
let selectedWT = [];

function humanFileSize(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function renderFileList(kind) {
  const listEl = kind === "PI" ? $("listPI") : $("listWT");
  const arr = kind === "PI" ? selectedPI : selectedWT;

  listEl.innerHTML = "";

  if (arr.length === 0) return;

  arr.forEach((f, idx) => {
    const li = document.createElement("li");
    li.className = "fileItem";

    li.innerHTML = `
      <div class="fileLeft">
        <div class="fileName">${escapeHtml(f.name)}</div>
        <div class="fileMeta">${humanFileSize(f.size)}</div>
      </div>
      <button class="btn danger" data-kind="${kind}" data-idx="${idx}">Rimuovi</button>
    `;

    listEl.appendChild(li);
  });

  // bind remove buttons
  listEl.querySelectorAll("button[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.getAttribute("data-kind");
      const i = Number(btn.getAttribute("data-idx"));
      if (k === "PI") selectedPI.splice(i, 1);
      else selectedWT.splice(i, 1);
      renderFileList(k);
    });
  });
}

function addFiles(kind, files) {
  const incoming = Array.from(files || []);
  if (incoming.length === 0) return;

  // Evita doppioni nello "staging" UI (stesso name+size)
  const key = (f) => `${f.name}__${f.size}`;
  const existing = new Set((kind === "PI" ? selectedPI : selectedWT).map(key));

  const merged = incoming.filter((f) => !existing.has(key(f)));

  if (kind === "PI") selectedPI = selectedPI.concat(merged);
  else selectedWT = selectedWT.concat(merged);

  renderFileList(kind);
}

function clearFiles(kind) {
  if (kind === "PI") selectedPI = [];
  else selectedWT = [];
  renderFileList(kind);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------------------------
// Auth: email/password session
// ---------------------------
async function requireSession() {
  setAuthUI(false, "checking session...", "-");
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;

  const user = data?.session?.user;
  if (!user) {
    setAuthUI(false, "signed-out", "-");
    const next = encodeURIComponent("index.html");
    location.href = `./login.html?next=${next}`;
    throw new Error("No session");
  }

  setAuthUI(true, "signed-in", user.email ?? user.id);
  return user;
}

async function signOut() {
  setBusy(true, "sign-out...");
  const { error } = await supabase.auth.signOut();
  if (error) log("❌ signOut error:", error.message);
  else log("✅ signed out");
  setAuthUI(false, "signed-out", "-");
  setBusy(false, "");
  location.href = "./login.html?next=index.html";
}

async function signOut() {
  setBusy(true, "reset session...");
  const { error } = await supabase.auth.signOut();
  if (error) log("❌ signOut error:", error.message);
  else log("✅ signed out");
  setAuthUI(false, "signed-out", "-");
  setBusy(false, "");
}

// ---------------------------
// Excel parsing (SheetJS)
// ---------------------------
function normHeader(h) {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.]/g, "")
    .replace(/[^a-z0-9 ]/g, "");
}

function normalizeText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function normalizeKey(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  return s === "" ? null : s;
}

function pad2(n) {
  const x = Number(n);
  return x < 10 ? `0${x}` : String(x);
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function toISOTime(d) {
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${hh}:${mm}:${ss}`;
}

function parseExcelDate(value) {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date && !isNaN(value.getTime())) {
    return toISODate(value);
  }

  if (typeof value === "number") {
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    const dt = new Date(d.y, d.m - 1, d.d);
    return toISODate(dt);
  }

  const s = String(value).trim();
  const m1 = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m1) {
    const dd = pad2(m1[1]);
    const mm = pad2(m1[2]);
    const yyyy = m1[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  const m2 = s.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
  if (m2) {
    const yyyy = m2[1];
    const mm = pad2(m2[2]);
    const dd = pad2(m2[3]);
    return `${yyyy}-${mm}-${dd}`;
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return toISODate(parsed);

  return null;
}

function parseExcelTime(value) {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date && !isNaN(value.getTime())) {
    return toISOTime(value);
  }

  if (typeof value === "number") {
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    return `${pad2(d.H)}:${pad2(d.M)}:${pad2(d.S)}`;
  }

  const s = String(value).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    return `${pad2(m[1])}:${pad2(m[2])}:${pad2(m[3] ?? "00")}`;
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return toISOTime(parsed);

  return null;
}

async function readExcelRows(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

function buildHeaderIndex(rowObj) {
  const map = new Map();
  for (const k of Object.keys(rowObj || {})) {
    map.set(normHeader(k), k);
  }
  return map;
}

function pickField(row, headerIndex, wanted) {
  for (const w of wanted) {
    const original = headerIndex.get(w);
    if (original !== undefined) return row[original];
  }
  return null;
}

// ---------------------------
// PI mapper
// ---------------------------
function mapPI(rows, userId, batchId) {
  if (!rows.length) return [];
  const headerIndex = buildHeaderIndex(rows[0]);

  const out = [];
  for (const r of rows) {
    const warehouseOrder = normalizeKey(pickField(r, headerIndex, ["warehouse order"]));
    const storageBin = normalizeKey(pickField(r, headerIndex, ["storage bin"]));
    if (!warehouseOrder || !storageBin) continue;

    const countDate = parseExcelDate(pickField(r, headerIndex, ["count date"]));
    const countTime = parseExcelTime(pickField(r, headerIndex, ["count time"]));
    if (!countDate || !countTime) continue;

    const status = normalizeText(
      pickField(r, headerIndex, ["physiscal inventory status", "physical inventory status"])
    );

    const counter = normalizeText(pickField(r, headerIndex, ["counter"]));
    const createdBy = normalizeText(pickField(r, headerIndex, ["created by"]));

    out.push({
      user_id: userId,
      batch_id: batchId,
      warehouse_order: warehouseOrder,
      storage_bin: storageBin,
      physical_inventory_status: status,
      count_date: countDate,
      count_time: countTime,
      counter,
      created_by: createdBy,
      raw: r,
    });
  }

  out.sort((a, b) => Date.parse(`${a.count_date}T${a.count_time}`) - Date.parse(`${b.count_date}T${b.count_time}`));
  return out;
}

// ---------------------------
// WT mapper
// ---------------------------
function mapWT(rows, userId, batchId) {
  if (!rows.length) return [];
  const headerIndex = buildHeaderIndex(rows[0]);

  const out = [];
  for (const r of rows) {
    const warehouseOrder = normalizeKey(pickField(r, headerIndex, ["warehouse order"]));
    const procType = normalizeText(pickField(r, headerIndex, ["whse proc type"]));
    const sourceBin = normalizeKey(pickField(r, headerIndex, ["source storage bin"]));

    if (!warehouseOrder || !sourceBin || !procType) continue;

    const confDate = parseExcelDate(pickField(r, headerIndex, ["confirmation date"]));
    const confTime = parseExcelTime(pickField(r, headerIndex, ["confirmation time"]));
    if (!confDate || !confTime) continue;

    const createdBy = normalizeText(pickField(r, headerIndex, ["created by"]));
    const confirmedBy = normalizeText(pickField(r, headerIndex, ["confirmed by"]));
    const destBin = normalizeText(pickField(r, headerIndex, ["original dest bin"]));

    out.push({
      user_id: userId,
      batch_id: batchId,
      warehouse_order: warehouseOrder,
      whse_proc_type: String(procType).trim(),
      created_by: createdBy,
      confirmation_date: confDate,
      confirmation_time: confTime,
      confirmed_by: confirmedBy,
      source_storage_bin: sourceBin,
      original_dest_bin: destBin,
      raw: r,
    });
  }

  out.sort((a, b) => Date.parse(`${a.confirmation_date}T${a.confirmation_time}`) - Date.parse(`${b.confirmation_date}T${b.confirmation_time}`));
  return out;
}

// ---------------------------
// Supabase upload + insert + upsert
// ---------------------------
function safeFilename(name) {
  return String(name)
    .replaceAll(" ", "_")
    .replaceAll(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 70);
}

async function uploadToStorage(file, userId, batchId, sourceTag) {
  const ext = file.name.toLowerCase().endsWith(".xls") ? "xls" : "xlsx";
  const path = `${userId}/${batchId}/${sourceTag}__${safeFilename(file.name)}.${ext}`;

  const { error } = await supabase.storage
    .from("uploads")
    .upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });

  if (error) throw error;
  return { bucket: "uploads", path };
}

async function insertBatch(batchId, userId, source, originalFilename, storageBucket, storagePath, rowCount) {
  const { error } = await supabase
    .from("import_batches")
    .insert({
      id: batchId,
      user_id: userId,
      source,
      original_filename: originalFilename,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      row_count: rowCount,
    });

  if (error) throw error;
}

async function upsertChunked(tableName, rows, onConflict) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from(tableName)
      .upsert(chunk, { onConflict, ignoreDuplicates: true });
    if (error) throw error;
  }
}

// ---------------------------
// Import per singolo file (batch per file)
// ---------------------------
async function importSinglePI(file, user) {
  const batchId = crypto.randomUUID();
  log(`\n=== PI import | ${file.name} | batch ${batchId} ===`);

  const excelRows = await readExcelRows(file);
  const mapped = mapPI(excelRows, user.id, batchId);

  log(`Excel rows: ${excelRows.length} | Valid rows: ${mapped.length}`);

  const up = await uploadToStorage(file, user.id, batchId, "PI");
  await insertBatch(batchId, user.id, "PI", file.name, up.bucket, up.path, mapped.length);

  await upsertChunked("pi_rows", mapped, "user_id,warehouse_order_key,storage_bin_key");
  log("✅ PI upsert OK (dedupe attiva)");
}

async function importSingleWT(file, user) {
  const batchId = crypto.randomUUID();
  log(`\n=== WT import | ${file.name} | batch ${batchId} ===`);

  const excelRows = await readExcelRows(file);
  const mapped = mapWT(excelRows, user.id, batchId);

  log(`Excel rows: ${excelRows.length} | Valid rows: ${mapped.length}`);

  const up = await uploadToStorage(file, user.id, batchId, "WT");
  await insertBatch(batchId, user.id, "WT", file.name, up.bucket, up.path, mapped.length);

  await upsertChunked("wt_rows", mapped, "user_id,warehouse_order_key,source_storage_bin_key");
  log("✅ WT upsert OK (dedupe attiva)");
}

// ---------------------------
// Preview events
// ---------------------------
async function loadPreview() {
  const tbody = $("previewTable").querySelector("tbody");
  tbody.innerHTML = "";

  const { data, error } = await supabase
    .from("v_operator_events")
    .select("source,event_dt,operator_code,warehouse_order,bin_from,bin_to,category")
    .order("event_dt", { ascending: false })
    .limit(50);

  if (error) {
    log("❌ Preview error:", error.message);
    return;
  }

  for (const r of data) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.source ?? "")}</td>
      <td>${escapeHtml(r.event_dt ?? "")}</td>
      <td>${escapeHtml(r.operator_code ?? "")}</td>
      <td>${escapeHtml(r.warehouse_order ?? "")}</td>
      <td>${escapeHtml(r.bin_from ?? "")}</td>
      <td>${escapeHtml(r.bin_to ?? "")}</td>
      <td>${escapeHtml(r.category ?? "")}</td>
    `;
    tbody.appendChild(tr);
  }

  log(`✅ Preview loaded: ${data.length} rows`);
}

// ---------------------------
// Drag & drop
// ---------------------------
function setupDropzone(kind, dzEl) {
  const add = (files) => addFiles(kind, files);

  dzEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    dzEl.classList.add("dragover");
  });

  dzEl.addEventListener("dragleave", () => {
    dzEl.classList.remove("dragover");
  });

  dzEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dzEl.classList.remove("dragover");
    if (e.dataTransfer?.files?.length) add(e.dataTransfer.files);
  });
}

// ---------------------------
// Init + wiring
// ---------------------------
(async function init() {
  log("Init...");

  try {
    const user = await requireSession();
    log("✅ Session ready:", user.id);

    // Multi-select inputs
    $("filePI").addEventListener("change", (e) => addFiles("PI", e.target.files));
    $("fileWT").addEventListener("change", (e) => addFiles("WT", e.target.files));

    // Clear buttons
    $("btnClearPI").addEventListener("click", () => clearFiles("PI"));
    $("btnClearWT").addEventListener("click", () => clearFiles("WT"));

    // Dropzones
    setupDropzone("PI", $("dzPI"));
    setupDropzone("WT", $("dzWT"));

    // Import actions
    $("btnImportAll").addEventListener("click", async () => {
      if (selectedPI.length === 0 && selectedWT.length === 0) {
        log("⚠️ Seleziona almeno un file PI o WT.");
        return;
      }

      setBusy(true, "Import in corso...");
      try {
        for (const f of selectedPI) await importSinglePI(f, user);
        for (const f of selectedWT) await importSingleWT(f, user);
        await loadPreview();
      } catch (e) {
        log("❌ Import error:", e?.message ?? String(e));
      } finally {
        setBusy(false, "");
      }
    });

    $("btnImportPI").addEventListener("click", async () => {
      if (selectedPI.length === 0) return log("⚠️ Seleziona almeno un file PI.");
      setBusy(true, "Import PI in corso...");
      try {
        for (const f of selectedPI) await importSinglePI(f, user);
        await loadPreview();
      } catch (e) {
        log("❌ PI import error:", e?.message ?? String(e));
      } finally {
        setBusy(false, "");
      }
    });

    $("btnImportWT").addEventListener("click", async () => {
      if (selectedWT.length === 0) return log("⚠️ Seleziona almeno un file WT.");
      setBusy(true, "Import WT in corso...");
      try {
        for (const f of selectedWT) await importSingleWT(f, user);
        await loadPreview();
      } catch (e) {
        log("❌ WT import error:", e?.message ?? String(e));
      } finally {
        setBusy(false, "");
      }
    });

    $("btnPreview").addEventListener("click", async () => {
      setBusy(true, "Caricamento preview...");
      try {
        await loadPreview();
      } finally {
        setBusy(false, "");
      }
    });

    $("btnSignOut").addEventListener("click", signOut);

    // First preview
    await loadPreview();
  } catch (e) {
    log("❌ init failed:", e?.message ?? String(e));
    setAuthUI(false, "AUTH ERROR", "-");
  }
})();
