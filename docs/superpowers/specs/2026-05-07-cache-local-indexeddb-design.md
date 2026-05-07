# Cache local en navegador con IndexedDB — Diseño

**Fecha**: 2026-05-07
**Estado**: Diseño aprobado, pendiente de implementación
**Autor**: brainstorming session

## Contexto

El dashboard `Dashboard Indicadores Financieros` (SB-RD) es una SPA estática
servida por Netlify que consume el API de Estadísticas del Sistema Financiero
de la Superintendencia de Bancos vía una Netlify Function (`netlify/functions/sb-api.js`)
que actúa como proxy y oculta la `SB_API_KEY`.

Hoy cada cambio de filtro (`periodoInicial`, `periodoFinal`, lista de `entidad`)
genera URLs nuevas, lo que produce miss en la CDN de Netlify (`s-maxage=21600`)
y obliga a un round-trip al upstream SB. La función ya inyecta los headers
necesarios para evitar el WAF Sucuri, pero las llamadas frías son lentas
(de varios segundos por endpoint). El cache existente en `index.html` es un
`Map` in-memory que se pierde con cada recarga del navegador.

## Objetivo

Reducir el tiempo percibido al cambiar filtros a casi cero, manteniendo el
proyecto como una SPA estática en Netlify y respetando la naturaleza mensual
de los datos publicados por SB.

## No-objetivos

- No introducir backend persistente nuevo (sin Netlify Blobs, sin DB).
- No cambiar la estructura de tabs ni la lógica de charts.
- No tocar `netlify/functions/sb-api.js`.
- No optimizar para audiencia masiva (uso interno ≤5 personas).

## Decisiones de diseño

| Eje | Elección | Razón |
|---|---|---|
| Audiencia | Equipo chico (≤5) | Cache solo en navegador es suficiente. |
| Estrategia de llenado | Híbrido: preload + lazy | Filtros comunes instantáneos, los raros caen a lazy. |
| Política de refresco | Inmutable (≥4 meses atrás) + SWR 24h (1-3 meses) + SWR 6h (mes actual) + botón fuerza | Aprovecha que SB no modifica meses cerrados; mantiene frescura para los recientes. |
| Alcance del preload | `TODOS` + 4 `tipoEntidad` (BM, BAyC, AC, ARC), año en curso | Cubre los selectores rápidos del UI. |
| UX del preload | Background con pill de progreso | Usuario empieza a trabajar inmediatamente y ve el calentamiento. |
| Storage | IndexedDB (capacidad >50MB típico) | Suficiente margen sobre los ~1-2MB esperados. |
| Backend | Solo navegador | Netlify Function queda intacta. |

## Arquitectura

```
┌─────────── index.html (UI + loaders) ───────────┐
│  fetchResumen / fetchCartera / ...              │
│         ↓                                       │
│  SBCache.get(url)             ← API única       │
└──────────────┬──────────────────────────────────┘
               ↓
┌─────────── cache.js (módulo nuevo) ─────────────┐
│  • IndexedDB: sb-dashboard-cache, store=responses│
│  • L1 in-memory Map (hot path)                  │
│  • policyFor(periodoFinal, now) — TTL pura      │
│  • SWR: stale inmediato + refetch async         │
│  • preload queue (concurrencia 6)               │
│  • Eventos: 'progress' | 'updated' | 'error' | 'done' │
│  • In-flight dedup map (no doble fetch para misma URL)│
└──────────────┬──────────────────────────────────┘
               ↓
       /api/<endpoint>?...   (Netlify Function existente, sin cambios)
```

### Por qué módulo separado

- `index.html` ya tiene 1290 líneas; sumar lógica empeora.
- El módulo es testeable independiente (Node + `fake-indexeddb`).
- Interfaz pública mínima y clara: `get`, `preload`, `invalidateAll`, `init`, `on`.
- Los loaders existentes solo cambian una línea cada uno.

## Modelo de datos

**Database**: `sb-dashboard-cache`, versión `1`.
**ObjectStore**: `responses`, `keyPath = "url"`.

**Schema de cada registro**:

```js
{
  url: "/api/indicadores/principales?periodoInicial=2026-01&periodoFinal=2026-04",
  body: <JSON parseado>,           // no string
  status: 200,                     // 200 | 204
  fetchedAt: 1735000000000,        // Date.now() al guardar
  periodoFinal: "2026-04",         // extraído de la query — entrada a la política
  expiresAt: 1735086400000,        // calculado al guardar; null = no expira
  schemaVersion: 1                 // permite invalidación masiva por bump
}
```

