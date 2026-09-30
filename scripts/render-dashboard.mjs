#!/usr/bin/env node
// Renderiza el Panel de Costos Azure (HTML autocontenido) a partir de un JSON
// de datos ya consultados a Azure Cost Management / Activity Log.
//
// Uso: node render-dashboard.mjs <datos.json> <salida.html> [--standalone]
//
// Ver `schema-ejemplo.json` en esta misma carpeta para el formato esperado.

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2).filter((a) => a !== "--standalone");
const standalone = process.argv.includes("--standalone");
const [dataPath, outPath] = args;
if (!dataPath || !outPath) {
  console.error("Uso: node render-dashboard.mjs <datos.json> <salida.html> [--standalone]");
  console.error("Sin --standalone: genera el FRAGMENTO (title+style+body, sin doctype/html/head/body) para publicar con la herramienta Artifact.");
  console.error("Con --standalone: genera la página HTML COMPLETA (doctype/html/head/body) para entregar como archivo descargable.");
  process.exit(1);
}

const data = JSON.parse(readFileSync(dataPath, "utf-8"));

// ---------------------------------------------------------------------
// Helpers de formato
// ---------------------------------------------------------------------
function money(n) {
  return "US$ " + Number(n).toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function money0(n) {
  return "US$ " + Number(n).toLocaleString("es-CL", { maximumFractionDigits: 0 });
}
function pct(n) {
  return Number(n).toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}
function shortId(id) {
  return id.length > 12 ? id.slice(0, 8) + "&hellip;" + id.slice(-3) : id;
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtDateShort(iso) {
  const d = new Date(iso);
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${d.getUTCDate()} ${meses[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes()
  ).padStart(2, "0")}`;
}
function slugify(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
// Estado de presupuesto: good / warning / critical
function budgetStatus(pct) {
  if (pct >= 100) return "critical";
  if (pct >= 85) return "warning";
  return "good";
}
const STATUS_LABEL = { good: "Dentro de presupuesto", warning: "Cerca del límite", critical: "Sobre presupuesto" };

// ---------------------------------------------------------------------
// Donut (dona) genérico + panel con leyenda numérica al costado
// ---------------------------------------------------------------------
const CAT_COLORS = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)", "var(--cat-5)"];

function legendDot(strokeVar, extraAttrs = "") {
  return `<span class="legend-dot" style="background:${strokeVar}"${extraAttrs}></span>`;
}

function renderDonutSvg(segments, { size = 172, thickness = 24, centerValue = "", centerLabel = "" } = {}) {
  const pad = 3;
  const r = (size - thickness) / 2 - pad;
  const cx = size / 2,
    cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  const gap = segments.length > 1 ? 3 : 0;
  const usable = Math.max(circumference - gap * segments.length, 1);

  let cum = 0;
  let arcs = "";
  for (const seg of segments) {
    const segLen = Math.max((seg.value / total) * usable, 0);
    if (segLen > 0.01) {
      const dasharray = `${segLen.toFixed(2)} ${Math.max(circumference - segLen, 0).toFixed(2)}`;
      const dashoffset = (-cum).toFixed(2);
      arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.stroke}" ${seg.attrs || ""} stroke-width="${thickness}" stroke-linecap="butt" stroke-dasharray="${dasharray}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 ${cx} ${cy})"><title>${esc(
        seg.name
      )}: ${money(seg.value)}</title></circle>`;
    }
    cum += segLen + gap;
  }

  return `
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="donut-svg" role="img" aria-label="Distribución de costo">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--gridline)" stroke-width="${thickness}"/>
        ${arcs}
        <text x="${cx}" y="${cy - 3}" text-anchor="middle" class="donut-center-value">${centerValue}</text>
        <text x="${cx}" y="${cy + 15}" text-anchor="middle" class="donut-center-label">${centerLabel}</text>
      </svg>`;
}

