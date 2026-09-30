import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildScope, resolveSubscriptionId, resolveTenantId, AzureArmError } from "./azureClient.js";
import { runCostQuery, runForecastQuery, listBudgets, type Timeframe, type CostType, type CostQueryResult } from "./costManagement.js";
import { toCsv, toMarkdownTable, formatMoney, textResult, errorResult } from "./format.js";

const TIMEFRAME_VALUES = [
  "MonthToDate",
  "TheLastMonth",
  "BillingMonthToDate",
  "TheLastBillingMonth",
  "WeekToDate",
  "TheCurrentMonth",
  "Custom",
] as const;

// Algunas suscripciones (sponsorship / partner / trial) tienen cuotas muy bajas
// en la API de Cost Management y devuelven 429 ante ráfagas de solicitudes
// concurrentes. Por eso el reporte consulta cada sección EN SECUENCIA, con una
// pequeña pausa entre cada una, en vez de todas en paralelo.
const REQUEST_SPACING_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SectionResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function safe<T>(fn: () => Promise<T>): Promise<SectionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

function sortByCostDesc(rows: Record<string, any>[]): Record<string, any>[] {
  if (!rows.length) return rows;
  const costKey = "Cost" in rows[0] ? "Cost" : "PreTaxCost";
  return [...rows].sort((a, b) => (Number(b[costKey]) || 0) - (Number(a[costKey]) || 0));
}

function nowInSantiago(): string {
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Santiago",
  }).format(new Date());
}

