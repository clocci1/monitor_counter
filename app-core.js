/* app-core.js
 * Core condiviso (offline):
 * - parsing PI/WT da XLSX (cdn xlsx)
 * - modello eventi + intervalli + KPI
 * - supporti (account→operatore reale) e indirette
 * - persistenza IndexedDB (così le pagine condividono i dati)
 *
 * Nota: è un modulo ES. Le pagine lo importano via <script type="module">.
 */

/** =========================
 *  CONFIG
 * ========================= */
export const INTEREST_OPERATORS = new Set([
  "A.BEJAN",
  "M.HAYAT",
  "L.VUONO",
  "S.ANASS",
  "S.RODRIGUE."
]);

export const SHIFT_DEFS = {
  AM: { start: "05:00", end: "13:00" },
  C:  { start: "08:00", end: "16:00" },
  PM: { start: "14:00", end: "22:00" }
};

export const SHIFT_TARGET_MIN = 480;            // 8h
export const PAUSE_THRESHOLD_MIN = 30;          // gap >= 30 => pausa
export const MAX_WORK_GAP_MIN = 240;            // gap enorme => pausa (hard stop)

/** =========================
 *  STATE (in-memory)
 * ========================= */
export const state = {
  // RAW (per account)
  eventsByOpDay: new Map(), // srcOp -> Map(dayKey -> events[])
  rawPiCounts: [],          // [{srcOp,timestamp,dayKey,hour,lane,isPick,isBulk,selfCount}]
  rawWtTouches: [],         // [{srcOp,timestamp,dayKey,hour,lane}]

  // USER RULES
  supportRules: new Map(),  // srcOp -> [{realOp,start,end}]
  shiftOverride: new Map(), // effOp -> Map(dayKey -> "AUTO"|AM|C|PM)
  indirectRules: new Map(), // effOp -> Map(dayKey -> [{start,end,desc}])

  // DERIVED (per operatore effettivo)
  derivedIntervalsByOpDay: new Map(), // effOp -> Map(dayKey -> intervals[])
  shiftByOpDay: new Map(),           // effOp -> Map(dayKey -> {code,start,end,inferred})
  piCounts: [],                      // [{op,dayKey,hour,lane,isPick,isBulk,selfCount}]
  wtTouches: []                      // [{op,dayKey,hour,lane}]
};

/** =========================
 *  HELPERS
 * ========================= */
export function normStr(v){ return (v===null||v===undefined) ? "" : String(v).trim(); }
export function round1(x){ return Math.round(x*10)/10; }
export function minutesBetween(a,b){ return (b-a)/60000; }

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

  // tie-break: usa l'ora del primo evento
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
 *  SUPPORTI + INDIRETTE
 * ========================= */
export function mapEffectiveOperator(srcOp, ts){
  const rules = (state.supportRules.get(srcOp) || []).slice().sort((a,b)=>a.start-b.start);
  for(const r of rules){
    if(ts >= r.start && ts < r.end) return r.realOp;
  }
  return srcOp;
}

export function addSupportRule(srcOp, realOp, start, end){
  if(!srcOp || !realOp) throw new Error("Supporto: srcOp/realOp mancanti.");
  if(!(start instanceof Date) || !(end instanceof Date) || !(end>start)) throw new Error("Supporto: intervallo non valido.");
  const cur = (state.supportRules.get(srcOp) || []).slice();
  cur.push({ realOp, start, end });
  cur.sort((a,b)=>a.start-b.start);
  state.supportRules.set(srcOp, cur);
}

export function removeSupportRule(srcOp, idx){
  const cur = (state.supportRules.get(srcOp) || []).slice();
  if(idx<0 || idx>=cur.length) return;
  cur.splice(idx,1);
  if(cur.length) state.supportRules.set(srcOp, cur); else state.supportRules.delete(srcOp);
}

export function addIndirectRule(op, dayKey, start, end, desc){
  if(!op || !dayKey) throw new Error("Indiretta: op/dayKey mancanti.");
  if(!(start instanceof Date) || !(end instanceof Date) || !(end>start)) throw new Error("Indiretta: intervallo non valido.");
  const dm = state.indirectRules.get(op) || new Map();
  const cur = (dm.get(dayKey) || []).slice();
  cur.push({ start, end, desc: desc||"" });
  cur.sort((a,b)=>a.start-b.start);
  dm.set(dayKey, cur);
  state.indirectRules.set(op, dm);
}

