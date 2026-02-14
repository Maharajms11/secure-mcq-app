import crypto from "node:crypto";

export const INTEGRITY_NOTICE = `ASSESSMENT INTEGRITY NOTICE

This is a supervised assessment. The following measures are active:
• Copy, paste, and text selection are disabled.
• Switching browser tabs or windows will be logged.
• This assessment cannot be printed or screenshotted for AI analysis.
• Navigation backwards between questions is not permitted.
• Questions and answer options are randomised for each student.
• Your name and ID are embedded as a watermark in this assessment.
• All violation events are recorded and may be reviewed by your invigilator.

By proceeding, you confirm that you are completing this assessment without unauthorised assistance, including AI tools, notes, or other persons.`;

export function sanitizeText(value) {
  return String(value || "").replace(/[<>`]/g, "").trim();
}

export function randomUuid() {
  return crypto.randomUUID();
}

export function fisherYates(input) {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function csvEscape(value) {
  const v = String(value ?? "");
  return `"${v.replaceAll('"', '""')}"`;
}

export function parseJsonObjectOrEmpty(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
