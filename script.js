import { createClient } from "https://esm.sh/@supabase/supabase-js@2";


/**
 * CONFIG
 * NB: publishable key OK lato client.
 */
const SUPABASE_URL = "https://wndlmkjhzgqdwsfylvmh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sf8tAbDNmRLtCGu9xsesSQ_JWmIyQHI";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ---------------------------
// UI helpers
// ---------------------------
const $ = (id) => document.getElementById(id);
const logEl = $("log");
const authStatusEl = $("authStatus");
const userIdEl = $("userId");
const busyLabelEl = $("busyLabel");

function log(...args) {
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(isBusy, msg = "") {
  $("btnImport").disabled = isBusy;
  $("btnImportPI").disabled = isBusy;
  $("btnImportWT").disabled = isBusy;
  $("btnPreview").disabled = isBusy;
  $("btnSignOut").disabled = isBusy;
  busyLabelEl.textContent = msg;
}

// ---------------------------
// Auth: anonymous sign-in
// ---------------------------
async function ensureAnonymousSession() {
  authStatusEl.textContent = "checking session...";
  const { data: s } = await supabase.auth.getSession();

  if (s?.session?.user) {
    authStatusEl.textContent = "signed-in";
    userIdEl.textContent = s.session.user.id;
    return s.session.user;
  }

  authStatusEl.textContent = "signing in anonymously...";
  const { data, error } = await supabase.auth.signInAnonymously();

  if (error) {
    authStatusEl.textContent = "ERROR";
    log("❌ Anonymous sign-in failed:", error.message);
    log("Suggerimento: abilita Anonymous Sign-ins in Authentication settings.");
    throw error;
  }

  authStatusEl.textContent = "signed-in (anon)";
  userIdEl.textContent = data.user?.id ?? "-";
  log("✅ Anonymous session created:", data.user?.id);
  return data.user;
}

async function signOut() {
  setBusy(true, "signing out...");
  const { error } = await supabase.auth.signOut();
  if (error) log("❌ signOut error:", error.message);
  else log("✅ signed out");
  authStatusEl.textContent = "signed-out";
  userIdEl.textContent = "-";
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
  return String(v).trim();
}

function normalizeKey(v) {
  // per ridurre refusi: trim + upper
  if (v === null || v === undefined) return null;
  return String(v).trim().toUpperCase();
}

function pad2(n) {
  const x = Number(n);
  return x < 10 ? `0${x}` : String(x);
}

function toISODate(d) {
  // d: Date
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function toISOTime(d) {
  // d: Date
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${hh}:${mm}:${ss}`;
}

function parseExcelDate(value) {
  // ritorna YYYY-MM-DD oppure null
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date && !isNaN(value.getTime())) {
    return toISODate(value);
  }

  if (typeof value === "number") {
    // Excel serial -> parse_date_code
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    const dt = new Date(d.y, d.m - 1, d.d);
    return toISODate(dt);
  }

  // stringa: prova dd/mm/yyyy o yyyy-mm-dd ecc.
  const s = String(value).trim();
  const m1 = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); // dd/mm/yyyy
  if (m1) {
    const dd = pad2(m1[1]);
    const mm = pad2(m1[2]);
    const yyyy = m1[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  const m2 = s.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/); // yyyy-mm-dd
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
  // ritorna HH:MM:SS oppure null
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date && !isNaN(value.getTime())) {
    return toISOTime(value);
  }

  if (typeof value === "number") {
    // Excel time fraction
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    const hh = pad2(d.H);
    const mm = pad2(d.M);
    const ss = pad2(d.S);
    return `${hh}:${mm}:${ss}`;
  }

  const s = String(value).trim();
  // hh:mm o hh:mm:ss
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const hh = pad2(m[1]);
    const mm = pad2(m[2]);
    const ss = pad2(m[3] ?? "00");
    return `${hh}:${mm}:${ss}`;
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return toISOTime(parsed);

  return null;
}

async function readExcelRows(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  return rows;
}

function buildHeaderIndex(rowObj) {
  // crea una mappa headerNormalizzato -> headerOriginale
  const map = new Map();
  for (const k of Object.keys(rowObj || {})) {
    map.set(normHeader(k), k);
  }
  return map;
}

function pickField(row, headerIndex, wanted) {
  // wanted: array di alias normalizzati
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

    const status =
      normalizeText(pickField(r, headerIndex, ["physiscal inventory status", "physical inventory status"]));

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

  // sort temporale
  out.sort((a, b) => {
    const ta = Date.parse(`${a.count_date}T${a.count_time}`);
    const tb = Date.parse(`${b.count_date}T${b.count_time}`);
    return ta - tb;
  });

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
    const procType = normalizeText(pickField(r, headerIndex, ["whse proc type", "whse proc type "]))?.trim();

    const sourceBin = normalizeKey(pickField(r, headerIndex, ["source storage bin"]));

    if (!warehouseOrder || !sourceBin || !procType) continue;

    const confDate = parseExcelDate(pickField(r, headerIndex, ["confirmation date"]));
    const confTime = parseExcelTime(pickField(r, headerIndex, ["confirmation time"]));
    if (!confDate || !confTime) continue;

    const createdBy = normalizeText(pickField(r, headerIndex, ["created by"]));
    const confirmedBy = normalizeText(pickField(r, headerIndex, ["confirmed by"]));

    const destBin = normalizeText(pickField(r, headerIndex, ["original dest bin", "original dest bin "]));

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

  out.sort((a, b) => {
    const ta = Date.parse(`${a.confirmation_date}T${a.confirmation_time}`);
    const tb = Date.parse(`${b.confirmation_date}T${b.confirmation_time}`);
    return ta - tb;
  });

  return out;
}

// ---------------------------
// Supabase upload + insert
// ---------------------------
async function uploadToStorage(file, userId, batchId, sourceTag) {
  const ext = file.name.toLowerCase().endsWith(".xls") ? "xls" : "xlsx";
  const path = `${userId}/${batchId}/${sourceTag}.${ext}`;

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
  let total = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);

    const { error } = await supabase
      .from(tableName)
      .upsert(chunk, { onConflict, ignoreDuplicates: true });

    if (error) throw error;
    total += chunk.length;
  }

  return total;
}

async function importPI(file, user) {
  const batchId = crypto.randomUUID();
  log(`\n=== PI import | batch ${batchId} ===`);
  log("Reading Excel...");

  const excelRows = await readExcelRows(file);
  log(`Excel rows: ${excelRows.length}`);

  const mapped = mapPI(excelRows, user.id, batchId);
  log(`Mapped rows (valid): ${mapped.length}`);

  log("Uploading file to Storage...");
  const up = await uploadToStorage(file, user.id, batchId, "PI");
  log("Storage path:", up.path);

  log("Inserting import_batches...");
  await insertBatch(batchId, user.id, "PI", file.name, up.bucket, up.path, mapped.length);

  log("Upserting pi_rows (dedupe by user_id + warehouse_order_key + storage_bin_key)...");
  const insertedApprox = await upsertChunked("pi_rows", mapped, "user_id,warehouse_order_key,storage_bin_key");
  log(`Upsert done. Rows processed: ${insertedApprox}`);
}

async function importWT(file, user) {
  const batchId = crypto.randomUUID();
  log(`\n=== WT import | batch ${batchId} ===`);
  log("Reading Excel...");

  const excelRows = await readExcelRows(file);
  log(`Excel rows: ${excelRows.length}`);

  const mapped = mapWT(excelRows, user.id, batchId);
  log(`Mapped rows (valid): ${mapped.length}`);

  log("Uploading file to Storage...");
  const up = await uploadToStorage(file, user.id, batchId, "WT");
  log("Storage path:", up.path);

  log("Inserting import_batches...");
  await insertBatch(batchId, user.id, "WT", file.name, up.bucket, up.path, mapped.length);

  log("Upserting wt_rows (dedupe by user_id + warehouse_order_key + source_storage_bin_key)...");
  const insertedApprox = await upsertChunked("wt_rows", mapped, "user_id,warehouse_order_key,source_storage_bin_key");
  log(`Upsert done. Rows processed: ${insertedApprox}`);
}

// ---------------------------
// Preview events
// ---------------------------
async function loadPreview(user) {
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
      <td>${r.source ?? ""}</td>
      <td>${r.event_dt ?? ""}</td>
      <td>${r.operator_code ?? ""}</td>
      <td>${r.warehouse_order ?? ""}</td>
      <td>${r.bin_from ?? ""}</td>
      <td>${r.bin_to ?? ""}</td>
      <td>${r.category ?? ""}</td>
    `;
    tbody.appendChild(tr);
  }

  log(`✅ Preview loaded: ${data.length} rows`);
}

// ---------------------------
// Wire UI
// ---------------------------
(async function init() {
  log("Init...");
  try {
    const user = await ensureAnonymousSession();
    log("Ready.");

    $("btnImport").addEventListener("click", async () => {
      const filePI = $("filePI").files?.[0] ?? null;
      const fileWT = $("fileWT").files?.[0] ?? null;

      if (!filePI && !fileWT) {
        log("⚠️ Seleziona almeno un file (PI o WT).");
        return;
      }

      setBusy(true, "importing...");
      try {
        if (filePI) await importPI(filePI, user);
        if (fileWT) await importWT(fileWT, user);
        await loadPreview(user);
      } catch (e) {
        log("❌ Import error:", e?.message ?? String(e));
      } finally {
        setBusy(false, "");
      }
    });

    $("btnImportPI").addEventListener("click", async () => {
      const filePI = $("filePI").files?.[0] ?? null;
      if (!filePI) return log("⚠️ Seleziona un file PI.");
      setBusy(true, "importing PI...");
      try {
        await importPI(filePI, user);
        await loadPreview(user);
      } catch (e) {
        log("❌ PI import error:", e?.message ?? String(e));
      } finally {
        setBusy(false, "");
      }
    });

    $("btnImportWT").addEventListener("click", async () => {
      const fileWT = $("fileWT").files?.[0] ?? null;
      if (!fileWT) return log("⚠️ Seleziona un file WT.");
      setBusy(true, "importing WT...");
      try {
        await importWT(fileWT, user);
        await loadPreview(user);
      } catch (e) {
        log("❌ WT import error:", e?.message ?? String(e));
      } finally {
        setBusy(false, "");
      }
    });

    $("btnPreview").addEventListener("click", async () => {
      setBusy(true, "loading preview...");
      try {
        await loadPreview(user);
      } finally {
        setBusy(false, "");
      }
    });

    $("btnSignOut").addEventListener("click", signOut);

  } catch (e) {
    log("❌ init failed:", e?.message ?? String(e));
  }
})();
