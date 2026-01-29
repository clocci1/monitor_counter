import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://wndlmkjhzgqdwsfylvmh.supabase.co";
const SUPABASE_KEY = "sb_publishable_sf8tAbDNmRLtCGu9xsesSQ_JWmIyQHI";
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (id) => document.getElementById(id);
const canon = (s) => (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, "");

const logEl = $("log");
function log(...args){
  console.log(...args);
  if(!logEl) return;
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function safeFilename(name){
  return name.replace(/[^a-zA-Z0-9._-]/g,"_");
}

async function uploadToStorage(file, batchId, tag){
  try{
    const ext = file.name.toLowerCase().endsWith(".xls") ? "xls" : "xlsx";
    const path = `${batchId}/${tag}__${safeFilename(file.name)}.${ext}`;
    const { error } = await supabase.storage.from("uploads").upload(path, file, {
      upsert: false,
      contentType: file.type || "application/octet-stream"
    });
    if(error) throw error;
    return { bucket:"uploads", path };
  }catch(e){
    log("⚠️ Storage upload skipped:", e?.message || e);
    return { bucket:null, path:null };
  }
}

async function createBatch(source, file, storageMeta){
  const payload = {
    source,
    file_name: file.name,
    storage_bucket: storageMeta.bucket,
    storage_path: storageMeta.path,
    rows_inserted: 0
  };
  const { data, error } = await supabase.from("import_batches").insert(payload).select("id").single();
  if(error) throw error;
  return data.id;
}

function parseExcel(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try{
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type:"array", cellDates:true });
        const sheetName = wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
        resolve(rows);
      }catch(err){
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function toDateOnly(v){
  if(!v) return null;
  if(v instanceof Date){
    const y=v.getFullYear();
    const m=String(v.getMonth()+1).padStart(2,"0");
    const d=String(v.getDate()).padStart(2,"0");
    return `${y}-${m}-${d}`;
  }
  const s=String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if(m) return m[1];
  return s;
}
function toTimeOnly(v){
  if(!v) return null;
  if(v instanceof Date){
    const hh=String(v.getHours()).padStart(2,"0");
    const mm=String(v.getMinutes()).padStart(2,"0");
    const ss=String(v.getSeconds()).padStart(2,"0");
    return `${hh}:${mm}:${ss}`;
  }
  const s=String(v).trim();
  const m=s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if(m){
    const hh=String(m[1]).padStart(2,"0");
    const mm=m[2];
    const ss=String(m[3]||"00").padStart(2,"0");
    return `${hh}:${mm}:${ss}`;
  }
  return s;
}
function pick(obj, keys){
  for(const k of keys){
    if(obj[k] !== undefined) return obj[k];
  }
  return null;
}

function mapPI(rawRows, importBatchId){
  const out=[];
  for(const r of rawRows){
    const wo = pick(r, ["Warehouse Order","WarehouseOrder","WAREHOUSE ORDER"]);
    const bin = pick(r, ["Storage Bin","StorageBin","STORAGE BIN"]);
    if(!wo || !bin) continue;
    out.push({
      import_batch_id: importBatchId,
      warehouse_order: String(wo).trim(),
      storage_bin: String(bin).trim(),
      physical_inventory_status: pick(r, ["Physiscal Inventory Status","Physical Inventory Status","PI Status"]),
      count_date: toDateOnly(pick(r, ["Count Date","CountDate"])),
      count_time: toTimeOnly(pick(r, ["Count Time","CountTime"])),
      counter: pick(r, ["Counter"]),
      created_by: pick(r, ["Created By","CreatedBy"])
    });
  }
  return out;
}

function mapWT(rawRows, importBatchId){
  const out=[];
  for(const r of rawRows){
    const wo = pick(r, ["Warehouse Order","WarehouseOrder","WAREHOUSE ORDER"]);
    const srcBin = pick(r, ["Source Storage Bin","SourceStorageBin","SOURCE STORAGE BIN"]);
    if(!wo || !srcBin) continue;
    out.push({
      import_batch_id: importBatchId,
      warehouse_order: String(wo).trim(),
      whse_proc_type: pick(r, ["Whse Proc. Type","Whse Proc Type","WhseProcType"]),
      created_by: pick(r, ["Created By","CreatedBy"]),
      confirmation_date: toDateOnly(pick(r, ["Confirmation Date","ConfirmationDate"])),
      confirmation_time: toTimeOnly(pick(r, ["Confirmation Time","ConfirmationTime"])),
      confirmed_by: pick(r, ["Confirmed By","ConfirmedBy"]),
      source_storage_bin: String(srcBin).trim(),
      original_dest_bin: pick(r, ["Original Dest. Bin","Original Dest Bin","OriginalDestBin"])
    });
  }
  return out;
}

async function upsertRows(table, rows, onConflict){
  if(!rows.length) return 0;
  const chunkSize=500;
  for(let i=0;i<rows.length;i+=chunkSize){
    const chunk=rows.slice(i,i+chunkSize);
    const { error } = await supabase.from(table).upsert(chunk, {
      onConflict,
      ignoreDuplicates: true
    });
    if(error) throw error;
  }
  return rows.length;
}

async function refreshPreview(){
  const tbody = $("previewTable")?.querySelector("tbody");
  if(tbody) tbody.innerHTML = "";
  const { data, error } = await supabase
    .from("v_operator_events")
    .select("source,event_dt,operator_code,warehouse_order,bin_from,bin_to,category")
    .order("event_dt", { ascending:false })
    .limit(50);
  if(error){
    log("❌ Preview error:", error.message);
    return;
  }
  if(!tbody) return;
  for(const r of data){
    const tr=document.createElement("tr");
    const cells=[
      r.source,
      r.event_dt,
      r.operator_code,
      r.warehouse_order,
      r.bin_from||"",
      r.bin_to||"",
      r.category||""
    ];
    for(const c of cells){
      const td=document.createElement("td");
      td.textContent=c ?? "";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

async function importFile(file, source){
  const storageMeta = await uploadToStorage(file, crypto.randomUUID?.() || String(Date.now()), source);
  const batchId = await createBatch(source, file, storageMeta);
  log(`✅ Batch ${source} created: ${batchId}`);

  const raw = await parseExcel(file);
  log(`📄 ${file.name}: ${raw.length} rows`);

  if(source==="PI"){
    const mapped = mapPI(raw, batchId);
    log(`➡️ PI mapped: ${mapped.length}`);
    await upsertRows("pi_rows", mapped, "workspace_id,warehouse_order_key,storage_bin_key");
  }else{
    const mapped = mapWT(raw, batchId);
    log(`➡️ WT mapped: ${mapped.length}`);
    await upsertRows("wt_rows", mapped, "workspace_id,warehouse_order_key,source_storage_bin_key");
  }
}

let piFiles=[];
let wtFiles=[];

function renderFileList(listEl, files){
  if(!listEl) return;
  listEl.innerHTML="";
  for(const f of files){
    const li=document.createElement("li");
    li.textContent = `${f.name} (${Math.round(f.size/1024)} KB)`;
    listEl.appendChild(li);
  }
}

function addFiles(arr, newFiles){
  for(const f of Array.from(newFiles||[])){
    if(!arr.find(x=>x.name===f.name && x.size===f.size && x.lastModified===f.lastModified)){
      arr.push(f);
    }
  }
}

function wireDropZone(zoneEl, onFiles){
  if(!zoneEl) return;
  zoneEl.addEventListener("dragover", (e)=>{ e.preventDefault(); zoneEl.classList.add("drag"); });
  zoneEl.addEventListener("dragleave", ()=>zoneEl.classList.remove("drag"));
  zoneEl.addEventListener("drop", (e)=>{
    e.preventDefault();
    zoneEl.classList.remove("drag");
    const files = e.dataTransfer?.files;
    if(files?.length) onFiles(files);
  });
}

function setBusy(b){
  const lbl=$("busyLabel");
  if(lbl) lbl.textContent = b ? "Working…" : "";
  document.body.classList.toggle("busy", !!b);
}

async function runImport(source){
  try{
    setBusy(true);
    const files = source==="PI" ? piFiles : wtFiles;
    if(!files.length){ log(`⚠️ Nessun file ${source}`); return; }
    for(const f of files){
      log("—");
      log(`Import ${source}: ${f.name}`);
      await importFile(f, source);
    }
    log(`✅ Done ${source}`);
    await refreshPreview();
  }catch(e){
    log("❌ Import failed:", e?.message || e);
    console.error(e);
  }finally{
    setBusy(false);
  }
}

async function runImportAll(){
  await runImport("PI");
  await runImport("WT");
}

function wire(){
  const inpPI=$("filePI");
  const inpWT=$("fileWT");
  inpPI?.addEventListener("change", ()=>{
    addFiles(piFiles, inpPI.files);
    renderFileList($("listPI"), piFiles);
  });
  inpWT?.addEventListener("change", ()=>{
    addFiles(wtFiles, inpWT.files);
    renderFileList($("listWT"), wtFiles);
  });

  wireDropZone($("dzPI"), (files)=>{ addFiles(piFiles, files); renderFileList($("listPI"), piFiles); });
  wireDropZone($("dzWT"), (files)=>{ addFiles(wtFiles, files); renderFileList($("listWT"), wtFiles); });

  $("btnClearPI")?.addEventListener("click", ()=>{ piFiles=[]; if(inpPI) inpPI.value=""; renderFileList($("listPI"), piFiles); });
  $("btnClearWT")?.addEventListener("click", ()=>{ wtFiles=[]; if(inpWT) inpWT.value=""; renderFileList($("listWT"), wtFiles); });

  $("btnImportPI")?.addEventListener("click", ()=>runImport("PI"));
  $("btnImportWT")?.addEventListener("click", ()=>runImport("WT"));
  $("btnImportAll")?.addEventListener("click", ()=>runImportAll());
  $("btnPreview")?.addEventListener("click", refreshPreview);

  $("btnSignOut")?.addEventListener("click", ()=>{ /* login later */ });

  refreshPreview().catch(()=>{});
}

wire();