function renderDonutPanel(title, sub, items, { valueFmt = money, topN = 5 } = {}) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const total = sorted.reduce((s, r) => s + r.value, 0) || 1;

  const segments = top.map((row, i) => ({ name: row.name, value: row.value, stroke: CAT_COLORS[i % CAT_COLORS.length] }));
  if (rest.length) {
    const restSum = rest.reduce((s, r) => s + r.value, 0);
    segments.push({ name: `Otros (${rest.length})`, value: restSum, stroke: "var(--cat-otros)" });
  }

  const svg = renderDonutSvg(segments, { centerValue: money0(total), centerLabel: "Total" });
  const legend = segments
    .map(
      (seg) => `<div class="legend-row">
          <span class="legend-row-left">${legendDot(seg.stroke)}${esc(seg.name)}</span>
          <span class="legend-row-right">${valueFmt(seg.value)}<span class="legend-pct">${pct(
        (seg.value / total) * 100
      )}</span></span>
        </div>`
    )
    .join("");

  return `<div class="card panel">
      <h2>${title}</h2>
      <p class="panel-sub">${sub}</p>
      <div class="donut-panel-body">
        <div class="donut-wrap">${svg}</div>
        <div class="donut-legend">${legend}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// Participación de costo por tenant (dona a nivel ejecutivo)
// ---------------------------------------------------------------------
function renderTenantShareCard(tenants) {
  if (tenants.length < 2) return "";
  const total = tenants.reduce((s, t) => s + t.totalCostMonth, 0) || 1;
  const segments = tenants.map((t, i) => ({
    name: t.tenantName,
    value: t.totalCostMonth,
    stroke: "var(--tenant-accent)",
    attrs: `class="tc" data-color="${i % 3}"`,
  }));
  const svg = renderDonutSvg(segments, { centerValue: money0(total), centerLabel: "Costo total" });
  const legend = tenants
    .map(
      (t, i) => `<div class="legend-row">
          <span class="legend-row-left">${legendDot(
            "var(--tenant-accent)",
            ` class="tc" data-color="${i % 3}"`
          )}${esc(t.tenantName)}</span>
          <span class="legend-row-right">${money(t.totalCostMonth)}<span class="legend-pct">${pct(
        (t.totalCostMonth / total) * 100
      )}</span></span>
        </div>`
    )
    .join("");

  return `<div class="card panel">
      <h2>Participación de costo por tenant</h2>
      <p class="panel-sub">Mes en curso &middot; ${money0(total)} combinados entre ${tenants.length} tenants</p>
      <div class="donut-panel-body">
        <div class="donut-wrap">${svg}</div>
        <div class="donut-legend">${legend}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// Gráfico de tendencia + pronóstico (SVG)
// ---------------------------------------------------------------------
function renderTrendChart(trend, forecast) {
  const realPoints = trend.map((d, i) => ({ i, v: d.cost }));
  const todayIdx = trend.length - 1;
  const forecastPoints = [{ i: todayIdx, v: trend[todayIdx].cost }];
  forecast.slice(1).forEach((d, k) => forecastPoints.push({ i: todayIdx + 1 + k, v: d.cost }));

  const N = todayIdx + forecast.length;
  const padLeft = 50,
    padRight = 14,
    padTop = 16,
    padBottom = 26;
  const plotW = 860 - padLeft - padRight;
  const plotH = 230 - padTop - padBottom;

  const allValues = [...realPoints, ...forecastPoints].map((p) => p.v);
  const rawMax = Math.max(...allValues, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const yMax = Math.ceil((rawMax * 1.15) / (magnitude / 2)) * (magnitude / 2);
  const yMin = 0;
  const ySteps = 4;

  const x = (i) => padLeft + (i / N) * plotW;
  const y = (v) => padTop + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const pathFor = (pts) => pts.map((p, idx) => `${idx === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  const realPath = pathFor(realPoints);
  const forecastPath = pathFor(forecastPoints);
  const areaPath = `${realPath} L${x(realPoints.at(-1).i).toFixed(1)},${y(0).toFixed(1)} L${x(realPoints[0].i).toFixed(
    1
  )},${y(0).toFixed(1)} Z`;

  const startDate = new Date(trend[0].date + "T00:00:00Z");
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  let ticksSvg = "";
  const tickCount = 8;
  for (let k = 0; k <= tickCount; k++) {
    const idx = Math.round((k / tickCount) * N);
    const d = new Date(startDate.getTime() + idx * 86400000);
    const label = `${d.getUTCDate()} ${meses[d.getUTCMonth()]}`;
    const px = x(idx).toFixed(1);
    ticksSvg += `<line x1="${px}" y1="${padTop}" x2="${px}" y2="${padTop + plotH}" stroke="var(--gridline)" stroke-width="1"/><text x="${px}" y="${
      padTop + plotH + 17
    }" font-size="10.5" fill="var(--text-muted)" text-anchor="middle">${label}</text>`;
  }

  let yGrid = "";
  for (let s = 0; s <= ySteps; s++) {
    const v = (yMax / ySteps) * s;
    const py = y(v).toFixed(1);
    yGrid += `<line x1="${padLeft}" y1="${py}" x2="${padLeft + plotW}" y2="${py}" stroke="var(--gridline)" stroke-width="1"/><text x="${
      padLeft - 9
    }" y="${Number(py) + 3}" font-size="10.5" fill="var(--text-muted)" text-anchor="end">US$${Math.round(v)}</text>`;
  }

  const todayX = x(todayIdx).toFixed(1);
  const todayY = y(trend[todayIdx].cost).toFixed(1);

  return `
      <svg viewBox="0 0 860 230" class="trend-chart" role="img" aria-label="Tendencia diaria de costo y pronóstico a 30 días">
        ${yGrid}
        ${ticksSvg}
        <line x1="${todayX}" y1="${padTop}" x2="${todayX}" y2="${padTop + plotH}" stroke="var(--baseline)" stroke-width="1" stroke-dasharray="2 3"/>
        <text x="${todayX}" y="11" font-size="10.5" font-weight="600" fill="var(--text-secondary)" text-anchor="middle">hoy</text>
        <path d="${areaPath}" fill="var(--tenant-wash)" stroke="none"/>
        <path d="${realPath}" fill="none" stroke="var(--tenant-accent)" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="${forecastPath}" fill="none" stroke="var(--tenant-accent)" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="5 4"/>
        <circle cx="${todayX}" cy="${todayY}" r="3.4" fill="var(--tenant-accent)" stroke="var(--surface-1)" stroke-width="1.5"/>
      </svg>`;
}

