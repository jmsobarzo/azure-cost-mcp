import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { armRequest, buildScope, resolveSubscriptionId, resolveTenantId, AzureArmError } from "./azureClient.js";
import { runCostQuery, runForecastQuery, listBudgets, type Timeframe, type CostType, type Granularity } from "./costManagement.js";
import { listActivityEvents, summarizeFirstSeenResources } from "./activityLog.js";
import { textResult, errorResult, formatMoney } from "./format.js";

const TIMEFRAME_VALUES = [
  "MonthToDate",
  "TheLastMonth",
  "BillingMonthToDate",
  "TheLastBillingMonth",
  "WeekToDate",
  "TheCurrentMonth",
  "Custom",
] as const;

const COST_TYPE_VALUES = ["ActualCost", "AmortizedCost", "Usage"] as const;
const GRANULARITY_VALUES = ["Daily", "Monthly", "None"] as const;

const subscriptionIdSchema = z
  .string()
  .optional()
  .describe(
    "ID de la suscripción de Azure (GUID). Si se omite, se usa la variable de entorno AZURE_SUBSCRIPTION_ID. " +
      "Usa la herramienta 'list_subscriptions' para obtenerlo."
  );

const tenantIdSchema = z
  .string()
  .optional()
  .describe(
    "ID del tenant de Azure AD, SOLO necesario si la suscripción vive en un tenant distinto al de tu sesión " +
      "principal (por ejemplo, la suscripción de un cliente u otra organización). Antes de usarlo, ejecuta " +
      "'az login --tenant <tenantId>' una vez en esa máquina para autenticarte contra ese tenant. Si se omite, " +
      "se usa AZURE_TENANT_ID o el tenant activo de la sesión."
  );

const resourceGroupSchema = z
  .string()
  .optional()
  .describe("Nombre del resource group para acotar la consulta. Si se omite, aplica a toda la suscripción.");

const timeframeSchema = z
  .enum(TIMEFRAME_VALUES)
  .optional()
  .describe(
    "Período predefinido de Cost Management. Por defecto 'MonthToDate'. Usa 'Custom' junto con 'from'/'to' " +
      "para un rango de fechas específico."
  );

const costTypeSchema = z
  .enum(COST_TYPE_VALUES)
  .optional()
  .describe("Tipo de costo: 'ActualCost' (por defecto), 'AmortizedCost' (reservas amortizadas) o 'Usage'.");

const fromToDescribe = "Fecha ISO 'YYYY-MM-DD'. Requerida cuando timeframe='Custom'.";

function handleError(err: unknown) {
  if (err instanceof AzureArmError) return errorResult(err.message);
  return errorResult(err instanceof Error ? err.message : String(err));
}

function sortByCostDesc(rows: Record<string, any>[]): Record<string, any>[] {
  const costKey = rows[0] && "Cost" in rows[0] ? "Cost" : "PreTaxCost";
  return [...rows].sort((a, b) => (Number(b[costKey]) || 0) - (Number(a[costKey]) || 0));
}