## Política TTL

Función pura: `policyFor(periodoFinal: string|null, now: number)
  → { ttlMs: number|null, swr: boolean }`.

| Edad de `periodoFinal` respecto a hoy | TTL | SWR | Razón |
|---|---|---|---|
| ≥ 4 meses atrás | Infinito (`null`) | n/a | Mes cerrado, SB no lo modifica. |
| 1-3 meses atrás | 24 h | sí | Posibles re-publicaciones tardías. |
| Mes actual o futuro | 6 h | sí | Aún en flujo. |
| Sin `periodoFinal` (ej. `/api/mercados`) | 1 h | sí | Fuente externa. |

`expiresAt` se calcula como `fetchedAt + ttlMs` cuando `ttlMs != null`; en caso
contrario el registro no expira.

## Comportamiento de `SBCache.get(url)`

1. Consulta L1 (in-memory Map). Si presente y no expirado → devuelve sincrónico.
2. Consulta L2 (IDB). Si presente:
   - Si **no expirado** → guarda en L1, devuelve.
   - Si **expirado y SWR** → devuelve stale inmediato; dispara refetch en
     background; al terminar, si `body` difiere del stale, persiste y emite
     `'updated'` con la URL.
   - Si **expirado y no SWR** → fetch sincrónico, persiste, devuelve.
3. Sin registro → fetch, persiste, devuelve.

**Dedup**: si una `get(url)` está in-flight, llamadas concurrentes a la misma
URL se atan a la misma `Promise` (sin doble request).

**No-cacheo**: URLs que no empiezan con `/api/` pasan directo a `fetch` sin
tocar IDB.

## Preload

### Generación de jobs

Los loaders existentes usan dos patrones distintos:

- **Range query** (1 sola URL para el rango completo):
  - `/indicadores/principales` — `fetchResumen`.
- **Monthly probing** vía `getLatestAll` (itera mes a mes hacia atrás hasta
  encontrar datos, una URL por mes, `periodoInicial == periodoFinal`):
  - `/indicadores/morosidad-estresada` — `fetchResumen`.
  - `/carteras/creditos/{tipo, sectores-economicos, moneda, genero, clasificacion-riesgo, facilidad, localidad}` — `fetchCartera` + `fetchMapa`.
  - `/captaciones/{moneda, sector-depositante, localidad}` — `fetchCaptaciones` + `fetchMapa`.
  - `/estados/situacion/eif`, `/estados/resultados/eif` — `fetchEstados`.
  - `/reclamaciones/eif` — `fetchReclamaciones`.
  - `/indicadores/financieros` (custom probing en `fetchComparativa` con un
    array fijo de 4 `indicador`).
- **Single-shot agregado** (1 sola URL, sin entidad ni periodo):
  - `/mercados` — `fetchMercados`.

Total: ~16 paths SB + 1 agregado.

Al boot, después de `renderActiveTab()`:

```js
const yyyy = new Date().getFullYear();
const periodoInicial = `${yyyy}-01`;
const pf = state.periodoFinal;                  // mes en curso o último válido
const probingMonths = [pf, prevMonth(pf), prevMonth(prevMonth(pf))];

const scopes = [
  {},                                           // TODOS
  { tipoEntidad: ["BM"]   },
  { tipoEntidad: ["BAyC"] },
  { tipoEntidad: ["AC"]   },
  { tipoEntidad: ["ARC"]  },
];

// 1) Range query: 1 path × 5 scopes = 5
// 2) Monthly probing: 14 paths × 5 scopes × 3 meses = 210
// 3) /indicadores/financieros: usa 'indicador' fijo, 5 scopes × 3 meses = 15
// 4) /mercados: 1 URL (sin scope, sin periodo)
// Total ≈ 231 jobs

const jobs = [
  ...rangeQueryJobs(periodoInicial, pf, scopes),
  ...probingJobs(probingMonths, scopes),
  ...comparativaJobs(probingMonths, scopes),
  mercadosJob(),
];
```

Los conjuntos `RANGE_PATHS`, `PROBING_PATHS` y `COMPARATIVA_INDICATORS`
viven como constantes en `cache.js`, anotadas con comentarios que indican qué
loader las consume. Si un loader nuevo se añade en el futuro, se actualiza
manualmente la constante (smoke-test 6 valida que los selectores rápidos
arranquen instantáneos para ese loader).

### Cola

