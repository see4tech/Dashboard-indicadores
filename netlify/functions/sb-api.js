/**
 * Proxy serverless al API de Estadísticas del Sistema Financiero (SB-RD)
 * + endpoint /mercados que agrega precios de divisas, commodities y combustibles.
 *
 * Ruta: /api/<endpoint>?...  → reescrito por netlify.toml a esta función.
 *
 * Cache L2 vía Netlify Blobs (`sb-cache`):
 *   - Persistente entre invocaciones de la function y compartido entre usuarios.
 *   - TTL por antigüedad del periodoFinal: meses cerrados (>=4 atrás) nunca
 *     expiran; 1-3 meses atrás → 7 días; mes actual → 24h; sin periodoFinal
 *     → 1h; errores 4xx → 5 min; 5xx no se persisten.
 *   - Cuando upstream falla y hay blob existente (aunque expirado), se sirve
 *     stale (header X-Cache: STALE-BLOB).
 *
 * Variables de entorno requeridas:
 *   SB_API_KEY = <tu Ocp-Apim-Subscription-Key>
 */

const { getStore } = require("@netlify/blobs");

const UPSTREAM = "https://apis.sb.gob.do/estadisticas/v2";

const HOUR = 3600 * 1000;
const DAY  = 24 * HOUR;

function policyForBlob(periodoFinal, now) {
  if (!periodoFinal) return { ttlMs: HOUR };
  const m = /^(\d{4})-(\d{2})$/.exec(periodoFinal);
  if (!m) return { ttlMs: HOUR };
  const y = +m[1], mo = +m[2];
  const d = new Date(now);
  const delta = (d.getUTCFullYear() - y) * 12 + (d.getUTCMonth() + 1 - mo);
  if (delta >= 4) return { ttlMs: null };          // inmutable
  if (delta >= 1) return { ttlMs: 7 * DAY };       // 1-3 meses atrás
  return { ttlMs: DAY };                           // mes actual / futuro
}

function periodoFinalFromQs(qsString) {
  try { return new URLSearchParams(qsString).get("periodoFinal"); }
  catch { return null; }
}

// Devuelve el store o null si Blobs no está disponible (p.ej. en ejecuciones
// fuera de Netlify o si la config no se inyectó).
function safeStore() {
  try { return getStore({ name: "sb-cache", consistency: "eventual" }); }
  catch (e) { return null; }
}

