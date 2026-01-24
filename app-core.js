/* app-core.js (global)
 * Libreria condivisa per dashboard Produttività (Supabase + GitHub Pages)
 * - Selezione periodo (giorni/settimane/mesi) in localStorage
 * - Caricamento datasets + eventi da Supabase
 * - Helper KPI (categorie, corsie, hh:mm)
 *
 * Dipendenze richieste in pagina:
 *  - <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
 */
(function(){
  'use strict';

  // =============== CONFIG ===============
  const SUPABASE_URL = "https://jslonbsvrtltfnrpneqw.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_OZZhrdcM8Zh3eXcqTdcljw_ZY4faGvl";
  const EVENTS_OPERATOR_COL = "operator"; // se hai spazi usa la stessa stringa della colonna su Supabase

  const INTEREST_OPERATORS = new Set(["A.BEJAN","M.HAYAT","L.VUONO","S.ANASS","S.RODRIGUE."]);

  const SHIFT_DEFS = {
    AM: { start: "05:00", end: "13:00" },
    C:  { start: "08:00", end: "16:00" },
    PM: { start: "14:00", end: "22:00" }
  };
  const SHIFT_TARGET_MIN = 480;
  const PAUSE_THRESHOLD_MIN = 30;

  const SEL_KEY = "selectedDaysV2"; // {mode, days:{dk:{pi,wt}}, groups:[gk], dayKinds:{...}}
  const SUPPORT_KEY = "supportRules"; // { srcOp:[{realOp,start,end}] }
  const INDIRECT_KEY = "indirectRules"; // { op:{ dayKey:[{start,end,desc}] } }
  const SHIFT_OV_KEY = "shiftOverride"; // { op:{ dayKey: "AUTO"|AM|C|PM } }

  const sb = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

  // =============== UTIL ===============
  function normStr(v){ return (v===null||v===undefined) ? "" : String(v).trim(); }
  function p2(n){ return String(n).padStart(2,'0'); }
  function dayKeyToDate(dayKey){ const d=new Date(dayKey+"T00:00:00"); return isNaN(d.getTime())?null:d; }
  function fmtDDMMYYYY(dayKey){
    const d=dayKeyToDate(dayKey); if(!d) return dayKey;
    return `${p2(d.getDate())}-${p2(d.getMonth()+1)}-${d.getFullYear()}`;
  }
  function minToHHMM(min){
    const total = Math.max(0, Math.round(Number(min||0)));
    const h = Math.floor(total/60);
    const m = total%60;
    return `${h}:${String(m).padStart(2,"0")}`;
  }
  function minutesBetween(a,b){ return (b-a)/60000; }

  function isNonEmptyBin(v){ const s=normStr(v); return s!=="" && s!=="0"; }
  function isPickBin(bin){
    const s=normStr(bin); if(!s) return false;
    const parts=s.split("-");
    return parts[parts.length-1]==="1";
  }
  function laneFromStorageBin(bin){
    const s=normStr(bin); if(!s) return null;
    const m=s.match(/(\d{2})/); if(!m) return null;
    const n=parseInt(m[1],10);
    if(!isFinite(n)||n<1||n>50) return null;
    return n;
  }
  function wtCategory(procType){
    const n=parseInt(procType,10);
    if(n===9994||n===9995) return "P2P";
    if(n===3060||n===3062||n===3040||n===3041||n===3042) return "Clean PICK";
    return "WT Other";
  }
  function piCategory(storageBin){ return isPickBin(storageBin) ? "PI Pick" : "PI Bulk"; }

  function shiftWindow(dayKey, code){
    const base=dayKeyToDate(dayKey); if(!base) return null;
    const def=SHIFT_DEFS[code]; if(!def) return null;
    const [sh,sm]=def.start.split(":").map(Number);
    const [eh,em]=def.end.split(":").map(Number);
    const start=new Date(base.getFullYear(),base.getMonth(),base.getDate(),sh,sm,0);
    const end  =new Date(base.getFullYear(),base.getMonth(),base.getDate(),eh,em,0);
    return {start,end};
  }

  function inferShift(op, dayKey, events, shiftOverride){
    const ov = shiftOverride?.[op]?.[dayKey];
    if(ov && ov!=="AUTO"){
      const w=shiftWindow(dayKey, ov);
      return {code:ov, start:w.start, end:w.end, inferred:false};
    }
    const counts={AM:0,C:0,PM:0};
    for(const e of events){
      for(const code of ["AM","C","PM"]){
        const w=shiftWindow(dayKey, code);
        if(e.ts>=w.start && e.ts<=w.end) counts[code]+=1;
      }
    }
    let best="AM";
    for(const code of ["C","PM"]) if(counts[code]>counts[best]) best=code;
    const first=events[0]?.ts;
    if(first && counts.AM===counts.C && counts.C===counts.PM){
      const hm=first.getHours()*60+first.getMinutes();
      best = hm<7*60 ? "AM" : (hm<12*60 ? "C" : "PM");
    }
    const w=shiftWindow(dayKey, best);
    return {code:best, start:w.start, end:w.end, inferred:true};
  }

  // =============== SELECTION (days/weeks/months) ===============
  function getSelection(){
    try{
      const raw=localStorage.getItem(SEL_KEY);
      const obj=raw?JSON.parse(raw):null;
      if(obj && typeof obj==='object') return obj;
    }catch{}
    return { mode:"day", days:{}, groups:[] };
  }
  function setSelection(sel){
    localStorage.setItem(SEL_KEY, JSON.stringify(sel||{mode:"day",days:{},groups:[]}));
  }

  function isoWeek(d){
    const date=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
    const dayNum=date.getUTCDay()||7;
    date.setUTCDate(date.getUTCDate()+4-dayNum);
    const yearStart=new Date(Date.UTC(date.getUTCFullYear(),0,1));
    const weekNo=Math.ceil((((date-yearStart)/86400000)+1)/7);
    return {year:date.getUTCFullYear(), week:weekNo};
  }
  function groupKey(dayKey, mode){
    const d=dayKeyToDate(dayKey); if(!d) return dayKey;
    if(mode==="month") return dayKey.slice(0,7); // YYYY-MM
    if(mode==="week"){
      const w=isoWeek(d);
      return `${w.year}-W${String(w.week).padStart(2,'0')}`;
    }
    return dayKey;
  }
  function expandSelectionToDayKeys(sel, allDayKeys){
    const mode=sel?.mode||"day";
    if(mode==="day"){
      return Object.keys(sel.days||{}).sort();
    }
    const groups=new Set(sel.groups||[]);
    const out=[];
    for(const dk of (allDayKeys||[])){
      if(groups.has(groupKey(dk, mode))) out.push(dk);
    }
    return out.sort();
  }

  // =============== LOCAL RULES ===============
  function getSupportRules(){
    try{ return JSON.parse(localStorage.getItem(SUPPORT_KEY)||"{}") || {}; }catch{ return {}; }
  }
  function setSupportRules(obj){ localStorage.setItem(SUPPORT_KEY, JSON.stringify(obj||{})); }

  function getIndirectRules(){
    try{ return JSON.parse(localStorage.getItem(INDIRECT_KEY)||"{}") || {}; }catch{ return {}; }
  }
  function setIndirectRules(obj){ localStorage.setItem(INDIRECT_KEY, JSON.stringify(obj||{})); }

  function getShiftOverride(){
    try{ return JSON.parse(localStorage.getItem(SHIFT_OV_KEY)||"{}") || {}; }catch{ return {}; }
  }
  function setShiftOverride(obj){ localStorage.setItem(SHIFT_OV_KEY, JSON.stringify(obj||{})); }

  function mapEffectiveOperator(srcOp, ts, supportRules){
    const arr=(supportRules?.[srcOp]||[]).slice().map(r=>({
      realOp: r.realOp,
      start: new Date(r.start),
      end: new Date(r.end)
    })).filter(r=>r.realOp && !isNaN(r.start) && !isNaN(r.end) && r.end>r.start)
      .sort((a,b)=>a.start-b.start);
    for(const r of arr){
      if(ts>=r.start && ts<r.end) return r.realOp;
    }
    return srcOp;
  }

  // =============== SUPABASE LOADERS ===============
  function requireSupabase(){
    if(!sb) throw new Error("Supabase non inizializzato: manca <script supabase.min.js> nella pagina.");
  }
  async function fetchDatasets(){
    requireSupabase();
    const { data, error } = await sb
      .from("datasets")
      .select("id, day_key, label, created_at, pi_rows, wt_rows")
      .order("day_key",{ascending:false});
    if(error) throw new Error(error.message);
    return data||[];
  }

  async function fetchEvents(dayKeys){
    requireSupabase();
    if(!dayKeys.length) return [];
    // chiediamo i campi minimi necessari alle analisi
    const opSel = EVENTS_OPERATOR_COL.includes(' ') ? `"${EVENTS_OPERATOR_COL}"` : EVENTS_OPERATOR_COL;
    const { data, error } = await sb
      .from("events")
      .select(`day_key, ts, ${opSel}, kind, category, self_count, storage_bin, lane, wo_id`)
      .in("day_key", dayKeys);
    if(error) throw new Error(error.message);
    return (data||[]).map(r=>({
      day_key: r.day_key,
      ts: new Date(r.ts),
      operator: r[EVENTS_OPERATOR_COL],
      kind: r.kind,
      category: r.category,
      self_count: !!r.self_count,
      storage_bin: r.storage_bin,
      lane: (r.lane===null||r.lane===undefined) ? null : Number(r.lane),
      wo_id: r.wo_id
    })).filter(r=>r.operator && !isNaN(r.ts.getTime()));
  }

  function filterEventsBySelection(events, sel){
    const days=sel?.days||{};
    return (events||[]).filter(e=>{
      const d=days[e.day_key];
      if(!d) return false;
      if(e.kind==="PI") return !!d.pi;
      if(e.kind==="WT") return !!d.wt;
      return false;
    });
  }

  // =============== ANALYSIS CORE ===============
  function buildPerOpDayEvents(events, supportRules){
    // ritorna Map effOp -> Map dayKey -> eventsSorted[]
    const by = new Map();
    for(const e of events){
      const effOp = mapEffectiveOperator(e.operator, e.ts, supportRules);
      if(!INTEREST_OPERATORS.has(effOp) && !INTEREST_OPERATORS.has(e.operator)){
        // se supporto reale è fuori lista, lo includiamo comunque (serve per split)
      }
      if(!by.has(effOp)) by.set(effOp, new Map());
      const dm=by.get(effOp);
      if(!dm.has(e.day_key)) dm.set(e.day_key, []);
      dm.get(e.day_key).push({...e, effOp});
    }
    for(const [,dm] of by){
      for(const [dk,list] of dm){
        list.sort((a,b)=>a.ts-b.ts);
        dm.set(dk,list);
      }
    }
    return by;
  }

  function computeIntervalsForOpDay(events, shiftInfo, indirectRulesForDay){
    // events sorted
    const out=[];
    if(!events.length) return out;

    const shiftStart = shiftInfo?.start || null;
    const shiftEnd   = shiftInfo?.end || null;

    // clip helper
    const clip = (a,b)=>{
      let s=new Date(a), e=new Date(b);
      if(shiftStart && s<shiftStart) s=new Date(shiftStart);
      if(shiftEnd && e>shiftEnd) e=new Date(shiftEnd);
      if(e<=s) return null;
      return {s,e};
    };

    // base intervals from event gaps
    for(let i=0;i<events.length;i++){
      const cur=events[i];
      const next=events[i+1];
      const start=cur.ts;
      const end=next ? next.ts : (shiftEnd ? new Date(shiftEnd) : new Date(cur.ts.getTime()+5*60000));
      const gapMin=minutesBetween(start,end);
      let cat = cur.kind==="PI" ? cur.category : (cur.kind==="WT" ? cur.category : "Other");
      let note = "";
      if(cur.kind==="PI" && cur.self_count) note="Self Count";
      if(gapMin>=PAUSE_THRESHOLD_MIN) cat="PAUSA";
      const clipped=clip(start,end);
      if(!clipped) continue;
      out.push({
        start: clipped.s,
        end: clipped.e,
        minutes: minutesBetween(clipped.s, clipped.e),
        category: cat,
        kind: cur.kind,
        self_count: cur.self_count,
        lane: cur.lane,
        wo_id: cur.wo_id,
        note
      });
    }

    // add indirect intervals (override PAUSA portions)
    const indirect = (indirectRulesForDay||[]).map(r=>({
      start:new Date(r.start), end:new Date(r.end), desc:r.desc||""
    })).filter(r=>!isNaN(r.start)&&!isNaN(r.end)&&r.end>r.start);

    if(!indirect.length) return out;

    // For simplicity: append indirect as standalone blocks; in KPI we'll subtract from PAUSA by overlap.
    for(const r of indirect){
      const clipped=clip(r.start,r.end);
      if(!clipped) continue;
      out.push({
        start: clipped.s, end: clipped.e,
        minutes: minutesBetween(clipped.s, clipped.e),
        category:"INDIRETTA", kind:"IND",
        note: r.desc||"Indiretta"
      });
    }
    out.sort((a,b)=>a.start-b.start);
    return out;
  }

  function overlapMinutes(aStart,aEnd,bStart,bEnd){
    const s = Math.max(aStart.getTime(), bStart.getTime());
    const e = Math.min(aEnd.getTime(), bEnd.getTime());
    if(e<=s) return 0;
    return (e-s)/60000;
  }

  function summarizeOpDay(intervals){
    const sum = {
      minPiPick:0,minPiBulk:0,minP2P:0,minClean:0,minOther:0,
      minIndirect:0,minPause:0,
      piPickBins:0,piBulkBins:0,selfCount:0,
      woP2P:new Set(), woClean:new Set(), woOther:new Set(),
      switchCount:0, switchMin:0,
      first:null,last:null
    };
    if(!intervals.length) return sum;

    // order already
    sum.first = intervals[0].start;
    sum.last = intervals[intervals.length-1].end;

    // switches: change between high-level buckets (PI vs WT vs PAUSA vs INDIRETTA) and between PI Pick/Bulk
    let prevTask=null;
    for(const it of intervals){
      const m = it.minutes;
      if(it.category==="PI Pick"){ sum.minPiPick+=m; sum.piPickBins+=1; if(it.note==="Self Count") sum.selfCount+=1; }
      else if(it.category==="PI Bulk"){ sum.minPiBulk+=m; sum.piBulkBins+=1; if(it.note==="Self Count") sum.selfCount+=1; }
      else if(it.category==="P2P"){ sum.minP2P+=m; if(it.wo_id) sum.woP2P.add(it.wo_id); }
      else if(it.category==="Clean PICK"){ sum.minClean+=m; if(it.wo_id) sum.woClean.add(it.wo_id); }
      else if(it.category==="WT Other"){ sum.minOther+=m; if(it.wo_id) sum.woOther.add(it.wo_id); }
      else if(it.category==="INDIRETTA"){ sum.minIndirect+=m; }
      else if(it.category==="PAUSA"){ sum.minPause+=m; }
      else { sum.minOther+=m; }

      // task label for switches
      const taskLabel = it.category; // enough for now
      if(prevTask!==null && taskLabel!==prevTask){
        sum.switchCount += 1;
        // time lost: first 10 minutes of new block? Here: we count 0; better: count the gap that caused PAUSA? We'll approximate by 0.
      }
      prevTask = taskLabel;
    }

    // subtract overlaps of indirect from pause (do not double count)
    if(sum.minIndirect>0 && sum.minPause>0){
      let overlap=0;
      const ind = intervals.filter(x=>x.category==="INDIRETTA");
      const pau = intervals.filter(x=>x.category==="PAUSA");
      for(const i of ind){
        for(const p of pau){
          overlap += overlapMinutes(i.start,i.end,p.start,p.end);
        }
      }
      sum.minPause = Math.max(0, sum.minPause - overlap);
    }

    return sum;
  }

  async function computeAggregatesForSelection(sel){
    // returns {dayKeys, allDayKeys, perOpAggRows, perOpDayDetail}
    requireSupabase();
    const datasets = await fetchDatasets();
    const allDayKeys = datasets.map(d=>d.day_key).filter(Boolean).sort();
    const dayKeys = expandSelectionToDayKeys(sel, allDayKeys);

    const supportRules = getSupportRules();
    const indirectRules = getIndirectRules();
    const shiftOv = getShiftOverride();

    const eventsRaw = await fetchEvents(dayKeys);
    const events = filterEventsBySelection(eventsRaw, sel);

    const byOpDay = buildPerOpDayEvents(events, supportRules);

    // compute per op/day intervals & summary
    const perOpDay = new Map(); // op -> Map dayKey -> {shift, intervals, sum}
    for(const [op, dm] of byOpDay.entries()){
      const opDayMap = new Map();
      for(const [dk, list] of dm.entries()){
        const shift = inferShift(op, dk, list, shiftOv);
        const indList = (indirectRules?.[op]?.[dk] || []);
        const intervals = computeIntervalsForOpDay(list, shift, indList);
        const sum = summarizeOpDay(intervals);
        opDayMap.set(dk, { shift, intervals, sum });
      }
      perOpDay.set(op, opDayMap);
    }

    // aggregate across selected days
    const rows=[];
    for(const [op, dm] of perOpDay.entries()){
      const agg={
        operator: op,
        dayCount: 0,
        shiftHint: "",
        targetMin:0,
        actualMin:0,
        minPiPick:0,minPiBulk:0,minP2P:0,minClean:0,minOther:0,minIndirect:0,minPause:0,
        piPickBins:0,piBulkBins:0,selfCount:0,
        woP2P:0,woClean:0,woOther:0,
        switchCount:0, switchMin:0
      };
      const woSets={P2P:new Set(), Clean:new Set(), Other:new Set()};
      for(const dk of dayKeys){
        const d = dm.get(dk);
        if(!d) continue;
        agg.dayCount += 1;
        agg.targetMin += SHIFT_TARGET_MIN;
        const s=d.sum;
        if(s.first && s.last) agg.actualMin += minutesBetween(s.first,s.last);
        agg.minPiPick += s.minPiPick;
        agg.minPiBulk += s.minPiBulk;
        agg.minP2P += s.minP2P;
        agg.minClean += s.minClean;
        agg.minOther += s.minOther;
        agg.minIndirect += s.minIndirect;
        agg.minPause += s.minPause;
        agg.piPickBins += s.piPickBins;
        agg.piBulkBins += s.piBulkBins;
        agg.selfCount += s.selfCount;
        for(const x of s.woP2P) woSets.P2P.add(x);
        for(const x of s.woClean) woSets.Clean.add(x);
        for(const x of s.woOther) woSets.Other.add(x);
        agg.switchCount += s.switchCount;
      }
      agg.woP2P = woSets.P2P.size;
      agg.woClean = woSets.Clean.size;
      agg.woOther = woSets.Other.size;
      rows.push(agg);
    }
    rows.sort((a,b)=> (b.actualMin - a.actualMin));

    return { datasets, allDayKeys, dayKeys, perOpDay, rows };
  }

  // =============== CHART HELPERS ===============
  function buildPieData(rows){
    const labels = rows.map(r=>r.operator);
    const pick = rows.map(r=>r.piPickBins||0);
    const bulk = rows.map(r=>r.piBulkBins||0);
    return { labels, pick, bulk };
  }

  function buildProdVsSwitch(rows){
    const labels = rows.map(r=>r.operator);
    const prod = rows.map(r=>{
      const piMin = r.minPiPick + r.minPiBulk;
      const wtMin = r.minP2P + r.minClean + r.minOther;
      const piBins = r.piPickBins + r.piBulkBins;
      const wtWO = r.woP2P + r.woClean + r.woOther;
      const piRate = piMin>0 ? (piBins/(piMin/60)) : 0;
      const wtRate = wtMin>0 ? (wtWO/(wtMin/60)) : 0;
      return Math.round((piRate + 2*wtRate)*10)/10;
    });
    const switches = rows.map(r=>r.switchCount||0);
    return { labels, prod, switches };
  }

  function buildHeatAisleHour(events, kindFilter){
    // Y=hours 05..22 (18 values), X=aisle 01..50
    const hours=[];
    for(let h=5; h<=22; h++) hours.push(h);
    const aisles=[];
    for(let a=1; a<=50; a++) aisles.push(a);

    const z = hours.map(()=>aisles.map(()=>0));
    for(const e of events){
      if(kindFilter && e.kind!==kindFilter) continue;
      if(e.lane===null||e.lane===undefined) continue;
      const h=e.ts.getHours();
      if(h<5||h>22) continue;
      const hi=hours.indexOf(h);
      const ai=aisles.indexOf(Number(e.lane));
      if(hi>=0 && ai>=0) z[hi][ai] += 1;
    }
    return { x: aisles.map(a=>String(a).padStart(2,'0')), y: hours.map(h=>String(h).padStart(2,'0')+":00"), z };
  }

  // =============== EXPORT ===============
  window.AppCore = {
    // config
    SUPABASE_URL, SUPABASE_ANON_KEY, EVENTS_OPERATOR_COL,
    INTEREST_OPERATORS,
    SHIFT_DEFS, SHIFT_TARGET_MIN, PAUSE_THRESHOLD_MIN,

    // selection
    SEL_KEY, getSelection, setSelection, groupKey, expandSelectionToDayKeys,
    fmtDDMMYYYY,

    // rules
    getSupportRules, setSupportRules,
    getIndirectRules, setIndirectRules,
    getShiftOverride, setShiftOverride,

    // categories/utils
    normStr, isNonEmptyBin, isPickBin, laneFromStorageBin, wtCategory, piCategory,
    minToHHMM,

    // supabase
    sb, fetchDatasets, fetchEvents, filterEventsBySelection,

    // analysis
    computeAggregatesForSelection,
    buildPieData, buildProdVsSwitch, buildHeatAisleHour
  };
})();
