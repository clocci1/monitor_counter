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
function minutesToHHMM(mins){
  const m=Math.max(0, Math.round(mins));
  const hh=Math.floor(m/60);
  const mm=m%60;
  return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
}

async function fetchEvents(fromDate, toDate){
  const from = `${fromDate}T00:00:00`;
  const to = `${toDate}T23:59:59`;
  const { data, error } = await supabase
    .from("v_operator_events_effective")
    .select("event_dt,source,category,warehouse_order,bin_from,bin_to,created_by,counter,confirmed_by,operator_code,operator_base,operator_code_effective")
    .gte("event_dt", from)
    .lte("event_dt", to)
    .order("operator_code_effective", { ascending:true })
    .order("event_dt", { ascending:true })
    .limit(20000);
  if(error) throw error;
  return data ?? [];
}

function computeKpi(events){
  const byOp=new Map();
  for(const e of events){
    const op = e.operator_code_effective || e.operator_code || "UNKNOWN";
    if(!byOp.has(op)) byOp.set(op, []);
    byOp.get(op).push(e);
  }

  const results=[];
  for(const [op, arr] of byOp.entries()){
    arr.sort((a,b)=>new Date(a.event_dt)-new Date(b.event_dt));
    const time = { PICK:0, BULK:0, P2P:0, CLP:0, PAUSE:0 };
    const counts = { PICK:0, BULK:0, P2P:0, CLP:0 };

    for(let i=0;i<arr.length;i++){
      const cur=arr[i];
      const cat = cur.category || "";
      if(cat==="PI_PICK"){ counts.PICK++; }
      else if(cat==="PI_BULK"){ counts.BULK++; }
      else if(cat==="WT_P2P"){ counts.P2P++; }
      else if(cat==="WT_CLP"){ counts.CLP++; }

      const tCur = new Date(cur.event_dt).getTime();
      const tNext = i < arr.length-1 ? new Date(arr[i+1].event_dt).getTime() : null;
      if(!tNext) continue;

      const deltaMin = (tNext - tCur) / 60000;
      if(deltaMin > 30){
        time.PAUSE += deltaMin;
        continue;
      }
      if(cat==="PI_PICK") time.PICK += deltaMin;
      else if(cat==="PI_BULK") time.BULK += deltaMin;
      else if(cat==="WT_P2P") time.P2P += deltaMin;
      else if(cat==="WT_CLP" || cat==="WT_IPL") time.CLP += deltaMin;
    }
    const total = time.PICK + time.BULK + time.P2P + time.CLP;
    results.push({ operator: op, baseAccount: arr[0]?.operator_code || op, total, time, counts });
  }

  results.sort((a,b)=>b.total-a.total);
  return results;
}

