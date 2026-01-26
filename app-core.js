/* app-core.js — Supabase shared core (NO ES modules) */
(function () {
  "use strict";

  const SUPABASE_URL = "https://jslonbsvrtltfnrpneqw.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_OZZhrdcM8Zh3eXcqTdcljw_ZY4faGvl";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const PAUSE_THRESHOLD_MIN = 30;
  const SHIFT_DEFS = {
    AM: { start: "05:00", end: "13:00" },
    C:  { start: "08:00", end: "16:00" },
    PM: { start: "14:00", end: "22:00" },
  };

  const KEY_ACTIVE_DS = "mc_active_dataset_id";
  const KEY_SEL_PREFIX = "mc_selected_days_"; // + datasetId

  function p2(n) { return String(n).padStart(2, "0"); }
  function dayKeyFromDate(d) {
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }
  function fmtDDMMYYYY(dayKey) {
    const d = new Date(dayKey + "T00:00:00");
    if (isNaN(d.getTime())) return dayKey;
    return `${p2(d.getDate())}-${p2(d.getMonth()+1)}-${d.getFullYear()}`;
  }
  function minToHHMM(min) {
    const total = Math.max(0, Math.round(Number(min || 0)));
    const h = Math.floor(total / 60), m = total % 60;
    return `${h}:${p2(m)}`;
  }

  function laneFromBin(bin) {
    const s = String(bin || "").trim();
    if (!s) return null;
    const m = s.match(/(\d{2})/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!isFinite(n) || n < 1 || n > 50) return null;
    return n;
  }
  function isPickBin(bin) {
    const s = String(bin || "").trim();
    if (!s) return false;
    const parts = s.split("-");
    return parts[parts.length - 1] === "1";
  }
  function wtCategory(procType) {
    const n = parseInt(procType, 10);
    if (n === 9994 || n === 9995) return "P2P";
    if (n === 3060 || n === 3062 || n === 3040 || n === 3041 || n === 3042) return "Clean PICK";
    return "WT Other";
  }

  function setActiveDatasetId(id) { localStorage.setItem(KEY_ACTIVE_DS, id || ""); }
  function getActiveDatasetId() { return localStorage.getItem(KEY_ACTIVE_DS) || ""; }

  function getSelection(datasetId) {
    try {
      const raw = localStorage.getItem(KEY_SEL_PREFIX + datasetId);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  function setSelection(datasetId, selObj) {
    localStorage.setItem(KEY_SEL_PREFIX + datasetId, JSON.stringify(selObj || {}));
  }
  function selectionDayKeys(selObj) {
    return Object.keys(selObj || {})
      .filter(k => !!selObj[k] && (selObj[k].pi || selObj[k].wt))
      .sort();
  }

  async function fetchDatasets() {
    const { data, error } = await sb
      .from("datasets")
      .select("id, created_at, label, start_date, end_date, notes")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }

  async function fetchEvents(datasetId, dayKeys) {
    let q = sb.from("events")
      .select("id, dataset_id, ts, day_key, src_operator, eff_operator, kind, category, self_count, storage_bin, lane, wo_id, meta")
      .eq("dataset_id", datasetId)
      .order("ts", { ascending: true });
    if (dayKeys && dayKeys.length) q = q.in("day_key", dayKeys);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data || []).map(e => ({
      ...e,
      tsObj: new Date(e.ts),
      day_key: typeof e.day_key === "string" ? e.day_key.slice(0, 10) : e.day_key
    }));
  }

  async function fetchSupportRules(datasetId) {
    const { data, error } = await sb
      .from("support_rules")
      .select("id, dataset_id, src_operator, real_operator, start_ts, end_ts")
      .eq("dataset_id", datasetId)
      .order("start_ts", { ascending: true });
    if (error) throw new Error(error.message);
    return (data || []).map(r => ({
      ...r,
      startObj: new Date(r.start_ts),
      endObj: new Date(r.end_ts),
    }));
  }

  async function fetchIndirectRules(datasetId) {
    const { data, error } = await sb
      .from("indirect_rules")
      .select("id, dataset_id, operator, day_key, start_ts, end_ts, description")
      .eq("dataset_id", datasetId)
      .order("start_ts", { ascending: true });
    if (error) throw new Error(error.message);
    return (data || []).map(r => ({
      ...r,
      day_key: typeof r.day_key === "string" ? r.day_key.slice(0, 10) : r.day_key,
      startObj: new Date(r.start_ts),
      endObj: new Date(r.end_ts),
    }));
  }

  async function fetchShiftOverrides(datasetId) {
    const { data, error } = await sb
      .from("shift_overrides")
      .select("id, dataset_id, operator, day_key, shift_code")
      .eq("dataset_id", datasetId);
    if (error) throw new Error(error.message);
    const map = new Map();
    for (const r of (data || [])) {
      const dk = typeof r.day_key === "string" ? r.day_key.slice(0, 10) : r.day_key;
      map.set(`${r.operator}|${dk}`, r.shift_code);
    }
    return map;
  }

  function applySupportRulesToEvents(events, supportRules) {
    if (!supportRules || !supportRules.length) {
      return events.map(e => ({ ...e, eff_calc: e.eff_operator || e.src_operator }));
    }
    const bySrc = new Map();
    for (const r of supportRules) {
      if (!bySrc.has(r.src_operator)) bySrc.set(r.src_operator, []);
      bySrc.get(r.src_operator).push(r);
    }
    for (const arr of bySrc.values()) arr.sort((a, b) => a.startObj - b.startObj);

    return events.map(e => {
      const src = e.src_operator;
      const arr = bySrc.get(src);
      let eff = e.eff_operator || src;
      if (arr && e.tsObj && !isNaN(e.tsObj.getTime())) {
        for (const r of arr) {
          if (e.tsObj >= r.startObj && e.tsObj < r.endObj) { eff = r.real_operator; break; }
        }
      }
      return { ...e, eff_calc: eff };
    });
  }

  function inferShiftForDay(op, dayKey, events, shiftOverrideMap) {
    const key = `${op}|${dayKey}`;
    const forced = shiftOverrideMap ? (shiftOverrideMap.get(key) || "AUTO") : "AUTO";
    const base = new Date(dayKey + "T00:00:00");

    function windowFor(code) {
      const def = SHIFT_DEFS[code];
      const [sh, sm] = def.start.split(":").map(Number);
      const [eh, em] = def.end.split(":").map(Number);
      return {
        code,
        start: new Date(base.getFullYear(), base.getMonth(), base.getDate(), sh, sm, 0),
        end: new Date(base.getFullYear(), base.getMonth(), base.getDate(), eh, em, 0),
        inferred: false
      };
    }

    if (forced && forced !== "AUTO") return windowFor(forced);

    const first = events && events.length ? events[0].tsObj : null;
    let code = "C";
    if (first && !isNaN(first.getTime())) {
      const hm = first.getHours() * 60 + first.getMinutes();
      if (hm < 7 * 60) code = "AM";
      else if (hm < 12 * 60) code = "C";
      else code = "PM";
    }
    const w = windowFor(code);
    w.inferred = true;
    return w;
  }

  function minutesBetween(a, b) { return (b - a) / 60000; }
  function clampDate(d, a, b) {
    const t = d.getTime();
    return new Date(Math.min(Math.max(t, a.getTime()), b.getTime()));
  }

  function buildIntervalsForOpDay(op, dayKey, events, shiftWin, indirectRules) {
    const aS = shiftWin.start, aE = shiftWin.end;
    const evRaw = (events || []).slice().sort((a, b) => a.tsObj - b.tsObj);

// Deduplicate markers at identical timestamp to avoid zero-gap WT "src/dest" duplicates affecting transitions
const ev = [];
const seen = new Set();
for (const e of evRaw) {
  const ts = e && e.tsObj ? e.tsObj.getTime() : 0;
  const key = [
    ts,
    e.kind || "",
    e.category || "",
    e.wo_id || "",
    e.src_operator || "",
    (e.meta && e.meta.role) ? e.meta.role : ""
  ].join("|");
  // Prefer keeping WT src over WT dest if both exist
  const altKey = [ts, e.kind||"", e.category||"", e.wo_id||"", e.src_operator||""].join("|");
  if (e.kind === "WT" && e.meta && e.meta.role === "dest") {
    if (seen.has(altKey + "|src")) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    continue; // by default do not use dest as timing marker
  }
  if (e.kind === "WT" && e.meta && e.meta.role === "src") {
    if (seen.has(altKey + "|src")) continue;
    seen.add(altKey + "|src");
    ev.push(e);
    continue;
  }
  if (seen.has(key)) continue;
  seen.add(key);
  ev.push(e);
}


    const intervals = [];
    let changeCount = 0;
    let changeTime = 0;
    let prevCat = null;

    for (let i = 1; i < ev.length; i++) {
      const prev = ev[i - 1], cur = ev[i];
      if (!prev.tsObj || !cur.tsObj) continue;

      const rawGap = minutesBetween(prev.tsObj, cur.tsObj);
      if (!(rawGap > 0)) continue;

      const s0 = clampDate(prev.tsObj, aS, aE);
      const e0 = clampDate(cur.tsObj, aS, aE);
      const gap = minutesBetween(s0, e0);
      if (!(gap > 0)) continue;

      const cat = (gap >= PAUSE_THRESHOLD_MIN) ? "PAUSA" : (cur.category || "WT Other");

      if (prevCat && cat !== prevCat) {
        changeCount++;
        if (gap < PAUSE_THRESHOLD_MIN) changeTime += gap;
      }
      prevCat = cat;

      intervals.push({
        start: s0,
        end: e0,
        minutes: gap,
        category: cat,
        srcEvent: cur
      });
    }
    // Tail interval: allocate time from last event to shift end (so last activity is counted)
    if (ev.length >= 1) {
      const last = ev[ev.length - 1];
      if (last && last.tsObj && !isNaN(last.tsObj.getTime())) {
        const sT = clampDate(last.tsObj, aS, aE);
        const eT = aE;
        const tail = minutesBetween(sT, eT);
        if (tail > 0) {
          const tailCat = (tail >= PAUSE_THRESHOLD_MIN) ? "PAUSA" : (last.category || "WT Other");
          intervals.push({
            start: sT,
            end: eT,
            minutes: tail,
            category: tailCat,
            srcEvent: last
          });
        }
      }
    }


    // Split PAUSA into INDIRETTA using indirect_rules
    const ind = (indirectRules || [])
      .filter(r => r.operator === op && r.day_key === dayKey)
      .map(r => ({ start: r.startObj, end: r.endObj, desc: r.description || "" }))
      .filter(r => r.end > r.start)
      .sort((a, b) => a.start - b.start);

    const out = [];
    for (const it of intervals) {
      if (it.category !== "PAUSA" || !ind.length) { out.push(it); continue; }

      let segs = [{ start: it.start, end: it.end }];
      for (const rule of ind) {
        const next = [];
        for (const seg of segs) {
          const a = Math.max(seg.start.getTime(), rule.start.getTime());
          const b = Math.min(seg.end.getTime(), rule.end.getTime());
          if (b <= a) { next.push(seg); continue; }

          if (seg.start.getTime() < a) {
            out.push({ ...it, start: seg.start, end: new Date(a), minutes: (a - seg.start.getTime()) / 60000, category: "PAUSA" });
          }
          out.push({ ...it, start: new Date(a), end: new Date(b), minutes: (b - a) / 60000, category: "INDIRETTA", note: rule.desc });
          if (b < seg.end.getTime()) next.push({ start: new Date(b), end: seg.end });
        }
        segs = next;
        if (!segs.length) break;
      }
      for (const seg of segs) {
        out.push({ ...it, start: seg.start, end: seg.end, minutes: (seg.end - seg.start) / 60000, category: "PAUSA" });
      }
    }
    out.sort((a, b) => a.start - b.start);
    return { intervals: out, changeCount, changeTime };
  }

  function groupSequential(intervals) {
    const groups = [];
    let cur = null;
    for (const it of (intervals || [])) {
      if (!cur || it.category !== cur.category) {
        if (cur) groups.push(cur);
        cur = { category: it.category, start: it.start, end: it.end, minutes: it.minutes, items: [it] };
      } else {
        cur.end = it.end;
        cur.minutes += it.minutes;
        cur.items.push(it);
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  function computeKpisForOpDay(op, dayKey, events, intervals, shiftWin) {
    const sum = new Map();
    for (const it of intervals) sum.set(it.category, (sum.get(it.category) || 0) + it.minutes);

    const shiftMin = minutesBetween(shiftWin.start, shiftWin.end);
    const pauseMin = sum.get("PAUSA") || 0;
    const indMin = sum.get("INDIRETTA") || 0;
    const workMin = Array.from(sum.entries()).filter(([k]) => k !== "PAUSA").reduce((a, [, v]) => a + v, 0);

    const piEvents = events.filter(e => e.kind === "PI");
    const wtEvents = events.filter(e => e.kind === "WT");

    const piPickBins = piEvents.filter(e => e.category === "PI Pick").length;
    const piBulkBins = piEvents.filter(e => e.category === "PI Bulk").length;

    const selfCount = piEvents.filter(e => e.self_count).length;

    const woByCat = (cat) => {
      const s = new Set();
      for (const e of wtEvents) if (e.category === cat && e.wo_id) s.add(e.wo_id);
      return s.size;
    };

    let qtyP2P = 0;
    for (const e of wtEvents) {
      if (e.category === \"P2P\" && e.meta && e.meta.role === \"src\") qtyP2P += Number(e.meta.act_qty || 0) || 0;
    }

    return {
      op, dayKey,
      shiftCode: shiftWin.code,
      shiftMin, workMin, pauseMin, indMin,
      tPiPick: sum.get("PI Pick") || 0,
      tPiBulk: sum.get("PI Bulk") || 0,
      tP2P: sum.get("P2P") || 0,
      tClean: sum.get("Clean PICK") || 0,
      tOther: sum.get("WT Other") || 0,
      piPickBins, piBulkBins,
      selfCount,
      woP2P: woByCat("P2P"),
      woClean: woByCat("Clean PICK"),
      woOther: woByCat("WT Other"),
      qtyP2P
    };
  }

  function aggregateByOperator(kpisList, changeList) {
    const map = new Map();
    for (const k of kpisList) {
      if (!map.has(k.op)) map.set(k.op, {
        op: k.op,
        days: new Set(),
        shiftCodes: new Set(),
        shiftMin: 0, workMin: 0, pauseMin: 0, indMin: 0,
        tPiPick: 0, tPiBulk: 0, tP2P: 0, tClean: 0, tOther: 0,
        piPickBins: 0, piBulkBins: 0, selfCount: 0,
        woP2P: 0, woClean: 0, woOther: 0, qtyP2P: 0,
        changes: 0, tChanges: 0,
      });
      const a = map.get(k.op);
      a.days.add(k.dayKey);
      a.shiftCodes.add(k.shiftCode);
      a.shiftMin += k.shiftMin;
      a.workMin += k.workMin;
      a.pauseMin += k.pauseMin;
      a.indMin += k.indMin;
      a.tPiPick += k.tPiPick;
      a.tPiBulk += k.tPiBulk;
      a.tP2P += k.tP2P;
      a.tClean += k.tClean;
      a.tOther += k.tOther;
      a.piPickBins += k.piPickBins;
      a.piBulkBins += k.piBulkBins;
      a.selfCount += k.selfCount;
      a.woP2P += k.woP2P;
      a.woClean += k.woClean;
      a.woOther += k.woOther;
      a.qtyP2P += k.qtyP2P;
    }
    for (const c of (changeList || [])) {
      if (!map.has(c.op)) continue;
      const a = map.get(c.op);
      a.changes += c.changeCount;
      a.tChanges += c.changeTime;
    }
    return Array.from(map.values()).map(a => ({
      ...a,
      dayCount: a.days.size,
      shift: a.shiftCodes.size === 1 ? Array.from(a.shiftCodes)[0] : "MIX",
    })).sort((x,y)=>x.op.localeCompare(y.op));
  }

  window.AppCore = {
    sb,
    PAUSE_THRESHOLD_MIN,
    SHIFT_DEFS,
    p2, dayKeyFromDate, fmtDDMMYYYY, minToHHMM,
    laneFromBin, isPickBin, wtCategory,
    setActiveDatasetId, getActiveDatasetId,
    getSelection, setSelection, selectionDayKeys,
    fetchDatasets, fetchEvents, fetchSupportRules, fetchIndirectRules, fetchShiftOverrides,
    applySupportRulesToEvents,
    inferShiftForDay,
    buildIntervalsForOpDay,
    groupSequential,
    computeKpisForOpDay,
    aggregateByOperator
  };
})();