function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function registerReportTool(server: McpServer) {
  server.registerTool(
    "generate_cost_report",
    {
      title: "Generar reporte de costos de Azure",
      description:
        "Genera un reporte consolidado de Azure Cost Management: costo total, desglose por resource group y " +
        "por servicio, tendencia diaria, presupuestos y pronóstico a futuro. Devuelve el reporte en Markdown y " +
        "además lo guarda en disco (Markdown y/o CSV por sección). Consulta cada sección en secuencia (no en " +
        "paralelo) para evitar el rate-limit (429) de suscripciones con cuota baja; si alguna sección falla, " +
        "el resto del reporte se genera igual y esa sección queda marcada como no disponible.",
      inputSchema: {
        subscriptionId: z
          .string()
          .optional()
          .describe("ID de la suscripción. Si se omite, se usa AZURE_SUBSCRIPTION_ID."),
        tenantId: z
          .string()
          .optional()
          .describe(
            "ID del tenant de Azure AD, si la suscripción vive fuera del tenant activo de la sesión (ejecuta " +
              "'az login --tenant <tenantId>' antes). Si se omite, se usa AZURE_TENANT_ID o el tenant activo."
          ),
        resourceGroup: z
          .string()
          .optional()
          .describe("Acota el reporte a un resource group (omite el desglose por resource group)."),
        costType: z.enum(["ActualCost", "AmortizedCost", "Usage"]).optional().describe("Por defecto 'ActualCost'."),
        timeframe: z.enum(TIMEFRAME_VALUES).optional().describe("Período del reporte. Por defecto 'MonthToDate'."),
        from: z.string().optional().describe("Fecha ISO 'YYYY-MM-DD'. Requerida si timeframe='Custom'."),
        to: z.string().optional().describe("Fecha ISO 'YYYY-MM-DD'. Requerida si timeframe='Custom'."),
        includeForecast: z.boolean().optional().describe("Incluir sección de pronóstico. Por defecto true."),
        forecastDays: z.number().int().min(1).max(365).optional().describe("Días a pronosticar. Por defecto 30."),
        outputDir: z
          .string()
          .optional()
          .describe("Carpeta donde guardar el reporte. Por defecto AZURE_COST_MCP_OUTPUT_DIR o './reports'."),
        format: z
          .enum(["markdown", "csv", "both"])
          .optional()
          .describe("Formato(s) de exportación a disco. Por defecto 'markdown'."),
      },
    },
    async ({
      subscriptionId,
      tenantId,
      resourceGroup,
      costType,
      timeframe,
      from,
      to,
      includeForecast,
      forecastDays,
      outputDir,
      format,
    }) => {
      try {
        const subId = resolveSubscriptionId(subscriptionId);
        const tid = resolveTenantId(tenantId);
        const scope = buildScope(subId, resourceGroup);
        const tf = (timeframe as Timeframe | undefined) ?? "MonthToDate";
        const ct = (costType as CostType | undefined) ?? "ActualCost";
        const wantForecast = includeForecast ?? true;
        const fmt = format ?? "markdown";

        const baseQuery = { scope, tenantId: tid, costType: ct, timeframe: tf, from, to };

        // --- Secuencial, con pausas, para no gatillar el rate-limit de Cost Management ---
        const total = await safe(() => runCostQuery({ ...baseQuery, granularity: "None" }));

        await delay(REQUEST_SPACING_MS);
        const byRg = resourceGroup
          ? null
          : await safe(() => runCostQuery({ ...baseQuery, granularity: "None", groupBy: ["ResourceGroup"] }));

        await delay(REQUEST_SPACING_MS);
        const byService = await safe(() => runCostQuery({ ...baseQuery, granularity: "None", groupBy: ["ServiceName"] }));

        await delay(REQUEST_SPACING_MS);
        const trend = await safe(() => runCostQuery({ ...baseQuery, granularity: "Daily" }));

        await delay(REQUEST_SPACING_MS);
        const budgets = await safe(() => listBudgets(scope, tid));

        const forecastRange = defaultForecastRange(forecastDays ?? 30);
        let forecast: SectionResult<CostQueryResult> | null = null;
        if (wantForecast) {
          await delay(REQUEST_SPACING_MS);
          forecast = await safe(() =>
            runForecastQuery({ scope, tenantId: tid, costType: ct, from: forecastRange.from, to: forecastRange.to, granularity: "Daily" })
          );
        }

        const currency =
          (total.ok && total.data.currency) ||
          (byService.ok && byService.data.currency) ||
          (trend.ok && trend.data.currency) ||
          "USD";
        const periodLabel = tf === "Custom" ? `${from} → ${to}` : tf;

        const sections: string[] = [];
        sections.push(`# Reporte de costos de Azure`);
        sections.push(
          `**Scope:** \`${scope}\`  \n**Período:** ${periodLabel}  \n**Tipo de costo:** ${ct}  \n` +
            `**Generado:** ${nowInSantiago()} (America/Santiago)`
        );

        sections.push(
          `## Resumen\n\n${
            total.ok ? `**Costo total: ${formatMoney(total.data.totalCost, currency)}**` : `_No se pudo obtener el costo total: ${total.error}_`
          }`
        );

        const byRgSorted = byRg && byRg.ok ? sortByCostDesc(byRg.data.rows) : null;
        if (byRg) {
          sections.push(
            `## Costo por resource group\n\n${
              byRg.ok ? toMarkdownTable(byRgSorted!) : `_No se pudo obtener: ${byRg.error}_`
            }`
          );
        }

        const byServiceSorted = byService.ok ? sortByCostDesc(byService.data.rows) : null;
        sections.push(
          `## Costo por servicio\n\n${byService.ok ? toMarkdownTable(byServiceSorted!) : `_No se pudo obtener: ${byService.error}_`}`
        );

        sections.push(`## Tendencia diaria\n\n${trend.ok ? toMarkdownTable(trend.data.rows, 31) : `_No se pudo obtener: ${trend.error}_`}`);

        if (!budgets.ok) {
          sections.push(`## Presupuestos\n\n_No se pudieron obtener presupuestos: ${budgets.error}_`);
        } else {
          const budgetRows = budgets.data.map((b) => ({
            Nombre: b.name,
            Presupuesto: formatMoney(b.amount, b.currency ?? currency),
            "Gasto actual": formatMoney(b.currentSpend, b.currency ?? currency),
            "% usado": b.percentUsed ?? "N/D",
            Periodicidad: b.timeGrain,
            Vigencia: `${b.startDate?.slice(0, 10)} → ${b.endDate?.slice(0, 10)}`,
          }));
          sections.push(`## Presupuestos\n\n${toMarkdownTable(budgetRows)}`);
        }

        if (wantForecast && forecast) {
          if (!forecast.ok) {
            sections.push(`## Pronóstico\n\n_No se pudo calcular el pronóstico: ${forecast.error}_`);
          } else {
            sections.push(
              `## Pronóstico (${forecastRange.from} → ${forecastRange.to})\n\n` +
                `**Costo proyectado: ${formatMoney(forecast.data.totalCost, forecast.data.currency ?? currency)}**\n\n${toMarkdownTable(forecast.data.rows, 31)}`
            );
          }
        }

        const markdown = sections.join("\n\n");

        const dir = outputDir ?? process.env.AZURE_COST_MCP_OUTPUT_DIR ?? "./reports";
        await mkdir(dir, { recursive: true });
        const baseName = `azure-cost-report-${subId.slice(0, 8)}${resourceGroup ? `-${resourceGroup}` : ""}-${timestampSlug()}`;

        const savedFiles: string[] = [];

        if (fmt === "markdown" || fmt === "both") {
          const mdPath = path.join(dir, `${baseName}.md`);
          await writeFile(mdPath, markdown, "utf-8");
          savedFiles.push(mdPath);
        }

        if (fmt === "csv" || fmt === "both") {
          const csvDir = path.join(dir, `${baseName}-csv`);
          await mkdir(csvDir, { recursive: true });
          if (byRgSorted) {
            await writeFile(path.join(csvDir, "costo_por_resource_group.csv"), toCsv(byRgSorted), "utf-8");
            savedFiles.push(path.join(csvDir, "costo_por_resource_group.csv"));
          }
          if (byServiceSorted) {
            await writeFile(path.join(csvDir, "costo_por_servicio.csv"), toCsv(byServiceSorted), "utf-8");
            savedFiles.push(path.join(csvDir, "costo_por_servicio.csv"));
          }
          if (trend.ok) {
            await writeFile(path.join(csvDir, "tendencia_diaria.csv"), toCsv(trend.data.rows), "utf-8");
            savedFiles.push(path.join(csvDir, "tendencia_diaria.csv"));
          }
          if (budgets.ok) {
            await writeFile(path.join(csvDir, "presupuestos.csv"), toCsv(budgets.data as any), "utf-8");
            savedFiles.push(path.join(csvDir, "presupuestos.csv"));
          }
          if (wantForecast && forecast && forecast.ok) {
            await writeFile(path.join(csvDir, "pronostico.csv"), toCsv(forecast.data.rows), "utf-8");
            savedFiles.push(path.join(csvDir, "pronostico.csv"));
          }
        }

        const filesNote = savedFiles.length
          ? `\n\n---\n\n📁 Archivos guardados:\n${savedFiles.map((f) => `- ${f}`).join("\n")}`
          : "";
        return textResult(`${markdown}${filesNote}`);
      } catch (err) {
        if (err instanceof AzureArmError || err instanceof Error) return errorResult(err.message);
        return errorResult(String(err));
      }
    }
  );
}

function describeError(err: unknown): string {
  if (err instanceof AzureArmError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function defaultForecastRange(days: number): { from: string; to: string } {
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const end = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
  return { from: toIso(today), to: toIso(end) };
}
