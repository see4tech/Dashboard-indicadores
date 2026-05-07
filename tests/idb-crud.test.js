const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetIDB } = require("./helpers/setup");
const SBCache = require("../cache.js");

beforeEach(async () => {
  await resetIDB();
  await SBCache.init();
});

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

test("_idbDelete: borra un registro específico", async () => {
  await SBCache._idbPut({ url: "/a", body: 1, fetchedAt: 0 });
  await SBCache._idbPut({ url: "/b", body: 2, fetchedAt: 0 });
  await SBCache._idbDelete("/a");
  assert.equal(await SBCache._idbGet("/a"), undefined);
  assert.ok(await SBCache._idbGet("/b"));
});
