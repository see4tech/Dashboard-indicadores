/* cache.js — SBCache: cache navegador-side con IndexedDB + SWR + preload */
(function (global) {
  "use strict";

  const SBCache = {
    _now: () => Date.now(),
    _fetch: (typeof fetch !== "undefined") ? fetch.bind(globalThis) : null,
    _indexedDB: (typeof indexedDB !== "undefined") ? indexedDB : null,

    init: null,  // assigned below
    _mode: null,
    get: null,  // assigned below
    preload: async function () { throw new Error("not implemented"); },
    invalidateAll: null,  // assigned below
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
  const _revalidating = new Set();

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

  function _normalizeBody(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      if ("Data" in parsed) return parsed.Data;
      if (parsed.Succeeded === false) return [];
    }
    return parsed;
  }

  function _buildRecord(url, body, status) {
    const periodoFinal = SBCache.parsePeriodoFinal(url);
    const now = SBCache._now();
    const policy = SBCache.policyFor(periodoFinal, now);
    return {
      url, body, status,
      fetchedAt: now,
      periodoFinal,
      expiresAt: policy.ttlMs == null ? null : now + policy.ttlMs,
      schemaVersion: 1,
    };
  }

  async function _safePut(rec) {
    try { await SBCache._idbPut(rec); }
    catch (e) { /* quota se maneja en Task 13 (eviction) */ }
  }

  async function _fetchAndPersist(url) {
    const r = await SBCache._fetch(url, { headers: { "Accept": "application/json" } });
    if (r.status === 204) {
      const empty = [];
      const rec = _buildRecord(url, empty, 204);
      await _safePut(rec);
      _l1.set(url, rec);
      return empty;
    }
    let parsed;
    try { parsed = await r.json(); } catch { parsed = null; }
    if (!r.ok) {
      const msg = (parsed && parsed.Message) || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    const body = _normalizeBody(parsed);
    const rec = _buildRecord(url, body, r.status);
    await _safePut(rec);
    _l1.set(url, rec);
    return body;
  }

  function _bodyEqual(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch { return false; }
  }

  function _scheduleRevalidate(url, prev) {
    if (_revalidating.has(url)) return;
    _revalidating.add(url);
    (async () => {
      try {
        const r = await SBCache._fetch(url, { headers: { "Accept": "application/json" } });
        if (r.status === 204) {
          const empty = [];
          const rec = _buildRecord(url, empty, 204);
          await _safePut(rec);
          _l1.set(url, rec);
          if (!_bodyEqual(prev.body, empty)) SBCache._emit("updated", { url });
          return;
        }
        const parsed = await r.json().catch(() => null);
        if (!r.ok) {
          SBCache._emit("error", { url, message: `HTTP ${r.status}` });
          return;
        }
        const body = _normalizeBody(parsed);
        const rec = _buildRecord(url, body, r.status);
        await _safePut(rec);
        _l1.set(url, rec);
        if (!_bodyEqual(prev.body, body)) SBCache._emit("updated", { url });
      } catch (e) {
        SBCache._emit("error", { url, message: e.message || String(e) });
      } finally {
        _revalidating.delete(url);
      }
    })();
  }

  async function _getOrFetch(url) {
    const now = SBCache._now();
    // L1
    const l1 = _l1.get(url);
    if (l1 && (l1.expiresAt == null || l1.expiresAt > now)) return l1.body;
    // L2
    const l2 = await SBCache._idbGet(url);
    if (l2) {
      const fresh = (l2.expiresAt == null || l2.expiresAt > now);
      if (fresh) {
        _l1.set(url, l2);
        return l2.body;
      }
      const policy = SBCache.policyFor(l2.periodoFinal, now);
      if (policy.swr) {
        _scheduleRevalidate(url, l2);
        _l1.set(url, l2);
        return l2.body;
      }
    }
    return _fetchAndPersist(url);
  }

  SBCache.get = async function (url) {
    if (!SBCache._mode) await SBCache.init();
    // Bypass para URLs no /api/
    if (!url.startsWith("/api/")) {
      const r = await SBCache._fetch(url);
      if (r.status === 204) return [];
      return _normalizeBody(await r.json());
    }
    // dedup: cualquier llamada concurrente comparte la misma promesa
    if (_inflight.has(url)) return _inflight.get(url);
    const p = _getOrFetch(url).finally(() => _inflight.delete(url));
    _inflight.set(url, p);
    return p;
  };

  function _tx(mode) {
    return _db.transaction(STORE, mode).objectStore(STORE);
  }

  SBCache._idbGet = function (url) {
    return new Promise((resolve, reject) => {
      if (SBCache._mode !== "idb") return resolve(undefined);
      const r = _tx("readonly").get(url);
      r.onsuccess = () => resolve(r.result || undefined);
      r.onerror = () => reject(r.error);
    });
  };

  SBCache._idbPut = function (record) {
    return new Promise((resolve, reject) => {
      if (SBCache._mode !== "idb") return resolve();
      const r = _tx("readwrite").put(record);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  };

  SBCache._idbClear = function () {
    return new Promise((resolve, reject) => {
      if (SBCache._mode !== "idb") return resolve();
      const r = _tx("readwrite").clear();
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  };

  SBCache._idbGetAll = function () {
    return new Promise((resolve, reject) => {
      if (SBCache._mode !== "idb") return resolve([]);
      const r = _tx("readonly").getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  };

  SBCache._idbDelete = function (url) {
    return new Promise((resolve, reject) => {
      if (SBCache._mode !== "idb") return resolve();
      const r = _tx("readwrite").delete(url);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  };

  SBCache.invalidateAll = async function () {
    _l1.clear();
    await SBCache._idbClear();
  };

  SBCache._closeForTests = function () {
    if (_db) { try { _db.close(); } catch (e) {} _db = null; }
    _l1.clear();
    _inflight.clear();
    _revalidating.clear();
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