export function removeIndirectRule(op, dayKey, idx){
  const dm = state.indirectRules.get(op);
  if(!dm) return;
  const cur = (dm.get(dayKey) || []).slice();
  if(idx<0 || idx>=cur.length) return;
  cur.splice(idx,1);
  if(cur.length) dm.set(dayKey, cur); else dm.delete(dayKey);
  if(dm.size) state.indirectRules.set(op, dm); else state.indirectRules.delete(op);
}

export function setShiftOverride(op, dayKey, code){
  if(!op || !dayKey) return;
  const dm = state.shiftOverride.get(op) || new Map();
  dm.set(dayKey, code || "AUTO");
  state.shiftOverride.set(op, dm);
}

/** =========================
 *  BUILD EVENTS
 * ========================= */
function getOrInitMap(map, key){
  if(!map.has(key)) map.set(key, new Map());
  return map.get(key);
}

function pushEvent(mapOpDay, op, dayKey, ev){
  const m = getOrInitMap(mapOpDay, op);
  if(!m.has(dayKey)) m.set(dayKey, []);
  m.get(dayKey).push(ev);
}

export function buildEventsFromRows(piRows, wtRows){
  const out = new Map();
  const rawPiCounts = [];
  const rawWtTouches = [];

  // PI
  for(const r of (piRows||[])){
    const counter = normStr(r["Counter"]);
    if(!INTEREST_OPERATORS.has(counter)) continue;
    const ts = combineDateTime(r["Count Date"], r["Count Time"]);
    if(!ts) continue;

    const createdBy = normStr(r["Created By"]);
    const storageBin = normStr(r["Storage Bin"]);
    const dayKey = dayKeyFromDate(ts);
    const cat = piCategory(storageBin);
    const self = (counter && counter===createdBy) ? "Yes" : "No";

    pushEvent(out, counter, dayKey, {
      timestamp: ts,
      timestampStr: fmtDateTime(ts),
      operator: counter,
      kind: "PI",
      category: cat,
      selfCount: self,
      storageBin
    });

    const lane = laneFromStorageBin(storageBin);
    if(lane!==null){
      rawPiCounts.push({
        srcOp: counter,
        timestamp: ts,
        dayKey,
        hour: ts.getHours(),
        lane,
        isPick: cat==="PI Pick",
        isBulk: cat==="PI Bulk",
        selfCount: self==="Yes"
      });
    }
  }

  // WT
  for(const r of (wtRows||[])){
    // Ci interessano solo WT con Source Storage Bin valorizzato
    const srcBin = normStr(r["Source Storage Bin"]);
    if(!isNonEmptyBin(srcBin)) continue;

    const createdBy = normStr(r["Created By"]);
    const confirmedBy = normStr(r["Confirmed by"]);
    const srcOp = confirmedBy || createdBy;
    if(!INTEREST_OPERATORS.has(srcOp)) continue;

    const ts = combineDateTime(r["Created On"], r["Created At"]);
    if(!ts) continue;

    const dayKey = dayKeyFromDate(ts);
    const procType = normStr(r["Whse Proc. Type"]);
    const cat = wtCategory(procType);
    const wo = normStr(r["Warehouse Order"]);
    const dstBin = normStr(r["Destination Storage Bin"]);

    pushEvent(out, srcOp, dayKey, {
      timestamp: ts,
      timestampStr: fmtDateTime(ts),
      operator: srcOp,
      kind: "WT",
      category: cat,
      woId: wo,
      srcBin,
      dstBin
    });

    // Heatmap "Task": conteggio corsie per ora su Source, e per P2P anche Destination
    const laneS = laneFromStorageBin(srcBin);
    if(laneS!==null) rawWtTouches.push({ srcOp, timestamp: ts, dayKey, hour: ts.getHours(), lane: laneS });
    if(cat==="P2P"){
      const laneD = laneFromStorageBin(dstBin);
      if(laneD!==null) rawWtTouches.push({ srcOp, timestamp: ts, dayKey, hour: ts.getHours(), lane: laneD });
    }
  }

  // Sort
  for(const [, m] of out.entries()){
    for(const [, list] of m.entries()) list.sort((a,b)=>a.timestamp-b.timestamp);
  }

  return { eventsByOpDay: out, rawPiCounts, rawWtTouches };
}

/** =========================
 *  INTERVAL BUILD
 * ========================= */
