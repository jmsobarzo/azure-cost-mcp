import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { armRequest, resolveTenantId, AzureArmError } from "./azureClient.js";
import { runCostQuery, runForecastQuery, listBudgets, type Timeframe, type CostType, type Granularity } from "./costManagement.js";
import { textResult, errorResult } from "./format.js";

// ---------------------------------------------------------------------
// Costos de clientes CSP vía "Cost Management for partners": usa el MISMO
// Microsoft.CostManagement/query que el resto del servidor, pero con un scope
// de billing (billingAccounts/{id} o billingAccounts/{id}/customers/{id}) en
// vez de un scope de subscription. Requiere:
//   - Iniciar sesión (az login) contra el tenant PARTNER (no el del cliente),
//     con una cuenta con rol Admin Agent o Billing Admin en Partner Center.
//   - Que el cliente esté en un Microsoft Customer Agreement con Azure Plan.
//   - Que la política "Azure Usage" esté habilitada para ese cliente
//     (Azure Portal → Cost Management + Billing → Customers → Settings → Policies).
// Docs: https://learn.microsoft.com/azure/cost-management-billing/costs/get-started-partners
const BILLING_API_VERSION = "2019-10-01-preview";

export function buildBillingScope(billingAccountName: string): string {
  return `/providers/Microsoft.Billing/billingAccounts/${billingAccountName}`;
}

export function buildCustomerScope(billingAccountName: string, customerId: string): string {
  return `${buildBillingScope(billingAccountName)}/customers/${customerId}`;
}

async function listBillingAccountsRaw(tenantId?: string) {
  const result = await armRequest<any>("/providers/Microsoft.Billing/billingAccounts", {
    apiVersion: BILLING_API_VERSION,
    tenantId,
  });
  return result?.value ?? [];
}

async function listPartnerCustomersRaw(billingAccountName: string, tenantId?: string) {
  const result = await armRequest<any>(`${buildBillingScope(billingAccountName)}/customers`, {
    apiVersion: BILLING_API_VERSION,
    tenantId,
  });
  return result?.value ?? [];
}

const billingAccountNameSchema = z
  .string()
  .describe(
    "Nombre/ID del billing account del tenant PARTNER (no del cliente), tal como lo devuelve " +
      "'list_billing_accounts'. Ej: '12345678-abcd-...:56789-...-_2019-05-31'."
  );

const partnerTenantIdSchema = z
  .string()
  .optional()
  .describe(
    "ID del tenant de Azure AD del PARTNER (Datapro), SOLO si difiere del tenant activo de la sesión. " +
      "Requiere haber hecho 'az login --tenant <tenantId>' con una cuenta con rol Admin Agent o Billing Admin " +
      "en Partner Center. Si se omite, se usa AZURE_TENANT_ID o el tenant activo."
  );

const customerIdSchema = z
  .string()
  .optional()
  .describe(
    "ID del cliente CSP (tal como lo devuelve 'list_partner_customers'), para acotar la consulta a UN cliente. " +
      "Si se omite, la consulta agrega el costo de TODOS los clientes del billing account."
  );

function handleError(err: unknown) {
  if (err instanceof AzureArmError) return errorResult(err.message);
  return errorResult(err instanceof Error ? err.message : String(err));
}

function sortByCostDesc(rows: Record<string, any>[]): Record<string, any>[] {
  if (!rows.length) return rows;
  const costKey = "Cost" in rows[0] ? "Cost" : "PreTaxCost";
  return [...rows].sort((a, b) => (Number(b[costKey]) || 0) - (Number(a[costKey]) || 0));
}

