const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/setup");
const SBCache = require("../cache.js");

test("buildPreloadJobs: cuenta total esperada (~47 jobs)", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  // 1 range × 1 scope (TODOS) = 1
  // 14 probing × 1 × 3 meses = 42
  // 1 comparativa × 1 × 3 meses = 3
  // 1 mercados = 1
  assert.equal(jobs.length, 1 + 42 + 3 + 1);
});

test("buildPreloadJobs: incluye /api/mercados sin params", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  assert.ok(jobs.some(j => j.url === "/api/mercados"));
});

test("buildPreloadJobs: range query con periodoInicial=YYYY-01 y TODOS", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  const range = jobs.filter(j => j.url.startsWith("/api/indicadores/principales"));
  assert.equal(range.length, 1);
  assert.match(range[0].url, /periodoInicial=2026-01/);
  assert.match(range[0].url, /periodoFinal=2026-05/);
  assert.match(range[0].url, /tipoEntidad=TODOS/);
});

test("buildPreloadJobs: probing usa 3 meses con TODOS", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  const tipo = jobs.filter(j => j.url.startsWith("/api/carteras/creditos/tipo"));
  assert.equal(tipo.length, 3);
  const months = new Set();
  for (const j of tipo) {
    months.add(j.url.match(/periodoFinal=([^&]+)/)[1]);
    assert.match(j.url, /tipoEntidad=TODOS/);
  }
  assert.equal(months.size, 3);
});
