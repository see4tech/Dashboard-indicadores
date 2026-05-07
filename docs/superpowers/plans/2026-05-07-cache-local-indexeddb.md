# Cache Local con IndexedDB — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar un cache navegador-side persistente (IndexedDB) con preload híbrido y stale-while-revalidate, para que los cambios de filtro en el dashboard SB-RD sean instantáneos tras el primer warmup.

**Architecture:** Un módulo nuevo `cache.js` expone `SBCache` (init, get, preload, invalidateAll, on). En `index.html` solo cambia el método `SB.get()` para llamar `SBCache.get(url)` en lugar de `fetch + Map`. La Netlify Function (`netlify/functions/sb-api.js`) y los 8 loaders quedan intactos. Tests con `node --test` (built-in) + `fake-indexeddb`.

**Tech Stack:** Vanilla JS sin build step. IndexedDB API. Node ≥20 test runner. `fake-indexeddb` (devDependency).

**Spec:** `docs/superpowers/specs/2026-05-07-cache-local-indexeddb-design.md`

---

## File Structure

```
.
├── cache.js                          # NUEVO — módulo SBCache (~300 líneas)
├── package.json                      # NUEVO — npm scripts + devDependencies
├── tests/
│   ├── helpers/
│   │   └── setup.js                  # NUEVO — mocks compartidos
│   ├── policy.test.js                # NUEVO — policyFor()
│   ├── url-helpers.test.js           # NUEVO — parsePeriodoFinal, monthDelta
│   ├── init.test.js                  # NUEVO — init/IDB schema
│   ├── get.test.js                   # NUEVO — get() todos los casos
│   ├── invalidate.test.js            # NUEVO — invalidateAll + bypass
│   ├── quota.test.js                 # NUEVO — eviction
│   ├── preload.test.js               # NUEVO — concurrencia, errores
│   └── buildjobs.test.js             # NUEVO — buildPreloadJobs()
├── index.html                        # modificado
├── .gitignore                        # modificado (añadir node_modules)
├── netlify/functions/sb-api.js       # SIN CAMBIOS
└── netlify.toml                      # SIN CAMBIOS
```

---

## Phase 1 — Infraestructura de tests

### Task 1: Crear infraestructura de testing

**Files:**
- Create: `package.json`
- Create: `tests/helpers/setup.js`
- Create: `tests/smoke.test.js`
- Modify: `.gitignore` (añadir `node_modules`)

- [ ] **Step 1: Crear `package.json`**

```json
{
  "name": "dashboard-indicadores-financieros",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "node --test tests/"
  },
  "devDependencies": {
    "fake-indexeddb": "^6.0.0"
  }
}
```

- [ ] **Step 2: Añadir `node_modules` a `.gitignore`**

```
# Append to existing .gitignore
node_modules/
```

- [ ] **Step 3: Instalar dependencia**

Run: `npm install`
Expected: crea `node_modules/` y `package-lock.json` sin errores.

- [ ] **Step 4: Crear `tests/helpers/setup.js`**

```js
// tests/helpers/setup.js
require("fake-indexeddb/auto");

let nextNow = Date.now();
function setNow(ts) { nextNow = ts; }
function now() { return nextNow; }
function advanceMs(ms) { nextNow += ms; }

let fetchMock = null;
let fetchCalls = [];
function setFetchMock(fn) { fetchMock = fn; fetchCalls = []; }
function getFetchCalls() { return fetchCalls; }

globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  if (!fetchMock) throw new Error("fetch mock not configured");
  return fetchMock(String(url), init);
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => k.toLowerCase() === "content-type" ? "application/json" : null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => null,
    text: async () => "",
  };
}

async function resetIDB() {
  // fake-indexeddb global; borrar la DB entre tests
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("sb-dashboard-cache");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

module.exports = {
  setNow, now, advanceMs,
  setFetchMock, getFetchCalls,
  jsonResponse, emptyResponse,
  resetIDB,
};
```

- [ ] **Step 5: Crear `tests/smoke.test.js`**

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { jsonResponse, setFetchMock, getFetchCalls } = require("./helpers/setup");

test("test runner works", () => {
  assert.equal(1 + 1, 2);
});

test("fetch mock works", async () => {
  setFetchMock(async () => jsonResponse({ ok: true }));
  const r = await fetch("/x");
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(getFetchCalls().length, 1);
});

test("indexedDB available", () => {
  assert.ok(typeof indexedDB !== "undefined");
});
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: 3 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore tests/
git commit -m "chore: añadir infraestructura de tests (node --test + fake-indexeddb)"
```

---

### Task 2: Scaffold de `cache.js` con UMD wrapper

**Files:**
- Create: `cache.js`
- Create: `tests/scaffold.test.js`

- [ ] **Step 1: Crear `tests/scaffold.test.js`**

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/setup");
const SBCache = require("../cache.js");

test("SBCache exposes expected methods", () => {
  assert.equal(typeof SBCache.init, "function");
  assert.equal(typeof SBCache.get, "function");
  assert.equal(typeof SBCache.preload, "function");
  assert.equal(typeof SBCache.invalidateAll, "function");
  assert.equal(typeof SBCache.on, "function");
  assert.equal(typeof SBCache.policyFor, "function");
  assert.equal(typeof SBCache.buildPreloadJobs, "function");
});

test("SBCache attaches to globalThis (browser-compat)", () => {
  assert.ok(globalThis.SBCache, "SBCache should be on globalThis");
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -- --test-name-pattern="SBCache"`
Expected: FAIL — `cache.js` no existe.

- [ ] **Step 3: Crear `cache.js` skeleton**

```js
/* cache.js — SBCache: cache navegador-side con IndexedDB + SWR + preload */
(function (global) {
  "use strict";

  const SBCache = {
    // configuración inyectable (tests)
    _now: () => Date.now(),
    _fetch: (typeof fetch !== "undefined") ? fetch.bind(globalThis) : null,
    _indexedDB: (typeof indexedDB !== "undefined") ? indexedDB : null,

    // pública (a implementar)
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
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`
Expected: scaffold tests pass.

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/scaffold.test.js
git commit -m "feat(cache): scaffold de SBCache con UMD wrapper"
```

---

## Phase 2 — Funciones puras + helpers

### Task 3: `policyFor(periodoFinal, now)` — política TTL

**Files:**
- Create: `tests/policy.test.js`
- Modify: `cache.js`

- [ ] **Step 1: Test cases**

```js
// tests/policy.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/setup");
const SBCache = require("../cache.js");

