import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, errorResult } from "./format.js";

// ---------------------------------------------------------------------
// Envío de correo (SMTP) — usado para mandar el Panel de Costos Azure
// (u otro reporte) a destinatarios elegidos manualmente, bajo pedido.
// No hay envío automático: esta herramienta solo actúa cuando alguien
// la invoca explícitamente.
//
// Configuración por variables de entorno (ver .env.example):
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM
// ---------------------------------------------------------------------

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

function readSmtpConfig(): SmtpConfig {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass || !from) {
    throw new Error(
      "Envío de correo no configurado. Define SMTP_HOST, SMTP_USER, SMTP_PASS (y opcionalmente SMTP_PORT, " +
        "SMTP_SECURE, SMTP_FROM) como variables de entorno del servidor MCP — agrégalas al bloque \"env\" de " +
        "azure-cost-mcp en tu configuración de Claude Desktop. Ver .env.example para un ejemplo con Microsoft " +
        "365 / Outlook."
    );
  }

  const port = Number(process.env.SMTP_PORT ?? 587);
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE.toLowerCase() === "true"
    : port === 465;

  return { host, port, secure, user, pass, from };
}

async function getTransporter() {
  // Import perezoso: si nodemailer no está instalado y nadie usa esta
  // herramienta, el resto del servidor MCP sigue funcionando igual.
  const nodemailer = await import("nodemailer");
  const cfg = readSmtpConfig();
  const transporter = nodemailer.default.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  return { transporter, from: cfg.from };
}

function parseRecipients(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmails(addrs: string[], label: string): void {
  const bad = addrs.filter((a) => !EMAIL_REGEX.test(a));
  if (bad.length) {
    throw new Error(`${label} contiene direcciones que no parecen válidas: ${bad.join(", ")}`);
  }
}

export function registerEmailTool(server: McpServer) {
  server.registerTool(
    "send_cost_report_email",
    {
      title: "Enviar reporte por correo",
      description:
        "Envía el Panel de Costos Azure (u otro archivo/reporte) por correo a los destinatarios indicados. " +
        "El envío es siempre bajo pedido explícito — esta herramienta nunca se dispara sola. Los destinatarios " +
        "se especifican en cada llamada (no hay lista fija guardada). Adjunta el archivo HTML del panel " +
        "(standalone, generado con scripts/render-dashboard.mjs --standalone) si se indica attachmentPath, y/o " +
        "envía un cuerpo de correo simple en texto/HTML. Requiere variables SMTP_* configuradas como variables " +
        "de entorno del servidor (ver .env.example).",
      inputSchema: {
        to: z
          .string()
          .describe(
            "Destinatario(s), separados por coma o punto y coma si son varios. Ej: 'ana@datapro.cl' o " +
              "'ana@datapro.cl, cliente@vtyg.cl'."
          ),
        cc: z.string().optional().describe("Destinatarios en copia (CC), mismo formato que 'to'."),
        subject: z.string().optional().describe("Asunto del correo. Por defecto 'Panel de Costos Azure'."),
        message: z
          .string()
          .optional()
          .describe(
            "Texto del cuerpo del correo (texto plano). Por defecto un mensaje breve indicando que el panel " +
              "va adjunto."
          ),
        attachmentPath: z
          .string()
          .optional()
          .describe(
            "Ruta a un archivo HTML standalone del panel (generado con 'node scripts/render-dashboard.mjs " +
              "<datos.json> <salida.html> --standalone') para adjuntar al correo. Si se omite, el correo se " +
              "envía sin adjunto — solo con el texto de 'message'."
          ),
        attachmentName: z
          .string()
          .optional()
          .describe("Nombre de archivo a mostrar para el adjunto. Por defecto se usa el nombre real del archivo."),
      },
    },
    async ({ to, cc, subject, message, attachmentPath, attachmentName }) => {
      try {
        const toList = parseRecipients(to);
        if (!toList.length) return errorResult("Debes indicar al menos un destinatario en 'to'.");
        validateEmails(toList, "'to'");

        const ccList = cc ? parseRecipients(cc) : [];
        if (ccList.length) validateEmails(ccList, "'cc'");

        const { transporter, from } = await getTransporter();

        const attachments: { filename: string; content: Buffer }[] = [];
        if (attachmentPath) {
          const abs = path.resolve(attachmentPath);
          const content = await readFile(abs);
          attachments.push({
            filename: attachmentName || path.basename(abs),
            content,
          });
        }

        const finalSubject = subject || "Panel de Costos Azure";
        const finalMessage =
          message ||
          (attachments.length
            ? "Adjunto encontrarás el Panel de Costos Azure actualizado. Ábrelo en tu navegador para ver el detalle completo."
            : "Panel de Costos Azure.");

        const info = await transporter.sendMail({
          from,
          to: toList.join(", "),
          cc: ccList.length ? ccList.join(", ") : undefined,
          subject: finalSubject,
          text: finalMessage,
          attachments,
        });

        return textResult(
          `✅ Correo enviado.\n` +
            `Para: ${toList.join(", ")}${ccList.length ? `\nCC: ${ccList.join(", ")}` : ""}\n` +
            `Asunto: ${finalSubject}\n` +
            `${attachments.length ? `Adjunto: ${attachments[0].filename}\n` : ""}` +
            `ID del mensaje: ${info.messageId}`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
