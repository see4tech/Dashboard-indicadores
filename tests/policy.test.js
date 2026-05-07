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
