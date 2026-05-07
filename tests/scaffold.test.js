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