function classifyAndSplitInterval(start, end, baseCategory, shiftStart, shiftEnd){
  const a = start.getTime(), b=end.getTime();
  if(b<=a) return { inside:[], outMinutes:0 };

  const inStart = Math.max(a, shiftStart.getTime());
  const inEnd   = Math.min(b, shiftEnd.getTime());

  const inside=[];
  if(inEnd > inStart){
    inside.push({
      start: new Date(inStart),
      end: new Date(inEnd),
      minutes: round1((inEnd-inStart)/60000),
      category: baseCategory
    });
  }
  const outMin = ((b-a)/60000) - (inEnd>inStart ? (inEnd-inStart)/60000 : 0);
  return { inside, outMinutes: Math.max(0, outMin) };
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

    let remaining=[{ start:it.start, end:it.end }];
    for(const rule of valid){
      const next=[];
      for(const seg of remaining){
        const a = Math.max(seg.start.getTime(), rule.start.getTime());
        const b = Math.min(seg.end.getTime(), rule.end.getTime());
        if(b<=a){ next.push(seg); continue; }

        // pausa prima
        if(seg.start.getTime() < a){
          const s1=seg.start, e1=new Date(a);
          out.push({
            ...it,
            start:s1,end:e1,startStr:fmtDateTime(s1),endStr:fmtDateTime(e1),
            minutes: round1(minutesBetween(s1,e1)),
            category:"PAUSA",
            notes:"Pausa",
            piBins:0,selfCount:0,woId:""
          });
        }
        // indiretta
        const s2=new Date(a), e2=new Date(b);
        out.push({
          ...it,
          start:s2,end:e2,startStr:fmtDateTime(s2),endStr:fmtDateTime(e2),
          minutes: round1(minutesBetween(s2,e2)),
          category:"INDIRETTA",
          notes: rule.desc ? `Indiretta: ${rule.desc}` : "Indiretta",
          piBins:0,selfCount:0,woId:""
        });
        if(b < seg.end.getTime()) next.push({ start:new Date(b), end:seg.end });
      }
      remaining=next;
      if(!remaining.length) break;
    }
    for(const seg of remaining){
      out.push({
        ...it,
        start:seg.start,end:seg.end,startStr:fmtDateTime(seg.start),endStr:fmtDateTime(seg.end),
        minutes: round1(minutesBetween(seg.start,seg.end)),
        category:"PAUSA",
        notes:"Pausa",
        piBins:0,selfCount:0,woId:""
      });
    }
  }
  out.sort((a,b)=>a.start-b.start);
  return out;
}

/** =========================
 *  REBUILD DERIVED
 * ========================= */
