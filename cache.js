/* cache.js — SBCache: cache navegador-side con IndexedDB + SWR + preload */
(function (global) {
  "use strict";

  const SBCache = {
    _now: () => Date.now(),
    _fetch: (typeof fetch !== "undefined") ? fetch.bind(globalThis) : null,
    _indexedDB: (typeof indexedDB !== "undefined") ? indexedDB : null,

    init: async function () { throw new Error("not implemented"); },
    get: async function () { throw new Error("not implemented"); },
    preload: async function () { throw new Error("not implemented"); },
    invalidateAll: async function () { throw new Error("not implemented"); },
    on: function () { throw new Error("not implemented"); },
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
