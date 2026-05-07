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
    policyFor: function () { throw new Error("not implemented"); },
    buildPreloadJobs: function () { throw new Error("not implemented"); },
  };

  global.SBCache = SBCache;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SBCache;
  }
})(typeof window !== "undefined" ? window : globalThis);
