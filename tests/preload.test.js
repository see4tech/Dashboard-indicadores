const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetIDB, setFetchMock, jsonResponse } = require("./helpers/setup");
const SBCache = require("../cache.js");

beforeEach(async () => {
  await resetIDB();
  SBCache._now = () => 1000;
  await SBCache.init();
});

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

test("preload: URL ya fresca en IDB → skip (no fetch, sí progress)", async () => {
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
  setFetchMock(async (url) => {
    if (url.includes("/bad/")) throw new Error("boom");
    return jsonResponse([{}]);
  });
  const payload = await new Promise(resolve => {
    const off = SBCache.on("done", (e) => { off(); resolve(e); });
    SBCache.preload([
      { url: "/api/ok/1?periodoFinal=2026-05" },
      { url: "/api/bad/1?periodoFinal=2026-05" },
      { url: "/api/ok/2?periodoFinal=2026-05" },
    ]);
  });
  assert.equal(payload.done, 3);
  assert.equal(payload.failed, 1);
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