const BROWSER_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Origin": "https://desarrollador.sb.gob.do",
  "Referer": "https://desarrollador.sb.gob.do/",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  let path = event.path || "";
  path = path.replace(/^\/\.netlify\/functions\/sb-api/, "");
  path = path.replace(/^\/api/, "");
  if (!path.startsWith("/")) path = "/" + path;

  // Endpoint: datos de mercados (divisas, commodities, combustibles)
  if (path === "/mercados") {
    return fetchMercados();
  }

  // Endpoint: GeoJSON de provincias de RD
  if (path === "/geo/provincias") {
    return fetchGeoJSON();
  }

  const apiKey = process.env.SB_API_KEY;
  if (!apiKey) {
    return jsonError(500, "SB_API_KEY no está configurada en Netlify (Site settings → Environment variables).");
  }

  const qs = new URLSearchParams();
  const mv = event.multiValueQueryStringParameters || {};
  if (Object.keys(mv).length) {
    for (const [k, vs] of Object.entries(mv)) {
      for (const v of vs) qs.append(k, v);
    }
  } else if (event.queryStringParameters) {
    for (const [k, v] of Object.entries(event.queryStringParameters)) {
      qs.append(k, v);
    }
  }

  const qsString = qs.toString();
  const url = UPSTREAM + path + (qsString ? "?" + qsString : "");
  const blobKey = path + (qsString ? "?" + qsString : "");
  const store = safeStore();
  const now = Date.now();

  // L2 — leer Blobs primero
  let cached = null;
  if (store) {
    try {
      const got = await store.getWithMetadata(blobKey, { type: "json" });
      if (got) cached = got;
    } catch (e) { /* blob layer down: degradar a upstream */ }
  }

  if (cached) {
    const expiresAt = cached.metadata && cached.metadata.expiresAt;
    if (expiresAt == null || expiresAt > now) {
      const data = cached.data || {};
      return {
        statusCode: data.status || 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": data.contentType || "application/json",
          "Cache-Control": "public, max-age=300, s-maxage=21600",
          "X-Cache": "HIT-BLOB",
        },
        body: data.body || "",
      };
    }
  }

  // L3 — upstream SB
  let upstream;
  try {
    upstream = await fetch(url, {
      headers: { ...BROWSER_HEADERS, "Ocp-Apim-Subscription-Key": apiKey },
    });
  } catch (e) {
    // Si hay blob aunque sea expirado, lo servimos stale-while-error
    if (cached && cached.data) {
      return {
        statusCode: cached.data.status || 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": cached.data.contentType || "application/json",
          "Cache-Control": "public, max-age=60",
          "X-Cache": "STALE-BLOB",
          "X-Stale-Reason": "upstream-network-error",
        },
        body: cached.data.body || "",
      };
    }
    return jsonError(502, "upstream: " + (e.message || String(e)));
  }

  const body = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "application/json";

  // Persistir según resultado
  if (store) {
    if (upstream.ok) {
      // 2xx — caché normal según política por antigüedad
      const policy = policyForBlob(periodoFinalFromQs(qsString), now);
      const expiresAt = policy.ttlMs == null ? null : now + policy.ttlMs;
      try {
        await store.setJSON(blobKey, { body, contentType, status: upstream.status }, {
          metadata: { expiresAt, fetchedAt: now },
        });
      } catch (e) { /* ignore blob write errors */ }
    } else if (upstream.status >= 400 && upstream.status < 500) {
      // 4xx — caché corto (5 min) para no martillar endpoints rotos
      try {
        await store.setJSON(blobKey, { body, contentType, status: upstream.status }, {
          metadata: { expiresAt: now + 5 * 60 * 1000, fetchedAt: now },
        });
      } catch (e) { /* ignore */ }
    } else if (upstream.status >= 500 && cached && cached.data) {
      // 5xx + tenemos blob → servir stale
      return {
        statusCode: cached.data.status || 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": cached.data.contentType || "application/json",
          "Cache-Control": "public, max-age=60",
          "X-Cache": "STALE-BLOB",
          "X-Stale-Reason": "upstream-" + upstream.status,
        },
        body: cached.data.body || "",
      };
    }
  }

  return {
    statusCode: upstream.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300, s-maxage=21600",
      "X-Cache": cached ? "REFRESH-BLOB" : "MISS-BLOB",
    },
    body,
  };
};

/* ─────────────────────────────────────────────────────────
   /mercados — agrega datos de fuentes externas gratuitas
   ───────────────────────────────────────────────────────── */
