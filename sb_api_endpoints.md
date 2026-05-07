# API de Estadísticas del Sistema Financiero v2 — Superintendencia de Bancos RD

Documentación consolidada de los **26 endpoints** del API.

- **Host base:** `https://apis.sb.gob.do/estadisticas/v2/`
- **Auth:** header `Ocp-Apim-Subscription-Key: <tu-api-key>`
- **Verbo:** todos `GET`
- **Formato:** JSON
- **Soporte:** soporteapis@sb.gob.do
- **Portal:** https://desarrollador.sb.gob.do/

## Parámetros comunes (todos los endpoints)

| Parámetro | Tipo | Requerido | Notas |
|---|---|---|---|
| `periodoInicial` | string | Sí | `YYYY-MM` (ej: `2024-01`) |
| `periodoFinal` | string | No | `YYYY-MM` |
| `entidad` | array | No | Nombres cortos (ej: `ADEMI`, `APAP`) |
| `tipoEntidad` | array | No | Códigos (ej: `BM`, `BAyC`, `AC`, `ARC`) |
| `paginas` | int | No | Número de páginas a retornar |
| `registros` | int | No | Tamaño de página (registros por página) |

Algunos endpoints aceptan parámetros adicionales (indicados por endpoint).

---

## 1. Captaciones (3)

### 1.1 `captacionesLocalidad` — Captaciones por localidad
- **GET** `/captaciones/localidad`
- **Schema:** `periodo, tipoEntidad, entidad, region, provincia, codIso, persona, divisa, cantidadInstrumento, balance, tasaPromedioPonderadoPorBalance, tasaPromedioPonderado`

### 1.2 `captacionesMoneda` — Captaciones por moneda
- **GET** `/captaciones/moneda`
- **Schema:** `periodo, tipoEntidad, entidad, partidaNivel2, divisa, instrumentoCaptacion, cantidadInstrumento, balance, tasaPrimedioPonderadoPorBalance, tasaPrimedioPonderado`

### 1.3 `captacionesSectorTipoDepositante` — Captaciones por sector y tipo depositante
- **GET** `/captaciones/sector-depositante`
- **Schema:** `periodo, tipoEntidad, entidad, residenteNoResidente, publicoPrivado, financieroNoFinanciero, cantidadInstrumento, balance, tasaPrimedioPonderadoPorBalance, tasaPrimedioPonderado`

---

## 2. Carteras (8)

### 2.1 `carteraCreditosClasificacionRiesgo` — Cartera por clasificación de riesgo
- **GET** `/carteras/creditos/clasificacion-riesgo`
- **Schema:** `periodo, tipoEntidad, entidad, clasificacionRiesgo, tipoCartera, cantidadPlastico, cantidadCredito, deuda, tasaPorDeuda, tasaPromedioPonderado, deudaCapital, deudaVencida, deudaVencidaDe31A90Dias, valorDesembolso, valorGarantia, valorProvisionCapitalYRendimiento`

### 2.2 `carteraCreditosGenero` — Cartera por género
- **GET** `/carteras/creditos/genero`
- **Schema:** `periodo, tipoEntidad, entidad, genero, cantidadCredito, deuda, tasaPorDeuda, tasaPromedioPonderado, deudaCapital, deudaVencida, deudaVencidaDe31A90Dias, valorDesembolso, valorGarantia, valorProvisionCapitalYRendimiento`

### 2.3 `carteraCreditosLocalidad` — Cartera por localidad
- **GET** `/carteras/creditos/localidad`
- **Schema:** `periodo, tipoEntidad, entidad, region, provincia, codIso, tipoCartera, deuda, tasaPorDeuda, cantidadCredito`

### 2.4 `carteraCreditosMoneda` — Cartera por moneda
- **GET** `/carteras/creditos/moneda`
- **Schema:** `periodo, tipoEntidad, entidad, tipoMoneda, tipoCartera, cantidadCredito, deuda, tasaPorDeuda, tasaPromedioPonderado, deudaCapital, deudaVencida, deudaVencidaDe31A90Dias, valorDesembolso, valorGarantia, valorProvisionCapitalYRendimiento`

### 2.5 `carteraCreditosSectoresEconomicos` — Cartera por sectores económicos
- **GET** `/carteras/creditos/sectores-economicos`
- **Schema:** `periodo, tipoEntidad, entidad, sectorEconomico, cantidadCredito, deuda, tasaPorDeuda, tasaPromedioPonderado, deudaCapital, deudaVencida, deudaVencidaDe31A90Dias, valorDesembolso, valorGarantia, valorProvisionCapitalYRendimiento`

