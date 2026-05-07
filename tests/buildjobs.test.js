const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/setup");
const SBCache = require("../cache.js");

test("buildPreloadJobs: cuenta total esperada (~231 jobs)", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  // 1 range × 5 scopes = 5
  // 14 probing × 5 scopes × 3 meses = 210
  // 1 comparativa × 5 scopes × 3 meses = 15
  // 1 mercados = 1
  assert.equal(jobs.length, 5 + 210 + 15 + 1);
});

test("buildPreloadJobs: incluye /api/mercados sin params", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  assert.ok(jobs.some(j => j.url === "/api/mercados"));
});

test("buildPreloadJobs: range query con periodoInicial=YYYY-01", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  const range = jobs.filter(j => j.url.startsWith("/api/indicadores/principales"));
  assert.equal(range.length, 5);
  for (const j of range) {
    assert.match(j.url, /periodoInicial=2026-01/);
    assert.match(j.url, /periodoFinal=2026-05/);
  }
});

test("buildPreloadJobs: probing usa 3 meses", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  const tipo = jobs.filter(j => j.url.startsWith("/api/carteras/creditos/tipo"));
  assert.equal(tipo.length, 5 * 3);
  const months = new Set();
  for (const j of tipo) months.add(j.url.match(/periodoFinal=([^&]+)/)[1]);
  assert.equal(months.size, 3);
});

test("buildPreloadJobs: scopes incluyen TODOS y 4 tipoEntidad", () => {
  const jobs = SBCache.buildPreloadJobs({ periodoFinal: "2026-05" });
  const tipo = jobs.filter(j => j.url.startsWith("/api/carteras/creditos/tipo"));
  const monthMay = tipo.filter(j => j.url.includes("periodoFinal=2026-05"));
  assert.equal(monthMay.length, 5);
  const tipos = monthMay.map(j => {
    const m = j.url.match(/tipoEntidad=([^&]+)/);
    return m ? m[1] : "TODOS";
  });
  assert.deepEqual(tipos.sort(), ["AC", "ARC", "BAyC", "BM", "TODOS"].sort());
});
