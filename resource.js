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

function isoDate(d){
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,"0");
  const day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function weekStart(d){
  const x=new Date(d);
  const day=(x.getDay()+6)%7; // monday=0
  x.setDate(x.getDate()-day);
  x.setHours(0,0,0,0);
  return x;
}
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function fmtWeekLabel(ws){ return `${isoDate(ws)} → ${isoDate(addDays(ws,6))}`; }
function minutesToHHMM(mins){
  const m=Math.max(0, Math.round(mins));
  const hh=Math.floor(m/60);
  const mm=m%60;
  return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
}

let currentWeek = weekStart(new Date());
let resources = [];
let schedule = [];
let supportSegs = [];
let lastActMap = new Map();
let weekEvents = []; // effective events for week (base account)

async function loadResources(){
  const { data, error } = await supabase
    .from("resources")
    .select("id,operator_code,operator_norm,role,active,display_name")
    .order("role", { ascending:true })
    .order("operator_code", { ascending:true });
  if(error) throw error;
  resources = data ?? [];
}

async function loadSchedule(){
  const from = isoDate(currentWeek);
  const to = isoDate(addDays(currentWeek,6));
  const { data, error } = await supabase
    .from("resource_schedule_segments")
    .select("id,operator_code,operator_norm,work_date,shift,status,start_time,end_time,note")
    .gte("work_date", from)
    .lte("work_date", to);
  if(error) throw error;
  schedule = data ?? [];
}

async function loadSupportSegments(){
  const from = isoDate(currentWeek) + "T00:00:00";
  const to = isoDate(addDays(currentWeek,6)) + "T23:59:59";
  const { data, error } = await supabase
    .from("support_work_segments")
    .select("id,account_used,kind,real_name,start_dt,end_dt,note")
    .gte("start_dt", from)
    .lte("start_dt", to)
    .order("start_dt", { ascending:true });
  if(error) throw error;
  supportSegs = data ?? [];
}

async function loadLastActivity(){
  const { data, error } = await supabase
    .from("v_account_last_activity")
    .select("operator_code,last_activity");
  if(error) throw error;
  lastActMap = new Map((data ?? []).map(r => [r.operator_code, r.last_activity]));
}

async function loadWeekEvents(){
  const from = isoDate(currentWeek) + "T00:00:00";
  const to = isoDate(addDays(currentWeek,6)) + "T23:59:59";
  const { data, error } = await supabase
    .from("v_operator_events_effective")
    .select("event_dt,operator_base,category")
    .gte("event_dt", from)
    .lte("event_dt", to)
    .order("operator_base", { ascending:true })
    .order("event_dt", { ascending:true })
    .limit(20000);
  if(error) throw error;
  weekEvents = data ?? [];
}

async function loadAccountsIntoSelect(){
  const sel = $("supAccount");
  if(!sel) return;
  sel.innerHTML="";
  const { data, error } = await supabase
    .from("v_all_operator_accounts")
    .select("operator_code")
    .order("operator_code");
  if(error){ log("⚠️ accounts:", error.message); return; }
  for(const r of data ?? []){
    const opt=document.createElement("option");
    opt.value=r.operator_code;
    opt.textContent=r.operator_code;
    sel.appendChild(opt);
  }
}

// ---------- Rendering helpers ----------
function getSchedRows(opNorm){
  return schedule.filter(s => s.operator_norm===opNorm);
}
function computeWeekShift(opNorm){
  const rows = getSchedRows(opNorm).filter(r => r.shift);
  if(!rows.length) return "";
  const freq = new Map();
  for(const r of rows){
    const k = r.shift;
    freq.set(k, (freq.get(k)||0)+1);
  }
  let best=""; let bestN=0;
  for(const [k,n] of freq.entries()){
    if(n>bestN){ best=k; bestN=n; }
  }
  return best;
}
function getLastAct(opNorm){
  // last activity view stores operator_code as operator_base (canonical norm). We use opNorm as already canonical.
  return lastActMap.get(opNorm) || "";
}

