/* app-core.js
 * Core condiviso: parsing, modello dati, calcoli, persistenza.
 * Funziona offline (file locale) usando IndexedDB.
 */

/** =========================
 *  CONFIG
 * ========================= */
export const INTEREST_OPERATORS = new Set(["A.BEJAN","M.HAYAT","L.VUONO","S.ANASS","S.RODRIGUE."]);
export const PAUSE_THRESHOLD_MIN = 30;
export const MAX_WORK_GAP_MIN = 240;

export const SHIFT_DEFS = {
  AM: { start:"05:00", end:"13:00" },
  C:  { start:"08:00", end:"16:00" },
  PM: { start:"14:00", end:"22:00" }
};
export const SHIFT_TARGET_MIN = 480;

/** =========================
 *  STATE (in-memory)
 * ========================= */
export const state = {
  // dataset
  eventsByOpDay: new Map(),        // src op -> Map(dayKey -> events[])
  rawPiCounts: [],                 // [{srcOp,timestamp,dayKey,hour,lane}]
  // user adjustments
  supportRules: new Map(),         // srcOp -> [{realOp,start,end}]
  shiftOverride: new Map(),        // op -> Map(dayKey -> "AUTO"|AM|C|PM)
  indirectRules: new Map(),        // op -> Map(dayKey -> [{start,end,desc}] )
  // derived
  derivedIntervalsByOpDay: new Map(), // effOp -> Map(dayKey -> intervals[])
  shiftByOpDay: new Map(),           // effOp -> Map(dayKey -> {code,start,end,inferred})
  piCounts: []                       // [{op,dayKey,hour,lane}]
};

/** =========================
 *  HELPERS
 * ========================= */
