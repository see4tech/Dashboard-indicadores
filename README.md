# Dashboard Indicadores Financieros — SB-RD

Dashboard interactivo que consume el [API de Estadísticas del Sistema Financiero](https://desarrollador.sb.gob.do/) de la Superintendencia de Bancos de la República Dominicana.

## Estructura

```
.
├── index.html                 # Dashboard (HTML + Chart.js + Leaflet)
├── cache.js                   # Cache navegador con IndexedDB + SWR + preload
├── netlify.toml               # Configuración de Netlify (redirects + functions)
├── netlify/functions/sb-api.js  # Proxy serverless que inyecta la API key
├── proxy.py                   # Proxy local para desarrollo (alternativa)
├── probar_api_sb.py           # Script para probar todos los endpoints
├── sb_api_endpoints.md        # Documentación consolidada de los 26 endpoints
├── package.json               # devDependencies para tests
└── tests/                     # node --test + fake-indexeddb
```

## Deploy en Netlify

### 1. Crear el sitio
```bash
# Sube esta carpeta a un repo de GitHub
git init
git add .
git commit -m "initial dashboard"
git remote add origin <tu-repo>
git push
```

Luego en Netlify:
1. New site → Import from Git → conecta el repo.
2. Build command: *(vacío)*
3. Publish directory: `.`
4. Deploy.

### 2. Configurar la API key
En Netlify → **Site settings → Environment variables → Add variable**:

| Key | Value |
|---|---|
| `SB_API_KEY` | `<tu Ocp-Apim-Subscription-Key>` |

Después de agregarla, redeploy (Deploys → Trigger deploy).

### 3. Verificar
- `https://<tu-sitio>.netlify.app/` → dashboard.
- `https://<tu-sitio>.netlify.app/api/indicadores/principales?periodoInicial=2024-01&periodoFinal=2024-06` → JSON crudo.

## Desarrollo local

Dos opciones:

### Opción A — Netlify CLI (recomendada)
Replica exactamente el comportamiento de producción.

```bash
npm install -g netlify-cli
export SB_API_KEY=tu_clave
netlify dev
# abre http://localhost:8888
```

### Opción B — Proxy Python (sin dependencias)
```bash
export SB_API_KEY=tu_clave
python3 proxy.py
# abre http://localhost:8787
```

> Nota: con la opción B, el `index.html` apunta a `/api`. Como el proxy también
> sirve los archivos estáticos, todo queda en el mismo origen y funciona igual
> que en Netlify.

## Cómo funciona

1. El navegador carga `index.html` (estático).
2. Cada gráfico llama a `/api/<endpoint>` (relativo).
3. `netlify.toml` reescribe `/api/*` → `/.netlify/functions/sb-api`.
4. La función `sb-api.js`:
   - Lee `SB_API_KEY` de las variables de entorno (server-side).
   - Reenvía la petición a `https://apis.sb.gob.do/estadisticas/v2/...`.
   - Inyecta headers de navegador para evitar el bloqueo de Sucuri WAF.
   - Devuelve la respuesta con `Cache-Control: s-maxage=21600` (6h en CDN).
5. La API key **nunca** llega al navegador.

## Endpoints consumidos

Ver [`sb_api_endpoints.md`](./sb_api_endpoints.md) para la lista completa de los
26 endpoints, parámetros y schemas.

El dashboard usa principalmente:
- `/indicadores/principales` — KPIs del sistema
- `/indicadores/financieros` — comparativa entre bancos
- `/carteras/creditos/{tipo,sectores-economicos,moneda,genero,clasificacion-riesgo,facilidad,localidad}` — desglose de cartera
- `/captaciones/{moneda,sector-depositante,localidad}` — captaciones
- `/estados/situacion/eif` y `/estados/resultados/eif` — balance y resultados
- `/reclamaciones/eif` — reclamaciones
- `/indicadores/morosidad-estresada` — morosidad estresada

## Personalización

- **Cambiar paleta:** edita las variables CSS en `:root` al inicio de `index.html`.
- **Agregar tab:** añade un `<button data-tab="...">` al nav, una `<section data-pane="...">` y un loader en el objeto `LOADERS`.
- **Cambiar TTL del cache:** ajusta `s-maxage` en `netlify/functions/sb-api.js`.

## Cache local (IndexedDB)

El dashboard cachea las respuestas del API SB en IndexedDB del navegador para
que cambios de filtro sean instantáneos. Detalles en `cache.js`:

- **L1**: Map en memoria (microsegundos).
- **L2**: IndexedDB (~10-100ms, persiste entre recargas).
- **Política TTL**: meses ≥4 atrás del actual nunca expiran (SB no los modifica);
  meses 1-3 atrás expiran a las 24h con SWR; mes actual a 6h con SWR;
  endpoints sin `periodoFinal` (ej. `/api/mercados`) a 1h.
- **Preload**: al cargar el dashboard se precachea en background ~47 URLs
  cubriendo los 3 meses más recientes con `tipoEntidad=TODOS` (agregado
  del sistema). El filtrado por entidad específica es client-side, por
  eso el preload usa siempre el scope agregado. Concurrencia 2 para no
  saturar el upstream del SB.
- **SWR**: si una URL stale trae datos nuevos al refrescarse, se dispara un
  refresh silencioso del pipeline (debounce 2s) y los charts se redibujan.
- **Invalidación**: el botón "Recargar datos" vacía el cache y dispara un
  nuevo preload.

### Tests

```bash
npm install
npm test
```

`fake-indexeddb` se usa solo en tests (devDependency); el build de Netlify
no lo instala (NODE_ENV=production).

## Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `SB_API_KEY no está configurada` | Variable no fue agregada o no hubo redeploy | Site settings → Env vars → Trigger deploy |
| 403 Sucuri | Bloqueo del WAF (raro, los headers ya lo evitan) | Esperar y reintentar; revisar logs de la función |
| 400 "Se debe introducir entidad…" | Endpoint requiere filtro de entidad | El dashboard manda `tipoEntidad=TODOS` por defecto (agregado de todo el sistema) |
| Gráfico vacío | El periodo seleccionado no tiene datos | Probar con un mes anterior (la SB publica con ~3-4 meses de lag) |
