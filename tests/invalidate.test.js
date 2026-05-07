const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetIDB, setFetchMock, getFetchCalls, jsonResponse } = require("./helpers/setup");
const SBCache = require("../cache.js");

beforeEach(async () => {
  await resetIDB();
  await SBCache.init();
});

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
