export function toCsv(rows: Record<string, any>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: any): string => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

function formatCell(value: any): string {
  if (typeof value === "number") {
    return value.toLocaleString("es-CL", { maximumFractionDigits: 2 });
  }
  return String(value ?? "");
}

export function toMarkdownTable(rows: Record<string, any>[], maxRows = 25): string {
  if (rows.length === 0) return "_Sin datos para este período._";
  const headers = Object.keys(rows[0]);
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows.slice(0, maxRows)) {
    lines.push(`| ${headers.map((h) => formatCell(row[h])).join(" | ")} |`);
  }
  if (rows.length > maxRows) {
    lines.push("", `_...y ${rows.length - maxRows} fila(s) más. Usa formato "csv" para exportar el detalle completo._`);
  }
  return lines.join("\n");
}

export function formatMoney(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "N/D";
  const formatted = amount.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${formatted} ${currency}` : formatted;
}

/** Convierte un entero YYYYMMDD o YYYYMM (formato usado por Cost Management) a fecha legible. */
export function formatUsageDate(value: any): string {
  const s = String(value);
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
  return s;
}

export function textResult(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

export function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `⚠️ ${message}` }], isError: true as const };
}