const HOUR = 3600 * 1000;
const DAY  = 24 * HOUR;
const NOW  = Date.UTC(2026, 4, 7); // 2026-05-07

test("policyFor: null periodoFinal → 1h SWR", () => {
  const p = SBCache.policyFor(null, NOW);
  assert.equal(p.ttlMs, HOUR);
  assert.equal(p.swr, true);
});

test("policyFor: mes actual → 6h SWR", () => {
  const p = SBCache.policyFor("2026-05", NOW);
  assert.equal(p.ttlMs, 6 * HOUR);
  assert.equal(p.swr, true);
});

test("policyFor: mes futuro → 6h SWR", () => {
  const p = SBCache.policyFor("2026-06", NOW);
  assert.equal(p.ttlMs, 6 * HOUR);
  assert.equal(p.swr, true);
});

test("policyFor: 1 mes atrás → 24h SWR", () => {
  const p = SBCache.policyFor("2026-04", NOW);
  assert.equal(p.ttlMs, DAY);
  assert.equal(p.swr, true);
});

test("policyFor: 3 meses atrás → 24h SWR", () => {
  const p = SBCache.policyFor("2026-02", NOW);
  assert.equal(p.ttlMs, DAY);
  assert.equal(p.swr, true);
});

test("policyFor: 4 meses atrás → infinito (null), sin SWR", () => {
  const p = SBCache.policyFor("2026-01", NOW);
  assert.equal(p.ttlMs, null);
  assert.equal(p.swr, false);
});

