import { armRequest } from "./azureClient.js";
import { formatUsageDate } from "./format.js";

const COST_MGMT_API_VERSION = "2025-03-01";
const BUDGETS_API_VERSION = "2024-08-01";

export type Granularity = "Daily" | "Monthly" | "None";
export type CostType = "ActualCost" | "AmortizedCost" | "Usage";
export type Timeframe =
  | "MonthToDate"
  | "TheLastMonth"
  | "BillingMonthToDate"
  | "TheLastBillingMonth"
  | "WeekToDate"
  | "TheCurrentMonth"
  | "Custom";

export interface CostQueryParams {
  scope: string;
  costType?: CostType;
  timeframe?: Timeframe;
  from?: string;
  to?: string;
  granularity?: Granularity;
  groupBy?: string[];
  /** Tenant de Azure AD, si la suscripción vive fuera del tenant activo de la sesión. */
  tenantId?: string;
}

export interface CostQueryResult {
  columns: string[];
  rows: Record<string, any>[];
  currency: string | null;
  totalCost: number;
}

function toIsoBound(dateStr: string, bound: "start" | "end"): string {
  // Acepta 'YYYY-MM-DD' o una fecha/hora ISO completa.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return `${dateStr}T${bound === "start" ? "00:00:00" : "23:59:59"}Z`;
  }
  return new Date(dateStr).toISOString();
}

function buildQueryBody(params: CostQueryParams) {
  const { costType = "ActualCost", timeframe = "MonthToDate", from, to, granularity = "None", groupBy = [] } = params;

  if (timeframe === "Custom" && (!from || !to)) {
    throw new Error("timeframe 'Custom' requiere los parámetros 'from' y 'to' (fechas ISO, ej. 2026-09-01).");
  }

  const body: any = {
    type: costType,
    timeframe,
    dataset: {
      granularity,
      aggregation: {
        totalCost: { name: "Cost", function: "Sum" },
      },
    },
  };

  if (timeframe === "Custom" && from && to) {
    body.timePeriod = { from: toIsoBound(from, "start"), to: toIsoBound(to, "end") };
  }

  if (groupBy.length > 0) {
    body.dataset.grouping = groupBy.slice(0, 2).map((name) => ({ type: "Dimension", name }));
  }

  return body;
}

function parseQueryResult(result: any): CostQueryResult {
  const columns: string[] = (result?.properties?.columns ?? []).map((c: any) => c.name);
  const rawRows: any[][] = result?.properties?.rows ?? [];
  const rows = rawRows.map((r) => {
    const obj: Record<string, any> = {};
    columns.forEach((c, i) => {
      obj[c] = r[i];
    });
    if ("UsageDate" in obj) obj.UsageDate = formatUsageDate(obj.UsageDate);
    return obj;
  });

  const currency = columns.includes("Currency") && rows.length ? rows[0]["Currency"] : null;
  const costCol = columns.includes("Cost") ? "Cost" : columns.includes("PreTaxCost") ? "PreTaxCost" : null;
  const totalCost = costCol ? rows.reduce((sum, r) => sum + (Number(r[costCol]) || 0), 0) : 0;

  return { columns, rows, currency, totalCost };
}

/** Ejecuta una consulta contra Microsoft.CostManagement/query (costo real / amortizado / uso). */
export async function runCostQuery(params: CostQueryParams): Promise<CostQueryResult> {
  const body = buildQueryBody(params);
  const result = await armRequest<any>(`${params.scope}/providers/Microsoft.CostManagement/query`, {
    method: "POST",
    apiVersion: COST_MGMT_API_VERSION,
    body,
    tenantId: params.tenantId,
  });
  return parseQueryResult(result);
}

export interface ForecastParams {
  scope: string;
  costType?: CostType;
  from: string;
  to: string;
  granularity?: "Daily" | "Monthly";
  includeActualCost?: boolean;
  /** Tenant de Azure AD, si la suscripción vive fuera del tenant activo de la sesión. */
  tenantId?: string;
}

/** Ejecuta una consulta contra Microsoft.CostManagement/forecast (pronóstico de costo). */
export async function runForecastQuery(params: ForecastParams): Promise<CostQueryResult> {
  const { scope, costType = "ActualCost", from, to, granularity = "Daily", includeActualCost = false, tenantId } = params;

  const body = {
    type: costType,
    timeframe: "Custom",
    timePeriod: { from: toIsoBound(from, "start"), to: toIsoBound(to, "end") },
    dataset: {
      granularity,
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
    },
    includeActualCost,
    includeFreshPartialCost: false,
  };

  const result = await armRequest<any>(`${scope}/providers/Microsoft.CostManagement/forecast`, {
    method: "POST",
    apiVersion: COST_MGMT_API_VERSION,
    body,
    tenantId,
  });

  // La API devuelve 204 (sin cuerpo) cuando no hay datos de forecast disponibles.
  if (!result) return { columns: [], rows: [], currency: null, totalCost: 0 };
  return parseQueryResult(result);
}

export interface BudgetSummary {
  name: string;
  category: string;
  amount: number;
  currentSpend: number | null;
  currency: string | null;
  forecastSpend: number | null;
  percentUsed: number | null;
  timeGrain: string;
  startDate: string;
  endDate: string;
}

/** Lista los presupuestos (Microsoft.Consumption/budgets) definidos en el scope indicado. */
export async function listBudgets(scope: string, tenantId?: string): Promise<BudgetSummary[]> {
  const result = await armRequest<any>(`${scope}/providers/Microsoft.Consumption/budgets`, {
    method: "GET",
    apiVersion: BUDGETS_API_VERSION,
    tenantId,
  });

  return (result?.value ?? []).map((b: any): BudgetSummary => {
    const props = b.properties ?? {};
    const amount = Number(props.amount) || 0;
    const currentSpend = props.currentSpend?.amount ?? null;
    return {
      name: b.name,
      category: props.category ?? "Cost",
      amount,
      currentSpend,
      currency: props.currentSpend?.unit ?? null,
      forecastSpend: props.forecastSpend?.amount ?? null,
      percentUsed: amount > 0 && currentSpend !== null ? Math.round((currentSpend / amount) * 1000) / 10 : null,
      timeGrain: props.timeGrain,
      startDate: props.timePeriod?.startDate,
      endDate: props.timePeriod?.endDate,
    };
  });
}
