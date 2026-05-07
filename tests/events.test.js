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
  SBCache.on("e2", () => { throw new Error("boom"); });
  const off = SBCache.on("e2", (x) => got.push(x));
  SBCache._emit("e2", 42);
  off();
  assert.deepEqual(got, [42]);
});