test("policyFor: 12 meses atrás → infinito", () => {
  const p = SBCache.policyFor("2025-05", NOW);
  assert.equal(p.ttlMs, null);
  assert.equal(p.swr, false);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -- --test-name-pattern="policyFor"`
Expected: FAIL — `not implemented`.

- [ ] **Step 3: Implementar en `cache.js`**

Reemplazar `policyFor` placeholder:

```js
function monthDelta(periodoFinal, now) {
  const [y, m] = periodoFinal.split("-").map(Number);
  const d = new Date(now);
  const refY = d.getUTCFullYear();
  const refM = d.getUTCMonth() + 1;
  return (refY - y) * 12 + (refM - m);
}

SBCache.policyFor = function (periodoFinal, now) {
  const HOUR = 3600 * 1000;
  const DAY  = 24 * HOUR;
  if (!periodoFinal) return { ttlMs: HOUR, swr: true };
  const delta = monthDelta(periodoFinal, now);
  if (delta >= 4)         return { ttlMs: null,    swr: false };  // inmutable
  if (delta >= 1)         return { ttlMs: DAY,     swr: true  };  // 1-3 meses
  return                          { ttlMs: 6*HOUR, swr: true  };  // mes actual o futuro
};
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`
Expected: 7 policy tests pass.

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/policy.test.js
git commit -m "feat(cache): policyFor() — TTL inmutable >=4 meses, SWR para recientes"
```

---

### Task 4: `parsePeriodoFinal(url)` y `monthDelta` — helpers públicos

**Files:**
- Create: `tests/url-helpers.test.js`
- Modify: `cache.js`

- [ ] **Step 1: Tests**

```js
// tests/url-helpers.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/setup");
const SBCache = require("../cache.js");

test("parsePeriodoFinal: con periodoFinal explícito", () => {
  assert.equal(
    SBCache.parsePeriodoFinal("/api/x?periodoInicial=2026-01&periodoFinal=2026-04"),
    "2026-04"
  );
});

test("parsePeriodoFinal: sin periodoFinal → null", () => {
  assert.equal(SBCache.parsePeriodoFinal("/api/mercados"), null);
  assert.equal(SBCache.parsePeriodoFinal("/api/x?periodoInicial=2026-01"), null);
});

test("parsePeriodoFinal: con multi params", () => {
  assert.equal(
    SBCache.parsePeriodoFinal("/api/x?tipoEntidad=BM&periodoFinal=2025-12&paginas=1"),
    "2025-12"
  );
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -- --test-name-pattern="parsePeriodoFinal"`
Expected: FAIL — `parsePeriodoFinal is not a function`.

- [ ] **Step 3: Implementar**

Añadir a `cache.js`:

```js
SBCache.parsePeriodoFinal = function (url) {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return null;
  const params = new URLSearchParams(url.slice(qIdx + 1));
  return params.get("periodoFinal");
};
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/url-helpers.test.js
git commit -m "feat(cache): parsePeriodoFinal() helper"
```

---

### Task 5: Event emitter (`on`/`emit`)

**Files:**
- Modify: `cache.js`
- Create: `tests/events.test.js`

- [ ] **Step 1: Tests**

```js
// tests/events.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/setup");
const SBCache = require("../cache.js");

test("on/emit: subscribe + emit + unsubscribe", () => {
  const events = [];
  const off = SBCache.on("test", (e) => events.push(e));
  SBCache._emit("test", { v: 1 });
  SBCache._emit("test", { v: 2 });
  off();
  SBCache._emit("test", { v: 3 });
  assert.deepEqual(events, [{ v: 1 }, { v: 2 }]);
});

test("on/emit: múltiples subscribers", () => {
  const a = []; const b = [];
  const offA = SBCache.on("e", (x) => a.push(x));
  const offB = SBCache.on("e", (x) => b.push(x));
  SBCache._emit("e", 1);
  offA(); offB();
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1]);
});

test("on/emit: error en handler no rompe otros", () => {
  const got = [];
  SBCache.on("e", () => { throw new Error("boom"); });
  const off = SBCache.on("e", (x) => got.push(x));
  SBCache._emit("e", 42);
  off();
  assert.deepEqual(got, [42]);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -- --test-name-pattern="on/emit"`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Añadir a `cache.js` (dentro del IIFE):

```js
const _listeners = new Map();  // event -> Set<handler>

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
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/events.test.js
git commit -m "feat(cache): event emitter (on/emit)"
```

---

### Task 6: `SBCache.init()` — abrir IDB con schema

**Files:**
- Create: `tests/init.test.js`
- Modify: `cache.js`

- [ ] **Step 1: Tests**

```js
// tests/init.test.js
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetIDB } = require("./helpers/setup");
const SBCache = require("../cache.js");

beforeEach(async () => { await resetIDB(); });

test("init: abre IDB y crea store 'responses'", async () => {
  await SBCache.init();
  assert.equal(SBCache._mode, "idb");
});

test("init: idempotente (segundo call no rompe)", async () => {
  await SBCache.init();
  await SBCache.init();
  assert.equal(SBCache._mode, "idb");
});

test("init: si IDB no disponible → modo passthrough", async () => {
  const original = SBCache._indexedDB;
  SBCache._indexedDB = null;
  await SBCache.init();
  assert.equal(SBCache._mode, "passthrough");
  SBCache._indexedDB = original;
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implementar**

Reemplazar el placeholder de `init`:

```js
const DB_NAME = "sb-dashboard-cache";
const DB_VERSION = 1;
const STORE = "responses";

let _db = null;
SBCache._mode = null;        // "idb" | "passthrough"
const _l1 = new Map();        // L1 in-memory
const _inflight = new Map();  // URL -> Promise (dedup)

SBCache.init = async function () {
  if (SBCache._mode) return;  // idempotente
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
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/init.test.js
git commit -m "feat(cache): init() — abre IDB con schema v1, fallback passthrough"
```

---

### Task 7: IDB CRUD helpers (`_idbGet`, `_idbPut`, `_idbClear`, `_idbGetAll`)

**Files:**
- Modify: `cache.js`
- Create: `tests/idb-crud.test.js`

- [ ] **Step 1: Tests**

```js
// tests/idb-crud.test.js
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetIDB } = require("./helpers/setup");
const SBCache = require("../cache.js");

beforeEach(async () => { await resetIDB(); SBCache._mode = null; await SBCache.init(); });

test("_idbPut + _idbGet round-trip", async () => {
  await SBCache._idbPut({ url: "/x", body: { a: 1 }, fetchedAt: 100, expiresAt: 200 });
  const r = await SBCache._idbGet("/x");
  assert.deepEqual(r.body, { a: 1 });
  assert.equal(r.fetchedAt, 100);
});

test("_idbGet: miss → undefined", async () => {
  const r = await SBCache._idbGet("/none");
  assert.equal(r, undefined);
});

test("_idbClear: vacía el store", async () => {
  await SBCache._idbPut({ url: "/a", body: 1, fetchedAt: 0 });
  await SBCache._idbPut({ url: "/b", body: 2, fetchedAt: 0 });
  await SBCache._idbClear();
  assert.equal(await SBCache._idbGet("/a"), undefined);
  assert.equal(await SBCache._idbGet("/b"), undefined);
});

test("_idbGetAll: devuelve todos los registros", async () => {
  await SBCache._idbPut({ url: "/a", body: 1, fetchedAt: 0 });
  await SBCache._idbPut({ url: "/b", body: 2, fetchedAt: 0 });
  const all = await SBCache._idbGetAll();
  assert.equal(all.length, 2);
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implementar**

```js
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
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/idb-crud.test.js
git commit -m "feat(cache): helpers IDB (_idbGet/Put/Clear/GetAll/Delete)"
```

---

## Phase 3 — `SBCache.get()`

### Task 8: `get()` — miss path básico + L1 hit

**Files:**
- Modify: `cache.js`
- Create: `tests/get.test.js`

- [ ] **Step 1: Tests**

```js
// tests/get.test.js
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  resetIDB, setNow, setFetchMock, getFetchCalls, jsonResponse, emptyResponse
} = require("./helpers/setup");
const SBCache = require("../cache.js");

const URL_FRESH = "/api/indicadores/principales?periodoInicial=2026-05&periodoFinal=2026-05";

beforeEach(async () => {
  await resetIDB();
  SBCache._mode = null;
  SBCache._now = () => 1000;
  await SBCache.init();
});

test("get: miss L1+L2 → fetch → persiste → devuelve", async () => {
  setFetchMock(async () => jsonResponse({ Data: [{ x: 1 }] }));
  const r = await SBCache.get(URL_FRESH);
  assert.deepEqual(r, [{ x: 1 }]);
  assert.equal(getFetchCalls().length, 1);
  const stored = await SBCache._idbGet(URL_FRESH);
  assert.ok(stored);
  assert.deepEqual(stored.body, [{ x: 1 }]);
});

test("get: status 204 → devuelve []", async () => {
  setFetchMock(async () => emptyResponse(204));
  const r = await SBCache.get("/api/x?periodoFinal=2026-05");
  assert.deepEqual(r, []);
});

test("get: segundo call → L1 hit, no fetch", async () => {
  setFetchMock(async () => jsonResponse([{ a: 1 }]));
  await SBCache.get(URL_FRESH);
  await SBCache.get(URL_FRESH);
  assert.equal(getFetchCalls().length, 1);
});

test("get: error HTTP no-2xx → throws con mensaje", async () => {
  setFetchMock(async () => ({
    ok: false, status: 500,
    headers: { get: () => "application/json" },
    json: async () => ({ Message: "boom" }),
    text: async () => '{"Message":"boom"}',
  }));
  await assert.rejects(() => SBCache.get(URL_FRESH), /boom/);
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implementar `get()` — primera versión**

```js
function _normalizeBody(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if ("Data" in parsed) return parsed.Data;
    if (parsed.Succeeded === false) return [];
  }
  return parsed;
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
  catch (e) { /* quota se maneja en Task 17 */ }
}

SBCache.get = async function (url) {
  // Bypass para URLs no /api/
  if (!url.startsWith("/api/")) {
    const r = await SBCache._fetch(url);
    if (r.status === 204) return [];
    return _normalizeBody(await r.json());
  }
  // L1
  const l1 = _l1.get(url);
  const now = SBCache._now();
  if (l1 && (l1.expiresAt == null || l1.expiresAt > now)) return l1.body;
  // dedup
  if (_inflight.has(url)) return _inflight.get(url);
  // L2
  const l2 = await SBCache._idbGet(url);
  if (l2) {
    const fresh = (l2.expiresAt == null || l2.expiresAt > now);
    if (fresh) {
      _l1.set(url, l2);
      return l2.body;
    }
    // SWR / no-SWR → Task 9
    const policy = SBCache.policyFor(l2.periodoFinal, now);
    if (policy.swr) {
      _scheduleRevalidate(url, l2);
      _l1.set(url, l2);
      return l2.body;
    }
  }
  // Fetch
  const p = _fetchAndPersist(url).finally(() => _inflight.delete(url));
  _inflight.set(url, p);
  return p;
};

function _scheduleRevalidate(/* url, prev */) {
  // Implementado en Task 9
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/get.test.js
git commit -m "feat(cache): get() miss path + L1 hit + bypass /api/"
```

---

### Task 9: `get()` — SWR (stale-while-revalidate)

**Files:**
- Modify: `cache.js`
- Modify: `tests/get.test.js` (añadir cases)

- [ ] **Step 1: Tests adicionales**

Añadir a `tests/get.test.js`:

```js
test("get: stale + SWR → devuelve stale + refetch + emite 'updated' si body cambia", async () => {
  // Pre-populate IDB con stale (mes actual, 7h atrás → expira a 6h)
  SBCache._now = () => 100_000_000;
  const url = "/api/x?periodoFinal=2026-05";
  await SBCache._idbPut({
    url, body: [{ old: true }], status: 200,
    fetchedAt: 100_000_000 - 7 * 3600 * 1000,
    periodoFinal: "2026-05",
    expiresAt: 100_000_000 - 1 * 3600 * 1000,  // ya expiró
    schemaVersion: 1,
  });
  setFetchMock(async () => jsonResponse([{ old: false, fresh: true }]));
  const updates = [];
  const off = SBCache.on("updated", (e) => updates.push(e));
  const r = await SBCache.get(url);
  assert.deepEqual(r, [{ old: true }]);  // stale inmediato
  // Esperar a que el background refetch termine
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].url, url);
  off();
});

test("get: stale + SWR + body idéntico → NO emite 'updated'", async () => {
  SBCache._now = () => 100_000_000;
  const url = "/api/y?periodoFinal=2026-05";
  await SBCache._idbPut({
    url, body: [{ same: true }], status: 200,
    fetchedAt: 100_000_000 - 10 * 3600 * 1000,
    periodoFinal: "2026-05",
    expiresAt: 100_000_000 - 1 * 3600 * 1000,
    schemaVersion: 1,
  });
  setFetchMock(async () => jsonResponse([{ same: true }]));
  const updates = [];
  const off = SBCache.on("updated", (e) => updates.push(e));
  await SBCache.get(url);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(updates.length, 0);
  off();
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implementar `_scheduleRevalidate`**

Reemplazar el stub en `cache.js`:

```js
function _bodyEqual(a, b) {
  // comparación profunda barata vía JSON
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

function _scheduleRevalidate(url, prev) {
  if (_inflight.has(url)) return;
  const p = (async () => {
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
      if (!r.ok) { SBCache._emit("error", { url, message: `HTTP ${r.status}` }); return; }
      const body = _normalizeBody(parsed);
      const rec = _buildRecord(url, body, r.status);
      await _safePut(rec);
      _l1.set(url, rec);
      if (!_bodyEqual(prev.body, body)) SBCache._emit("updated", { url });
    } catch (e) {
      SBCache._emit("error", { url, message: e.message || String(e) });
    } finally {
      _inflight.delete(url);
    }
  })();
  _inflight.set(url, p);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/get.test.js
git commit -m "feat(cache): SWR — devuelve stale + refetch background + 'updated'"
```

---

### Task 10: `get()` — dedup concurrente

**Files:**
- Modify: `tests/get.test.js`

- [ ] **Step 1: Test**

Añadir a `tests/get.test.js`:

```js
test("get: 2 calls concurrentes para misma URL → 1 fetch", async () => {
  let calls = 0;
  setFetchMock(async () => {
    calls++;
    await new Promise(r => setTimeout(r, 5));
    return jsonResponse([{ v: calls }]);
  });
  const url = "/api/dedup?periodoFinal=2026-05";
  const [a, b] = await Promise.all([SBCache.get(url), SBCache.get(url)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});
```

- [ ] **Step 2: Run, verify pass**

(la dedup ya está implementada en Task 8 vía `_inflight` map; este test la verifica)
Run: `npm test`
Expected: PASS sin cambios de código.

- [ ] **Step 3: Commit**

```bash
git add tests/get.test.js
git commit -m "test(cache): cubrir dedup de gets concurrentes"
```

---

### Task 11: `get()` — fetch error con/sin stale

**Files:**
- Modify: `tests/get.test.js`
- Modify: `cache.js`

- [ ] **Step 1: Tests**

```js
test("get: fetch falla con stale en IDB → devuelve stale + 'error'", async () => {
  SBCache._now = () => 100_000_000;
  const url = "/api/err?periodoFinal=2026-05";
  await SBCache._idbPut({
    url, body: [{ stale: true }], status: 200,
    fetchedAt: 100_000_000 - 10 * 3600 * 1000,
    periodoFinal: "2026-05",
    expiresAt: 100_000_000 - 1 * 3600 * 1000,
    schemaVersion: 1,
  });
  setFetchMock(async () => { throw new Error("network down"); });
  const errors = [];
  const off = SBCache.on("error", (e) => errors.push(e));
  const r = await SBCache.get(url);
  assert.deepEqual(r, [{ stale: true }]);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /network/);
  off();
});

test("get: fetch falla SIN stale → throws", async () => {
  setFetchMock(async () => { throw new Error("offline"); });
  await assert.rejects(
    () => SBCache.get("/api/nostale?periodoFinal=2026-05"),
    /offline/
  );
});

test("get: bypass /api/ → llamada directa, sin IDB", async () => {
  setFetchMock(async () => jsonResponse([{ ext: true }]));
  const r = await SBCache.get("/external/thing");
  assert.deepEqual(r, [{ ext: true }]);
  // No debe haber registro en IDB
  const keys = await SBCache._idbGetAll();
  assert.equal(keys.length, 0);
});
```

- [ ] **Step 2: Run, verify pass/fail**

(error con stale + bypass ya implementados en Tasks 8-9; throws sin stale también)
Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/get.test.js
git commit -m "test(cache): fetch error con stale, sin stale, bypass /api/"
```

---

## Phase 4 — invalidación + cuota

### Task 12: `invalidateAll()`

**Files:**
- Create: `tests/invalidate.test.js`
- Modify: `cache.js`

- [ ] **Step 1: Tests**

```js
// tests/invalidate.test.js
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetIDB, setFetchMock, getFetchCalls, jsonResponse } = require("./helpers/setup");
const SBCache = require("../cache.js");

beforeEach(async () => { await resetIDB(); SBCache._mode = null; await SBCache.init(); });

test("invalidateAll: limpia L1 + IDB; nuevo get() → fetch", async () => {
  setFetchMock(async () => jsonResponse([1]));
  const url = "/api/inv?periodoFinal=2026-05";
  await SBCache.get(url);
  assert.equal(getFetchCalls().length, 1);
  await SBCache.invalidateAll();
  assert.equal((await SBCache._idbGetAll()).length, 0);
  await SBCache.get(url);
  assert.equal(getFetchCalls().length, 2);
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implementar**

Reemplazar placeholder en `cache.js`:

```js
SBCache.invalidateAll = async function () {
  _l1.clear();
  await SBCache._idbClear();
};
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/invalidate.test.js
git commit -m "feat(cache): invalidateAll() — limpia L1 + IDB"
```

---

### Task 13: Quota exceeded → eviction de los 30 más viejos

**Files:**
- Create: `tests/quota.test.js`
- Modify: `cache.js`

- [ ] **Step 1: Tests**

```js
// tests/quota.test.js
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetIDB, setFetchMock, jsonResponse } = require("./helpers/setup");
const SBCache = require("../cache.js");

beforeEach(async () => { await resetIDB(); SBCache._mode = null; await SBCache.init(); });

test("quota: si _idbPut lanza una vez, evicciona y reintenta", async () => {
  // poblamos 35 registros con fetchedAt creciente
  for (let i = 0; i < 35; i++) {
    await SBCache._idbPut({
      url: `/api/old/${i}`,
      body: [i],
      status: 200,
      fetchedAt: 1000 + i,
      periodoFinal: "2026-05",
      expiresAt: 999999999,
      schemaVersion: 1,
    });
  }

  // Mock _idbPut original; primero lanza QuotaExceededError, luego éxito
  const realPut = SBCache._idbPut;
  let calls = 0;
  SBCache._idbPut = async function (rec) {
    calls++;
    if (calls === 1 && rec.url === "/api/new?periodoFinal=2026-05") {
      const e = new Error("quota");
      e.name = "QuotaExceededError";
      throw e;
    }
    return realPut.call(SBCache, rec);
  };

  setFetchMock(async () => jsonResponse([{ x: 1 }]));
  await SBCache.get("/api/new?periodoFinal=2026-05");

  // El registro nuevo está; los 30 más viejos fueron borrados
  const all = await SBCache._idbGetAll();
  assert.ok(all.find(r => r.url === "/api/new?periodoFinal=2026-05"));
  // Deben quedar 35 - 30 + 1 = 6 registros (5 viejos restantes + el nuevo)
  assert.equal(all.length, 6);

  SBCache._idbPut = realPut;
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implementar `_safePut` con retry**

Reemplazar `_safePut` en `cache.js`:

```js
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
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/quota.test.js
git commit -m "feat(cache): eviction al QuotaExceededError (30 más viejos + retry)"
```

---

## Phase 5 — preload + buildPreloadJobs

### Task 14: `preload()` — básico + concurrencia 6

**Files:**
- Create: `tests/preload.test.js`
- Modify: `cache.js`

- [ ] **Step 1: Tests**

```js
// tests/preload.test.js
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetIDB, setFetchMock, jsonResponse } = require("./helpers/setup");
const SBCache = require("../cache.js");

beforeEach(async () => { await resetIDB(); SBCache._mode = null; await SBCache.init(); });

test("preload: 1 job → 1 fetch + progress + done", async () => {
  setFetchMock(async () => jsonResponse([{ v: 1 }]));
  const events = [];
  const offP = SBCache.on("progress", (e) => events.push({ t: "progress", ...e }));
  const offD = SBCache.on("done",     (e) => events.push({ t: "done",     ...e }));
  await SBCache.preload([{ url: "/api/p1?periodoFinal=2026-05" }]);
  offP(); offD();
  const progress = events.filter(e => e.t === "progress");
  assert.ok(progress.length >= 1);
  assert.equal(progress[progress.length - 1].done, 1);
  assert.equal(progress[progress.length - 1].total, 1);
  const done = events.filter(e => e.t === "done");
  assert.equal(done.length, 1);
  assert.equal(done[0].done, 1);
  assert.equal(done[0].failed, 0);
});

test("preload: concurrencia <=6", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  setFetchMock(async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 10));
    inFlight--;
    return jsonResponse([{}]);
  });
  const jobs = Array.from({length: 20}, (_, i) => ({ url: `/api/c/${i}?periodoFinal=2026-05` }));
  await SBCache.preload(jobs);
  assert.ok(maxInFlight <= 6, `expected <=6, got ${maxInFlight}`);
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implementar `preload`**

Reemplazar placeholder en `cache.js`:

```js
const PRELOAD_CONCURRENCY = 6;

SBCache.preload = async function (jobs) {
  const total = jobs.length;
  let done = 0;
  let failed = 0;
  let allFailed = true;

  async function runJob(job) {
    try {
      // Si ya fresco en IDB → skip (cuenta como done sin fetch)
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

  // Pool con concurrencia fija
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
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/preload.test.js
git commit -m "feat(cache): preload() con concurrencia 6 + eventos progress/done"
```

---

### Task 15: `preload()` — skip fresh + per-job error + total failure

**Files:**
- Modify: `tests/preload.test.js`

- [ ] **Step 1: Tests**

Añadir a `tests/preload.test.js`:

```js
test("preload: URL ya fresca en IDB → skip (no fetch, sí progress)", async () => {
  SBCache._now = () => 1000;
  await SBCache._idbPut({
    url: "/api/skip?periodoFinal=2026-05",
    body: [{ cached: true }],
    status: 200,
    fetchedAt: 1000,
    periodoFinal: "2026-05",
    expiresAt: 1000 + 6 * 3600 * 1000,
    schemaVersion: 1,
  });
  let calls = 0;
  setFetchMock(async () => { calls++; return jsonResponse([]); });
  const events = [];
  const off = SBCache.on("progress", (e) => events.push(e));
  await SBCache.preload([{ url: "/api/skip?periodoFinal=2026-05" }]);
  off();
  assert.equal(calls, 0);
  assert.equal(events[events.length - 1].done, 1);
  assert.equal(events[events.length - 1].failed, 0);
});

test("preload: error individual no aborta cola", async () => {
  let calls = 0;
  setFetchMock(async (url) => {
    calls++;
    if (url.includes("/bad/")) throw new Error("boom");
    return jsonResponse([{}]);
  });
  const offDone = await new Promise(resolve => {
    let payload;
    const off = SBCache.on("done", (e) => { payload = e; off(); resolve(payload); });
    SBCache.preload([
      { url: "/api/ok/1?periodoFinal=2026-05" },
      { url: "/api/bad/1?periodoFinal=2026-05" },
      { url: "/api/ok/2?periodoFinal=2026-05" },
    ]);
  });
  assert.equal(offDone.done, 3);
  assert.equal(offDone.failed, 1);
});

test("preload: TODOS fallan → 'error' con total_failure=true", async () => {
  setFetchMock(async () => { throw new Error("offline"); });
  const errs = [];
  const off = SBCache.on("error", (e) => errs.push(e));
  await SBCache.preload([
    { url: "/api/x/1?periodoFinal=2026-05" },
    { url: "/api/x/2?periodoFinal=2026-05" },
  ]);
  off();
  const total = errs.find(e => e.total_failure);
  assert.ok(total, "should emit total_failure");
});
```

- [ ] **Step 2: Run, verify pass**

(funcionalidad ya implementada en Task 14; estos tests la cubren)
Run: `npm test`

- [ ] **Step 3: Commit**

```bash
git add tests/preload.test.js
git commit -m "test(cache): preload skip fresh, error individual, total failure"
```

---

### Task 16: `buildPreloadJobs(state)` — generar URLs del preload

**Files:**
- Create: `tests/buildjobs.test.js`
- Modify: `cache.js`

- [ ] **Step 1: Tests**

```js
// tests/buildjobs.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/setup");
const SBCache = require("../cache.js");

test("buildPreloadJobs: cuenta total esperada (~231 jobs)", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  // 1 range × 5 scopes = 5
  // 14 probing × 5 scopes × 3 meses = 210
  // 1 comparativa × 5 scopes × 3 meses = 15
  // 1 mercados = 1
  assert.equal(jobs.length, 5 + 210 + 15 + 1);
});

test("buildPreloadJobs: incluye /api/mercados sin params", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  assert.ok(jobs.some(j => j.url === "/api/mercados"));
});

test("buildPreloadJobs: range query con periodoInicial=YYYY-01", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  const range = jobs.filter(j => j.url.startsWith("/api/indicadores/principales"));
  assert.equal(range.length, 5);
  for (const j of range) {
    assert.match(j.url, /periodoInicial=2026-01/);
    assert.match(j.url, /periodoFinal=2026-05/);
  }
});

test("buildPreloadJobs: probing usa 3 meses", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  const tipo = jobs.filter(j => j.url.startsWith("/api/carteras/creditos/tipo"));
  assert.equal(tipo.length, 5 * 3);  // 5 scopes × 3 meses
  // 3 meses distintos
  const months = new Set();
  for (const j of tipo) months.add(j.url.match(/periodoFinal=([^&]+)/)[1]);
  assert.equal(months.size, 3);
});

test("buildPreloadJobs: scopes incluyen TODOS y 4 tipoEntidad", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  // Para /api/carteras/creditos/tipo, contar variantes
  const tipo = jobs.filter(j => j.url.startsWith("/api/carteras/creditos/tipo"));
  const monthMay = tipo.filter(j => j.url.includes("periodoFinal=2026-05"));
  assert.equal(monthMay.length, 5);
  const tipos = monthMay.map(j => {
    const m = j.url.match(/tipoEntidad=([^&]+)/);
    return m ? m[1] : "TODOS";
  });
  assert.deepEqual(tipos.sort(), ["AC", "ARC", "BAyC", "BM", "TODOS"].sort());
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implementar `buildPreloadJobs` y `prevMonth`**

Añadir a `cache.js`:

```js
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

const PRELOAD_SCOPES = [
  {},
  { tipoEntidad: ["BM"]   },
  { tipoEntidad: ["BAyC"] },
  { tipoEntidad: ["AC"]   },
  { tipoEntidad: ["ARC"]  },
];

function _prevMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));  // m-2 because Date months are 0-indexed
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

  // 1) Range query
  for (const scope of PRELOAD_SCOPES) {
    jobs.push({ url: _buildUrl("/indicadores/principales", {
      periodoInicial, periodoFinal: pf,
      paginas: 1, registros: 200,
      ...scope,
    })});
  }

  // 2) Probing (14 paths × 5 scopes × 3 meses)
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

  // 3) Comparativa (1 × 5 × 3)
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

  // 4) Mercados (sin scope, sin periodo)
  jobs.push({ url: "/api/mercados" });

  return jobs;
};
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add cache.js tests/buildjobs.test.js
git commit -m "feat(cache): buildPreloadJobs() — range + probing + comparativa + mercados"
```

---

## Phase 6 — Integración con `index.html`

### Task 17: Pill UI (HTML + CSS) y `<script src=cache.js>`

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Añadir `<script>` al `<head>`**

Buscar la línea con el primer `<script>` (probablemente Chart.js o Leaflet) y añadir antes del `<script>` propio del dashboard:

```html
<script src="/cache.js"></script>
```

- [ ] **Step 2: Añadir CSS en el `<style>` existente**

Buscar `:root {` en el bloque `<style>` y añadir al final del bloque:

```css
#preloadPill {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.625rem;
  margin-left: 0.5rem;
  background: var(--surface, #1e2a44);
  color: var(--text, #e6ecf6);
  border: 1px solid var(--border, #2a3a5e);
  border-radius: 999px;
  font-size: 0.8125rem;
  line-height: 1.2;
  vertical-align: middle;
}
#preloadPill.success { border-color: #16a36a; color: #16a36a; }
#preloadPill.error   { border-color: #d73a4f; color: #d73a4f; background: #2a0f15; }
#preloadPill button {
  background: transparent;
  color: inherit;
  border: 0;
  padding: 0;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
}
#preloadPill[hidden] { display: none; }
```

- [ ] **Step 3: Añadir HTML del pill junto al botón Recargar**

Buscar `<button class="primary" id="reloadBtn">` (línea ~228) y añadir DESPUÉS:

```html
<div id="preloadPill" hidden>
  <span id="preloadPillText">Precargando 0/0</span>
  <button id="preloadPillClose" type="button" aria-label="ocultar">×</button>
</div>
```

- [ ] **Step 4: Verificar manual**

Abrir `index.html` con `python3 proxy.py` o `netlify dev` y confirmar:
- La página carga sin errores en la consola.
- El pill **no** aparece (está `hidden` por default).
- En la consola, `window.SBCache` existe y tiene los métodos esperados.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(ui): pill de preload + script tag de cache.js"
```

---

### Task 18: Reemplazar cache interno de `SB.get()` por `SBCache.get()`

**Files:**
- Modify: `index.html` (líneas ~456-482)

- [ ] **Step 1: Reemplazar el objeto `SB`**

Buscar el bloque que empieza en línea ~456 (`const SB = {`) y termina en `};` (línea ~482). Reemplazarlo por:

```js
const SB = {
  base: "/api",
  async get(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === "") continue;
      if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
      else qs.append(k, v);
    }
    const url = `${this.base}${path}?${qs.toString()}`;
    return SBCache.get(url);
  },
  // mantenido por compatibilidad; ahora delega a SBCache
  clearCache() { return SBCache.invalidateAll(); },
};
```

- [ ] **Step 2: Verificar manual (sin preload aún)**

Servir el dashboard:
- Cargar la página → ver que los charts se pintan como antes.
- Network tab: las requests `/api/...` se hacen igual.
- Recargar la página: la segunda vez los datos vienen de IDB (Network → request fewer or no fetches al `/api/`).
- Inspeccionar `Application → IndexedDB → sb-dashboard-cache → responses` y ver registros con `expiresAt`.

**Importante:** Antes de `SBCache.get` resolver, debe haberse llamado `SBCache.init()`. Como `init()` aún no se llama desde `boot()`, hay que añadir un await temporal en `boot()` antes de las llamadas a loaders. **Lo correcto se hace en Task 19; aquí, si la página no carga, mover este task DESPUÉS de Task 19.** Alternativamente, hacer una fallback: si `_mode` es null cuando se llame `get`, llamar `init` primero.

Para evitar dependencia de orden, modificar `SBCache.get` en `cache.js` para auto-init si aún no inició:

```js
// Añadir como primera línea de SBCache.get:
if (!SBCache._mode) await SBCache.init();
```

- [ ] **Step 3: Añadir auto-init en `cache.js`**

En el primer `if` de `SBCache.get`, añadir:

```js
SBCache.get = async function (url) {
  if (!SBCache._mode) await SBCache.init();
  // ... resto igual
};
```

- [ ] **Step 4: Verificar tests siguen pasando**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cache.js index.html
git commit -m "feat(cache): SB.get() delega a SBCache.get() con auto-init"
```

---

### Task 19: Cablear `boot()` con preload + listeners del pill

**Files:**
- Modify: `index.html` (función `boot()` y nueva `wirePillEvents()`)

- [ ] **Step 1: Localizar `boot()`**

Buscar `function boot()` o el código del `DOMContentLoaded`/inicialización (cerca de línea ~1260).

- [ ] **Step 2: Añadir init + preload + listeners**

Insertar al **final** de la función de inicialización, después de que se haya seleccionado el tab inicial:

```js
// Preload de cache (background, no-await)
async function startPreload() {
  await SBCache.init();
  wirePillEvents();
  if (state.periodoFinal) {
    const jobs = SBCache.buildPreloadJobs({ periodoFinal: state.periodoFinal });
    SBCache.preload(jobs);
  }
}
startPreload();

function wirePillEvents() {
  const pill   = document.getElementById("preloadPill");
  const text   = document.getElementById("preloadPillText");
  const close  = document.getElementById("preloadPillClose");
  if (!pill || !text || !close) return;

  if (localStorage.getItem("sb_pill_dismissed") === "1") return;

  close.addEventListener("click", () => {
    pill.hidden = true;
    localStorage.setItem("sb_pill_dismissed", "1");
  });

  let totalCache = 0;
  SBCache.on("progress", ({ done, total, failed }) => {
    totalCache = total;
    pill.hidden = false;
    pill.classList.remove("success", "error");
    const fail = failed > 0 ? ` (${failed} fallidos)` : "";
    text.textContent = `Precargando ${done}/${total}${fail}`;
  });
  SBCache.on("done", ({ done, failed }) => {
    pill.classList.add("success");
    text.textContent = failed > 0
      ? `✓ Datos listos (${failed} fallaron)`
      : `✓ Datos listos`;
    setTimeout(() => { pill.hidden = true; pill.classList.remove("success"); }, 3000);
  });
  SBCache.on("error", (e) => {
    if (e && e.total_failure) {
      pill.classList.add("error");
      text.textContent = "Preload falló — modo lazy";
      pill.hidden = false;
    }
  });
  // SWR redraw: recargar tab activo si llega 'updated'
  SBCache.on("updated", () => {
    if (typeof renderActiveTab === "function") renderActiveTab();
  });
}
```

**Nota sobre `renderActiveTab`:** verificar el nombre real en `index.html` (puede ser `renderTab`, `loadTab`, etc.). Buscar con `grep -n "function render" index.html`. Ajustar la llamada al nombre correcto.

- [ ] **Step 3: Verificar manual**

Recargar la página:
- El pill aparece con `"Precargando X/231"`.
- Tras ~30-60s, cambia a `"✓ Datos listos"` y se oculta.
- Cambiar entre tabs → instantáneo.
- Cambiar entre TODOS / Solo BM → instantáneo (post-preload).
- DevTools → IndexedDB → ver ~231 entradas.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(ui): boot wire preload + pill listeners + SWR redraw"
```

---

### Task 20: Recargar button → `invalidateAll` + re-preload

**Files:**
- Modify: `index.html` (handler de `#reloadBtn`)

- [ ] **Step 1: Localizar handler actual**

Buscar `document.getElementById("reloadBtn").addEventListener` (línea ~1285).

- [ ] **Step 2: Reemplazar handler**

```js
document.getElementById("reloadBtn").addEventListener("click", async () => {
  await SBCache.invalidateAll();
  if (typeof renderActiveTab === "function") renderActiveTab();
  if (state.periodoFinal) {
    const jobs = SBCache.buildPreloadJobs({ periodoFinal: state.periodoFinal });
    SBCache.preload(jobs);
  }
});
```

(verificar el nombre real de la función de render del tab activo y ajustar)

- [ ] **Step 3: Verificar manual**

- Click "Recargar" → IndexedDB se vacía (ver DevTools).
- Pill arranca de nuevo con `0/231`.
- Datos se vuelven a bajar.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(ui): Recargar button vacía cache + re-preload"
```

---

## Phase 7 — Documentación + smoke

### Task 21: Actualizar `README.md` con sección de cache + tests

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Añadir nueva sección antes de "Troubleshooting"**

```markdown
## Cache local (IndexedDB)

El dashboard cachea las respuestas del API SB en IndexedDB del navegador para
que cambios de filtro sean instantáneos. Detalles en `cache.js`:

- **L1**: Map en memoria (microsegundos).
- **L2**: IndexedDB (~10-100ms, persiste entre recargas).
- **Política**: meses ≥4 atrás del actual nunca expiran (SB no los modifica);
  meses 1-3 atrás expiran a las 24h con SWR; mes actual a 6h con SWR;
  endpoints sin `periodoFinal` (ej. `/api/mercados`) a 1h.
- **Preload**: al cargar el dashboard se precachea, en background, el año en
  curso para `TODOS` + `BM` + `BAyC` + `AC` + `ARC` (~231 requests con
  concurrencia 6). Un pill muestra el progreso.
- **Invalidación**: el botón "Recargar datos" vacía el cache y dispara un
  nuevo preload.

### Tests

```bash
npm install
npm test
```

`fake-indexeddb` se usa solo en tests (devDependency); el build de Netlify
no lo instala.
```

- [ ] **Step 2: Actualizar la sección de "Estructura"**

Reemplazar el árbol existente por:

```
.
├── index.html                       # Dashboard (HTML + Chart.js + Leaflet)
├── cache.js                         # Cache navegador con IndexedDB + SWR + preload
├── netlify.toml                     # Configuración de Netlify
├── netlify/functions/sb-api.js      # Proxy serverless (inyecta API key)
├── proxy.py                         # Proxy local para desarrollo
├── probar_api_sb.py                 # Script para probar endpoints
├── sb_api_endpoints.md              # Documentación de los 26 endpoints
├── package.json                     # devDependencies para tests
└── tests/                           # node --test + fake-indexeddb
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: cache local IndexedDB + tests en README"
```

---

### Task 22: Smoke checklist manual + commit final

**Files:** ninguno (solo verificación)

- [ ] **Step 1: Run `npm test` localmente**

Run: `npm test`
Expected: todos los tests pasan, 0 fail.

- [ ] **Step 2: Smoke 1 — Boot frío en navegador limpio**

- Abrir DevTools → Application → Storage → "Clear site data".
- Recargar.
- Pill aparece con `Precargando X/231`.
- Tras 30-60s, `✓ Datos listos`, luego oculto.

- [ ] **Step 3: Smoke 2 — Cambiar entre tipoEntidad**

- Click en "Solo BM" → cargar tab activo → instantáneo (<200ms).
- Click "Todas" → instantáneo.
- Repetir con BAyC, AC, ARC → todos instantáneos.

- [ ] **Step 4: Smoke 3 — Hard reload**

- Cmd+Shift+R.
- Pill arranca rápido y la mayoría de jobs salen como skip (verificar en
  Network: pocas requests reales a `/api/`).

- [ ] **Step 5: Smoke 4 — Modo offline + Recargar**

- DevTools → Network → "Offline".
- Click "Recargar datos".
- El pill muestra `Preload falló — modo lazy` (rojo).
- La UI no se rompe.

- [ ] **Step 6: Smoke 5 — Inspección IDB**

- DevTools → Application → IndexedDB → `sb-dashboard-cache` → `responses`.
- Ver registros con campos `url`, `body`, `fetchedAt`, `periodoFinal`,
  `expiresAt`. Para registros con `periodoFinal` ≥ 4 meses atrás, `expiresAt`
  debe ser `null`.

- [ ] **Step 7: Smoke 6 — Entidad individual no precargada**

- Abrir el selector de entidades → marcar una entidad individual (ej. `APAP`).
- Click "Aplicar".
- Primera vez: tarda lo de un fetch normal.
- Inmediatamente repetir el mismo filtro: instantáneo (vino de cache).

- [ ] **Step 8: Commit final**

```bash
git commit --allow-empty -m "feat: cache local IndexedDB con preload híbrido y SWR

Cierra implementación según docs/superpowers/specs/2026-05-07-cache-local-indexeddb-design.md.

Smoke pasado:
- Boot frío 30-60s con pill de progreso
- Filtros tipoEntidad instantáneos post-preload
- Hard reload mayormente skip
- Modo offline degrada a 'modo lazy' sin romper
- IDB persiste con expiresAt correcto por edad de periodoFinal
- Entidad individual: lazy primera vez, instantánea luego"
```

---

## Self-review notes

Después de escribir el plan, verificación contra el spec:

| Sección spec | Cubierto en task |
|---|---|
| Modelo de datos / schema | Task 6 (init) + Task 8 (`_buildRecord`) |
| `policyFor` | Task 3 |
| `get` con miss/hit/SWR/dedup/error | Tasks 8-11 |
| `invalidateAll` | Task 12 |
| Quota eviction | Task 13 |
| `preload` con concurrencia/skip/error/total_failure | Tasks 14-15 |
| `buildPreloadJobs` | Task 16 |
| Pill UI | Task 17 |
| `SB.get` integración | Task 18 |
| `boot()` wire | Task 19 |
| Recargar | Task 20 |
| SWR redraw | Task 19 (listener `updated`) |
| README | Task 21 |
| Smoke checklist | Task 22 |
| IDB unavailable passthrough | Task 6 (init test) |
| Bypass `/api/` | Task 11 |
| Schema bump invalidation | Task 6 (`onupgradeneeded`) |

Todas las requirements del spec tienen tarea asignada.