- Concurrencia: 6 (constante `PRELOAD_CONCURRENCY`).
- Por job: si la URL ya está en IDB **fresca** → skip + `progress`. Si no →
  `fetch` + persistir + `progress`.
- Errores individuales no abortan la cola; se cuentan en `progress` como
  `failed`.
- Si **todos** los jobs iniciales fallan (probablemente offline) → aborta y
  emite `'error'` con `total_failure: true`.

### Eventos emitidos por `preload`

```
{ type: 'progress', done: number, total: number, failed: number }
{ type: 'updated',  url: string }       // SWR refresh entregó datos distintos
{ type: 'error',    url?: string, message: string, total_failure?: boolean }
{ type: 'done',     done: number, failed: number }
```

## UX del pill de progreso

Elemento en el header, junto al botón "Recargar":

```html
<div id="preloadPill" hidden>
  <span id="preloadPillText">Precargando 0/230</span>
  <button id="preloadPillClose" aria-label="ocultar">×</button>
</div>
```

- Aparece al primer `'progress'`, oculto si `localStorage.sb_pill_dismissed === "1"`.
- Texto: `"Precargando {done}/{total}"`. Si `failed > 0` añade `" ({failed} fallidos)"`.
- Al `'done'` cambia a `"✓ Datos listos"` durante 3s, luego se oculta.
- Si `'error'` con `total_failure` → pill rojo con texto `"Preload falló — modo lazy"` (persiste hasta cierre manual).
- Click en `×` → oculta y persiste en `localStorage.sb_pill_dismissed`.
- Estilos reutilizan las variables CSS existentes en `:root` para mantener
  coherencia con el tema.

## Cambios concretos en `index.html`

### Adiciones

1. `<script src="/cache.js"></script>` antes del bloque `<script>` principal.
2. HTML del pill (`#preloadPill`) en el header.
3. CSS del pill en el `<style>` existente (compacto, mismo tema).

### Eliminaciones

4. Objeto `cache` actual (líneas ~458-481) se elimina entero.

### Modificaciones

5. Cada `fetchXxx()` cambia `await fetch(url)` por `await SBCache.get(url)`
   (8 loaders, una línea cada uno).
6. `boot()` añade:
   ```js
   await SBCache.init();
   renderActiveTab();
   const jobs = buildPreloadJobs(state);
   SBCache.preload(jobs);
   wirePillEvents();
   ```
7. `wirePillEvents()` (función nueva en `index.html`):
   - Suscribe a `'progress' | 'updated' | 'error' | 'done'`.
   - Actualiza el pill según el evento.
   - En `'updated'`: si la URL pertenece al set del loader del tab activo,
     re-corre `renderActiveTab()` (que leerá del cache ya fresco).
8. Botón "Recargar" cambia su handler:
   ```js
   await SBCache.invalidateAll();
   renderActiveTab();
   SBCache.preload(buildPreloadJobs(state));
   ```

### Tracking de URLs por loader (para `'updated'`)

Cada `fetchXxx()` registra las URLs que consultó en su última ejecución
(`window.LAST_URLS_BY_LOADER[name] = Set`). El listener de `'updated'`
consulta este mapa para decidir si redibujar.

## Errores y edge cases

| Caso | Comportamiento |
|---|---|
| IndexedDB no disponible | `SBCache` cae a passthrough (solo L1 + red). Pill rojo `"Cache desactivado (IDB no soportado)"` una vez. |
| `quota exceeded` al escribir | Eviccionar 30 registros más viejos por `fetchedAt`, reintentar una vez. Si vuelve a fallar, degrada a L1 sin persistir. |
| Fetch falla durante `get()`, hay stale | Devuelve stale + emite `'error'`. |
| Fetch falla durante `get()`, sin stale | Propaga error al loader. |
| Fetch falla durante preload | Job marcado como error, cola continúa. |
| URL no `/api/*` | Bypass total a `fetch`. |
| Schema incompatible al abrir IDB | `onupgradeneeded` borra y recrea el store. |
| Doble `get()` simultáneo misma URL | In-flight map; segunda llamada se ata a la misma promesa. |
| SWR refresh idéntico al stale | No emite `'updated'` (compara hash de body). |
| Cambio de filtros mid-preload | Loader actual corre normal (lazy si no precargado). Preload sigue intacto. |
| Reloj cliente desfasado | Política compara con `Date.now()` simétrico — no rompe. |

## Testing

### Estrategia

Testear `cache.js` aislado en Node con `node --test` (built-in, sin runner
extra). Mock de IDB con `fake-indexeddb` (única dep dev). El `index.html` se
valida manualmente con un smoke checklist.