export function rebuildDerived(){
  state.derivedIntervalsByOpDay = new Map();
  state.shiftByOpDay = new Map();
  state.piCounts = [];
  state.wtTouches = [];

  // Remap events -> effective operator
  const effEventsByOpDay = new Map();
  for(const [srcOp, dayMap] of state.eventsByOpDay.entries()){
    for(const [dayKey, events] of dayMap.entries()){
      for(const e of events){
        const effOp = mapEffectiveOperator(srcOp, e.timestamp);
        const m = getOrInitMap(effEventsByOpDay, effOp);
        if(!m.has(dayKey)) m.set(dayKey, []);
        m.get(dayKey).push({ ...e, operator: effOp, _srcOp: srcOp });
      }
    }
  }
  for(const [, m] of effEventsByOpDay.entries()){
    for(const [, list] of m.entries()) list.sort((a,b)=>a.timestamp-b.timestamp);
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
        const isPause = (gap >= PAUSE_THRESHOLD_MIN) || (gap > MAX_WORK_GAP_MIN);
        if(isPause){
          baseCat="PAUSA";
          notes=`Gap ${Math.round(gap)} min`;
        }else{
          if(curr.kind==="PI"){
            piBins=1;
            if(curr.selfCount==="Yes") selfCount=1;
            if(selfCount) notes = `Self Count`;
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
    state.piCounts.push({ op:effOp, dayKey:r.dayKey, hour:r.hour, lane:r.lane, isPick:r.isPick, isBulk:r.isBulk, selfCount:r.selfCount });
  }

  // WT touches remap
  for(const r of state.rawWtTouches){
    const effOp = mapEffectiveOperator(r.srcOp, r.timestamp);
    state.wtTouches.push({ op:effOp, dayKey:r.dayKey, hour:r.hour, lane:r.lane });
  }
}

/** =========================
 *  XLSX READ + ANALYZE ENTRY
 * ========================= */
async function readFirstSheetAsObjects(file){
  // XLSX è atteso su window (da CDN)
  const XLSX = window.XLSX;
  if(!XLSX) throw new Error("XLSX non disponibile. Carica xlsx.full.min.js.");
  const arrayBuffer = await file.arrayBuffer();
  const wb = XLSX.read(arrayBuffer, { type:"array", cellDates:true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval:"" });
}

export async function analyzeFromFiles(piFiles, wtFiles){
  // reset dataset ma NON le regole utente (support/indirect) – quelle vengono tenute e riapplicate
  state.eventsByOpDay = new Map();
  state.rawPiCounts = [];
  state.rawWtTouches = [];

  const piRowsAll=[];
  const wtRowsAll=[];

  for(const f of (piFiles||[])){
    const rows = await readFirstSheetAsObjects(f);
    piRowsAll.push(...rows);
  }
  for(const f of (wtFiles||[])){
    const rows = await readFirstSheetAsObjects(f);
    wtRowsAll.push(...rows);
  }

  const { eventsByOpDay, rawPiCounts, rawWtTouches } = buildEventsFromRows(piRowsAll, wtRowsAll);
  state.eventsByOpDay = eventsByOpDay;
  state.rawPiCounts = rawPiCounts;
  state.rawWtTouches = rawWtTouches;

  rebuildDerived();
  await saveSnapshot();
}

/** =========================
 *  AGGREGATION (KPI)
 * ========================= */
export function listOperators(){
  return Array.from(state.derivedIntervalsByOpDay.keys()).sort((a,b)=>a.localeCompare(b));
}

export function computeAllDayKeys(){
  const keys=new Set();
  for(const [, dayMap] of state.derivedIntervalsByOpDay.entries()){
    for(const [dk] of dayMap.entries()) keys.add(dk);
  }
  return Array.from(keys).sort((a,b)=>a.localeCompare(b));
}

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

export function computeShiftLabelForOp(op, dayKeys){
  const dm = state.shiftByOpDay.get(op);
  if(!dm) return "—";
  const counts={AM:0,C:0,PM:0};
  for(const dk of dayKeys){
    const sh = dm.get(dk);
    if(sh?.code) counts[sh.code] += 1;
  }
  const best = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0];
  if(!best) return "—";
  const inferredSome = dayKeys.some(dk => dm.get(dk)?.inferred);
  return inferredSome ? `${best} (AUTO)` : best;
}

export function aggregateForOp(op, dayKeys){
  const intervals = concatIntervalsForOp(op, dayKeys);
  if(!intervals.length) return null;

  const byDay = new Set(dayKeys.filter(dk => (state.derivedIntervalsByOpDay.get(op)?.get(dk)||[]).length));
  const dayCount = byDay.size;

  let minPiPick=0, minPiBulk=0, minP2P=0, minClean=0, minOther=0, minIndirect=0, minPause=0;
  let piPickBins=0, piBulkBins=0, selfCountBins=0;
  const woP2P=new Set(), woClean=new Set(), woOther=new Set();

  // cambi task: conta transizioni tra categorie "operative" (PI Pick/Bulk/P2P/Clean/WT Other)
  let switchCount=0;
  let switchMin=0;
  let prevWorkCat=null;
  let prevEnd=null;

  for(const it of intervals){
    const m = Number(it.minutes||0);
    const cat = it.category;
    if(cat==="PAUSA") { minPause+=m; continue; }
    if(cat==="INDIRETTA") { minIndirect+=m; continue; }

    if(cat==="PI Pick") { minPiPick+=m; piPickBins += Number(it.piBins||0); selfCountBins += Number(it.selfCount||0); }
    else if(cat==="PI Bulk") { minPiBulk+=m; piBulkBins += Number(it.piBins||0); selfCountBins += Number(it.selfCount||0); }
    else if(cat==="P2P") { minP2P+=m; if(it.woId) woP2P.add(it.woId); }
    else if(cat==="Clean PICK") { minClean+=m; if(it.woId) woClean.add(it.woId); }
    else { minOther+=m; if(it.woId) woOther.add(it.woId); }

    // switch logic
    const isWork = ["PI Pick","PI Bulk","P2P","Clean PICK","WT Other"].includes(cat);
    if(isWork){
      if(prevWorkCat!==null && cat!==prevWorkCat){
        switchCount += 1;
        if(prevEnd) switchMin += Math.max(0, minutesBetween(prevEnd, it.start));
      }
      prevWorkCat = cat;
      prevEnd = it.end;
    }
  }

  return {
    operator: op,
    dayCount,
    shiftLabel: computeShiftLabelForOp(op, Array.from(byDay)),
    minPiPick: round1(minPiPick),
    minPiBulk: round1(minPiBulk),
    minP2P: round1(minP2P),
    minClean: round1(minClean),
    minOther: round1(minOther),
    minIndirect: round1(minIndirect),
    minPause: round1(minPause),
    piPickBins: Math.round(piPickBins),
    piBulkBins: Math.round(piBulkBins),
    selfCountBins: Math.round(selfCountBins),
    woP2P: woP2P.size,
    woClean: woClean.size,
    woOther: woOther.size,
    switchCount,
    switchMin: round1(switchMin)
  };
}

export function buildAggRows(dayKeys){
  const ops = listOperators();
  const rows=[];
  for(const op of ops){
    const r = aggregateForOp(op, dayKeys);
    if(r) rows.push(r);
  }
  return rows;
}

/** =========================
 *  SCORE
 * ========================= */
function tphAndSecTask(timeMin, volume){
  if(!volume || volume<=0 || !timeMin || timeMin<=0) return { tph:0, secPerTask:0 };
  const tph = volume / (timeMin/60);
  const sec = (timeMin*60) / volume;
  return { tph: round1(tph), secPerTask: Math.round(sec) };
}

export function computeDayScore(op, dayKey){
  const dm = state.derivedIntervalsByOpDay.get(op);
  const intervals = dm ? (dm.get(dayKey) || []) : [];
  if(!intervals.length) return null;

  const sh = state.shiftByOpDay.get(op)?.get(dayKey);
  if(!sh) return null;

  const first = intervals[0].start;
  const last = intervals[intervals.length-1].end;
  let actualMin = Math.max(0, minutesBetween(first, last));
  actualMin = Math.min(actualMin, SHIFT_TARGET_MIN);

  let pause=0, indirect=0;
  let piPick=0, piBulk=0, p2p=0, clean=0, other=0;
  let binPick=0, binBulk=0, selfCount=0;
  const woP2P=new Set(), woClean=new Set(), woOther=new Set();
  let switchCount=0, switchMin=0;

  let prevWorkCat=null;
  let prevEnd=null;

  for(const it of intervals){
    const m = Number(it.minutes||0);
    const cat = it.category;
    if(cat==="PAUSA"){ pause+=m; continue; }
    if(cat==="INDIRETTA"){ indirect+=m; continue; }

    if(cat==="PI Pick"){ piPick+=m; binPick+=Number(it.piBins||0); selfCount+=Number(it.selfCount||0); }
    else if(cat==="PI Bulk"){ piBulk+=m; binBulk+=Number(it.piBins||0); selfCount+=Number(it.selfCount||0); }
    else if(cat==="P2P"){ p2p+=m; if(it.woId) woP2P.add(it.woId); }
    else if(cat==="Clean PICK"){ clean+=m; if(it.woId) woClean.add(it.woId); }
    else { other+=m; if(it.woId) woOther.add(it.woId); }

    const isWork = ["PI Pick","PI Bulk","P2P","Clean PICK","WT Other"].includes(cat);
    if(isWork){
      if(prevWorkCat!==null && cat!==prevWorkCat){
        switchCount += 1;
        if(prevEnd) switchMin += Math.max(0, minutesBetween(prevEnd, it.start));
      }
      prevWorkCat=cat;
      prevEnd=it.end;
    }
  }

  const effProd = piPick+piBulk+p2p+clean+other;
  const effAll = effProd+indirect;
  const inactivity = Math.max(0, SHIFT_TARGET_MIN - actualMin);

  // KPI task speed
  const pi = tphAndSecTask(piPick+piBulk, binPick+binBulk);
  const p2pK = tphAndSecTask(p2p, woP2P.size);
  const cleanK = tphAndSecTask(clean, woClean.size);
  const otherK = tphAndSecTask(other, woOther.size);

  return {
    op, dayKey,
    shift: sh.code,
    targetMin: SHIFT_TARGET_MIN,
    actualMin: Math.round(actualMin),
    inactivityMin: Math.round(inactivity),
    pauseMin: Math.round(pause),
    indirectMin: Math.round(indirect),
    effProdMin: Math.round(effProd),
    effAllMin: Math.round(effAll),

    piPickMin: round1(piPick),
    piBulkMin: round1(piBulk),
    p2pMin: round1(p2p),
    cleanMin: round1(clean),
    otherMin: round1(other),

    binPick: Math.round(binPick),
    binBulk: Math.round(binBulk),
    selfCount: Math.round(selfCount),
    woP2P: woP2P.size,
    woClean: woClean.size,
    woOther: woOther.size,
    switchCount,
    switchMin: round1(switchMin),

    tphPI: pi.tph,
    secPI: pi.secPerTask,
    tphP2P: p2pK.tph,
    secP2P: p2pK.secPerTask,
    tphClean: cleanK.tph,
    secClean: cleanK.secPerTask,
    tphOther: otherK.tph,
    secOther: otherK.secPerTask
  };
}

export function buildScore(dayKeys){
  const ops = listOperators();
  const daySet = new Set(dayKeys);
  const daily=[];
  for(const op of ops){
    const dm = state.derivedIntervalsByOpDay.get(op);
    if(!dm) continue;
    for(const dk of Array.from(dm.keys()).sort()){
      if(!daySet.has(dk)) continue;
      const r = computeDayScore(op, dk);
      if(r) daily.push(r);
    }
  }

  // Aggregato per operatore
  const byOp=new Map();
  for(const r of daily){
    const a = byOp.get(r.op) || {
      op:r.op,
      dayCount:0,
      shifts:new Map(),
      targetMin:0, actualMin:0, inactivityMin:0, pauseMin:0, indirectMin:0, effProdMin:0, effAllMin:0,
      piPickMin:0, piBulkMin:0, p2pMin:0, cleanMin:0, otherMin:0,
      binPick:0, binBulk:0, selfCount:0,
      woP2P:0, woClean:0, woOther:0,
      switchCount:0, switchMin:0
    };
    a.dayCount += 1;
    a.shifts.set(r.shift, (a.shifts.get(r.shift)||0)+1);
    for(const k of ["targetMin","actualMin","inactivityMin","pauseMin","indirectMin","effProdMin","effAllMin",
      "piPickMin","piBulkMin","p2pMin","cleanMin","otherMin","binPick","binBulk","selfCount","woP2P","woClean","woOther","switchCount","switchMin"]){
      a[k] += Number(r[k]||0);
    }
    byOp.set(r.op, a);
  }

  const agg=[];
  for(const a of byOp.values()){
    const bestShift = Array.from(a.shifts.entries()).sort((x,y)=>y[1]-x[1])[0]?.[0] || "—";
    agg.push({
      operator:a.op,
      dayCount:a.dayCount,
      shiftLabel: bestShift,
      targetMin: Math.round(a.targetMin),
      actualMin: Math.round(a.actualMin),
      inactivityMin: Math.round(a.inactivityMin),
      pauseMin: round1(a.pauseMin),
      indirectMin: round1(a.indirectMin),
      effProdMin: round1(a.effProdMin),
      effAllMin: round1(a.effAllMin),
      piPickMin: round1(a.piPickMin),
      piBulkMin: round1(a.piBulkMin),
      p2pMin: round1(a.p2pMin),
      cleanMin: round1(a.cleanMin),
      otherMin: round1(a.otherMin),
      binPick: Math.round(a.binPick),
      binBulk: Math.round(a.binBulk),
      selfCount: Math.round(a.selfCount),
      woP2P: Math.round(a.woP2P),
      woClean: Math.round(a.woClean),
      woOther: Math.round(a.woOther),
      switchCount: Math.round(a.switchCount),
      switchMin: round1(a.switchMin)
    });
  }
  agg.sort((x,y)=>x.operator.localeCompare(y.operator));

  return { daily, agg };
}

/** =========================
 *  HEATMAP MATRICES (Charts)
 *  - PI: conteggi per (ora, corsia)
 *  - WT: conteggi per (ora, corsia) su source + (per P2P anche dest)
 * ========================= */
export function buildHeatmapHourLane(kind, dayKeys){
  const daySet = new Set(dayKeys);
  const hours=[]; for(let h=5; h<=22; h++) hours.push(h);
  const lanes=[]; for(let l=1; l<=50; l++) lanes.push(l);
  const z = hours.map(()=>lanes.map(()=>0)); // y=hours, x=lanes

  const rows = kind==="PI" ? state.piCounts : state.wtTouches;
  for(const r of rows){
    if(!daySet.has(r.dayKey)) continue;
    if(r.hour<5 || r.hour>22) continue;
    if(!r.lane || r.lane<1 || r.lane>50) continue;
    const yi = r.hour-5;
    const xi = r.lane-1;
    z[yi][xi] += 1;
  }
  return { hours, lanes, z };
}

export function buildPieBins(dayKeys){
  const daySet=new Set(dayKeys);
  const out = new Map(); // op -> {pick, bulk}
  for(const r of state.piCounts){
    if(!daySet.has(r.dayKey)) continue;
    const cur = out.get(r.op) || { pick:0, bulk:0 };
    if(r.isPick) cur.pick += 1;
    if(r.isBulk) cur.bulk += 1;
    out.set(r.op, cur);
  }
  return out;
}

/** =========================
 *  SELECTION UTILITIES (Days/Weeks/Months)
 * ========================= */
function isoWeek(d){
  // ISO week number
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1)/7);
  return { year: date.getUTCFullYear(), week: weekNo };
}

