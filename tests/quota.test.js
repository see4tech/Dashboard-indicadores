const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetIDB, setFetchMock, jsonResponse } = require("./helpers/setup");
const SBCache = require("../cache.js");

beforeEach(async () => {
  await resetIDB();
  await SBCache.init();
});

test("quota: si _idbPut lanza una vez, evicciona y reintenta", async () => {
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

  const all = await SBCache._idbGetAll();
  assert.ok(all.find(r => r.url === "/api/new?periodoFinal=2026-05"));
  assert.equal(all.length, 6);

  SBCache._idbPut = realPut;
});