export function registerTools(server: McpServer) {
  // ---------------------------------------------------------------------
  server.registerTool(
    "list_subscriptions",
    {
      title: "Listar suscripciones de Azure",
      description:
        "Lista las suscripciones de Azure visibles con las credenciales configuradas, dentro de un tenant de " +
        "Azure AD. Si tienes suscripciones repartidas en varios tenants (por ejemplo, de distintos clientes u " +
        "organizaciones), llama esta herramienta una vez por cada 'tenantId' (después de haber hecho " +
        "'az login --tenant <tenantId>' en esa máquina para cada uno). Útil para obtener el 'subscriptionId' " +
        "que usan el resto de las herramientas de reportería de costos.",
      inputSchema: { tenantId: tenantIdSchema },
    },
    async ({ tenantId }) => {
      try {
        const tid = resolveTenantId(tenantId);
        const result = await armRequest<any>("/subscriptions", { apiVersion: "2022-12-01", tenantId: tid });
        const subs = (result?.value ?? []).map((s: any) => ({
          subscriptionId: s.subscriptionId,
          name: s.displayName,
          state: s.state,
          tenantId: s.tenantId,
        }));
        return textResult(
          subs.length
            ? subs
            : `No se encontraron suscripciones accesibles${tid ? ` en el tenant ${tid}` : ""} con las credenciales actuales.`
        );
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "list_tenants",
    {
      title: "Listar tenants de Azure AD",
      description:
        "Lista los tenants de Azure AD accesibles con las credenciales actuales (nombre de la organización, " +
        "dominio por defecto y tenantId). Útil para saber a qué organización pertenece cada suscripción cuando " +
        "trabajas con varios tenants, o para mostrar el nombre del tenant en reportes/paneles.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await armRequest<any>("/tenants", { apiVersion: "2022-12-01" });
        const tenants = (result?.value ?? []).map((t: any) => ({
          tenantId: t.tenantId,
          name: t.displayName,
          defaultDomain: t.defaultDomain,
        }));
        return textResult(
          tenants.length ? tenants : "No se encontraron tenants accesibles con las credenciales actuales."
        );
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "list_resource_activity",
    {
      title: "Recursos creados/modificados (Activity Log)",
      description:
        "Lista, a partir del Activity Log de Azure Monitor, los recursos con actividad de escritura (creación o " +
        "modificación) en los últimos N días, indicando cuándo y quién lo hizo ('caller'). IMPORTANTE: el Activity " +
        "Log no distingue de forma 100% confiable 'crear' de 'actualizar' (ambas son operaciones write/PUT); esta " +
        "herramienta muestra, por cada recurso, el PRIMER evento de escritura visible dentro del rango consultado, " +
        "como aproximación razonable de 'creado o tocado por primera vez en este período'. Requiere el rol " +
        "'Reader' (u otro que incluya 'Microsoft.Insights/eventtypes/values/read') sobre la suscripción — el rol " +
        "'Cost Management Reader' NO alcanza para esta consulta.",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        tenantId: tenantIdSchema,
        days: z.number().optional().describe("Días hacia atrás a consultar, desde hoy. Por defecto 30."),
        from: z.string().optional().describe("Fecha ISO 'YYYY-MM-DD' de inicio. Si se indica, ignora 'days'."),
        to: z.string().optional().describe("Fecha ISO 'YYYY-MM-DD' de término. Por defecto, hoy."),
        resourceGroup: resourceGroupSchema,
      },
    },
    async ({ subscriptionId, tenantId, days, from, to, resourceGroup }) => {
      try {
        const subId = resolveSubscriptionId(subscriptionId);
        const tid = resolveTenantId(tenantId);

        const toDate = to ? new Date(`${to}T23:59:59Z`) : new Date();
        const fromDate = from
          ? new Date(`${from}T00:00:00Z`)
          : new Date(toDate.getTime() - (days ?? 30) * 24 * 60 * 60 * 1000);

        const { events, truncated } = await listActivityEvents({
          subscriptionId: subId,
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
          tenantId: tid,
        });

        const filteredEvents = resourceGroup
          ? events.filter((e) => (e.resourceGroupName ?? "").toLowerCase() === resourceGroup.toLowerCase())
          : events;

        const firstSeen = summarizeFirstSeenResources(filteredEvents);

        const byCaller: Record<string, number> = {};
        for (const r of firstSeen) {
          const key = r.caller ?? "(desconocido)";
          byCaller[key] = (byCaller[key] ?? 0) + 1;
        }

        return textResult({
          period: { from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10) },
          scope: resourceGroup ? `/subscriptions/${subId}/resourceGroups/${resourceGroup}` : `/subscriptions/${subId}`,
          resourcesWithActivity: firstSeen.length,
          resumenPorAutor: byCaller,
          recursos: firstSeen,
          nota:
            "Cada entrada muestra el primer evento de escritura visible del recurso en el período " +
            "(posible creación o primera modificación registrada).",
          truncado: truncated
            ? "Se alcanzó el límite de páginas consultadas; puede haber más eventos sin traer."
            : undefined,
        });
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "list_resource_groups",
    {
      title: "Listar resource groups",
      description: "Lista los resource groups de una suscripción de Azure.",
      inputSchema: { subscriptionId: subscriptionIdSchema, tenantId: tenantIdSchema },
    },
    async ({ subscriptionId, tenantId }) => {
      try {
        const subId = resolveSubscriptionId(subscriptionId);
        const tid = resolveTenantId(tenantId);
        const result = await armRequest<any>(`/subscriptions/${subId}/resourceGroups`, {
          apiVersion: "2021-04-01",
          tenantId: tid,
        });
        const groups = (result?.value ?? []).map((rg: any) => ({ name: rg.name, location: rg.location }));
        return textResult(groups.length ? groups : "No se encontraron resource groups en esta suscripción.");
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "query_cost",
    {
      title: "Consulta de costos (flexible)",
      description:
        "Herramienta genérica para consultar costos de Azure Cost Management con control total sobre período, " +
        "granularidad y agrupación. Para reportes rápidos, prefiere get_cost_by_resource_group, " +
        "get_cost_by_service o get_cost_trend.",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        tenantId: tenantIdSchema,
        resourceGroup: resourceGroupSchema,
        costType: costTypeSchema,
        timeframe: timeframeSchema,
        from: z.string().optional().describe(fromToDescribe),
        to: z.string().optional().describe(fromToDescribe),
        granularity: z.enum(GRANULARITY_VALUES).optional().describe("Granularidad temporal. Por defecto 'None' (total agregado)."),
        groupBy: z
          .array(z.string())
          .max(2)
          .optional()
          .describe(
            "Hasta 2 dimensiones para agrupar, ej. ResourceGroup, ServiceName, ResourceId, ResourceType, " +
              "SubscriptionId, MeterCategory, ChargeType, ResourceLocation, PricingModel."
          ),
      },
    },
    async ({ subscriptionId, tenantId, resourceGroup, costType, timeframe, from, to, granularity, groupBy }) => {
      try {
        const subId = resolveSubscriptionId(subscriptionId);
        const tid = resolveTenantId(tenantId);
        const scope = buildScope(subId, resourceGroup);
        const result = await runCostQuery({
          scope,
          tenantId: tid,
          costType: costType as CostType | undefined,
          timeframe: timeframe as Timeframe | undefined,
          from,
          to,
          granularity: granularity as Granularity | undefined,
          groupBy,
        });
        const rows = groupBy && groupBy.length ? sortByCostDesc(result.rows) : result.rows;
        return textResult({
          scope,
          totalCost: result.totalCost,
          currency: result.currency,
          rowCount: rows.length,
          rows,
        });
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "get_cost_by_resource_group",
    {
      title: "Costo por resource group",
      description: "Desglosa el costo de una suscripción agrupado por resource group, ordenado de mayor a menor.",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        tenantId: tenantIdSchema,
        costType: costTypeSchema,
        timeframe: timeframeSchema,
        from: z.string().optional().describe(fromToDescribe),
        to: z.string().optional().describe(fromToDescribe),
      },
    },
    async ({ subscriptionId, tenantId, costType, timeframe, from, to }) => {
      try {
        const subId = resolveSubscriptionId(subscriptionId);
        const tid = resolveTenantId(tenantId);
        const scope = buildScope(subId);
        const result = await runCostQuery({
          scope,
          tenantId: tid,
          costType: costType as CostType | undefined,
          timeframe: timeframe as Timeframe | undefined,
          from,
          to,
          granularity: "None",
          groupBy: ["ResourceGroup"],
        });
        return textResult({
          scope,
          totalCost: result.totalCost,
          currency: result.currency,
          byResourceGroup: sortByCostDesc(result.rows),
        });
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "get_cost_by_service",
    {
      title: "Costo por servicio",
      description:
        "Desglosa el costo agrupado por servicio de Azure (ServiceName: VMs, Storage, SQL Database, etc.), " +
        "ordenado de mayor a menor. Opcionalmente acotado a un resource group.",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        tenantId: tenantIdSchema,
        resourceGroup: resourceGroupSchema,
        costType: costTypeSchema,
        timeframe: timeframeSchema,
        from: z.string().optional().describe(fromToDescribe),
        to: z.string().optional().describe(fromToDescribe),
      },
    },
    async ({ subscriptionId, tenantId, resourceGroup, costType, timeframe, from, to }) => {
      try {
        const subId = resolveSubscriptionId(subscriptionId);
        const tid = resolveTenantId(tenantId);
        const scope = buildScope(subId, resourceGroup);
        const result = await runCostQuery({
          scope,
          tenantId: tid,
          costType: costType as CostType | undefined,
          timeframe: timeframe as Timeframe | undefined,
          from,
          to,
          granularity: "None",
          groupBy: ["ServiceName"],
        });
        return textResult({
          scope,
          totalCost: result.totalCost,
          currency: result.currency,
          byService: sortByCostDesc(result.rows),
        });
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "get_cost_trend",
    {
      title: "Tendencia de costo (diaria/mensual)",
      description: "Serie de tiempo del costo total (diario o mensual) para detectar picos o tendencias de gasto.",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        tenantId: tenantIdSchema,
        resourceGroup: resourceGroupSchema,
        costType: costTypeSchema,
        timeframe: timeframeSchema,
        from: z.string().optional().describe(fromToDescribe),
        to: z.string().optional().describe(fromToDescribe),
        granularity: z.enum(["Daily", "Monthly"]).optional().describe("Por defecto 'Daily'."),
      },
    },
    async ({ subscriptionId, tenantId, resourceGroup, costType, timeframe, from, to, granularity }) => {
      try {
        const subId = resolveSubscriptionId(subscriptionId);
        const tid = resolveTenantId(tenantId);
        const scope = buildScope(subId, resourceGroup);
        const result = await runCostQuery({
          scope,
          tenantId: tid,
          costType: costType as CostType | undefined,
          timeframe: timeframe as Timeframe | undefined,
          from,
          to,
          granularity: (granularity as Granularity | undefined) ?? "Daily",
        });
        return textResult({
          scope,
          totalCost: result.totalCost,
          currency: result.currency,
          trend: result.rows,
        });
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "get_cost_forecast",
    {
      title: "Pronóstico de costo",
      description:
        "Proyecta el costo futuro usando Azure Cost Management Forecast para un rango de fechas (por defecto, " +
        "los próximos 30 días).",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        tenantId: tenantIdSchema,
        resourceGroup: resourceGroupSchema,
        costType: costTypeSchema,
        from: z.string().optional().describe("Fecha ISO 'YYYY-MM-DD' de inicio. Por defecto, hoy."),
        to: z.string().optional().describe("Fecha ISO 'YYYY-MM-DD' de término. Por defecto, hoy + 30 días."),
        granularity: z.enum(["Daily", "Monthly"]).optional().describe("Por defecto 'Daily'."),
        includeActualCost: z
          .boolean()
          .optional()
          .describe("Incluir el costo real ya incurrido junto con el pronóstico. Por defecto false."),
      },
    },
    async ({ subscriptionId, tenantId, resourceGroup, costType, from, to, granularity, includeActualCost }) => {
      try {
        const subId = resolveSubscriptionId(subscriptionId);
        const tid = resolveTenantId(tenantId);
        const scope = buildScope(subId, resourceGroup);
        const { from: resolvedFrom, to: resolvedTo } = defaultForecastRange(from, to);
        const result = await runForecastQuery({
          scope,
          tenantId: tid,
          costType: costType as CostType | undefined,
          from: resolvedFrom,
          to: resolvedTo,
          granularity: granularity as "Daily" | "Monthly" | undefined,
          includeActualCost,
        });
        return textResult({
          scope,
          period: { from: resolvedFrom, to: resolvedTo },
          totalForecastCost: result.totalCost,
          currency: result.currency,
          forecast: result.rows,
        });
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "list_budgets",
    {
      title: "Listar presupuestos",
      description: "Lista los presupuestos (budgets) configurados con su gasto actual, pronóstico y % consumido.",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        tenantId: tenantIdSchema,
        resourceGroup: resourceGroupSchema,
      },
    },
    async ({ subscriptionId, tenantId, resourceGroup }) => {
      try {
        const subId = resolveSubscriptionId(subscriptionId);
        const tid = resolveTenantId(tenantId);
        const scope = buildScope(subId, resourceGroup);
        const budgets = await listBudgets(scope, tid);
        return textResult(budgets.length ? { scope, budgets } : `No hay presupuestos configurados en ${scope}.`);
      } catch (err) {
        return handleError(err);
      }
    }
  );
}

function defaultForecastRange(from?: string, to?: string): { from: string; to: string } {
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  return { from: from ?? toIso(today), to: to ?? toIso(in30Days) };
}

export { formatMoney };
