/* app-core.js (minimal, ASCII-only)
   Shared utilities for Monitor Counter (Supabase + helpers)
*/
(function () {
  'use strict';

  // CONFIG (public)
  // You can override these via localStorage:
  //   mc_supabase_url
  //   mc_supabase_key
  const DEFAULT_SUPABASE_URL = 'https://jslonbsvrtltfnrpneqw.supabase.co';
  const DEFAULT_SUPABASE_KEY = 'sb_publishable_OZZhrdcM8Zh3eXcqTdcljw_ZY4faGvl';

  function getSupabaseUrl() {
    return localStorage.getItem('mc_supabase_url') || DEFAULT_SUPABASE_URL;
  }
  function getSupabaseKey() {
    return localStorage.getItem('mc_supabase_key') || DEFAULT_SUPABASE_KEY;
  }

  function createClientSafe() {
    if (!window.supabase || !window.supabase.createClient) return null;
    try {
      return window.supabase.createClient(getSupabaseUrl(), getSupabaseKey());
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  const sb = createClientSafe();

  function pad2(n) { return String(n).padStart(2, '0'); }

  function dayKeyFromDate(dt) {
    const y = dt.getFullYear();
    const m = pad2(dt.getMonth() + 1);
    const d = pad2(dt.getDate());
    return y + '-' + m + '-' + d;
  }

  function fmtDDMMYYYY(dayKey) {
    const m = String(dayKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(dayKey || '');
    return m[3] + '-' + m[2] + '-' + m[1];
  }

  function laneFromBin(bin) {
    const s = String(bin || '').trim();
    const m = s.match(/^(\d{2})/);
    if (!m) return null;
    const v = parseInt(m[1], 10);
    if (!isFinite(v) || v < 1 || v > 50) return null;
    return v;
  }

  function wtCategory(procType) {
    const p = String(procType || '').trim();
    if (p === '9994' || p === '9995') return 'P2P';
    if (p === '3060' || p === '3062' || p === '3040' || p === '3041' || p === '3042') return 'Clean PICK';
    return 'WT Other';
  }

  const KEY_ACTIVE_DATASET = 'mc_active_dataset_id';
  const KEY_SELECTION_PREFIX = 'mc_sel_days_';

  function getActiveDatasetId() { return localStorage.getItem(KEY_ACTIVE_DATASET) || ''; }
  function setActiveDatasetId(id) { localStorage.setItem(KEY_ACTIVE_DATASET, id || ''); }

  function getSelection(datasetId) {
    try {
      const raw = localStorage.getItem(KEY_SELECTION_PREFIX + datasetId);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }
  function setSelection(datasetId, obj) {
    localStorage.setItem(KEY_SELECTION_PREFIX + datasetId, JSON.stringify(obj || {}));
  }
  function selectionDayKeys(obj) {
    return Object.keys(obj || {}).sort();
  }

  async function fetchDatasets() {
    if (!sb) throw new Error('Supabase client not available');
    const { data, error } = await sb.from('datasets')
      .select('id,label,created_at,start_date,end_date')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }

  window.AppCore = {
    sb,
    getSupabaseUrl,
    getSupabaseKey,
    createClientSafe,

    dayKeyFromDate,
    fmtDDMMYYYY,

    laneFromBin,
    wtCategory,

    getActiveDatasetId,
    setActiveDatasetId,

    getSelection,
    setSelection,
    selectionDayKeys,

    fetchDatasets
  };
})();
