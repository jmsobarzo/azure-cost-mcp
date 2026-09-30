import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

const ARM_BASE = "https://management.azure.com";
const ARM_SCOPE = "https://management.azure.com/.default";

// Cuando este servidor corre como extensión de Claude Desktop (.mcpb) y el
// usuario deja un campo opcional de configuración vacío (por ejemplo Tenant ID
// o Client Secret), Claude Desktop puede inyectar el texto LITERAL del
// placeholder sin resolver (ej. "${user_config.tenant_id}") como valor de la
// variable de entorno, en vez de omitirla o dejarla vacía. Si no se limpia,
// ese texto se usa como si fuera un tenantId/clientId real y rompe la
// autenticación (incluyendo @azure/identity's EnvironmentCredential, que se
// activa apenas ve AZURE_CLIENT_ID+AZURE_CLIENT_SECRET+AZURE_TENANT_ID
// "presentes"). Por eso se sanea el entorno ANTES de construir cualquier
// credencial o leer estas variables.
const ENV_VARS_TO_SANITIZE = [
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_COST_MCP_OUTPUT_DIR",
] as const;

function isUnresolvedOrEmpty(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  // Coincide con placeholders sin resolver tipo "${user_config.algo}" o "${algo}".
  return /^\$\{[^}]*\}$/.test(trimmed);
}

for (const name of ENV_VARS_TO_SANITIZE) {
  if (isUnresolvedOrEmpty(process.env[name])) {
    delete process.env[name];
  }
}

let credential: TokenCredential | null = null;
// Cache de tokens por tenant (clave "default" para el tenant activo de la sesión).
const tokenCache = new Map<string, { token: string; expiresOn: number }>();

function getCredential(): TokenCredential {
  if (!credential) {
    // additionallyAllowedTenants: ["*"] permite pedir tokens para CUALQUIER tenant
    // en el que la identidad (az login, o el Service Principal) tenga acceso,
    // no solo el tenant "activo" por defecto. Necesario para trabajar con
    // suscripciones repartidas en varios tenants de Azure AD.
    credential = new DefaultAzureCredential({ additionallyAllowedTenants: ["*"] });
  }
  return credential;
}

async function getAccessToken(tenantId?: string): Promise<string> {
  const cacheKey = tenantId ?? "default";
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresOn - now > 60_000) {
    return cached.token;
  }

  let result;
  try {
    result = await getCredential().getToken(ARM_SCOPE, tenantId ? { tenantId } : undefined);
  } catch (err) {
    throw new Error(
      `No se pudo autenticar contra Azure AD${tenantId ? ` (tenant ${tenantId})` : ""} (${(err as Error).message}). ` +
        `Ejecuta 'az login'${tenantId ? ` --tenant ${tenantId}` : ""} en esta máquina, o configura ` +
        "AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID para autenticación con Service Principal."
    );
  }

  if (!result) {
    throw new Error(
      `No se pudo obtener un token de acceso de Azure AD${tenantId ? ` para el tenant ${tenantId}` : ""}. ` +
        `Ejecuta 'az login'${tenantId ? ` --tenant ${tenantId}` : ""} en esta máquina, o configura credenciales ` +
        "de Service Principal (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID)."
    );
  }

  tokenCache.set(cacheKey, { token: result.token, expiresOn: result.expiresOnTimestamp });
  return result.token;
}

export class AzureArmError extends Error {
  status: number;
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "AzureArmError";
    this.status = status;
    this.body = body;
  }
}

export interface ArmRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  apiVersion: string;
  body?: unknown;
  query?: Record<string, string>;
  /** Tenant de Azure AD a usar para el token, si la suscripción vive fuera del tenant activo. */
  tenantId?: string;
}

async function doFetch<T = any>(
  url: string,
  method: string,
  token: string,
  body: unknown,
  tenantId: string | undefined
): Promise<T | undefined> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  if (!res.ok) {
    const code = json?.error?.code ?? res.status;
    const message = json?.error?.message ?? res.statusText ?? "Error desconocido";
    let hint = "";
    if (res.status === 401) {
      hint = tenantId
        ? ` Sugerencia: ejecuta 'az login --tenant ${tenantId}' en esta máquina (la suscripción vive en ` +
          "otro tenant de Azure AD), o revisa las variables AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID."
        : " Sugerencia: ejecuta 'az login' en esta máquina. Si la suscripción vive en otro tenant de Azure AD, " +
          "indica el parámetro 'tenantId' (y haz 'az login --tenant <tenantId>' primero), o revisa las variables " +
          "AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID.";
    } else if (res.status === 403) {
      hint =
        " Sugerencia: la identidad usada necesita, como mínimo, el rol 'Cost Management Reader' " +
        "(o 'Reader') sobre la suscripción o resource group consultado.";
    } else if (res.status === 404) {
      hint = " Sugerencia: verifica el subscriptionId / resourceGroup, o que el recurso exista.";
    }
    throw new AzureArmError(`Error de Azure ARM (${code}): ${message}.${hint}`, res.status, json);
  }

  return json as T;
}

/**
 * Llama a Azure Resource Manager (management.azure.com) con el token del
 * DefaultAzureCredential, y da errores legibles cuando algo falla.
 */
export async function armRequest<T = any>(path: string, options: ArmRequestOptions): Promise<T | undefined> {
  const token = await getAccessToken(options.tenantId);

  const url = new URL(ARM_BASE + (path.startsWith("/") ? path : `/${path}`));
  url.searchParams.set("api-version", options.apiVersion);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  return doFetch<T>(url.toString(), options.method ?? "GET", token, options.body, options.tenantId);
}

/**
 * Igual que armRequest, pero para una URL ABSOLUTA ya armada (por ejemplo el
 * 'nextLink' de una respuesta paginada de Azure Monitor / Activity Log).
 */
export async function armRequestUrl<T = any>(url: string, tenantId?: string): Promise<T | undefined> {
  const token = await getAccessToken(tenantId);
  return doFetch<T>(url, "GET", token, undefined, tenantId);
}

/** Construye el "scope" de ARM usado por Cost Management / Consumption. */
export function buildScope(subscriptionId: string, resourceGroup?: string): string {
  return resourceGroup
    ? `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`
    : `/subscriptions/${subscriptionId}`;
}

/** Resuelve el subscriptionId explícito o cae al valor por defecto de AZURE_SUBSCRIPTION_ID. */
export function resolveSubscriptionId(subscriptionId?: string): string {
  const resolved = subscriptionId ?? process.env.AZURE_SUBSCRIPTION_ID;
  if (!resolved) {
    throw new Error(
      "Falta 'subscriptionId'. Indícalo explícitamente o configura la variable de entorno " +
        "AZURE_SUBSCRIPTION_ID como valor por defecto. Usa la herramienta 'list_subscriptions' " +
        "para ver las suscripciones disponibles."
    );
  }
  return resolved;
}

/** Resuelve el tenantId explícito o cae al valor por defecto de AZURE_TENANT_ID (ambos opcionales). */
export function resolveTenantId(tenantId?: string): string | undefined {
  return tenantId ?? process.env.AZURE_TENANT_ID ?? undefined;
}
