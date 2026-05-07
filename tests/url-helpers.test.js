const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/setup");
const SBCache = require("../cache.js");

test("parsePeriodoFinal: con periodoFinal explícito", () => {
  assert.equal(
    SBCache.parsePeriodoFinal("/api/x?periodoInicial=2026-01&periodoFinal=2026-04"),
    "2026-04"
  );
});

test("parsePeriodoFinal: sin periodoFinal → null", () => {
  assert.equal(SBCache.parsePeriodoFinal("/api/mercados"), null);
  assert.equal(SBCache.parsePeriodoFinal("/api/x?periodoInicial=2026-01"), null);
});

test("parsePeriodoFinal: con multi params", () => {
  assert.equal(
    SBCache.parsePeriodoFinal("/api/x?tipoEntidad=BM&periodoFinal=2025-12&paginas=1"),
    "2025-12"
  );
});