// ---------------------------------------------------------------------
// Historial de costo mensual (barras, hasta 12 meses, límite de Cost
// Management API). El último mes se marca "parcial" si coincide con el
// mes de generación del reporte, y se dibuja con menor opacidad.
// ---------------------------------------------------------------------
function roundedTopBarPath(x, w, yTop, yBase, r) {
  const rr = Math.max(0, Math.min(r, (yBase - yTop) / 2, w / 2));
  if (rr < 0.5) {
    return `M${x.toFixed(1)},${yBase.toFixed(1)} L${x.toFixed(1)},${yTop.toFixed(1)} L${(x + w).toFixed(1)},${yTop.toFixed(
      1
    )} L${(x + w).toFixed(1)},${yBase.toFixed(1)} Z`;
  }
  return `M${x.toFixed(1)},${yBase.toFixed(1)} L${x.toFixed(1)},${(yTop + rr).toFixed(1)} Q${x.toFixed(1)},${yTop.toFixed(
    1
  )} ${(x + rr).toFixed(1)},${yTop.toFixed(1)} L${(x + w - rr).toFixed(1)},${yTop.toFixed(1)} Q${(x + w).toFixed(
    1
  )},${yTop.toFixed(1)} ${(x + w).toFixed(1)},${(yTop + rr).toFixed(1)} L${(x + w).toFixed(1)},${yBase.toFixed(1)} Z`;
}