async function fetchMercados() {
  const [forexR, metalsR, oilR, btcR, fuelR] = await Promise.allSettled([
    fetchForex(),
    fetchMetals(),
    fetchOil(),
    fetchBTC(),
    fetchFuelPrices(),
  ]);

  const forex  = forexR.status  === "fulfilled" ? forexR.value  : null;
  const metals = metalsR.status === "fulfilled" ? metalsR.value : null;
  const oil    = oilR.status    === "fulfilled" ? oilR.value    : null;
  const btc    = btcR.status    === "fulfilled" ? btcR.value    : null;
  const fuel   = fuelR.status   === "fulfilled" ? fuelR.value   : null;

  // Tasa de referencia USD → DOP (mid-market)
  const usdDop = forex?.usdDop ?? null;

  // Spread típico de bancos comerciales en RD: ~2% cada lado
  const compra = usdDop ? +(usdDop * 0.980).toFixed(2) : null;
  const venta  = usdDop ? +(usdDop * 1.020).toFixed(2) : null;

  const data = {
    timestamp: new Date().toISOString(),
    fuentes: {
      forex:  forex?.fuente  ?? null,
      metals: metals?.fuente ?? null,
      oil:    "Yahoo Finance (CL=F)",
      btc:    "CoinGecko",
      fuel:   fuel?.fuente   ?? null,
    },
    forex: {
      usdDopMid:    usdDop,
      usdDopCompra: compra,
      usdDopVenta:  venta,
    },
    btc: {
      usd: btc?.usd ?? null,
      dop: (btc?.usd && usdDop) ? +(btc.usd * usdDop) : null,
    },
    gold: {
      usdPerOzt: metals?.gold ?? null,
      dopPerOzt: (metals?.gold && usdDop) ? +(metals.gold * usdDop).toFixed(2) : null,
    },
    silver: {
      usdPerOzt: metals?.silver ?? null,
      dopPerOzt: (metals?.silver && usdDop) ? +(metals.silver * usdDop).toFixed(2) : null,
    },
    oil: {
      usdPerBarrel: oil ?? null,
      dopPerBarrel: (oil && usdDop) ? +(oil * usdDop).toFixed(2) : null,
    },
    fuel: fuel?.prices ?? null,
  };

  return {
    statusCode: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      // 15 min en cliente, 1 hora en CDN Netlify
      "Cache-Control": "public, max-age=900, s-maxage=3600",
    },
    body: JSON.stringify(data),
  };
}

/** USD/DOP mid-market — Frankfurter (ECB) → Open ER-API */
async function fetchForex() {
  try {
    const r = await fetchWT("https://api.frankfurter.app/latest?from=USD&to=DOP", 8000);
    const j = await r.json();
    if (j?.rates?.DOP) return { usdDop: j.rates.DOP, fuente: "Frankfurter / ECB" };
  } catch {}
  try {
    const r = await fetchWT("https://open.er-api.com/v6/latest/USD", 8000);
    const j = await r.json();
    if (j?.rates?.DOP) return { usdDop: j.rates.DOP, fuente: "Open ER-API" };
  } catch {}
  return null;
}

/** Oro y plata (USD/ozt) — metals.live */
async function fetchMetals() {
  try {
    const r = await fetchWT("https://api.metals.live/v1/spot/gold,silver", 8000);
    const j = await r.json();
    let gold, silver;
    if (Array.isArray(j)) {
      for (const item of j) {
        if (item.gold   != null) gold   = item.gold;
        if (item.silver != null) silver = item.silver;
      }
    } else {
      gold   = j?.gold;
      silver = j?.silver;
    }
    if (gold && silver) return { gold, silver, fuente: "metals.live" };
  } catch {}
  return null;
}

/** Petróleo WTI (USD/barril) — Yahoo Finance */
async function fetchOil() {
  for (const ticker of ["CL=F", "BZ=F"]) {
    try {
      const r = await fetchWT(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } },
        8000
      );
      const j = await r.json();
      const price = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) return price;
    } catch {}
  }
  return null;
}

/** Bitcoin (USD) — CoinGecko free API */
async function fetchBTC() {
  try {
    const r = await fetchWT(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      { headers: { "Accept": "application/json" } },
      10000
    );
    const j = await r.json();
    if (j?.bitcoin?.usd) return { usd: j.bitcoin.usd };
  } catch {}
  return null;
}

/**
 * Precios de combustibles en RD (DOP/galón).
 * MICM publica precios cada semana — intentamos su API y luego la web.
 */
async function fetchFuelPrices() {
  // Intento con endpoints JSON conocidos/especulativos
  for (const url of [
    "https://micm.gob.do/api/precios-combustibles",
    "https://micm.gob.do/api/combustibles/precios",
  ]) {
    try {
      const r = await fetchWT(url, {}, 5000);
      if (r.ok) {
        const j = await r.json();
        const prices = normalizeMICMJson(j);
        if (prices) return { prices, fuente: url };
      }
    } catch {}
  }

  // Fallback: parsear HTML de la página pública
  try {
    const r = await fetchWT(
      "https://micm.gob.do/combustibles",
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" } },
      10000
    );
    if (r.ok) {
      const html = await r.text();
      const prices = parseMICMHtml(html);
      if (prices) return { prices, fuente: "micm.gob.do" };
    }
  } catch {}

  return null;
}

