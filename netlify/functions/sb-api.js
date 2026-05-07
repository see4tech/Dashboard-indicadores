/**
 * Proxy serverless al API de Estadísticas del Sistema Financiero (SB-RD).
 *
 * Ruta: /api/<endpoint>?...  → reescrito por netlify.toml a esta función.
 *
 * Variables de entorno requeridas (Netlify → Site settings → Environment variables):
 *   SB_API_KEY = <tu Ocp-Apim-Subscription-Key>
 *
 * Resuelve dos cosas:
 *   1) CORS: el API de SB no envía Access-Control-Allow-Origin.
 *   2) Sucuri WAF: bloquea peticiones que no parecen navegador → mandamos
 *      User-Agent / Origin / Referer realistas.
 */

const UPSTREAM = "https://apis.sb.gob.do/estadisticas/v2";

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

  const apiKey = process.env.SB_API_KEY;
  if (!apiKey) {
    return jsonError(500, "SB_API_KEY no está configurada en Netlify (Site settings → Environment variables).");
  }

  // event.path puede llegar como /.netlify/functions/sb-api/captaciones/localidad
  // o como /api/captaciones/localidad — manejamos ambos.
  let path = event.path || "";
  path = path.replace(/^\/\.netlify\/functions\/sb-api/, "");
  path = path.replace(/^\/api/, "");
  if (!path.startsWith("/")) path = "/" + path;

  // Reconstruir querystring respetando parámetros multi-valor (ej. entidad=A&entidad=B)
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

  const url = UPSTREAM + path + (qs.toString() ? "?" + qs.toString() : "");

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: { ...BROWSER_HEADERS, "Ocp-Apim-Subscription-Key": apiKey },
    });
  } catch (e) {
    return jsonError(502, "upstream: " + (e.message || String(e)));
  }

  const body = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "application/json";

  return {
    statusCode: upstream.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      // Los datos del SB se actualizan mensualmente — cacheamos 6 horas en CDN
      "Cache-Control": "public, max-age=300, s-maxage=21600",
    },
    body,
  };
};

function jsonError(status, message) {
  return {
    statusCode: status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ Succeeded: false, Message: message, Errors: null, Data: null }),
  };
}
