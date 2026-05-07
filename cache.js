/* cache.js — SBCache: cache navegador-side con IndexedDB + SWR + preload */
(function (global) {
  "use strict";

  const SBCache = {
    _now: () => Date.now(),
    _fetch: (typeof fetch !== "undefined") ? fetch.bind(globalThis) : null,
    _indexedDB: (typeof indexedDB !== "undefined") ? indexedDB : null,

    init: null,  // assigned below
    _mode: null,
    get: async function () { throw new Error("not implemented"); },
    preload: async function () { throw new Error("not implemented"); },
    invalidateAll: async function () { throw new Error("not implemented"); },
    on: null,  // assigned below
    policyFor: null,  // assigned below
    buildPreloadJobs: function () { throw new Error("not implemented"); },
  };

  function monthDelta(periodoFinal, now) {
    const [y, m] = periodoFinal.split("-").map(Number);
    const d = new Date(now);
    const refY = d.getUTCFullYear();
    const refM = d.getUTCMonth() + 1;
    return (refY - y) * 12 + (refM - m);
  }

  const DB_NAME = "sb-dashboard-cache";
  const DB_VERSION = 1;
  const STORE = "responses";

  let _db = null;
  const _l1 = new Map();
  const _inflight = new Map();

  SBCache.init = async function () {
    if (SBCache._mode) return;
    if (!SBCache._indexedDB) {
      SBCache._mode = "passthrough";
      return;
    }
    await new Promise((resolve, reject) => {
      const req = SBCache._indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        db.createObjectStore(STORE, { keyPath: "url" });
      };
      req.onsuccess = () => { _db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
    SBCache._mode = "idb";
  };

  SBCache._closeForTests = function () {
    if (_db) { try { _db.close(); } catch (e) {} _db = null; }
    _l1.clear();
    _inflight.clear();
    SBCache._mode = null;
  };

  const _listeners = new Map();

  SBCache.on = function (event, handler) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(handler);
    return function off() { _listeners.get(event)?.delete(handler); };
  };

  SBCache._emit = function (event, payload) {
    const set = _listeners.get(event);
    if (!set) return;
    for (const h of set) {
      try { h(payload); } catch (e) { /* swallow */ }
    }
  };

  SBCache.parsePeriodoFinal = function (url) {
    const qIdx = url.indexOf("?");
    if (qIdx < 0) return null;
    const params = new URLSearchParams(url.slice(qIdx + 1));
    return params.get("periodoFinal");
  };

  SBCache.policyFor = function (periodoFinal, now) {
    const HOUR = 3600 * 1000;
    const DAY  = 24 * HOUR;
    if (!periodoFinal) return { ttlMs: HOUR, swr: true };
    const delta = monthDelta(periodoFinal, now);
    if (delta >= 4) return { ttlMs: null,    swr: false };
    if (delta >= 1) return { ttlMs: DAY,     swr: true  };
    return                 { ttlMs: 6*HOUR, swr: true  };
  };

  global.SBCache = SBCache;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SBCache;
  }
})(typeof window !== "undefined" ? window : globalThis);
