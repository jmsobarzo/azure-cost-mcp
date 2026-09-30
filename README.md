# azure-cost-mcp

Servidor MCP (Model Context Protocol) para generar reportería de **Azure Cost
Management** directamente desde Claude (u otro cliente MCP): costo por
suscripción/resource group, por servicio, tendencias diarias/mensuales,
presupuestos (budgets) y pronóstico (forecast).

## Herramientas incluidas

| Herramienta | Qué hace |
|---|---|
| `list_subscriptions` | Lista las suscripciones de Azure visibles. |
| `list_resource_groups` | Lista los resource groups de una suscripción. |
| `query_cost` | Consulta de costos genérica y flexible (período, granularidad, agrupación libre). |
| `get_cost_by_resource_group` | Costo total agrupado por resource group. |
| `get_cost_by_service` | Costo total agrupado por servicio de Azure (VMs, Storage, SQL, etc.). |
| `get_cost_trend` | Serie de tiempo diaria o mensual del costo. |
| `get_cost_forecast` | Pronóstico de costo futuro (Cost Management Forecast API). |
| `list_budgets` | Lista presupuestos configurados, gasto actual y % consumido. |
| `generate_cost_report` | Genera un **reporte consolidado** (resumen + todas las secciones anteriores) en Markdown/CSV, y lo guarda en disco. |
| `send_cost_report_email` | Envía el Panel de Costos (u otro archivo) por correo a destinatarios indicados en el momento — **siempre bajo pedido explícito**, nunca automático. Requiere configurar SMTP (ver `.env.example`). |

## Requisitos

- Node.js 18 o superior.
- Una identidad de Azure con, como mínimo, el rol **Cost Management Reader**
  (o **Reader**) sobre la(s) suscripción(es) o resource group(s) a consultar.
- Azure CLI instalado y con sesión iniciada (`az login`) — es la forma más
  simple de autenticar, ver sección siguiente.

## Instalación

**Ya está compilado y listo para usar en este equipo.** El archivo
`dist/azure-cost-mcp.bundle.cjs` es un bundle autocontenido (generado con
esbuild) que incluye todas sus dependencias — no necesitas ejecutar
`npm install` para correrlo. La carpeta `src/` queda de todas formas
disponible por si quieres modificar el código.

Si en algún momento cambias el código fuente y quieres regenerar el
bundle:

```bash
npm install
npm run build:bundle
```

(`npm run build` sigue disponible para compilar la versión "normal" a
`dist/index.js`, que sí requiere `node_modules` en tiempo de ejecución;
`build:bundle` es la que produce el archivo único `dist/azure-cost-mcp.bundle.cjs`).

## Autenticación con Azure

El servidor usa `DefaultAzureCredential` del SDK de Azure Identity, que
prueba, en orden, varias formas de autenticarse. Para este MCP hay dos
caminos recomendados:

### Opción A — Azure CLI (recomendada para uso local/interactivo)

```bash
az login
# si tienes varios tenants/suscripciones:
az account set --subscription "<subscriptionId>"
```

No necesitas configurar nada más: `DefaultAzureCredential` detecta la
sesión de `az login` automáticamente.

### Opción B — Service Principal (para automatización / sin sesión interactiva)

Crea un service principal con permisos de lectura de costos:

```bash
az ad sp create-for-rbac --name azure-cost-mcp --role "Cost Management Reader" \
  --scopes /subscriptions/<subscriptionId>
```

Y define estas variables de entorno (ver `.env.example`) antes de ejecutar
el servidor, o en la configuración `env` de tu cliente MCP:

```
AZURE_CLIENT_ID=<appId>
AZURE_CLIENT_SECRET=<password>
AZURE_TENANT_ID=<tenant>
```

### Suscripciones en distintos tenants de Azure AD (multi-tenant)

Si trabajas con suscripciones de varias organizaciones/clientes (cada una en
su propio tenant de Azure AD), no hace falta reconfigurar nada: todas las
herramientas aceptan un parámetro opcional `tenantId`.

1. Autentícate una vez contra cada tenant que necesites:
   ```bash
   az login --tenant <tenantId-1>
   az login --tenant <tenantId-2>
   ```
