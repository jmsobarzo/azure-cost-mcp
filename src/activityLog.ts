import { armRequest, armRequestUrl } from "./azureClient.js";

const ACTIVITY_LOG_API_VERSION = "2015-04-01";

export interface ActivityEvent {
  eventTimestamp: string;
  operationName: string;
  resourceId: string;
  resourceGroupName: string | null;
  caller: string | null;
  status: string;
  level: string;
}

function parseEvent(raw: any): ActivityEvent {
  return {
    eventTimestamp: raw.eventTimestamp,
    operationName: raw.operationName?.value ?? raw.operationName?.localizedValue ?? "",
    resourceId: raw.resourceId ?? "",
    resourceGroupName: raw.resourceGroupName ?? null,
    caller: raw.caller ?? null,
    status: raw.status?.value ?? "",
    level: raw.level ?? "",
  };
}

export interface ListActivityEventsParams {
  subscriptionId: string;
  from: string; // ISO datetime
  to: string; // ISO datetime
  tenantId?: string;
  /** Tope de páginas a seguir vía nextLink, para no disparar demasiadas llamadas. */
  maxPages?: number;
}

/**
 * Consulta el Activity Log de Azure Monitor (Microsoft.Insights/eventtypes/management)
 * para una suscripción y rango de fechas, siguiendo la paginación (nextLink) hasta
 * 'maxPages' páginas.
 */
export async function listActivityEvents(params: ListActivityEventsParams): Promise<{
  events: ActivityEvent[];
  truncated: boolean;
}> {
  const { subscriptionId, from, to, tenantId, maxPages = 5 } = params;

  const filter = `eventTimestamp ge '${from}' and eventTimestamp le '${to}'`;
  const select = "eventTimestamp,operationName,resourceId,resourceGroupName,caller,status,level";

  let result = await armRequest<any>(`/subscriptions/${subscriptionId}/providers/Microsoft.Insights/eventtypes/management/values`, {
    apiVersion: ACTIVITY_LOG_API_VERSION,
    query: { $filter: filter, $select: select },
    tenantId,
  });

  const events: ActivityEvent[] = [];
  let pages = 0;
  let truncated = false;

  while (result) {
    pages++;
    for (const raw of result.value ?? []) {
      events.push(parseEvent(raw));
    }
    const nextLink = result.nextLink;
    if (!nextLink) break;
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    result = await armRequestUrl<any>(nextLink, tenantId);
  }

  return { events, truncated };
}

export interface ResourceFirstSeen {
  resourceId: string;
  resourceGroupName: string | null;
  firstEventTimestamp: string;
  operationName: string;
  caller: string | null;
}

/**
 * A partir de los eventos de Activity Log, filtra las escrituras exitosas
 * (create/update; el Activity Log no distingue de forma 100% confiable entre
 * ambas, ya que ambas son operaciones "write"/PUT) y devuelve, por recurso,
 * el PRIMER evento visible dentro del rango consultado — un proxy razonable
 * de "creado o tocado por primera vez en este período".
 */
export function summarizeFirstSeenResources(events: ActivityEvent[]): ResourceFirstSeen[] {
  const successfulWrites = events.filter(
    (e) => e.status === "Succeeded" && e.operationName.toLowerCase().endsWith("/write") && e.resourceId
  );

  const byResource = new Map<string, ActivityEvent>();
  for (const e of successfulWrites) {
    const existing = byResource.get(e.resourceId);
    if (!existing || new Date(e.eventTimestamp).getTime() < new Date(existing.eventTimestamp).getTime()) {
      byResource.set(e.resourceId, e);
    }
  }

  return [...byResource.values()]
    .map((e) => ({
      resourceId: e.resourceId,
      resourceGroupName: e.resourceGroupName,
      firstEventTimestamp: e.eventTimestamp,
      operationName: e.operationName,
      caller: e.caller,
    }))
    .sort((a, b) => new Date(a.firstEventTimestamp).getTime() - new Date(b.firstEventTimestamp).getTime());
}