function renderResources(){
  const tbody = $("tblRes")?.querySelector("tbody");
  if(!tbody) return;
  tbody.innerHTML="";
  for(const r of resources.filter(x=>x.active)){
    const tr=document.createElement("tr");
    // WORKER column: show account
    const tdWorker=document.createElement("td");
    tdWorker.textContent = r.operator_code;
    tr.appendChild(tdWorker);

    const tdRole=document.createElement("td");
    tdRole.textContent = r.role;
    tr.appendChild(tdRole);

    const tdShift=document.createElement("td");
    tdShift.textContent = computeWeekShift(r.operator_norm);
    tr.appendChild(tdShift);

    const tdLast=document.createElement("td");
    tdLast.textContent = getLastAct(r.operator_norm);
    tr.appendChild(tdLast);

    const tdMng=document.createElement("td");
    const btn=document.createElement("button");
    btn.className="btn small";
    btn.textContent="Modifica";
    btn.onclick=()=>openResModal(r);
    tdMng.appendChild(btn);
    tr.appendChild(tdMng);

    tbody.appendChild(tr);
  }
}

function getSched(opNorm, dateStr){
  return schedule.find(s => s.operator_norm===opNorm && s.work_date===dateStr);
}

function renderSchedule(){
  const table = $("tblWeek");
  const tbody = table?.querySelector("tbody");
  const thead = table?.querySelector("thead");
  if(!tbody || !thead) return;

  const days=[0,1,2,3,4,5,6].map(i=>addDays(currentWeek,i));
  thead.innerHTML="";
  const hr=document.createElement("tr");
  hr.innerHTML = "<th>Risorsa</th>" + days.map(d=>`<th>${isoDate(d)}</th>`).join("");
  thead.appendChild(hr);

  tbody.innerHTML="";
  for(const r of resources.filter(x=>x.active)){
    const tr=document.createElement("tr");
    const td0=document.createElement("td");
    td0.textContent = r.operator_code;
    tr.appendChild(td0);

    for(const d of days){
      const dateStr=isoDate(d);
      const td=document.createElement("td");
      const sel=document.createElement("select");
      sel.className="cellSelect";
      const opts=["","AM","C","PM","OFF"];
      for(const o of opts){
        const op=document.createElement("option");
        op.value=o; op.textContent=o===""?"—":o;
        sel.appendChild(op);
      }
      const existing = getSched(r.operator_norm, dateStr);
      if(existing?.status==="other" && existing?.note==="OFF") sel.value="OFF";
      else sel.value = existing?.shift || "";
      sel.dataset.op = r.operator_code;
      sel.dataset.opnorm = r.operator_norm;
      sel.dataset.date = dateStr;
      td.appendChild(sel);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // support panel week indicator is a date input; set to Monday
  if($("supWeek")) $("supWeek").value = isoDate(currentWeek);
}

async function saveSchedule(){
  const selects = Array.from(document.querySelectorAll("#tblWeek select.cellSelect"));
  const rows=[];
  for(const sel of selects){
    const shift = sel.value;
    const operator_code=sel.dataset.op;
    const operator_norm=sel.dataset.opnorm;
    const work_date=sel.dataset.date;

    if(shift==="") continue;

    if(shift==="OFF"){
      rows.push({ operator_code, operator_norm, work_date, status:"other", shift:null, start_time:null, end_time:null, note:"OFF" });
    }else{
      let start="05:00:00", end="13:00:00";
      if(shift==="C"){ start="08:00:00"; end="16:00:00"; }
      if(shift==="PM"){ start="14:00:00"; end="22:00:00"; }
      rows.push({ operator_code, operator_norm, work_date, status:"present", shift, start_time:start, end_time:end, note:null });
    }
  }
  if(rows.length){
    const { error } = await supabase
      .from("resource_schedule_segments")
      .upsert(rows, { onConflict:"workspace_id,operator_norm,work_date" });
    if(error) throw error;
  }
  await loadSchedule();
  renderSchedule();
  renderResources();
  log("✅ Schedule salvato.");
}

function renderSupportSegments(){
  const tbody = $("tblSupportSeg")?.querySelector("tbody");
  if(!tbody) return;
  tbody.innerHTML="";
  for(const s of supportSegs){
    const tr=document.createElement("tr");
    const cells=[s.account_used, s.kind, s.start_dt, s.end_dt, s.real_name||""];
    for(const c of cells){
      const td=document.createElement("td");
      td.textContent = c ?? "";
      tr.appendChild(td);
    }
    const td=document.createElement("td");
    const del=document.createElement("button");
    del.className="btn small danger";
    del.textContent="Del";
    del.onclick=async ()=>{
      const ok=confirm("Eliminare segmento?");
      if(!ok) return;
      const { error } = await supabase.from("support_work_segments").delete().eq("id", s.id);
      if(error) return log("❌ delete:", error.message);
      await loadSupportSegments();
      renderSupportSegments();
      await reloadSupportiTable(); // refresh time-over
    };
    td.appendChild(del);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  $("kpiSegments").textContent = String(supportSegs.length);
}

function computeExpectedMinutesForAccount(opNorm){
  // expected = sum shift minutes - 30 min pause per present day
  const rows = getSchedRows(opNorm);
  let expected = 0;
  for(const r of rows){
    if(r.status !== "present") continue;
    if(!r.start_time || !r.end_time) continue;
    // times are strings 'HH:MM:SS'
    const [sh,sm] = String(r.start_time).split(":").map(Number);
    const [eh,em] = String(r.end_time).split(":").map(Number);
    const dur = (eh*60+em) - (sh*60+sm);
    if(dur>0) expected += Math.max(0, dur - 30);
  }
  return expected;
}

function computeActualMinutesForAccount(baseAccountNorm){
  const events = weekEvents.filter(e => e.operator_base === baseAccountNorm);
  if(events.length < 2) return 0;
  let actual = 0;
  for(let i=0;i<events.length-1;i++){
    const t1 = new Date(events[i].event_dt).getTime();
    const t2 = new Date(events[i+1].event_dt).getTime();
    const delta = (t2-t1)/60000;
    if(delta > 30) continue; // pause
    if(delta > 0) actual += delta;
  }
  return actual;
}

async function reloadSupportiTable(){
  const tbody = $("tblSupporti")?.querySelector("tbody");
  if(!tbody) return;
  tbody.innerHTML="";

  // accounts observed in week events
  const accSet = new Set(weekEvents.map(e => e.operator_base).filter(Boolean));
  // include guaranteed resources even if no events
  for(const r of resources.filter(x=>x.active)) accSet.add(r.operator_norm);

  const rows=[];
  for(const acc of accSet){
    const actual = computeActualMinutesForAccount(acc);
    const expected = computeExpectedMinutesForAccount(acc);
    const over = actual - expected;
    if(over <= 0) continue;
    rows.push({ acc, over });
  }
  rows.sort((a,b)=>b.over-a.over);

  for(const r of rows){
    const tr=document.createElement("tr");
    const tdAcc=document.createElement("td");
    tdAcc.textContent = r.acc;
    tr.appendChild(tdAcc);

    const tdOver=document.createElement("td");
    tdOver.textContent = minutesToHHMM(r.over);
    tr.appendChild(tdOver);

    const tdAct=document.createElement("td");
    const btn=document.createElement("button");
    btn.className="btn small";
    btn.textContent="Set supporto";
    btn.onclick=()=>openSupModal({ account_used:r.acc, kind:"support" });
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  }

  $("kpiOver").textContent = String(rows.length);
}

let editingResId=null;
function openResModal(r){
  editingResId = r?.id ?? null;
  $("resTitle").textContent = editingResId ? "Modifica risorsa" : "Aggiungi risorsa";
  $("resCode").value = r?.operator_code ?? "";
  $("resRole").value = r?.role ?? "COUNTER";
  $("resGroup").value = r?.display_name ?? "";
  $("resOverlay").style.display="flex";
}
function closeResModal(){ $("resOverlay").style.display="none"; editingResId=null; }

async function saveResModal(){
  const operator_code = $("resCode").value.trim();
  if(!operator_code){ alert("Inserisci account"); return; }
  const role = ($("resRole").value || "COUNTER").toUpperCase();
  const display_name = $("resGroup").value.trim() || null;
  const operator_norm = canon(operator_code);

  const payload = { operator_code, operator_norm, role, display_name, active:true };
  const { error } = await supabase.from("resources").upsert(payload, { onConflict:"workspace_id,operator_norm" });
  if(error) throw error;

  await loadResources();
  renderResources();
  renderSchedule();
  await loadAccountsIntoSelect();
  closeResModal();
}

let editingSupId=null;
function openSupModal(seg){
  editingSupId = seg?.id ?? null;
  $("supTitle").textContent = editingSupId ? "Modifica supporto" : "Aggiungi supporto";
  $("supKind").value = seg?.kind ?? "support";
  $("supAccount").value = seg?.account_used ?? "";
  $("supReal").value = seg?.real_name ?? "";
  $("supNote").value = seg?.note ?? "";

  // infer day from segment or currentWeek monday
  const day = seg?.start_dt ? String(seg.start_dt).slice(0,10) : isoDate(currentWeek);
  $("supDay").value = day;
  $("supStart").value = seg?.start_dt ? String(seg.start_dt).slice(11,16) : "08:00";
  $("supEnd").value = seg?.end_dt ? String(seg.end_dt).slice(11,16) : "12:00";
  toggleSupFields();
  $("supOverlay").style.display="flex";
}
function closeSupModal(){ $("supOverlay").style.display="none"; editingSupId=null; }

function toggleSupFields(){
  const kind = $("supKind").value;
  $("supRealWrap").style.display = (kind==="support") ? "" : "none";
}

async function saveSupModal(){
  const kind = $("supKind").value;
  const account_used = $("supAccount").value.trim();
  if(!account_used){ alert("Seleziona account"); return; }
  const real = $("supReal").value.trim();
  if(kind==="support" && !real){ alert("Inserisci nome reale (es. Hassan)"); return; }
  const day = $("supDay").value;
  const start = $("supStart").value;
  const end = $("supEnd").value;
  const start_dt = `${day}T${start}:00`;
  const end_dt = `${day}T${end}:00`;

  const payload = {
    kind,
    account_used,
    account_used_norm: canon(account_used),
    real_name: kind==="support" ? real : null,
    real_name_norm: kind==="support" ? canon(real) : "",
    note: $("supNote").value.trim() || null,
    start_dt,
    end_dt
  };

  let res;
  if(editingSupId){
    res = await supabase.from("support_work_segments").update(payload).eq("id", editingSupId);
  }else{
    res = await supabase.from("support_work_segments").insert(payload);
  }
  if(res.error) throw res.error;

  await loadSupportSegments();
  renderSupportSegments();
  await reloadSupportiTable();
  closeSupModal();
}

function wire(){
  $("btnPrevWeek")?.addEventListener("click", async ()=>{ currentWeek = addDays(currentWeek,-7); await reloadAll(); });
  $("btnNextWeek")?.addEventListener("click", async ()=>{ currentWeek = addDays(currentWeek, 7); await reloadAll(); });

  $("supWeek")?.addEventListener("change", async ()=>{
    const v = $("supWeek").value;
    if(!v) return;
    currentWeek = weekStart(new Date(v+"T00:00:00"));
    await reloadAll();
  });

  $("btnAddRes")?.addEventListener("click", ()=>openResModal(null));
  $("btnCloseRes")?.addEventListener("click", closeResModal);
  $("btnSaveRes")?.addEventListener("click", async ()=>{ try{ await saveResModal(); }catch(e){ log("❌ save resource:", e.message||e); } });

  // schedule save button is btnSaveImp in this UI
  $("btnSaveImp")?.addEventListener("click", async ()=>{ try{ await saveSchedule(); }catch(e){ log("❌ save schedule:", e.message||e); } });

  // support modal
  $("btnCloseSup")?.addEventListener("click", closeSupModal);
  $("btnSaveSupSeg")?.addEventListener("click", async ()=>{ try{ await saveSupModal(); }catch(e){ log("❌ save segment:", e.message||e); } });
  $("supKind")?.addEventListener("change", toggleSupFields);

  $("btnReloadSupporti")?.addEventListener("click", async ()=>{ await reloadAll(); });
  $("btnReset")?.addEventListener("click", ()=>{ logEl.textContent=""; });
}

async function reloadAll(){
  try{
    await loadResources();
    await loadSchedule();
    await loadSupportSegments();
    await loadLastActivity();
    await loadWeekEvents();
    renderResources();
    renderSchedule();
    renderSupportSegments();
    await loadAccountsIntoSelect();
    await reloadSupportiTable();

    $("kpiGuaranteed").textContent = String(resources.filter(r=>r.active).length);
    $("kpiCounters").textContent = String(resources.filter(r=>r.role==="COUNTER" && r.active).length);
    $("kpiSpecialist").textContent = String(resources.filter(r=>r.role==="SPECIALIST" && r.active).length);
  }catch(e){
    log("❌ init:", e.message||e);
    console.error(e);
  }
}

wire();
reloadAll();