function renderSummary(kpis){
  const tbody = $("tblSummary")?.querySelector("tbody");
  if(!tbody) return;
  tbody.innerHTML="";

  for(const k of kpis){
    const tr=document.createElement("tr");

    // Support button (opens modal, prefill account = baseAccount)
    const tdBtn=document.createElement("td");
    const btn=document.createElement("button");
    btn.className="btn small";
    btn.textContent="+";
    btn.onclick=()=>openSupportModal(k.baseAccount);
    tdBtn.appendChild(btn);
    tr.appendChild(tdBtn);

    const cells=[
      k.operator,
      minutesToHHMM(k.total),
      minutesToHHMM(k.time.PICK),
      minutesToHHMM(k.time.BULK),
      minutesToHHMM(k.time.P2P),
      minutesToHHMM(k.time.CLP),
      minutesToHHMM(k.time.PAUSE)
    ];
    for(const c of cells){
      const td=document.createElement("td");
      td.textContent=c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

async function loadSupportRanges(account){
  const from = `${$("fromDate").value}T00:00:00`;
  const to = `${$("toDate").value}T23:59:59`;
  const { data, error } = await supabase
    .from("support_work_segments")
    .select("id,account_used,real_name,start_dt,end_dt,kind")
    .eq("kind","support")
    .eq("account_used_norm", canon(account))
    .gte("start_dt", from)
    .lte("start_dt", to)
    .order("start_dt", { ascending:true });
  if(error) throw error;
  return data ?? [];
}

async function renderSupportRanges(account){
  const tbody = $("tblSupportRanges")?.querySelector("tbody");
  if(!tbody) return;
  tbody.innerHTML="";
  const rows = await loadSupportRanges(account);
  for(const r of rows){
    const tr=document.createElement("tr");
    const cells=[r.real_name||"", r.start_dt, r.end_dt];
    for(const c of cells){
      const td=document.createElement("td");
      td.textContent=c ?? "";
      tr.appendChild(td);
    }
    const td=document.createElement("td");
    const del=document.createElement("button");
    del.className="btn small danger";
    del.textContent="Del";
    del.onclick=async ()=>{
      const ok=confirm("Eliminare segmento?");
      if(!ok) return;
      const { error } = await supabase.from("support_work_segments").delete().eq("id", r.id);
      if(error) return log("❌ delete:", error.message);
      await renderSupportRanges(account);
    };
    td.appendChild(del);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

let currentAccountForSupport=null;

function openSupportModal(account){
  currentAccountForSupport = account;
  $("supportTitle").textContent = `Supporto su account ${account}`;
  $("supportSubtitle").textContent = "Inserisci il nome reale e la finestra oraria (ora locale).";
  $("realOperator").value = "";
  // default start/end in selected day (fromDate)
  const day = $("fromDate").value || isoDate(new Date());
  $("supportStart").value = `${day}T08:00`;
  $("supportEnd").value = `${day}T12:00`;
  $("supportOverlay").style.display="flex";
  renderSupportRanges(account).catch(e=>log("❌ support ranges:", e.message||e));
}
function closeSupportModal(){
  $("supportOverlay").style.display="none";
  currentAccountForSupport=null;
}

async function addSupport(){
  try{
    if(!currentAccountForSupport) return;
    const real = $("realOperator").value.trim();
    if(!real){ alert("Inserisci nome reale (es. Hassan)"); return; }
    const start_dt = $("supportStart").value;
    const end_dt = $("supportEnd").value;
    const payload = {
      kind:"support",
      account_used: currentAccountForSupport,
      account_used_norm: canon(currentAccountForSupport),
      real_name: real,
      real_name_norm: canon(real),
      start_dt,
      end_dt
    };
    const { error } = await supabase.from("support_work_segments").insert(payload);
    if(error) throw error;
    await renderSupportRanges(currentAccountForSupport);
    log("✅ Supporto inserito.");
  }catch(e){
    log("❌ add support:", e.message||e);
  }
}

let lastKpis=[];
async function refresh(){
  try{
    const from = $("fromDate").value;
    const to = $("toDate").value;
    if(!from || !to) return;
    const events = await fetchEvents(from, to);
    const kpis = computeKpi(events);
    lastKpis = kpis;
    renderSummary(kpis);
    $("kpiLeft").textContent = `${kpis.length} operatori`;
  }catch(e){
    log("❌", e.message||e);
    console.error(e);
  }
}

async function init(){
  const today=new Date();
  $("toDate").value = isoDate(today);
  $("fromDate").value = isoDate(today);

  $("btnApply")?.addEventListener("click", refresh);
  $("btnRefresh")?.addEventListener("click", refresh);
  $("btnReset")?.addEventListener("click", ()=>{ logEl.textContent=""; });

  // support modal
  $("btnCloseSupport")?.addEventListener("click", closeSupportModal);
  $("btnAddSupport")?.addEventListener("click", addSupport);
  $("btnRecalc")?.addEventListener("click", async ()=>{ closeSupportModal(); await refresh(); });

  await refresh();
}

init();