export function registerPartnerTools(server: McpServer) {
  // ---------------------------------------------------------------------
  server.registerTool(
    "list_billing_accounts",
    {
      title: "Listar billing accounts (Partner Center)",
      description:
        "Lista los billing accounts visibles con las credenciales actuales en Microsoft Billing (Cost Management " +
        "for Partners). Úsalo desde el tenant PARTNER (ej. Datapro), con una cuenta con rol Admin Agent o Billing " +
        "Admin en Partner Center — NO desde el tenant de un cliente. El 'name' devuelto se usa como " +
        "'billingAccountName' en el resto de las herramientas 'list_partner_customers' / 'query_partner_cost'.",
      inputSchema: { tenantId: partnerTenantIdSchema },
    },
    async ({ tenantId }) => {
      try {
        const tid = resolveTenantId(tenantId);
        const accounts = await listBillingAccountsRaw(tid);
        const mapped = accounts.map((a: any) => ({
          name: a.name,
          displayName: a.properties?.displayName,
          accountType: a.properties?.accountType,
          agreementType: a.properties?.agreementType,
        }));
        return textResult(
          mapped.length
            ? mapped
            : "No se encontraron billing accounts accesibles. Verifica que iniciaste sesión con una cuenta " +
                "que tenga rol Admin Agent o Billing Admin en Partner Center, en el tenant del PARTNER (no de un cliente)."
        );
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "list_partner_customers",
    {
      title: "Listar clientes CSP (Partner Center)",
      description:
        "Lista los clientes CSP visibles bajo un billing account del partner. Devuelve, además de los campos " +
        "mapeados, el objeto 'properties' crudo tal como lo entrega la API (por si el nombre exacto de algún " +
        "campo, como el tenantId del cliente, no coincide con lo mapeado).",
      inputSchema: { billingAccountName: billingAccountNameSchema, tenantId: partnerTenantIdSchema },
    },
    async ({ billingAccountName, tenantId }) => {
      try {
        const tid = resolveTenantId(tenantId);
        const customers = await listPartnerCustomersRaw(billingAccountName, tid);
        const mapped = customers.map((c: any) => ({
          id: c.name,
          displayName: c.properties?.displayName ?? c.properties?.companyName ?? c.name,
          properties: c.properties,
        }));
        return textResult(
          mapped.length
            ? mapped
            : `No se encontraron clientes bajo el billing account ${billingAccountName}.`
        );
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "query_partner_cost",
    {
      title: "Consulta de costos de clientes CSP (Partner Center)",
      description:
        "Consulta Azure Cost Management a nivel de billing account o de un cliente CSP específico (en vez de por " +
        "subscriptionId), para ver el costo de tus clientes sin iniciar sesión en cada tenant de cliente. " +
        "Requisitos: el cliente debe estar en un Microsoft Customer Agreement con Azure Plan, y la política " +
        "'Azure Usage' debe estar habilitada para ese cliente (Azure Portal → Cost Management + Billing → " +
        "Customers → Settings → Policies). Si 'customerId' se omite, agrega el costo de TODOS los clientes del " +
        "billing account, y puedes agrupar por 'CustomerName' o 'CustomerTenantId' para desglosarlo por cliente.",
      inputSchema: {
        billingAccountName: billingAccountNameSchema,
        customerId: customerIdSchema,
        tenantId: partnerTenantIdSchema,
        costType: z.enum(["ActualCost", "AmortizedCost", "Usage"]).optional().describe("Por defecto 'ActualCost'."),
        timeframe: z
          .enum(["MonthToDate", "TheLastMonth", "BillingMonthToDate", "TheLastBillingMonth", "WeekToDate", "TheCurrentMonth", "Custom"])
          .optional()
          .describe("Por defecto 'MonthToDate'. Usa 'Custom' junto con 'from'/'to'."),
        from: z.string().optional().describe("Fecha ISO 'YYYY-MM-DD'. Requerida si timeframe='Custom'."),
        to: z.string().optional().describe("Fecha ISO 'YYYY-MM-DD'. Requerida si timeframe='Custom'."),
        granularity: z.enum(["Daily", "Monthly", "None"]).optional().describe("Por defecto 'None' (total agregado)."),
        groupBy: z
          .array(z.string())
          .max(2)
          .optional()
          .describe(
            "Hasta 2 dimensiones para agrupar, ej. CustomerName, CustomerTenantId, SubscriptionId, ResourceGroup, " +
              "ServiceName, ResourceType."
          ),
      },
    },
    async ({ billingAccountName, customerId, tenantId, costType, timeframe, from, to, granularity, groupBy }) => {
      try {
        const tid = resolveTenantId(tenantId);
        const scope = customerId ? buildCustomerScope(billingAccountName, customerId) : buildBillingScope(billingAccountName);
        const result = await runCostQuery({
          scope,
          tenantId: tid,
          costType: costType as CostType | undefined,
          timeframe: timeframe as Timeframe | undefined,
          from,
          to,
          granularity: (granularity as Granularity | undefined) ?? "None",
          groupBy,
        });
        const rows = groupBy && groupBy.length ? sortByCostDesc(result.rows) : result.rows;
        return textResult({ scope, totalCost: result.totalCost, currency: result.currency, rowCount: rows.length, rows });
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // ---------------------------------------------------------------------
  server.registerTool(
    "get_partner_forecast",
    {
      title: "Pronóstico de costo de clientes CSP (Partner Center)",
      description: "Igual que 'get_cost_forecast', pero a nivel de billing account o de un cliente CSP específico.",
      inputSchema: {
        billingAccountName: billingAccountNameSchema,
        customerId: customerIdSchema,
        tenantId: partnerTenantIdSchema,
        costType: z.enum(["ActualCost", "AmortizedCost", "Usage"]).optional(),
        from: z.string().optional().describe("Fecha ISO 'YYYY-MM-DD'. Por defecto, hoy."),
        to: z.string().optional().describe("Fecha ISO 'YYYY-MM-DD'. Por defecto, hoy + 30 días."),
        granularity: z.enum(["Daily", "Monthly"]).optional(),
      },
    },
    async ({ billingAccountName, customerId, tenantId, costType, from, to, granularity }) => {
      try {
        const tid = resolveTenantId(tenantId);
        const scope = customerId ? buildCustomerScope(billingAccountName, customerId) : buildBillingScope(billingAccountName);
        const toIso = (d: Date) => d.toISOString().slice(0, 10);
        const today = new Date();
        const resolvedFrom = from ?? toIso(today);
        const resolvedTo = to ?? toIso(new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000));
        const result = await runForecastQuery({
          scope,
          tenantId: tid,
          costType: costType as CostType | undefined,
          from: resolvedFrom,
          to: resolvedTo,
          granularity: granularity as "Daily" | "Monthly" | undefined,
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
    "list_partner_budgets",
    {
      title: "Listar presupuestos de clientes CSP (Partner Center)",
      description: "Igual que 'list_budgets', pero a nivel de billing account o de un cliente CSP específico.",
      inputSchema: {
        billingAccountName: billingAccountNameSchema,
        customerId: customerIdSchema,
        tenantId: partnerTenantIdSchema,
      },
    },
    async ({ billingAccountName, customerId, tenantId }) => {
      try {
        const tid = resolveTenantId(tenantId);
        const scope = customerId ? buildCustomerScope(billingAccountName, customerId) : buildBillingScope(billingAccountName);
        const budgets = await listBudgets(scope, tid);
        return textResult(budgets.length ? { scope, budgets } : `No hay presupuestos configurados en ${scope}.`);
      } catch (err) {
        return handleError(err);
      }
    }
  );
}
