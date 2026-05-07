const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  resetIDB, setFetchMock, getFetchCalls, jsonResponse, emptyResponse
} = require("./helpers/setup");
const SBCache = require("../cache.js");

const URL_FRESH = "/api/indicadores/principales?periodoInicial=2026-05&periodoFinal=2026-05";

beforeEach(async () => {
  await resetIDB();
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

test("get: stale + SWR → devuelve stale + refetch + emite 'updated' si body cambia", async () => {
  SBCache._now = () => 100_000_000;
  const url = "/api/x?periodoFinal=2026-05";
  await SBCache._idbPut({
    url, body: [{ old: true }], status: 200,
    fetchedAt: 100_000_000 - 7 * 3600 * 1000,
    periodoFinal: "2026-05",
    expiresAt: 100_000_000 - 1 * 3600 * 1000,
    schemaVersion: 1,
  });
  setFetchMock(async () => jsonResponse([{ old: false, fresh: true }]));
  const updates = [];
  const off = SBCache.on("updated", (e) => updates.push(e));
  const r = await SBCache.get(url);
  assert.deepEqual(r, [{ old: true }]);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].url, url);
  off();
});

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

test("get: HTTP 500 → cachea error y 2do call no toca red", async () => {
  setFetchMock(async () => ({
    ok: false, status: 500,
    headers: { get: () => "application/json" },
    json: async () => ({ Message: "upstream down" }),
    text: async () => '{"Message":"upstream down"}',
  }));
  const url = "/api/cached-error?periodoFinal=2026-05";
  await assert.rejects(() => SBCache.get(url), /upstream down/);
  assert.equal(getFetchCalls().length, 1);
  // 2do call dentro del TTL → mismo error, sin tocar red
  await assert.rejects(() => SBCache.get(url), /upstream down/);
  assert.equal(getFetchCalls().length, 1);
});

test("get: network error (fetch throws) → cacheado igual", async () => {
  setFetchMock(async () => { throw new Error("ECONNREFUSED"); });
  const url = "/api/network-fail?periodoFinal=2026-05";
  await assert.rejects(() => SBCache.get(url), /ECONNREFUSED/);
  assert.equal(getFetchCalls().length, 1);
  await assert.rejects(() => SBCache.get(url), /ECONNREFUSED/);
  assert.equal(getFetchCalls().length, 1);
});

test("get: error cacheado expira → reintenta y cachea éxito", async () => {
  // Setup: error record que ya expiró
  SBCache._now = () => 1_000_000_000;
  const url = "/api/error-expired?periodoFinal=2026-05";
  await SBCache._idbPut({
    url, body: null, status: 500,
    errorMessage: "old error",
    fetchedAt: 1_000_000_000 - 10 * 60 * 1000,
    periodoFinal: "2026-05",
    expiresAt:    1_000_000_000 - 5  * 60 * 1000,  // ya expiró
    schemaVersion: 1,
  });
  setFetchMock(async () => jsonResponse([{ recovered: true }]));
  const r = await SBCache.get(url);
  assert.deepEqual(r, [{ recovered: true }]);
  assert.equal(getFetchCalls().length, 1);
});

test("get: stale-good + SWR refetch falla → mantiene stale-good (no overwrite con error)", async () => {
  SBCache._now = () => 100_000_000;
  const url = "/api/protect-good?periodoFinal=2026-05";
  await SBCache._idbPut({
    url, body: [{ good: true }], status: 200,
    fetchedAt: 100_000_000 - 10 * 3600 * 1000,
    periodoFinal: "2026-05",
    expiresAt: 100_000_000 - 1 * 3600 * 1000,  // expirado pero SWR
    schemaVersion: 1,
  });
  setFetchMock(async () => { throw new Error("transient"); });
  const r = await SBCache.get(url);
  assert.deepEqual(r, [{ good: true }]);
  // dejar que el revalidate termine
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  // El registro en IDB debe seguir siendo el bueno, no un error record
  const after = await SBCache._idbGet(url);
  assert.deepEqual(after.body, [{ good: true }]);
  assert.equal(after.errorMessage, undefined);
});

test("get: bypass /api/ → llamada directa, sin IDB", async () => {
  setFetchMock(async () => jsonResponse([{ ext: true }]));
  const r = await SBCache.get("/external/thing");
  assert.deepEqual(r, [{ ext: true }]);
  const all = await SBCache._idbGetAll();
  assert.equal(all.length, 0);
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
  await new Promise(setImmediate);
  assert.equal(updates.length, 0);
  off();
});
