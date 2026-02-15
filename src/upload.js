import crypto from "node:crypto";
import XLSX from "xlsx";
import { sanitizeText } from "./utils.js";

function normalizeDifficulty(value) {
  const v = sanitizeText(value || "").toLowerCase();
  if (v === "easy" || v === "medium" || v === "hard") return v;
  return "medium";
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function parseCsv(text) {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((x) => x.trim());
  if (!rows.length) return [];
  const header = parseCsvLine(rows[0]).map((h) => sanitizeText(h).toLowerCase());
  return rows.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = cols[idx] ?? "";
    });
    return obj;
  });
}

function parseAikenText(rawText) {
  const text = String(rawText || "").replace(/\r/g, "");
  const blocks = text.split(/\n\s*\n/g).map((b) => b.trim()).filter(Boolean);
  const questions = [];
  const errors = [];

  blocks.forEach((block, blockIndex) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 6) {
      errors.push(`Block ${blockIndex + 1}: expected stem + 4 options + ANSWER line.`);
      return;
    }

    const answerLine = lines.find((l) => /^answer\s*:/i.test(l));
    if (!answerLine) {
      errors.push(`Block ${blockIndex + 1}: missing ANSWER: line.`);
      return;
    }
    const answerMatch = answerLine.match(/^answer\s*:\s*([A-D])\s*$/i);
    if (!answerMatch) {
      errors.push(`Block ${blockIndex + 1}: ANSWER line must be one of A/B/C/D.`);
      return;
    }
    const correctLetter = answerMatch[1].toUpperCase();

    const optionLines = lines.filter((l) => /^[A-D][\.\)]\s+/i.test(l));
    if (optionLines.length !== 4) {
      errors.push(`Block ${blockIndex + 1}: expected exactly 4 option lines (A-D).`);
      return;
    }

    const stemLines = [];
    for (const line of lines) {
      if (/^[A-D][\.\)]\s+/i.test(line) || /^answer\s*:/i.test(line)) continue;
      stemLines.push(line);
    }
    const stem = sanitizeText(stemLines.join(" ").trim());
    if (!stem) {
      errors.push(`Block ${blockIndex + 1}: missing question stem.`);
      return;
    }

    const options = optionLines.map((line) => {
      const m = line.match(/^([A-D])[\.\)]\s+(.+)$/i);
      const letter = m[1].toUpperCase();
      return {
        id: letter.toLowerCase(),
        text: sanitizeText(m[2]),
        correct: letter === correctLetter
      };
    });

    if (options.some((o) => !o.text)) {
      errors.push(`Block ${blockIndex + 1}: one or more option texts are empty.`);
      return;
    }

    questions.push({ stem, distractors: options });
  });

  return { questions, errors };
}

function rowToQuestion(row, index) {
  const normalized = Object.fromEntries(
    Object.entries(row || {}).map(([k, v]) => [sanitizeText(k).toLowerCase(), sanitizeText(v)])
  );

  const qidRaw = normalized.question_id || normalized.id || "";
  const questionId = sanitizeText(qidRaw) || `auto_${index + 1}_${crypto.createHash("sha1").update(JSON.stringify(normalized)).digest("hex").slice(0, 10)}`;
  const difficulty = normalizeDifficulty(normalized.difficulty);
  const topicTag = sanitizeText(normalized.topic_tag || normalized.topictag || "");
  const explanation = sanitizeText(normalized.explanation || "");
  const category = sanitizeText(normalized.category || topicTag || "General");

  if (normalized.aiken || normalized.question_aiken || normalized.aiken_text) {
    const parsed = parseAikenText(normalized.aiken || normalized.question_aiken || normalized.aiken_text);
    if (parsed.errors.length) return { error: `Row ${index + 2}: ${parsed.errors[0]}` };
    if (parsed.questions.length !== 1) return { error: `Row ${index + 2}: aiken field must contain exactly one question block.` };
    const q = parsed.questions[0];
    return {
      id: questionId,
      category,
      difficulty,
      topic_tag: topicTag || null,
      stem: q.stem,
      explanation,
      image: null,
      distractors: q.distractors
    };
  }

  const stem = sanitizeText(normalized.stem || normalized.question || normalized.question_text || "");
  const a = sanitizeText(normalized.a || normalized.option_a || normalized.option1 || "");
  const b = sanitizeText(normalized.b || normalized.option_b || normalized.option2 || "");
  const c = sanitizeText(normalized.c || normalized.option_c || normalized.option3 || "");
  const d = sanitizeText(normalized.d || normalized.option_d || normalized.option4 || "");
  const correctRaw = sanitizeText(normalized.correct || normalized.correct_option || normalized.answer || "").toLowerCase();
  const correct = ["a", "b", "c", "d"].includes(correctRaw) ? correctRaw : "";

  if (!stem || !a || !b || !c || !d || !correct) {
    return { error: `Row ${index + 2}: expected columns for stem/options A-D/correct (or aiken).` };
  }

  return {
    id: questionId,
    category,
    difficulty,
    topic_tag: topicTag || null,
    stem,
    explanation,
    image: null,
    distractors: [
      { id: "a", text: a, correct: correct === "a" },
      { id: "b", text: b, correct: correct === "b" },
      { id: "c", text: c, correct: correct === "c" },
      { id: "d", text: d, correct: correct === "d" }
    ]
  };
}

function parseRows(rows) {
  const questions = [];
  const errors = [];
  rows.forEach((row, idx) => {
    const parsed = rowToQuestion(row, idx);
    if (parsed.error) {
      errors.push(parsed.error);
      return;
    }
    questions.push(parsed);
  });
  return { questions, errors };
}

export function parseQuestionUpload(fileName, buffer) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".csv")) {
    const text = Buffer.from(buffer).toString("utf8");
    const csvRows = parseCsv(text);
    if (!csvRows.length) {
      const aiken = parseAikenText(text);
      if (aiken.errors.length) return { questions: [], errors: aiken.errors };
      const questions = aiken.questions.map((q, idx) => ({
        id: `aiken_${idx + 1}`,
        category: "General",
        difficulty: "medium",
        topic_tag: null,
        stem: q.stem,
        explanation: "",
        image: null,
        distractors: q.distractors
      }));
      return { questions, errors: [] };
    }
    return parseRows(csvRows);
  }

  if (lower.endsWith(".xlsx")) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const firstSheet = wb.SheetNames[0];
    if (!firstSheet) return { questions: [], errors: ["XLSX file has no sheets."] };
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { defval: "" });
    if (!rows.length) return { questions: [], errors: ["XLSX file has no data rows."] };
    return parseRows(rows);
  }

  return { questions: [], errors: ["Only .csv and .xlsx uploads are supported."] };
}