### 2.6 `carteraCreditosTipo` — Cartera por tipo
- **GET** `/carteras/creditos/tipo`
- **Schema:** `periodo, tipoEntidad, entidad, tipoCartera, cantidadCredito, deuda, tasaPorDeuda, tasaPromedioPonderado, deudaCapital, deudaVencida, deudaVencidaDe31A90Dias, valorDesembolso, valorGarantia, valorProvisionCapitalYRendimiento`

### 2.7 `carteraCreditosTipoFacilidad` — Cartera por tipo de facilidad
- **GET** `/carteras/creditos/facilidad`
- **Schema:** `periodo, tipoEntidad, entidad, facilidad, cantidadPlastico, cantidadCredito, deuda, tasaPorDeuda, tasaPromedioPonderado, deudaCapital, deudaVencida, deudaVencidaDe31A90Dias, valorDesembolso, valorGarantia, valorProvisionCapitalYRendimiento`

### 2.8 `carteraInversiones` — Cartera de inversiones
- **GET** `/carteras/creditos/inversiones`
- **Parámetros extra:** `moneda` (ej: `MONEDA NACIONAL`), `componente` (ej: `CAPITAL`, `RENDIMIENTOS`)
- **Schema:** `periodo, tipoEntidad, entidad, clasificacionCuentas, partidaNivel1, partidaNivel2, moneda, publicoPrivadoNivel1, publicoPrivadoNivel2, financieroNoFinanciero, residenteNoResidente, componente, instrumentoMedio, contraparte, situacionNivel1, situacionNivel2, valor`

---

## 3. DetalleEntidades (1)

### 3.1 `cifrasAcceso` — Cifras de acceso
- **GET** `/detalle-entidades/acceso`
- **Parámetros extra:** `detalle` (ej: `EMPLEADO`, `OFICINA`, `CAJERO`)
- **Schema:** `periodo, tipoEntidad, entidad, detalle, cantidad`

---

## 4. EstadosFinancieros (4)

### 4.1 `estadoResultadosEIC` — Estado de resultados EIC
- **GET** `/estados/resultados/eic`
- **Schema:** `periodo, tipoEntidad, entidad, conceptoNivel1...conceptoNivel7, valor`

### 4.2 `estadoResultadosEIF` — Estado de resultados EIF
- **GET** `/estados/resultados/eif`
- **Schema:** `periodo, tipoEntidad, entidad, conceptoNivel1...conceptoNivel7, valor`

### 4.3 `estadoSituacionEIC` — Estado de situación EIC
- **GET** `/estados/situacion/eic`
- **Schema:** `periodo, tipoEntidad, entidad, conceptoNivel1, conceptoNivel2, conceptoNivel3, valor`

### 4.4 `estadoSituacionEIF` — Estado de situación EIF
- **GET** `/estados/situacion/eif`
- **Schema:** `periodo, tipoEntidad, entidad, conceptoNivel1, conceptoNivel2, conceptoNivel3, valor`

---

## 5. Indicadores (4)

### 5.1 `indicadorMorosidadEstresada` — Morosidad estresada
- **GET** `/indicadores/morosidad-estresada`
- **Schema:** `periodo, vencido, cobranza, tc31a60, reestructuradoRea, reestructuradoTemporal, castigos, adjudicado, carteraTotal`

### 5.2 `indicadoresRiesgoCredito` — Indicadores de riesgo de crédito
- **GET** `/indicadores/riesgo-credito`
- **Parámetros extra:** `tipoCartera` (ej: `Tarjetas de créditos`)
- **Schema:** `periodo, tipoEntidad, entidad, tipoCartera, sector, deudaVencida, deudaVencidaDe31A90Dias, deuda, provisionesRequerida`

### 5.3 `indicadoresFinancieros` — Indicadores financieros
- **GET** `/indicadores/financieros`
- **Parámetros extra:** `indicador` (ej: `Total de Pasivos`), `tipoIndicador` (ej: `Volumen`, `Rentabilidad`)
- **Schema:** `periodo, tipoEntidad, entidad, indicador, tipoIndicador, valor, unidad`

### 5.4 `principalesIndicadoresSistema` — Principales indicadores del sistema
- **GET** `/indicadores/principales`
- **Sin filtro por entidad** (es un agregado del sistema)
- **Schema:** `periodo, activos, solvencia, montoCarteraCredito, morosidad, roa, tasaActiva, tasaPasiva, margen`

---