export function groupDayKeys(dayKeys){
  const days = (dayKeys||[]).slice().sort();
  const byMonth=new Map();
  const byWeek=new Map();
  for(const dk of days){
    const d = dayKeyToDate(dk);
    if(!d) continue;
    const ym = dk.slice(0,7); // YYYY-MM
    byMonth.set(ym, (byMonth.get(ym)||[]).concat([dk]));
    const w = isoWeek(d);
    const wk = `${w.year}-W${String(w.week).padStart(2,"0")}`;
    byWeek.set(wk, (byWeek.get(wk)||[]).concat([dk]));
  }
  return { byMonth, byWeek, days };
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
      if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{ keyPath:"id" });
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

function serMapOfMaps(map, serLeafFn){
  const obj={};
  for(const [k1, dm] of map.entries()){
    obj[k1]={};
    for(const [k2, v] of dm.entries()) obj[k1][k2]=serLeafFn(v);
  }
  return obj;
}

function deMapOfMaps(obj, deLeafFn){
  const map=new Map();
  if(!obj) return map;
  for(const k1 of Object.keys(obj)){
    const dm=new Map();
    for(const k2 of Object.keys(obj[k1]||{})) dm.set(k2, deLeafFn(obj[k1][k2]));
    map.set(k1, dm);
  }
  return map;
}

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
  return serMapOfMaps(state.shiftOverride, (v)=>v);
}
function deShiftOv(obj){
  return deMapOfMaps(obj, (v)=>v);
}

