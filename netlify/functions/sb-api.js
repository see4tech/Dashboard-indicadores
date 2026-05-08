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

const { getStore, connectLambda } = require("@netlify/blobs");

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
let _blobsStatus = "unknown";
function safeStore() {
  try {
    const s = getStore({ name: "sb-cache", consistency: "eventual" });
    _blobsStatus = "ok";
    return s;
  } catch (e) {
    _blobsStatus = "init-error: " + (e.message || String(e));
    console.warn("[sb-api] Blobs init failed:", e.message);
    return null;
  }
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
  // Inyecta el contexto de Blobs al runtime cuando la function corre en
  // formato Lambda legacy (exports.handler). Sin esto, getStore() lanza
  // "environment has not been configured".
  try { connectLambda(event); } catch (e) { /* ya inyectado o no aplica */ }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  let path = event.path || "";
  path = path.replace(/^\/\.netlify\/functions\/sb-api/, "");
  path = path.replace(/^\/api/, "");
  if (!path.startsWith("/")) path = "/" + path;

  // ?_refresh=1 lo manda el botón "Recargar datos" para saltear caches
  // (Blobs L2 + CDN). Detectamos antes de rutear porque /mercados y
  // /geo/provincias no pasan por la lógica de Blobs pero sí por CDN.
  const isRefresh = !!(event.queryStringParameters && event.queryStringParameters._refresh);

  // Endpoint: datos de mercados (divisas, commodities, combustibles)
  if (path === "/mercados") {
    return fetchMercados(isRefresh);
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

  // Detectar y stripear _refresh=1 (force-refresh del cliente). Cuando está
  // presente saltamos la lectura de Blobs y forzamos un fetch al upstream;
  // el resultado SÍ se persiste en Blobs bajo la clave limpia para que los
  // próximos reads (sin _refresh) lo encuentren.
  const forceRefresh = qs.has("_refresh");
  if (forceRefresh) qs.delete("_refresh");

  const qsString = qs.toString();
  const url = UPSTREAM + path + (qsString ? "?" + qsString : "");
  // Blob keys no pueden empezar con / — stripeamos la barra inicial.
  const blobKey = (path.replace(/^\/+/, "")) + (qsString ? "?" + qsString : "");
  const store = safeStore();
  const now = Date.now();

  // L2 — leer Blobs primero (salvo force-refresh)
  let cached = null;
  let blobReadError = null;
  if (store && !forceRefresh) {
    try {
      const got = await store.getWithMetadata(blobKey, { type: "json" });
      if (got) cached = got;
    } catch (e) {
      blobReadError = e.message || String(e);
      console.warn("[sb-api] blob get failed:", blobReadError, "key=", blobKey.slice(0, 80));
    }
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
          "X-Blobs-Status": _blobsStatus,
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
          "X-Blobs-Status": _blobsStatus,
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
  let blobWriteError = null;
  if (store) {
    if (upstream.ok) {
      // 2xx — caché normal según política por antigüedad
      const policy = policyForBlob(periodoFinalFromQs(qsString), now);
      const expiresAt = policy.ttlMs == null ? null : now + policy.ttlMs;
      try {
        await store.setJSON(blobKey, { body, contentType, status: upstream.status }, {
          metadata: { expiresAt, fetchedAt: now },
        });
        console.log("[sb-api] blob set ok:", blobKey.slice(0, 80), "ttl=", policy.ttlMs);
      } catch (e) {
        blobWriteError = e.message || String(e);
        console.warn("[sb-api] blob set failed:", blobWriteError, "key=", blobKey.slice(0, 80));
      }
    } else if (upstream.status >= 400 && upstream.status < 500) {
      // 4xx — caché corto (5 min) para no martillar endpoints rotos
      try {
        await store.setJSON(blobKey, { body, contentType, status: upstream.status }, {
          metadata: { expiresAt: now + 5 * 60 * 1000, fetchedAt: now },
        });
      } catch (e) {
        blobWriteError = e.message || String(e);
        console.warn("[sb-api] blob set 4xx failed:", blobWriteError);
      }
    } else if (upstream.status >= 500 && cached && cached.data) {
      // 5xx + tenemos blob → servir stale
      return {
        statusCode: cached.data.status || 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": cached.data.contentType || "application/json",
          "Cache-Control": "public, max-age=60",
          "X-Cache": "STALE-BLOB",
          "X-Blobs-Status": _blobsStatus,
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
      "X-Blobs-Status": _blobsStatus,
      ...(blobReadError  ? { "X-Blobs-Read-Error":  blobReadError.slice(0, 200) }  : {}),
      ...(blobWriteError ? { "X-Blobs-Write-Error": blobWriteError.slice(0, 200) } : {}),
    },
    body,
  };
};

/* ─────────────────────────────────────────────────────────
   /mercados — agrega datos de fuentes externas gratuitas
   ───────────────────────────────────────────────────────── */
async function fetchMercados(isRefresh = false) {
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
  const fuelRaw = fuelR.status === "fulfilled" ? fuelR.value : null;
  // fuel resuelto a precios válidos (con .prices) o null si solo trae __debug
  const fuel = (fuelRaw && fuelRaw.prices) ? fuelRaw : null;
  const fuelDebug = (fuelRaw && fuelRaw.__debug) ? fuelRaw.__debug : null;

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
    fuelDebug,
  };

  return {
    statusCode: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      // En refresh: no-store para que CDN no cachee la respuesta refrescada.
      // En normal: 15 min cliente, 1 hora CDN.
      "Cache-Control": isRefresh
        ? "no-store"
        : "public, max-age=900, s-maxage=3600",
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

/** Oro y plata (USD/ozt) — gold-api.com (gratis, sin key) con fallback. */
async function fetchMetals() {
  // Intento 1: api.gold-api.com (free, working as of late 2025)
  try {
    const [goldR, silverR] = await Promise.allSettled([
      fetchWT("https://api.gold-api.com/price/XAU", 6000),
      fetchWT("https://api.gold-api.com/price/XAG", 6000),
    ]);
    let gold = null, silver = null;
    if (goldR.status === "fulfilled" && goldR.value.ok) {
      const j = await goldR.value.json();
      if (j && typeof j.price === "number") gold = j.price;
    }
    if (silverR.status === "fulfilled" && silverR.value.ok) {
      const j = await silverR.value.json();
      if (j && typeof j.price === "number") silver = j.price;
    }
    if (gold && silver) return { gold, silver, fuente: "gold-api.com" };
  } catch {}

  // Intento 2: data-asg.goldprice.org (usado por goldprice.org)
  try {
    const r = await fetchWT(
      "https://data-asg.goldprice.org/dbXRates/USD",
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } },
      6000
    );
    const j = await r.json();
    const item = Array.isArray(j?.items) ? j.items[0] : null;
    if (item && item.xauPrice && item.xagPrice) {
      return { gold: item.xauPrice, silver: item.xagPrice, fuente: "goldprice.org" };
    }
  } catch {}

  // Intento 3: legacy metals.live (probablemente muerto, lo dejamos por si vuelve)
  try {
    const r = await fetchWT("https://api.metals.live/v1/spot/gold,silver", 5000);
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
  const debug = { tried: [] };
  const browserHeaders = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-DO,es;q=0.9,en;q=0.8",
  };

  // Fuente primaria: API JSON de conectate.com.do — incluye Kerosene + GNV +
  // los 5 que también publica MICM. Es la fuente más completa.
  try {
    const r = await fetchWT(
      "https://graphs.conectate.com.do/api/fuel-table-data",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Accept": "application/json",
          "User-Agent": browserHeaders["User-Agent"],
          "Origin": "https://www.conectate.com.do",
          "Referer": "https://www.conectate.com.do/",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: "slug=",
      },
      10000
    );
    if (r.ok) {
      const j = await r.json();
      const prices = normalizeConectateFuel(j);
      if (prices) {
        console.log("[fuel] OK from conectate →", JSON.stringify(prices));
        return { prices, fuente: "conectate.com.do" };
      }
    }
    debug.tried.push({ url: "conectate fuel-table-data", status: r.status });
  } catch (e) {
    debug.tried.push({ url: "conectate fuel-table-data", error: e.message || String(e) });
  }

  // Fallback: scrape de la home page de MICM (6 fuels, sin Kerosene).
  for (const url of [
    "https://micm.gob.do/",
    "https://micm.gob.do/direcciones/combustibles/avisos-semanales-de-precios/avisos-semanales-de-precios-de-combustibles/",
  ]) {
    try {
      const r = await fetchWT(url, { headers: browserHeaders }, 10000);
      const status = r.status;
      const html = r.ok ? await r.text() : "";
      const prices = html ? parseMICMHtml(html) : null;
      debug.tried.push({ url, status, htmlLen: html.length, parsedKeys: prices ? Object.keys(prices) : null });
      if (prices) {
        console.log("[fuel] OK from", url, "→", JSON.stringify(prices));
        return { prices, fuente: url };
      }
    } catch (e) {
      debug.tried.push({ url, error: e.message || String(e) });
    }
  }

  return { __debug: debug };
}

/**
 * Normaliza la respuesta del API de conectate.com.do al schema interno.
 * Input: { from, to, data: [{name, from, to}, ...] }
 *   "to" es el precio actual de la semana, "from" el de la semana anterior.
 */
function normalizeConectateFuel(j) {
  if (!j || !Array.isArray(j.data)) return null;
  const out = {};
  for (const item of j.data) {
    const name = (item.name || "").toLowerCase();
    const price = parseFloat(item.to);  // 'to' es la semana actual
    if (!isFinite(price) || price <= 0) continue;
    if      (/gasolina\s+premium/.test(name))      out.gasolinaPremium = price;
    else if (/gasolina\s+regular/.test(name))      out.gasolinaRegular = price;
    else if (/gasoil\s+[oó]ptimo/.test(name))      out.gasoilOptimo    = price;
    else if (/gasoil\s+regular/.test(name))        out.gasoilRegular   = price;
    else if (/kerosene|kerosén|avtur/.test(name))  out.kerosene        = price;
    else if (/gas\s+licuado|\bglp\b/.test(name))   out.glp             = price;
    else if (/gas\s+natural|\bgnv\b|\bgnc\b|\bgnl\b/.test(name)) out.gasNatural = price;
    else if (/fuel\s*oil/.test(name))              out.fuelOil         = price;
  }
  return Object.keys(out).length >= 4 ? out : null;
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
  // Stripeamos tags HTML para tener un texto plano searchable
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");

  const out = {};

  // El layout de MICM home pone PRECIO antes del nombre:
  //   $323.10 ... Gasolina Premium
  // Orden de búsqueda importante: específicas antes que generales.
  // (gas natural antes que glp para evitar match cruzado)
  const patternsPriceFirst = [
    [/\$\s*([\d,]+\.\d{1,2})\s*(?:[A-Za-zÁÉÍÓÚáéíóúñÑ\s\.\(\)\-]{0,40})?\bgasolina\s+premium\b/i, "gasolinaPremium"],
    [/\$\s*([\d,]+\.\d{1,2})\s*(?:[A-Za-zÁÉÍÓÚáéíóúñÑ\s\.\(\)\-]{0,40})?\bgasolina\s+regular\b/i, "gasolinaRegular"],
    [/\$\s*([\d,]+\.\d{1,2})\s*(?:[A-Za-zÁÉÍÓÚáéíóúñÑ\s\.\(\)\-]{0,40})?\bgasoil\s+[oó]ptimo\b/i, "gasoilOptimo"],
    [/\$\s*([\d,]+\.\d{1,2})\s*(?:[A-Za-zÁÉÍÓÚáéíóúñÑ\s\.\(\)\-]{0,40})?\bgasoil\s+regular\b/i, "gasoilRegular"],
    [/\$\s*([\d,]+\.\d{1,2})\s*(?:[A-Za-zÁÉÍÓÚáéíóúñÑ\s\.\(\)\-]{0,40})?\bgas\s+licuado\b/i,    "glp"],
    [/\$\s*([\d,]+\.\d{1,2})\s*(?:[A-Za-zÁÉÍÓÚáéíóúñÑ\s\.\(\)\-]{0,40})?\bglp\b/i,              "glp"],
    [/\$\s*([\d,]+\.\d{1,2})\s*(?:[A-Za-zÁÉÍÓÚáéíóúñÑ\s\.\(\)\-]{0,40})?\bgas\s+natural\b/i,    "gasNatural"],
    [/\$\s*([\d,]+\.\d{1,2})\s*(?:[A-Za-zÁÉÍÓÚáéíóúñÑ\s\.\(\)\-]{0,40})?\b(?:kerosene|avtur)\b/i, "kerosene"],
    [/\$\s*([\d,]+\.\d{1,2})\s*(?:[A-Za-zÁÉÍÓÚáéíóúñÑ\s\.\(\)\-]{0,40})?\bfuel\s*oil\b/i,       "fuelOil"],
  ];

  // Layout alternativo (avisos-semanales): NOMBRE antes del precio.
  const patternsNameFirst = [
    [/\bgasolina\s+premium\b[^\d$]{0,60}\$?\s*([\d,]+\.\d{1,2})/i, "gasolinaPremium"],
    [/\bgasolina\s+regular\b[^\d$]{0,60}\$?\s*([\d,]+\.\d{1,2})/i, "gasolinaRegular"],
    [/\bgasoil\s+[oó]ptimo\b[^\d$]{0,60}\$?\s*([\d,]+\.\d{1,2})/i, "gasoilOptimo"],
    [/\bgasoil\s+regular\b[^\d$]{0,60}\$?\s*([\d,]+\.\d{1,2})/i,   "gasoilRegular"],
    [/\bgas\s+licuado\b[^\d$]{0,60}\$?\s*([\d,]+\.\d{1,2})/i,      "glp"],
    [/\bglp\b[^\d$]{0,40}\$?\s*([\d,]+\.\d{1,2})/i,                "glp"],
    [/\bgas\s+natural\b[^\d$]{0,60}\$?\s*([\d,]+\.\d{1,2})/i,      "gasNatural"],
    [/\b(?:kerosene|avtur)\b[^\d$]{0,60}\$?\s*([\d,]+\.\d{1,2})/i, "kerosene"],
    [/\bfuel\s*oil\b[^\d$]{0,60}\$?\s*([\d,]+\.\d{1,2})/i,         "fuelOil"],
  ];

  for (const [re, key] of patternsPriceFirst) {
    if (out[key]) continue;
    const m = text.match(re);
    if (m) out[key] = parseFloat(m[1].replace(/,/g, ""));
  }
  for (const [re, key] of patternsNameFirst) {
    if (out[key]) continue;
    const m = text.match(re);
    if (m) out[key] = parseFloat(m[1].replace(/,/g, ""));
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