function renderMonthlyHistoryChart(months, generatedAt) {
  const N = months.length;
  const padLeft = 50,
    padRight = 14,
    padTop = 16,
    padBottom = 26;
  const plotW = 860 - padLeft - padRight;
  const plotH = 230 - padTop - padBottom;

  const currentYM = (generatedAt || "").slice(0, 7);
  const values = months.map((m) => m.cost);
  const rawMax = Math.max(...values, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const yMax = Math.ceil((rawMax * 1.15) / (magnitude / 2)) * (magnitude / 2);
  const ySteps = 4;

  const slotW = plotW / N;
  const barW = Math.min(24, slotW - 2);
  const baseline = padTop + plotH;
  const barX = (i) => padLeft + i * slotW + (slotW - barW) / 2;
  const y = (v) => padTop + (1 - (yMax > 0 ? v / yMax : 0)) * plotH;

  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const labelFor = (ym) => {
    const [yy, mm] = ym.split("-").map(Number);
    return `${meses[mm - 1]} ${String(yy).slice(2)}`;
  };

  let barsSvg = "";
  let labelsSvg = "";
  months.forEach((m, i) => {
    const isCurrent = m.month === currentYM;
    const x0 = barX(i);
    const yTop = y(m.cost);
    const label = labelFor(m.month);
    barsSvg += `<path d="${roundedTopBarPath(x0, barW, yTop, baseline, 4)}" fill="var(--tenant-accent)" opacity="${
      isCurrent ? 0.5 : 1
    }"><title>${esc(label)}: ${money(m.cost)}${isCurrent ? " (mes en curso, parcial)" : ""}</title></path>`;
    const px = (x0 + barW / 2).toFixed(1);
    labelsSvg += `<text x="${px}" y="${baseline + 17}" font-size="10.5" fill="var(--text-muted)" text-anchor="middle">${label}</text>`;
  });

  const last = months.at(-1);
  const lastX = (barX(N - 1) + barW / 2).toFixed(1);
  const lastY = Math.max(y(last.cost) - 8, padTop + 10).toFixed(1);
  const valueLabel = `<text x="${lastX}" y="${lastY}" font-size="12" font-weight="600" fill="var(--text-primary)" text-anchor="middle" font-family="var(--font-mono)">${money0(
    last.cost
  )}</text>`;

  let yGrid = "";
  for (let s = 0; s <= ySteps; s++) {
    const v = (yMax / ySteps) * s;
    const py = y(v).toFixed(1);
    yGrid += `<line x1="${padLeft}" y1="${py}" x2="${padLeft + plotW}" y2="${py}" stroke="var(--gridline)" stroke-width="1"/><text x="${
      padLeft - 9
    }" y="${Number(py) + 3}" font-size="10.5" fill="var(--text-muted)" text-anchor="end">US$${Math.round(v).toLocaleString(
      "es-CL"
    )}</text>`;
  }

  return `
      <svg viewBox="0 0 860 230" class="trend-chart" role="img" aria-label="Historial de costo mensual">
        ${yGrid}
        ${barsSvg}
        ${labelsSvg}
        ${valueLabel}
      </svg>`;
}

function renderMonthlyHistoryPanel(t, generatedAt) {
  const months = t.monthlyHistory || [];
  if (!months.length) {
    return `
    <div class="card panel">
      <h2>Historial de costo mensual</h2>
      <p class="panel-sub">Costo real por mes, según Cost Management</p>
      <div class="empty-state"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg><div>Sin historial disponible para este tenant en esta actualización.</div></div>
    </div>`;
  }
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const labelFor = (ym) => {
    const [yy, mm] = ym.split("-").map(Number);
    return `${meses[mm - 1]} ${yy}`;
  };
  const sub = `${labelFor(months[0].month)}&ndash;${labelFor(months.at(-1).month)} &middot; el mes en curso es parcial (barra atenuada)`;
  return `
    <div class="card panel">
      <h2>Historial de costo mensual</h2>
      <p class="panel-sub">${sub}</p>
      ${renderMonthlyHistoryChart(months, generatedAt)}
    </div>`;
}

// ---------------------------------------------------------------------
// Gauge de presupuesto (siempre visible, escalado a 120%)
// ---------------------------------------------------------------------
function renderBudgetGauge(budget) {
  if (!budget) {
    return `<div class="card stat-mini">
        <div class="label">Presupuesto</div>
        <div class="value">Sin configurar</div>
        <div class="sub">No hay budgets activos en esta suscripción</div>
      </div>`;
  }
  const status = budgetStatus(budget.percentUsed);
  const scaleMax = 120;
  const fillPct = Math.min(budget.percentUsed, scaleMax);
  const markerPct = (100 / scaleMax) * 100;
  const over = budget.percentUsed >= 100;
  return `<div class="card stat-mini">
        <div class="label">Presupuesto &ndash; ${esc(budget.name)}</div>
        <div class="stat-mini-head">
          <div class="value">${pct(budget.percentUsed)}</div>
          <span class="status-pill status-${status}">${STATUS_LABEL[status]}</span>
        </div>
        <div class="sub">${money(budget.currentSpend)} de ${money(budget.amount)}${
    over ? ` &middot; ${money(budget.currentSpend - budget.amount)} sobre el límite` : ""
  }</div>
        <div class="gauge-track">
          <div class="gauge-fill status-fill-${status}" style="width:${fillPct}%"></div>
          <div class="gauge-marker" style="left:${markerPct}%" title="100% del presupuesto"></div>
        </div>
      </div>`;
}

// ---------------------------------------------------------------------
// Lista de "recursos nuevos detectados"
// ---------------------------------------------------------------------
function renderActivityList(items) {
  if (!items.length) {
    return `<div class="empty-state"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg><div>Sin recursos nuevos detectados en el período.</div></div>`;
  }
  return `
      <div class="activity-list">
        <div class="activity-row activity-head" aria-hidden="true">
          <span>Recurso</span><span>Autor &middot; fecha</span>
        </div>
        ${items
          .map(
            (r) => `<div class="activity-row">
          <div class="activity-main"><span class="activity-name">${esc(r.name)}</span><span class="activity-type">${esc(
              r.type
            )}</span></div>
          <div class="activity-side"><span class="activity-author">${esc(r.caller || "Sin identificar")}</span><span class="activity-date">${fmtDateShort(
              r.timestamp
            )}</span></div>
        </div>`
          )
          .join("")}
      </div>`;
}

// ---------------------------------------------------------------------
// Barra de navegación rápida entre tenants
// ---------------------------------------------------------------------
function renderTenantNav(tenants) {
  if (tenants.length < 2) return "";
  return `<nav class="tenant-nav" aria-label="Ir a un tenant">
      ${tenants
        .map(
          (t, i) =>
            `<a class="tenant-nav-pill tc" data-color="${i % 3}" href="#tenant-${slugify(t.tenantName)}"><span class="dot"></span>${esc(
              t.tenantName
            )}</a>`
        )
        .join("")}
    </nav>`;
}

// ---------------------------------------------------------------------
// Resumen ejecutivo (rollup de todos los tenants)
// ---------------------------------------------------------------------
function renderSummary(tenants) {
  const totalCost = tenants.reduce((s, t) => s + t.totalCostMonth, 0);
  const totalForecast = tenants.reduce((s, t) => s + t.forecast.reduce((ss, d) => ss + d.cost, 0), 0);
  const totalNew = tenants.reduce((s, t) => s + (t.newResources || []).length, 0);
  const withBudget = tenants.filter((t) => t.budget);
  const alerts = withBudget.filter((t) => t.budget.percentUsed >= 85);
  const critical = alerts.filter((t) => t.budget.percentUsed >= 100);

  let alertStatus = "good";
  let alertValue = "Sin alertas";
  let alertSub = withBudget.length
    ? "Todos los presupuestos configurados están dentro de rango."
    : "Ningún tenant tiene un budget configurado todavía.";
  if (alerts.length) {
    alertStatus = critical.length ? "critical" : "warning";
    alertValue = `${alerts.length} de ${withBudget.length} tenant${withBudget.length === 1 ? "" : "s"}`;
    alertSub = alerts.map((t) => `${esc(t.tenantName)} (${pct(t.budget.percentUsed)})`).join(" &middot; ");
  }

  return `<div class="summary-grid">
      <div class="card summary-tile">
        <div class="label">Costo total &ndash; todos los tenants</div>
        <div class="value">${money0(totalCost)}</div>
        <div class="sub">${tenants.length} tenant${tenants.length === 1 ? "" : "s"} de Azure AD, mes en curso</div>
      </div>
      <div class="card summary-tile">
        <div class="label">Pronóstico a 30 días</div>
        <div class="value">${money0(totalForecast)}</div>
        <div class="sub">Suma de forecasts de Cost Management</div>
      </div>
      <div class="card summary-tile">
        <div class="label">Recursos nuevos (30 días)</div>
        <div class="value">${totalNew}</div>
        <div class="sub">Detectados vía Activity Log, todos los tenants</div>
      </div>
      <div class="card summary-tile">
        <div class="label">Alertas de presupuesto</div>
        <div class="stat-mini-head"><div class="value">${alertValue}</div><span class="status-pill status-${alertStatus}">${
    alertStatus === "good" ? "OK" : alertStatus === "warning" ? "Atención" : "Crítico"
  }</span></div>
        <div class="sub">${alertSub}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// Una sección de tenant completa
// ---------------------------------------------------------------------
function renderTenantSection(t, colorIndex) {
  const slug = slugify(t.tenantName);
  const trendTotal = t.trend.reduce((s, d) => s + d.cost, 0);
  const forecastTotal = t.forecast.reduce((s, d) => s + d.cost, 0);
  const fromLabel = t.trend[0]?.date;
  const toLabel = t.trend.at(-1)?.date;
  const forecastToLabel = t.forecast.at(-1)?.date;

  return `
    <section class="tenant-section" id="tenant-${slug}" data-color="${colorIndex % 3}">
    <div class="tenant-head">
      <h2 class="tenant-title"><span class="tenant-badge">Tenant</span>${esc(t.tenantName)} <span class="tenant-domain">(${esc(
    t.tenantDomain
  )})</span></h2>
      <span class="tenant-meta">${esc(t.subscriptionName)} &middot; ${shortId(t.subscriptionId)}</span>
    </div>

    <div class="hero-row">
      <div class="card hero">
        <div class="label">Costo total del mes</div>
        <div class="value">${money(t.totalCostMonth)}</div>
        <div class="sub">${t.resourceGroups.length} resource groups &middot; ${t.services.length} servicios activos</div>
      </div>
      ${renderBudgetGauge(t.budget)}
    </div>

    <div class="panels">
      ${renderDonutPanel("Costo por resource group", "Distribución del mes en curso", t.resourceGroups)}
      ${renderDonutPanel("Costo por servicio", "Distribución del mes en curso", t.services)}
    </div>

    <div class="card panel">
      <div class="panel-head-row">
        <div>
          <h2>Tendencia diaria y pronóstico</h2>
          <p class="panel-sub">Costo real (${fromLabel}&ndash;${toLabel}) y pronóstico de Cost Management (${toLabel}&ndash;${forecastToLabel})</p>
        </div>
        <div class="legend">
          <span class="legend-item"><span class="swatch swatch-solid"></span>Real</span>
          <span class="legend-item"><span class="swatch swatch-dashed"></span>Pronóstico</span>
        </div>
      </div>
      ${renderTrendChart(t.trend, t.forecast)}
      <div class="trend-foot">
        <div class="trend-stat"><span class="trend-stat-label">Real acumulado</span><span class="trend-stat-value">${money(
          trendTotal
        )}</span></div>
        <div class="trend-stat"><span class="trend-stat-label">Pronóstico (30 días)</span><span class="trend-stat-value">${money(
          forecastTotal
        )}</span></div>
      </div>
    </div>

    ${renderMonthlyHistoryPanel(t, data.generatedAt)}

    <div class="card panel">
      <h2>Recursos nuevos detectados</h2>
      <p class="panel-sub">Primer evento de escritura visible por recurso, últimos 30 días</p>
      ${renderActivityList(t.newResources || [])}
    </div>
    </section>`;
}

// ---------------------------------------------------------------------
// Logo de Datapro, embebido como data URI (PNG con fondo transparente,
// recortado a su contenido) para que el panel sea 100% autocontenido.
// ---------------------------------------------------------------------
const DATAPRO_LOGO_DATA_URI =
  "data:image/png;base64,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";

// ---------------------------------------------------------------------
// Tipografía y hoja de estilos
// ---------------------------------------------------------------------
const FONT_LINK = `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600;700&display=swap">`;

const CSS = `
  html, body { margin: 0; padding: 0; background: #f4f6f9; }
  @media (prefers-color-scheme: dark) { html, body { background: #0a0c10; } }
  .viz-root {
    color-scheme: light;
    --font-sans: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
    --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    --plane:          #f4f6f9;
    --surface-1:      #ffffff;
    --surface-2:      #eef1f6;
    --text-primary:   #12151c;
    --text-secondary: #4c5266;
    --text-muted:     #838aa0;
    --gridline:       #e4e7ee;
    --baseline:       #c7ccd9;
    --border:         rgba(18,21,28,0.09);
    --status-good:     #0ca30c;
    --status-warning:  #b9790a;
    --status-critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .viz-root {
      color-scheme: dark;
      --plane: #0a0c10; --surface-1: #14171e; --surface-2: #1b1f28; --text-primary: #f3f5f9; --text-secondary: #aab0c2;
      --text-muted: #747c91; --gridline: #252a35; --baseline: #333a48; --border: rgba(255,255,255,0.10);
      --status-good: #3fc23f; --status-warning: #e2a730; --status-critical: #e0684f;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --plane: #0a0c10; --surface-1: #14171e; --surface-2: #1b1f28; --text-primary: #f3f5f9; --text-secondary: #aab0c2;
    --text-muted: #747c91; --gridline: #252a35; --baseline: #333a48; --border: rgba(255,255,255,0.10);
    --status-good: #3fc23f; --status-warning: #e2a730; --status-critical: #e0684f;
  }
  /* Colores de identidad por tenant (paleta categórica, orden fijo, hasta 3 tenants).
     .tc[data-color] es la clase genérica: se usa en la sección del tenant, las
     pastillas de navegación, y los puntos de leyenda de la dona de participación. */
  .tenant-section[data-color="0"], .tc[data-color="0"] { --tenant-accent: #2a78d6; }
  .tenant-section[data-color="1"], .tc[data-color="1"] { --tenant-accent: #eb6834; }
  .tenant-section[data-color="2"], .tc[data-color="2"] { --tenant-accent: #1baf7a; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .tenant-section[data-color="0"], :root:not([data-theme="light"]) .tc[data-color="0"] { --tenant-accent: #3987e5; }
    :root:not([data-theme="light"]) .tenant-section[data-color="1"], :root:not([data-theme="light"]) .tc[data-color="1"] { --tenant-accent: #d95926; }
    :root:not([data-theme="light"]) .tenant-section[data-color="2"], :root:not([data-theme="light"]) .tc[data-color="2"] { --tenant-accent: #199e70; }
  }
  :root[data-theme="dark"] .tenant-section[data-color="0"], :root[data-theme="dark"] .tc[data-color="0"] { --tenant-accent: #3987e5; }
  :root[data-theme="dark"] .tenant-section[data-color="1"], :root[data-theme="dark"] .tc[data-color="1"] { --tenant-accent: #d95926; }
  :root[data-theme="dark"] .tenant-section[data-color="2"], :root[data-theme="dark"] .tc[data-color="2"] { --tenant-accent: #199e70; }
  .tenant-section, .tc {
    --tenant-wash: color-mix(in srgb, var(--tenant-accent) 9%, transparent);
    --tenant-soft-bg: color-mix(in srgb, var(--tenant-accent) 13%, var(--surface-1));
    --tenant-soft-border: color-mix(in srgb, var(--tenant-accent) 40%, var(--surface-1));
  }
  /* Paleta categórica para las donas de resource group / servicio (orden fijo, slots 1-5 + Otros neutro) */
  .viz-root {
    --cat-1: #2a78d6; --cat-2: #eb6834; --cat-3: #1baf7a; --cat-4: #eda100; --cat-5: #e87ba4;
    --cat-otros: #aab0c2;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .viz-root {
      --cat-1: #3987e5; --cat-2: #d95926; --cat-3: #199e70; --cat-4: #c98500; --cat-5: #d55181;
      --cat-otros: #4a5163;
    }
  }
  :root[data-theme="dark"] .viz-root {
    --cat-1: #3987e5; --cat-2: #d95926; --cat-3: #199e70; --cat-4: #c98500; --cat-5: #d55181;
    --cat-otros: #4a5163;
  }

  * { box-sizing: border-box; }
  .viz-root { background: var(--plane); color: var(--text-primary); font-family: var(--font-sans); padding-inline: max(16px, env(safe-area-inset-left, 0px)); padding-block: 32px 52px; display: flex; justify-content: center; }
  .wrap { width: 100%; max-width: 980px; display: flex; flex-direction: column; gap: 24px; }

  header.top { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px 16px; }
  header.top h1 { font-size: 25px; font-weight: 700; margin: 0; letter-spacing: -0.015em; text-wrap: balance; }
  .header-brand { display: flex; align-items: center; gap: 14px; }
  .brand-mark { display: inline-flex; align-items: center; flex: none; background: #ffffff; border: 1px solid var(--border); border-radius: 10px; padding: 7px 12px; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06); }
  .brand-logo { display: block; height: 26px; width: auto; }
  @media (max-width: 480px) { .brand-logo { height: 22px; } .brand-mark { padding: 6px 10px; } }
  .eyebrow { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-muted); margin: 0 0 4px; }
  .meta { font-size: 13px; color: var(--text-secondary); display: flex; flex-wrap: wrap; align-items: center; gap: 5px 10px; text-align: right; }
  .meta b { color: var(--text-primary); font-weight: 600; }
  .dot-sep { color: var(--text-muted); }
  .live-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--status-good); background: color-mix(in srgb, var(--status-good) 12%, var(--surface-1)); border: 1px solid color-mix(in srgb, var(--status-good) 30%, var(--surface-1)); border-radius: 999px; padding: 4px 10px 4px 8px; }
  .live-pill .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--status-good); box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-good) 55%, transparent); animation: pulse 2.4s ease-out infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-good) 45%, transparent); } 70% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--status-good) 0%, transparent); } 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-good) 0%, transparent); } }
  @media (prefers-reduced-motion: reduce) { .live-pill .pulse { animation: none; } }

  .tenant-nav { display: flex; flex-wrap: wrap; gap: 8px; }
  .tenant-nav-pill { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--text-primary); text-decoration: none; background: var(--surface-1); border: 1px solid var(--border); border-radius: 999px; padding: 7px 14px 7px 11px; transition: border-color .15s ease, background .15s ease; }
  .tenant-nav-pill:hover, .tenant-nav-pill:focus-visible { border-color: var(--tenant-soft-border); background: var(--tenant-soft-bg); outline: none; }
  .tenant-nav-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tenant-accent); flex: none; }

  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  @media (max-width: 860px) { .summary-grid { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 480px) { .summary-grid { grid-template-columns: 1fr; } }
  .summary-tile { display: flex; flex-direction: column; gap: 4px; }
  .summary-tile .value { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

  .tenant-section { display: flex; flex-direction: column; gap: 14px; scroll-margin-top: 16px; }
  .tenant-section + .tenant-section { margin-top: 8px; padding-top: 32px; border-top: 1px solid var(--border); }
  .tenant-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 14px; }
  .tenant-head h2.tenant-title { font-size: 18px; font-weight: 700; margin: 0; }
  .tenant-domain { font-weight: 400; color: var(--text-muted); }
  .tenant-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--tenant-accent); background: var(--tenant-soft-bg); border: 1px solid var(--tenant-soft-border); border-radius: 999px; padding: 3px 10px; margin-right: 9px; }
  .tenant-meta { font-size: 12px; color: var(--text-muted); font-family: var(--font-mono); }

  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 14px; padding: 20px; }
  .hero-row { display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; align-items: stretch; }
  @media (max-width: 620px) { .hero-row { grid-template-columns: 1fr; } }
  .hero .label, .summary-tile .label, .stat-mini .label { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
  .hero .value { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 38px; font-weight: 600; letter-spacing: -0.01em; margin-top: 9px; }
  .hero .sub, .summary-tile .sub, .stat-mini .sub { font-size: 12.5px; color: var(--text-secondary); margin-top: 6px; }
  .stat-mini { display: flex; flex-direction: column; justify-content: center; gap: 5px; }
  .stat-mini .value { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 21px; font-weight: 600; margin-top: 4px; }
  .stat-mini-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .status-pill { display: inline-flex; align-items: center; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; border-radius: 999px; padding: 3px 9px; white-space: nowrap; }
  .status-good { color: var(--status-good); background: color-mix(in srgb, var(--status-good) 14%, var(--surface-1)); }
  .status-warning { color: var(--status-warning); background: color-mix(in srgb, var(--status-warning) 18%, var(--surface-1)); }
  .status-critical { color: var(--status-critical); background: color-mix(in srgb, var(--status-critical) 16%, var(--surface-1)); }
  .gauge-track { position: relative; background: var(--gridline); border-radius: 5px; height: 8px; overflow: visible; margin-top: 12px; }
  .gauge-fill { height: 100%; border-radius: 5px; min-width: 6px; }
  .status-fill-good { background: var(--status-good); }
  .status-fill-warning { background: var(--status-warning); }
  .status-fill-critical { background: var(--status-critical); }
  .gauge-marker { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--text-primary); opacity: .35; }

  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 700px) { .panels { grid-template-columns: 1fr; } }
  .panel h2 { font-size: 15px; font-weight: 700; margin: 0 0 4px; }
  .panel .panel-sub { font-size: 12px; color: var(--text-muted); margin: 0 0 16px; }

  .donut-panel-body { display: flex; align-items: center; gap: 22px; }
  @media (max-width: 520px) { .donut-panel-body { flex-direction: column; align-items: stretch; } }
  .donut-wrap { flex: none; display: flex; justify-content: center; }
  .donut-svg { display: block; }
  .donut-center-value { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 19px; font-weight: 600; fill: var(--text-primary); }
  .donut-center-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; fill: var(--text-muted); }
  .donut-legend { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .legend-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .legend-row:last-child { border-bottom: none; padding-bottom: 0; }
  .legend-row-left { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .legend-row-right { display: flex; align-items: baseline; gap: 8px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
  .legend-pct { color: var(--text-muted); font-weight: 600; min-width: 46px; text-align: right; }

  .panel-head-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 8px 16px; margin-bottom: 8px; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; padding-top: 2px; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
  .swatch { display: inline-block; width: 16px; height: 0; border-top: 2.5px solid var(--tenant-accent); }
  .swatch-dashed { border-top-style: dashed; }
  .trend-chart { width: 100%; height: auto; display: block; margin-top: 4px; }
  .trend-foot { display: flex; flex-wrap: wrap; gap: 24px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
  .trend-stat { display: flex; flex-direction: column; gap: 3px; }
  .trend-stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .trend-stat-value { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 16px; font-weight: 600; }

  .activity-list { display: flex; flex-direction: column; }
  .activity-head { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); padding-bottom: 8px !important; border-bottom: 1px solid var(--border); }
  .activity-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .activity-row:last-child { border-bottom: none; padding-bottom: 0; }
  .activity-main { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
  .activity-name { font-size: 13px; font-weight: 600; color: var(--text-primary); font-family: var(--font-mono); }
  .activity-type { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap; }
  .activity-side { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; text-align: right; }
  .activity-author { font-size: 12px; color: var(--text-secondary); font-weight: 600; }
  .activity-date { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
  .empty-state { border: 1px dashed var(--border); border-radius: 10px; padding: 16px; font-size: 13px; color: var(--text-secondary); display: flex; gap: 10px; align-items: flex-start; }
  .empty-state svg { flex: none; margin-top: 1px; color: var(--text-muted); }

  footer.page-footer { font-size: 12px; color: var(--text-muted); text-align: center; padding-top: 6px; }
  footer.page-footer a { color: inherit; }
`;

// ---------------------------------------------------------------------
// Página completa
// ---------------------------------------------------------------------
const updatedLabel = new Date(data.generatedAt).toLocaleString("es-CL", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const body = `
<div class="viz-root">
  <div class="wrap">
    <header class="top">
      <div class="header-brand">
        <span class="brand-mark"><img class="brand-logo" src="${DATAPRO_LOGO_DATA_URI}" alt="Datapro" width="160" height="34"></span>
        <div>
          <p class="eyebrow">Azure Cost Management</p>
          <h1>Panel de Costos Azure</h1>
        </div>
      </div>
      <div class="meta">
        <span class="live-pill"><span class="pulse"></span>Se actualiza sola cada 12 h</span>
        <span>${data.tenants.length} tenant${data.tenants.length === 1 ? "" : "s"} &middot; actualizado ${updatedLabel}</span>
      </div>
    </header>

    ${renderSummary(data.tenants)}
    ${renderTenantShareCard(data.tenants)}
    ${renderTenantNav(data.tenants)}

    ${data.tenants.map((t, i) => renderTenantSection(t, i)).join("\n")}

    <footer class="page-footer">Generado con azure-cost-mcp &middot; Azure Resource Manager &middot; Cost Management API &middot; se actualiza automáticamente cada 12 horas</footer>
  </div>
</div>`;

const head = `${FONT_LINK}
<title>Panel de Costos Azure</title>
<style>${CSS}</style>`;

const fragment = `${head}
${body}
`;

const standaloneHtml = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
${head}
</head>
<body>${body}
</body>
</html>
`;

const html = standalone ? standaloneHtml : fragment;
writeFileSync(outPath, html, "utf-8");
console.log(`OK (${standalone ? "standalone" : "fragmento para Artifact"}): ${outPath} (${html.length} chars)`);