function normalizeMICMJson(j) {
  if (!Array.isArray(j)) return null;
  const out = {};
  for (const item of j) {
    const nombre = (item.nombre || item.name || item.combustible || "").toLowerCase();
    const precio = parseFloat(item.precio || item.price || item.valor || 0);
    if (!precio) continue;
    if (/premium/i.test(nombre))                                         out.gasolinaPremium = precio;
    else if (/regular.*gasolina|gasolina.*regular/i.test(nombre))        out.gasolinaRegular = precio;
    else if (/gasoil.*[oó]ptimo|[oó]ptimo.*gasoil/i.test(nombre))        out.gasoilOptimo    = precio;
    else if (/gasoil/i.test(nombre))                                     out.gasoilRegular   = precio;
    else if (/glp|propano/i.test(nombre))                                out.glp             = precio;
    else if (/kerosene|kero|avtur/i.test(nombre))                        out.kerosene        = precio;
    else if (/fuel\s*oil/i.test(nombre))                                 out.fuelOil         = precio;
  }
  return Object.keys(out).length >= 2 ? out : null;
}

function parseMICMHtml(html) {
  const out = {};
  const patterns = [
    [/gasolina\s+premium[^\d]{0,60}(\d{2,3}[.,]\d{1,2})/i,           "gasolinaPremium"],
    [/gasolina\s+regular[^\d]{0,60}(\d{2,3}[.,]\d{1,2})/i,           "gasolinaRegular"],
    [/gasoil\s+[oó]ptimo[^\d]{0,60}(\d{2,3}[.,]\d{1,2})/i,           "gasoilOptimo"],
    [/gasoil\s+regular[^\d]{0,60}(\d{2,3}[.,]\d{1,2})/i,             "gasoilRegular"],
    [/gas\s+licuado[^\d]{0,60}(\d{2,3}[.,]\d{1,2})/i,                "glp"],
    [/glp[^\d]{0,40}(\d{2,3}[.,]\d{1,2})/i,                          "glp"],
    [/kerosene[^\d]{0,60}(\d{2,3}[.,]\d{1,2})/i,                     "kerosene"],
    [/avtur[^\d]{0,60}(\d{2,3}[.,]\d{1,2})/i,                        "avtur"],
    [/fuel\s*oil[^\d]{0,60}(\d{2,3}[.,]\d{1,2})/i,                   "fuelOil"],
  ];
  for (const [re, key] of patterns) {
    if (out[key]) continue;
    const m = html.match(re);
    if (m) out[key] = parseFloat(m[1].replace(",", "."));
  }
  return Object.keys(out).length >= 2 ? out : null;
}

/** fetch con timeout usando AbortController */
function fetchWT(url, optsOrMs, ms) {
  let opts = {};
  if (typeof optsOrMs === "number") { ms = optsOrMs; }
  else if (optsOrMs && typeof optsOrMs === "object") { opts = optsOrMs; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function jsonError(status, message) {
  return {
    statusCode: status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ Succeeded: false, Message: message, Errors: null, Data: null }),
  };
}

async function fetchGeoJSON() {
  const sources = [
    "https://raw.githubusercontent.com/codeforgermany/click_that_hood/master/public/data/dominican-republic.geojson",
    "https://raw.githubusercontent.com/glynnbird/usstatesgeojson/master/dominican-republic.geojson",
    "https://gist.githubusercontent.com/AshKyd/5453c1b4af19fcb9d9e0/raw/dominican-republic.geojson",
  ];
  for (const url of sources) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "netlify-fn" } });
      if (!r.ok) continue;
      const body = await r.text();
      const j = JSON.parse(body);
      if (j && j.type === "FeatureCollection" && Array.isArray(j.features)) {
        return {
          statusCode: 200,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/geo+json",
            "Cache-Control": "public, max-age=86400, s-maxage=604800",
          },
          body,
        };
      }
    } catch {}
  }
  return jsonError(502, "No se pudo obtener GeoJSON de provincias.");
}
