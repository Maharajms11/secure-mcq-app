import nodemailer from "nodemailer";
import { config } from "./config.js";

let cachedTransport = null;

function isConfigured() {
  return !!(config.email.host && config.email.port && config.email.from);
}

function getTransport() {
  if (cachedTransport) return cachedTransport;
  if (!isConfigured()) return null;
  const auth = config.email.user || config.email.pass
    ? { user: config.email.user, pass: config.email.pass }
    : undefined;
  cachedTransport = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: !!config.email.secure,
    auth
  });
  return cachedTransport;
}

export async function sendResultsReleasedEmail({
  to,
  studentName,
  testName,
  resultsUrl
}) {
  if (!config.email.enabled) {
    return { sent: false, reason: "disabled" };
  }
  const transport = getTransport();
  if (!transport) {
    return { sent: false, reason: "smtp_not_configured" };
  }
  const subject = `Results released: ${testName || "Assessment"}`;
  const safeName = studentName || "Student";
  const text = [
    `Hello ${safeName},`,
    "",
    `Your results for "${testName || "Assessment"}" are now available.`,
    `Open this link to view your results:`,
    resultsUrl,
    "",
    "If you did not request this, please contact your invigilator."
  ].join("\n");
  const html = `
    <p>Hello ${escapeHtml(safeName)},</p>
    <p>Your results for "<strong>${escapeHtml(testName || "Assessment")}</strong>" are now available.</p>
    <p><a href="${escapeAttribute(resultsUrl)}">View your results</a></p>
    <p>If you did not request this, please contact your invigilator.</p>
  `;
  await transport.sendMail({
    from: config.email.from,
    to,
    subject,
    text,
    html
  });
  return { sent: true };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return String(value || "").replaceAll('"', "&quot;");
}