### Casos cubiertos por tests automáticos

1. **`policyFor(periodoFinal, now)`** — tabla parametrizada:
   - 6+ meses atrás → TTL infinito, sin SWR.
   - 1-3 meses atrás → 24h, SWR true.
   - Mes actual → 6h, SWR true.
   - `null` → 1h, SWR true.
2. **`get()`**:
   - Miss → fetch + persiste + devuelve.
   - Hit fresco → no fetch.
   - Hit stale + SWR → devuelve stale + dispara refetch + emite `'updated'`
     cuando `body` cambia.
   - Hit stale + SWR + body idéntico → no emite `'updated'`.
   - Hit stale sin SWR → fetch sincrónico.
   - Doble `get` concurrente → un solo fetch.
3. **`preload(jobs)`**:
   - Respeta concurrencia 6.
   - Emite `'progress'` por cada job (skip o fetch).
   - Sigue ante errores individuales.
   - Emite `'done'` con totales correctos.
   - Si todos fallan → `'error'` con `total_failure`.
4. **`invalidateAll()`** → store vacío + L1 limpio + nuevos `get` van a red.
5. **Error paths**:
   - IDB no disponible → passthrough.
   - `quota exceeded` → eviction + retry.
   - Schema bump → store recreado.

### Smoke checklist post-deploy

1. Boot frío en navegador limpio → ver pill, llegar a `"✓ Datos listos"`.
2. Cambiar entre BM / BAyC / AC → instantáneo.
3. Hard reload → segundo boot rápido (mayoría skip).
4. DevTools → Offline + click "Recargar" → mensaje de error claro sin romper UI.
5. DevTools → Application → IndexedDB → ver registros con `expiresAt` correctos.
6. Cambiar a un tipoEntidad fuera del preload → primera vez lenta, segunda instantánea.

## Estructura de archivos resultante

```
.
├── cache.js                              # NUEVO — módulo IDB cache (~250-300 líneas)
├── index.html                            # modificado (~40 líneas netas)
├── package.json                          # NUEVO — solo para `node --test` y `fake-indexeddb`
├── tests/
│   ├── cache.policy.test.js              # NUEVO — tabla de TTLs
│   ├── cache.get.test.js                 # NUEVO — get / SWR / dedup
│   ├── cache.preload.test.js             # NUEVO — cola, concurrencia, errores
│   └── cache.invalidate.test.js          # NUEVO — invalidación + edge cases
├── netlify/functions/sb-api.js           # SIN CAMBIOS
├── netlify.toml                          # SIN CAMBIOS
└── docs/superpowers/specs/
    └── 2026-05-07-cache-local-indexeddb-design.md   # este documento
```

## Criterios de aceptación

1. Tras boot frío, cambiar el filtro `tipoEntidad` entre `TODOS` / `BM` / `BAyC` /
   `AC` / `ARC` para el año en curso es **instantáneo** (<200ms perceptibles).
2. Refrescar la pestaña del navegador no obliga a re-bajar todo: el segundo
   boot completa el preload mayormente con skips.
3. El botón "Recargar" sigue funcionando: vacía cache y vuelve a precargar.
4. Cambiar a una entidad individual (no en preload) carga lazy la primera vez
   y queda instantánea para la segunda.
5. SWR aplicado: en una vista con datos del mes actual, abrir la app
   muestra datos cacheados al instante; si SB tiene cambios, el chart se
   redibuja en background sin spinner.
6. Sin IndexedDB el dashboard sigue funcionando (passthrough), con aviso una
   vez.
7. Tests automatizados (`node --test`) pasan en CI o local con `npm test`.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Preload satura el upstream (~230 requests) → 429 / WAF block | Concurrencia 6 + el proxy ya tiene `s-maxage` 6h en CDN, así que después del primer usuario los siguientes ven cache HIT a nivel CDN. Tiempo total estimado: 30-60s en background. |
| Lista `ENDPOINTS` en `cache.js` se desincroniza de los loaders | Comentario por endpoint indicando qué loader lo usa; smoke-test 1 verifica que no haya loader sin precargar. |
| Datos cacheados con bug en política → usuario ve datos viejos sin saber | `schemaVersion` permite forzar invalidación con un commit que la sube; pill `'updated'` da feedback visual cuando SWR trae datos nuevos. |
| Dependencia nueva (`fake-indexeddb`) sólo para tests | Va en `devDependencies`; build de Netlify no la instala (sigue siendo `Build command: vacío`). |
