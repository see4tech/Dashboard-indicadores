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