2. Luego, en cualquier herramienta, pasa `tenantId` junto con el
   `subscriptionId` correspondiente a ese tenant (por ejemplo,
   `list_subscriptions` con `tenantId: "<tenantId-2>"` para ver las
   suscripciones de esa organización).

Si no indicas `tenantId`, se usa `AZURE_TENANT_ID` (si está definida) o el
tenant activo de la sesión de `az login`.

`DefaultAzureCredential` las detecta automáticamente y las usa antes de
intentar `az login`.

### Variables opcionales adicionales

- `AZURE_SUBSCRIPTION_ID`: si la defines, puedes omitir el parámetro
  `subscriptionId` en cada llamada a las herramientas.
- `AZURE_COST_MCP_OUTPUT_DIR`: carpeta por defecto donde
  `generate_cost_report` guarda los reportes (por defecto `./reports`).

## Configuración en Claude Desktop / Claude Code

Agrega esto a tu configuración de servidores MCP (por ejemplo
`claude_desktop_config.json` en Claude Desktop, o el equivalente en Claude
Code):

```json
{
  "mcpServers": {
    "azure-cost": {
      "command": "node",
      "args": ["C:\\Users\\JoséMiguelSobarzo\\Documents\\azure-cost-mcp\\dist\\azure-cost-mcp.bundle.cjs"],
      "env": {
        "AZURE_SUBSCRIPTION_ID": "<opcional: tu subscriptionId por defecto>",
        "SMTP_HOST": "<opcional, solo si vas a usar send_cost_report_email — ver .env.example>",
        "SMTP_USER": "<opcional>",
        "SMTP_PASS": "<opcional>"
      }
    }
  }
}
```

(Esa ruta ya apunta al bundle instalado en este equipo, en tu carpeta
Documents. Si mueves la carpeta `azure-cost-mcp`, actualiza la ruta.)

Si usas Service Principal (Opción B), agrega también `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET` y `AZURE_TENANT_ID` dentro de ese mismo bloque `env`.

El archivo de configuración de Claude Desktop en Windows normalmente está en:

```
%APPDATA%\Claude\claude_desktop_config.json
```

(en tu caso: `C:\Users\JoséMiguelSobarzo\AppData\Roaming\Claude\claude_desktop_config.json`).
Ábrelo con un editor de texto, agrega el bloque `"azure-cost": {...}` dentro
de `"mcpServers"` (créalo si el archivo no existe todavía) y guarda.

Reinicia Claude Desktop y las 10 herramientas deberían aparecer disponibles.

## Ejemplos de uso (una vez conectado en Claude)

- *"Lista mis suscripciones de Azure"* → `list_subscriptions`
- *"¿Cuánto he gastado este mes en la suscripción X por resource group?"* →
  `get_cost_by_resource_group`
- *"Dame la tendencia diaria de costos de los últimos 30 días"* →
  `get_cost_trend` con `timeframe: "Custom"`
- *"Genérame un reporte de costos completo del mes en curso, en CSV"* →
  `generate_cost_report` con `format: "both"`
- *"¿Cómo van mis presupuestos?"* → `list_budgets`
- *"Proyecta el gasto de los próximos 60 días"* → `get_cost_forecast` con
  `forecastDays`-equivalente vía `from`/`to`
- *"Mándale el panel de costos a ana@datapro.cl"* → `send_cost_report_email`
  con `to: "ana@datapro.cl"` y `attachmentPath` apuntando al HTML standalone
  del panel (requiere SMTP configurado, ver arriba)

## Notas técnicas

- Usa directamente la **REST API de Azure Resource Manager**
  (`management.azure.com`, `Microsoft.CostManagement` y
  `Microsoft.Consumption`) en vez de los SDKs `@azure/arm-*`, para tener
  control total y transparencia sobre las peticiones. API version:
  `2025-03-01` (Cost Management) y `2024-08-01` (Budgets).
- Los reportes generados con `generate_cost_report` se guardan en disco
  (Markdown y/o CSV) además de devolverse en la respuesta de la
  herramienta.
- El costo devuelto respeta el tipo de costo elegido (`ActualCost` por
  defecto, o `AmortizedCost`/`Usage`).

## Desarrollo

```bash
npm run dev    # ejecuta src/index.ts directamente con tsx (sin compilar)
npm run build  # compila TypeScript a dist/
npm start      # ejecuta la versión compilada
```
