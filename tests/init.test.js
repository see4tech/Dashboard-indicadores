const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { resetIDB } = require("./helpers/setup");
const SBCache = require("../cache.js");

beforeEach(async () => {
  await resetIDB();
});

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