## 6. Reclamaciones (2)

### 6.1 `reclamacionesEIF` — Reclamaciones de EIF
- **GET** `/reclamaciones/eif`
- **Schema:** `periodo, tipoEntidad, entidad, productoServicio, resultadoReclamacion, cantidad`

### 6.2 `reclamacionesProUsuario` — Reclamaciones ProUsuario
- **GET** `/reclamaciones/prousuario`
- **Schema:** `periodo, tipoEntidad, tipoPersona, producto, valor`

---

## 7. SolvenciaComponentes (1)

### 7.1 `solvencia` — Solvencia y componentes
- **GET** `/solvencia/componentes`
- **Schema:** `periodo, tipoEntidad, entidad, componente, valor, unidad`

---

## 8. SubagentesBancarios (2)

### 8.1 `operacionesSubagentesBancarios` — Operaciones de subagentes bancarios
- **GET** `/subagentes/operaciones`
- **Parámetros extra:** `region`, `provincia`
- **Schema:** `periodo, tipoEntidad, entidad, region, provincia, actividadEconomica, tipoTransaccion, productoServicio, cantidadTransacciones, valorTransado`

### 8.2 `sucursalesSubagentesBancariosLocalidadActividad` — Sucursales por localidad y actividad económica
- **GET** `/subagentes/actividad-economica`
- **Parámetros extra:** `region`, `provincia`
- **Schema:** `periodo, tipoEntidad, entidad, region, provincia, actividadEconomica, cantidadSucursales`

---

## 9. TasasComisiones (1)

### 9.1 `tasasComisionesTarjetasCredito` — Tasas y comisiones de tarjetas de crédito
- **GET** `/tasas-comisiones/tarjetas-credito`
- **Schema:** `periodo, tipoEntidad, entidad, nombreProducto, marca, tipoTarjeta, moneda, concepto, periodicidad, formatoTarifa, valor, valorMinimo, valorMaximo, unidadValor`

---

## Ejemplo de llamada

```bash
curl "https://apis.sb.gob.do/estadisticas/v2/indicadores/principales?periodoInicial=2024-01&periodoFinal=2024-12&paginas=1&registros=12" \
  -H "Ocp-Apim-Subscription-Key: TU_API_KEY"
```

```python
import requests

API_KEY = "tu_api_key"
HEADERS = {"Ocp-Apim-Subscription-Key": API_KEY}
BASE = "https://apis.sb.gob.do/estadisticas/v2"

r = requests.get(
    f"{BASE}/indicadores/principales",
    params={"periodoInicial": "2024-01", "periodoFinal": "2024-12",
            "paginas": 1, "registros": 12},
    headers=HEADERS,
)
data = r.json()
```

## Catálogos de valores válidos

Ver listas completas en https://desarrollador.sb.gob.do/referencias

- **Tipo EIF:** `AAyP`, `BAyC`, `BM`, `CC`, `EP`, `TODOS`
- **Tipo EIC:** `AC`, `ARC`, `TODOS`
- **Entidades EIF:** `POPULAR`, `BANRESERVAS`, `BHD LEON`, `SCOTIABANK`, `ADEMI`, `APAP`, ... (~50 nombres cortos)
- **Regiones:** `TODOS`, `NORTE`, `DISTRITO NACIONAL`, `ESTE`, `SUR`
- **Provincias:** las 31 provincias + Distrito Nacional
- **Divisas:** `DOP`, `USD`, `EUR`, `TODOS`
- **Tipos de cartera:** `Créditos comerciales`, `Créditos de consumo`, `Créditos Hipotecarios`, `Tarjetas de créditos`
- **Tipos de indicadores:** `Capital`, `Liquidez`, `Rentabilidad`, `Gestión`, `Volumen`, `Estructura de activos/pasivos/cartera/gastos`
- **Detalles bancarización:** `CAJERO`, `EMPLEADO`, `OFICINA`

## Recomendación para el dashboard

KPIs/visuales que cubren las cuatro vistas más útiles con sólo 4 endpoints:

1. **`/indicadores/principales`** → KPIs del header (activos, solvencia, ROA, morosidad, tasa activa/pasiva, margen)
2. **`/indicadores/financieros`** filtrado por `Rentabilidad` y entidades top → ranking ROA/ROE
3. **`/carteras/creditos/tipo`** → composición de cartera (donut)
4. **`/captaciones/localidad`** y **`/carteras/creditos/localidad`** → mapa coroplético por provincia (`codIso` viene listo para JOIN con un GeoJSON ISO 3166-2:DO)
