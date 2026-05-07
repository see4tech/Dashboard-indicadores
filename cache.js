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
    preload: null,  // assigned below
    invalidateAll: null,  // assigned below
    on: null,  // assigned below
    policyFor: null,  // assigned below
    buildPreloadJobs: null,  // assigned below
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

  async function _evictOldest(n) {
    const all = await SBCache._idbGetAll();
    all.sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0));
    const toDelete = all.slice(0, n);
    for (const r of toDelete) await SBCache._idbDelete(r.url);
  }

  async function _safePut(rec) {
    try {
      await SBCache._idbPut(rec);
    } catch (e) {
      if (e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""))) {
        try {
          await _evictOldest(30);
          await SBCache._idbPut(rec);
        } catch (e2) { /* degrada a L1 only */ }
      }
    }
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

  const PROBING_PATHS = [
    "/indicadores/morosidad-estresada",
    "/carteras/creditos/tipo",
    "/carteras/creditos/sectores-economicos",
    "/carteras/creditos/moneda",
    "/carteras/creditos/genero",
    "/carteras/creditos/clasificacion-riesgo",
    "/carteras/creditos/facilidad",
    "/carteras/creditos/localidad",
    "/captaciones/moneda",
    "/captaciones/sector-depositante",
    "/captaciones/localidad",
    "/estados/situacion/eif",
    "/estados/resultados/eif",
    "/reclamaciones/eif",
  ];

  const COMPARATIVA_INDICATORS = [
    "ROA (Rentabilidad de los Activos)",
    "Indice de Solvencia",
    "Cartera de Créditos Vencida (Capital y Rendimientos) / Total de Cartera de Crédito Bruta",
    "Total Patrimonio Neto",
  ];

  // El dashboard pide siempre el agregado del sistema pasando los 4 códigos
  // de tipoEntidad (BM/BAyC/AC/ARC). Las URLs precacheadas deben matchear
  // ese formato exacto para servir cache hits a las llamadas reales.
  const PRELOAD_SCOPES = [
    { tipoEntidad: ["BM", "BAyC", "AC", "ARC"] },
  ];

  function _prevMonth(ym) {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function _buildUrl(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === "") continue;
      if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
      else qs.append(k, v);
    }
    const q = qs.toString();
    return `/api${path}${q ? "?" + q : ""}`;
  }

  SBCache.buildPreloadJobs = function (state) {
    const pf = state.periodoFinal;
    const yyyy = pf.split("-")[0];
    const periodoInicial = `${yyyy}-01`;
    const months = [pf, _prevMonth(pf), _prevMonth(_prevMonth(pf))];
    const jobs = [];

    for (const scope of PRELOAD_SCOPES) {
      jobs.push({ url: _buildUrl("/indicadores/principales", {
        periodoInicial, periodoFinal: pf,
        paginas: 1, registros: 200,
        ...scope,
      })});
    }

    for (const path of PROBING_PATHS) {
      for (const scope of PRELOAD_SCOPES) {
        for (const m of months) {
          jobs.push({ url: _buildUrl(path, {
            periodoInicial: m, periodoFinal: m,
            paginas: 1, registros: 5000,
            ...scope,
          })});
        }
      }
    }

    for (const scope of PRELOAD_SCOPES) {
      for (const m of months) {
        jobs.push({ url: _buildUrl("/indicadores/financieros", {
          periodoInicial: m, periodoFinal: m,
          paginas: 1, registros: 5000,
          indicador: COMPARATIVA_INDICATORS,
          ...scope,
        })});
      }
    }

    jobs.push({ url: "/api/mercados" });

    return jobs;
  };

  const PRELOAD_CONCURRENCY = 2;

  SBCache.preload = async function (jobs) {
    const total = jobs.length;
    let done = 0;
    let failed = 0;
    let allFailed = true;

    async function runJob(job) {
      try {
        const now = SBCache._now();
        const existing = _l1.get(job.url) || await SBCache._idbGet(job.url);
        if (existing && (existing.expiresAt == null || existing.expiresAt > now)) {
          if (!_l1.has(job.url)) _l1.set(job.url, existing);
          allFailed = false;
          return;
        }
        await _fetchAndPersist(job.url);
        allFailed = false;
      } catch (e) {
        failed++;
        SBCache._emit("error", { url: job.url, message: e.message || String(e) });
      } finally {
        done++;
        SBCache._emit("progress", { done, total, failed });
      }
    }

    const queue = jobs.slice();
    const workers = Array.from({ length: Math.min(PRELOAD_CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const job = queue.shift();
        await runJob(job);
      }
    });
    await Promise.all(workers);

    if (allFailed && total > 0) {
      SBCache._emit("error", { message: "preload total failure", total_failure: true });
    }
    SBCache._emit("done", { done, failed });
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