function serIndirect(){
  return serMapOfMaps(state.indirectRules, (list)=>(list||[]).map(r=>({ start:r.start.toISOString(), end:r.end.toISOString(), desc:r.desc||"" })));
}
function deIndirect(obj){
  return deMapOfMaps(obj, (list)=>(list||[]).map(r=>({ start:new Date(r.start), end:new Date(r.end), desc:r.desc||"" })));
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
        timestampStr: e.timestampStr || fmtDateTime(new Date(e.timestamp))
      })));
    }
    m.set(op, dm);
  }
  return m;
}

function serRowsWithTS(arr){
  return (arr||[]).map(r=>({ ...r, timestamp:r.timestamp.toISOString() }));
}
function deRowsWithTS(arr){
  return (arr||[]).map(r=>({ ...r, timestamp:new Date(r.timestamp) }));
}

export async function saveSnapshot(){
  const doc={
    id: SNAP_ID,
    savedAt: new Date().toISOString(),
    eventsByOpDay: serEvents(),
    rawPiCounts: serRowsWithTS(state.rawPiCounts),
    rawWtTouches: serRowsWithTS(state.rawWtTouches),
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
  state.rawPiCounts = deRowsWithTS(doc.rawPiCounts);
  state.rawWtTouches = deRowsWithTS(doc.rawWtTouches);
  state.supportRules = deSupport(doc.supportRules);
  state.shiftOverride = deShiftOv(doc.shiftOverride);
  state.indirectRules = deIndirect(doc.indirectRules);

  rebuildDerived();
  return { ok:true, savedAt: doc.savedAt };
}

export async function clearSnapshot(){
  await idbDel(SNAP_ID);
}