export function normStr(v){ return (v===null||v===undefined) ? "" : String(v).trim(); }
export function minutesBetween(a,b){ return (b-a)/60000; }
export function round1(x){ return Math.round(x*10)/10; }
export function minToHHMM(min){
  const total = Math.max(0, Math.round(Number(min||0)));
  const h = Math.floor(total/60);
  const m = total%60;
  return `${h}:${String(m).padStart(2,"0")}`;
}
export function fmtDateTime(dt){
  if(!(dt instanceof Date) || isNaN(dt.getTime())) return "";
  const p=n=>String(n).padStart(2,"0");
  return `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}
export function dayKeyFromDate(dt){
  const p=n=>String(n).padStart(2,"0");
  return `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())}`;
}
export function dayKeyToDate(dayKey){
  const d = new Date(dayKey + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function excelDateToYMD(d){
  if(!d) return null;
  if(d instanceof Date && !isNaN(d.getTime())) return { y:d.getFullYear(), m:d.getMonth()+1, day:d.getDate() };
  const dt = new Date(d);
  if(!isNaN(dt.getTime())) return { y:dt.getFullYear(), m:dt.getMonth()+1, day:dt.getDate() };
  return null;
}
function parseTimeToHMS(t){
  if(t===null||t===undefined||t==="") return { h:0, min:0, s:0 };
  if(t instanceof Date && !isNaN(t.getTime())) return { h:t.getHours(), min:t.getMinutes(), s:t.getSeconds() };
  if(typeof t==="number" && isFinite(t)){
    const totalSeconds = Math.round(t*24*3600);
    return { h:Math.floor(totalSeconds/3600)%24, min:Math.floor((totalSeconds%3600)/60), s:totalSeconds%60 };
  }
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if(m) return { h:+m[1], min:+m[2], s:m[3]?+m[3]:0 };
  const dt = new Date(s);
  if(!isNaN(dt.getTime())) return { h:dt.getHours(), min:dt.getMinutes(), s:dt.getSeconds() };
  return { h:0, min:0, s:0 };
}
export function combineDateTime(dateVal, timeVal){
  const ymd = excelDateToYMD(dateVal);
  if(!ymd) return null;
  const hms = parseTimeToHMS(timeVal);
  const dt = new Date(ymd.y, ymd.m-1, ymd.day, hms.h, hms.min, hms.s);
  return isNaN(dt.getTime()) ? null : dt;
}

export function isNonEmptyBin(v){ const s = normStr(v); return s!=="" && s!=="0"; }
export function isPickBin(bin){
  const s = normStr(bin);
  if(!s) return false;
  const parts = s.split("-");
  return parts[parts.length-1] === "1";
}
export function laneFromStorageBin(bin){
  const s = normStr(bin);
  if(!s) return null;
  const m = s.match(/(\d{2})/);
  if(!m) return null;
  const n = parseInt(m[1],10);
  if(!isFinite(n) || n<1 || n>50) return null;
  return n;
}

/** =========================
 *  CATEGORIE
 * ========================= */
export function wtCategory(procType){
  const n = parseInt(procType, 10);
  if(n===9994 || n===9995) return "P2P";
  if(n===3060 || n===3062 || n===3040 || n===3041 || n===3042) return "Clean PICK";
  return "WT Other";
}
export function piCategory(storageBin){
  return isPickBin(storageBin) ? "PI Pick" : "PI Bulk";
}

/** =========================
 *  SHIFT
 * ========================= */
export function shiftWindow(dayKey, code){
  const base = dayKeyToDate(dayKey);
  if(!base) return null;
  const def = SHIFT_DEFS[code];
  if(!def) return null;
  const [sh, sm] = def.start.split(":").map(Number);
  const [eh, em] = def.end.split(":").map(Number);
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), sh, sm, 0);
  const end   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), eh, em, 0);
  return { start, end };
}

export function inferShiftForOpDay(op, dayKey, events){
  const ovMap = state.shiftOverride.get(op);
  const ov = ovMap ? ovMap.get(dayKey) : null;
  if(ov && ov !== "AUTO"){
    const w = shiftWindow(dayKey, ov);
    return { code:ov, start:w.start, end:w.end, inferred:false };
  }
  const counts = { AM:0, C:0, PM:0 };
  for(const e of events){
    for(const code of ["AM","C","PM"]){
      const w = shiftWindow(dayKey, code);
      if(e.timestamp >= w.start && e.timestamp <= w.end) counts[code] += 1;
    }
  }
  let best="AM";
  for(const code of ["C","PM"]){
    if(counts[code] > counts[best]) best=code;
  }
  const first = events[0]?.timestamp;
  if(first && counts.AM===counts.C && counts.C===counts.PM){
    const hm = first.getHours()*60 + first.getMinutes();
    if(hm < 7*60) best="AM";
    else if(hm < 12*60) best="C";
    else best="PM";
  }
  const w = shiftWindow(dayKey, best);
  return { code:best, start:w.start, end:w.end, inferred:true };
}

/** =========================
 *  SUPPORT + INDIRECT
 * ========================= */
export function mapEffectiveOperator(srcOp, ts){
  const rules = (state.supportRules.get(srcOp) || []).slice().sort((a,b)=>a.start-b.start);
  for(const r of rules){
    if(ts >= r.start && ts < r.end) return r.realOp;
  }
  return srcOp;
}

function getOrInitMap(map, key){
  if(!map.has(key)) map.set(key, new Map());
  return map.get(key);
}
function pushEvent(mapOpDay, op, dayKey, ev){
  const m = getOrInitMap(mapOpDay, op);
  if(!m.has(dayKey)) m.set(dayKey, []);
  m.get(dayKey).push(ev);
}

/** =========================
 *  BUILD EVENTS
 * ========================= */
export function buildEventsFromRows(piRows, wtRows){
  const out = new Map();
  const rawPiCounts = [];

  // PI
  for(const r of piRows){
    const counter = normStr(r["Counter"]);
    if(!INTEREST_OPERATORS.has(counter)) continue;

    const ts = combineDateTime(r["Count Date"], r["Count Time"]);
    if(!ts) continue;

    const createdBy = normStr(r["Created By"]);
    const storageBin = normStr(r["Storage Bin"]);
    const dayKey = dayKeyFromDate(ts);

    const cat = piCategory(storageBin);
    pushEvent(out, counter, dayKey, {
      timestamp: ts,
      timestampStr: fmtDateTime(ts),
      operator: counter,
      kind: "PI",
      category: cat,
      selfCount: (counter && counter===createdBy) ? "Yes" : "No",
      storageBin
    });

    const lane = laneFromStorageBin(storageBin);
    if(lane !== null){
      rawPiCounts.push({ srcOp: counter, timestamp: ts, dayKey, hour: ts.getHours(), lane });
    }
  }

  // WT
  for(const r of wtRows){
    if(!isNonEmptyBin(r["Source Storage Bin"])) continue;
    const createdBy = normStr(r["Created By"]);
    const confirmedBy = normStr(r["Confirmed by"]);
    const operator = confirmedBy || createdBy;
    if(!INTEREST_OPERATORS.has(operator)) continue;

    const ts = combineDateTime(r["Created On"], r["Created At"]);
    if(!ts) continue;

    const dayKey = dayKeyFromDate(ts);
    const procType = normStr(r["Whse Proc. Type"]);
    const cat = wtCategory(procType);
    const wo = normStr(r["Warehouse Order"]);

    pushEvent(out, operator, dayKey, {
      timestamp: ts,
      timestampStr: fmtDateTime(ts),
      operator,
      kind: "WT",
      category: cat,
      woId: wo
    });
  }

  // sort
  for(const [, m] of out.entries()){
    for(const [, list] of m.entries()){
      list.sort((a,b)=>a.timestamp-b.timestamp);
    }
  }

  return { eventsByOpDay: out, rawPiCounts };
}

/** =========================
 *  INTERVAL BUILD
 * ========================= */
function classifyAndSplitInterval(start, end, baseCategory, shiftStart, shiftEnd){
  const parts=[];
  const a = start.getTime(), b=end.getTime();
  if(b<=a) return { inside:[], outMinutes:0 };

  const inStart = Math.max(a, shiftStart.getTime());
  const inEnd   = Math.min(b, shiftEnd.getTime());

  if(inEnd > inStart){
    parts.push({
      start: new Date(inStart),
      end: new Date(inEnd),
      minutes: round1((inEnd-inStart)/60000),
      category: baseCategory
    });
  }
  const outMin = ((b-a)/60000) - (inEnd>inStart ? (inEnd-inStart)/60000 : 0);
  return { inside: parts, outMinutes: Math.max(0, outMin) };
}

function applyIndirectForOpDay(op, dayKey, intervals){
  const dayRulesMap = state.indirectRules.get(op);
  const rules = dayRulesMap ? (dayRulesMap.get(dayKey) || []) : [];
  const valid = rules
    .filter(r=>r && r.start instanceof Date && r.end instanceof Date && r.end>r.start)
    .sort((a,b)=>a.start-b.start);
  if(!valid.length) return intervals.slice();

  const out=[];
  for(const it of intervals){
    if(it.category!=="PAUSA"){ out.push(it); continue; }

    let remaining=[{ start:it.start, end:it.end, notes:it.notes }];
    for(const rule of valid){
      const next=[];
      for(const seg of remaining){
        const a = Math.max(seg.start.getTime(), rule.start.getTime());
        const b = Math.min(seg.end.getTime(), rule.end.getTime());
        if(b<=a){ next.push(seg); continue; }

        if(seg.start.getTime() < a){
          const s1=seg.start, e1=new Date(a);
          out.push({ ...it,
            start:s1,end:e1,startStr:fmtDateTime(s1),endStr:fmtDateTime(e1),
            minutes: round1(minutesBetween(s1,e1)),
            category:"PAUSA",
            notes: seg.notes||"Pausa",
            piBins:0,selfCount:0,woId:""
          });
        }
        const s2=new Date(a), e2=new Date(b);
        out.push({ ...it,
          start:s2,end:e2,startStr:fmtDateTime(s2),endStr:fmtDateTime(e2),
          minutes: round1(minutesBetween(s2,e2)),
          category:"INDIRETTA",
          notes: rule.desc ? `Indiretta: ${rule.desc}` : "Indiretta",
          piBins:0,selfCount:0,woId:""
        });
        if(b < seg.end.getTime()){
          next.push({ start:new Date(b), end:seg.end, notes:seg.notes });
        }
      }
      remaining=next;
      if(!remaining.length) break;
    }
    for(const seg of remaining){
      out.push({ ...it,
        start:seg.start,end:seg.end,startStr:fmtDateTime(seg.start),endStr:fmtDateTime(seg.end),
        minutes: round1(minutesBetween(seg.start,seg.end)),
        category:"PAUSA", notes: seg.notes||"Pausa",
        piBins:0,selfCount:0,woId:""
      });
    }
  }
  out.sort((a,b)=>a.start-b.start);
  return out;
}

export function rebuildDerived(){
  state.derivedIntervalsByOpDay = new Map();
  state.shiftByOpDay = new Map();
  state.piCounts = [];

  // Remap events -> effective
  const effEventsByOpDay = new Map();
  for(const [srcOp, dayMap] of state.eventsByOpDay.entries()){
    for(const [dayKey, events] of dayMap.entries()){
      for(const e of events){
        const effOp = mapEffectiveOperator(srcOp, e.timestamp);
        const m = getOrInitMap(effEventsByOpDay, effOp);
        if(!m.has(dayKey)) m.set(dayKey, []);
        m.get(dayKey).push({ ...e, operator: effOp });
      }
    }
  }
  for(const [, m] of effEventsByOpDay.entries()){
    for(const [, list] of m.entries()){
      list.sort((a,b)=>a.timestamp-b.timestamp);
    }
  }

  // intervals per op/day inside shift
  for(const [op, dayMap] of effEventsByOpDay.entries()){
    for(const [dayKey, events] of dayMap.entries()){
      if(events.length<2) continue;
      const sh = inferShiftForOpDay(op, dayKey, events);
      getOrInitMap(state.shiftByOpDay, op).set(dayKey, sh);

      const outIntervals=[];
      for(let i=1;i<events.length;i++){
        const prev = events[i-1];
        const curr = events[i];
        const gap = minutesBetween(prev.timestamp, curr.timestamp);
        if(!(gap>0)) continue;

        let baseCat = curr.category;
        let notes = "";
        let piBins=0, selfCount=0, woId="";

        if(gap >= PAUSE_THRESHOLD_MIN || gap > MAX_WORK_GAP_MIN){
          baseCat="PAUSA";
          notes=`Gap ${Math.round(gap)} min`;
        }else{
          if(curr.kind==="PI"){
            piBins=1; if(curr.selfCount==="Yes") selfCount=1;
          }else{
            woId = curr.woId || "";
            notes = woId ? `WO=${woId}` : "";
          }
        }

        const split = classifyAndSplitInterval(prev.timestamp, curr.timestamp, baseCat, sh.start, sh.end);
        for(const p of split.inside){
          outIntervals.push({
            start:p.start,end:p.end,
            startStr:fmtDateTime(p.start), endStr:fmtDateTime(p.end),
            minutes:p.minutes,
            category:p.category,
            notes,
            piBins: (p.category.startsWith("PI") ? piBins : 0),
            selfCount: (p.category.startsWith("PI") ? selfCount : 0),
            woId: (p.category==="P2P"||p.category==="Clean PICK"||p.category==="WT Other") ? woId : ""
          });
        }
      }
      outIntervals.sort((a,b)=>a.start-b.start);
      const finalIntervals = applyIndirectForOpDay(op, dayKey, outIntervals);

      const m = getOrInitMap(state.derivedIntervalsByOpDay, op);
      m.set(dayKey, finalIntervals);
    }
  }

  // PI counts remap
  for(const r of state.rawPiCounts){
    const effOp = mapEffectiveOperator(r.srcOp, r.timestamp);
    state.piCounts.push({ op:effOp, dayKey:r.dayKey, hour:r.hour, lane:r.lane });
  }
}

/** =========================
 *  AGGREGATION (reusable)
 * ========================= */
export function concatIntervalsForOp(op, dayKeys){
  const dayMap = state.derivedIntervalsByOpDay.get(op);
  if(!dayMap) return [];
  const all=[];
  for(const dk of dayKeys){
    const list = dayMap.get(dk);
    if(list && list.length) all.push(...list.map(x=>({ ...x, dayKey: dk })));
  }
  all.sort((a,b)=>a.start-b.start);
  return all;
}

export function computeAllDayKeys(){
  const keys=new Set();
  for(const [, dayMap] of state.derivedIntervalsByOpDay.entries()){
    for(const [dk] of dayMap.entries()) keys.add(dk);
  }
  return Array.from(keys).sort((a,b)=>a.localeCompare(b));
}

/** =========================
 *  PERSISTENZA IndexedDB
 * ========================= */
const DB_NAME="produttivitaDB";
const DB_VER=1;
const STORE="snapshots";
const SNAP_ID="latest";

function idbOpen(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(STORE)){
        db.createObjectStore(STORE,{ keyPath:"id" });
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function idbPut(doc){
  return idbOpen().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).put(doc);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  }));
}
function idbGet(id){
  return idbOpen().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readonly");
    const req=tx.objectStore(STORE).get(id);
    req.onsuccess=()=>resolve(req.result||null);
    req.onerror=()=>reject(req.error);
  }));
}
function idbDel(id){
  return idbOpen().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  }));
}

// serialize/deserialize Maps + Dates
function serSupport(){
  const obj={};
  for(const [src, arr] of state.supportRules.entries()){
    obj[src]=(arr||[]).map(r=>({ realOp:r.realOp, start:r.start.toISOString(), end:r.end.toISOString() }));
  }
  return obj;
}
function deSupport(obj){
  const m=new Map();
  if(!obj) return m;
  for(const k of Object.keys(obj)){
    m.set(k,(obj[k]||[]).map(r=>({ realOp:r.realOp, start:new Date(r.start), end:new Date(r.end) })));
  }
  return m;
}
function serShiftOv(){
  const obj={};
  for(const [op, dm] of state.shiftOverride.entries()){
    obj[op]={};
    for(const [dk, v] of dm.entries()) obj[op][dk]=v;
  }
  return obj;
}
function deShiftOv(obj){
  const m=new Map();
  if(!obj) return m;
  for(const op of Object.keys(obj)){
    const dm=new Map();
    for(const dk of Object.keys(obj[op]||{})) dm.set(dk, obj[op][dk]);
    m.set(op, dm);
  }
  return m;
}
function serIndirect(){
  const obj={};
  for(const [op, dm] of state.indirectRules.entries()){
    obj[op]={};
    for(const [dk, list] of dm.entries()){
      obj[op][dk]=(list||[]).map(r=>({ start:r.start.toISOString(), end:r.end.toISOString(), desc:r.desc||"" }));
    }
  }
  return obj;
}
function deIndirect(obj){
  const m=new Map();
  if(!obj) return m;
  for(const op of Object.keys(obj)){
    const dm=new Map();
    for(const dk of Object.keys(obj[op]||{})){
      dm.set(dk,(obj[op][dk]||[]).map(r=>({ start:new Date(r.start), end:new Date(r.end), desc:r.desc||"" })));
    }
    m.set(op, dm);
  }
  return m;
}
function serEvents(){
  const obj={};
  for(const [op, dm] of state.eventsByOpDay.entries()){
    obj[op]={};
    for(const [dk, list] of dm.entries()){
      obj[op][dk]=(list||[]).map(e=>({ ...e, timestamp:e.timestamp.toISOString() }));
    }
  }
  return obj;
}
function deEvents(obj){
  const m=new Map();
  if(!obj) return m;
  for(const op of Object.keys(obj)){
    const dm=new Map();
    for(const dk of Object.keys(obj[op]||{})){
      dm.set(dk,(obj[op][dk]||[]).map(e=>({
        ...e,
        timestamp:new Date(e.timestamp),
        timestampStr:e.timestampStr || fmtDateTime(new Date(e.timestamp))
      })));
    }
    m.set(op, dm);
  }
  return m;
}
function serRawPi(arr){
  return (arr||[]).map(r=>({ ...r, timestamp:r.timestamp.toISOString() }));
}
function deRawPi(arr){
  return (arr||[]).map(r=>({ ...r, timestamp:new Date(r.timestamp) }));
}

export async function saveSnapshot(){
  const doc={
    id: SNAP_ID,
    savedAt: new Date().toISOString(),
    eventsByOpDay: serEvents(),
    rawPiCounts: serRawPi(state.rawPiCounts),
    supportRules: serSupport(),
    shiftOverride: serShiftOv(),
    indirectRules: serIndirect()
  };
  await idbPut(doc);
}

export async function loadSnapshot(){
  const doc = await idbGet(SNAP_ID);
  if(!doc) return { ok:false, msg:"Nessun dataset salvato." };

  state.eventsByOpDay = deEvents(doc.eventsByOpDay);
  state.rawPiCounts = deRawPi(doc.rawPiCounts);

  state.supportRules = deSupport(doc.supportRules);
  state.shiftOverride = deShiftOv(doc.shiftOverride);
  state.indirectRules = deIndirect(doc.indirectRules);

  rebuildDerived();

  return { ok:true, savedAt: doc.savedAt };
}

export async function clearSnapshot(){
  await idbDel(SNAP_ID);
}

/** =========================
 *  Utility per UI: list operators
 * ========================= */
export function listOperators(){
  return Array.from(state.derivedIntervalsByOpDay.keys()).sort((a,b)=>a.localeCompare(b));
}
