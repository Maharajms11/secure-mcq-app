import { sanitizeText } from "./utils.js";

const META_KEYS = new Set(["question_id", "id", "difficulty", "topic_tag", "explanation", "category"]);

function isMetaLine(line) {
  const match = line.match(/^([A-Za-z_ ]+)\s*:\s*(.+)$/);
  if (!match) return false;
  const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
  return META_KEYS.has(key);
}

function parseMetaLine(line) {
  const match = line.match(/^([A-Za-z_ ]+)\s*:\s*(.+)$/);
  if (!match) return null;
  const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
  const value = sanitizeText(match[2]);
  return { key, value };
}

function parseOptionLine(line, expectedLabel) {
  const re = new RegExp(`^${expectedLabel}[\\.)]\\s+(.+)$`, "i");
  const match = line.match(re);
  if (!match) return null;
  return sanitizeText(match[1]);
}

export function parseAikenText(content) {
  const src = String(content || "").replace(/\uFEFF/g, "");
  const lines = src.split(/\r?\n/);
  const questions = [];
  let i = 0;

  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i += 1;
    if (i >= lines.length) break;

    const meta = {};
    while (i < lines.length && lines[i].trim() && isMetaLine(lines[i].trim())) {
      const parsed = parseMetaLine(lines[i].trim());
      if (parsed) meta[parsed.key] = parsed.value;
      i += 1;
    }

    const questionStartLine = i + 1;
    const questionLines = [];
    while (i < lines.length && lines[i].trim() && !/^[A][\.)]\s+/i.test(lines[i].trim())) {
      if (isMetaLine(lines[i].trim())) {
        throw new Error(`Unexpected metadata at line ${i + 1}. Metadata lines must appear before question text.`);
      }
      questionLines.push(sanitizeText(lines[i]));
      i += 1;
    }

    const stem = sanitizeText(questionLines.join(" "));
    if (!stem) {
      throw new Error(`Missing question text at line ${questionStartLine}.`);
    }

    const optionA = parseOptionLine((lines[i] || "").trim(), "A");
    const optionB = parseOptionLine((lines[i + 1] || "").trim(), "B");
    const optionC = parseOptionLine((lines[i + 2] || "").trim(), "C");
    const optionD = parseOptionLine((lines[i + 3] || "").trim(), "D");
    if (!optionA || !optionB || !optionC || !optionD) {
      throw new Error(`Expected four options A-D starting at line ${i + 1}.`);
    }
    i += 4;

    const answerLine = (lines[i] || "").trim();
    const answerMatch = answerLine.match(/^ANSWER\s*:\s*([ABCD])$/i);
    if (!answerMatch) {
      throw new Error(`Missing or invalid ANSWER line at line ${i + 1}.`);
    }
    const answerKey = answerMatch[1].toUpperCase();
    i += 1;

    while (i < lines.length && !lines[i].trim()) i += 1;

    const questionId = sanitizeText(meta.question_id || meta.id || "");
    if (!questionId) {
      throw new Error(`Missing required question_id metadata for question starting at line ${questionStartLine}.`);
    }

    const difficulty = sanitizeText(meta.difficulty || "medium").toLowerCase();
    if (!["easy", "medium", "hard"].includes(difficulty)) {
      throw new Error(`Invalid difficulty '${meta.difficulty}' for question_id '${questionId}'.`);
    }

    const topicTag = sanitizeText(meta.topic_tag || "");
    const category = sanitizeText(meta.category || topicTag || "General");
    const explanation = sanitizeText(meta.explanation || "");

    const options = [
      { id: "a", text: optionA },
      { id: "b", text: optionB },
      { id: "c", text: optionC },
      { id: "d", text: optionD }
    ];

    const answerId = answerKey.toLowerCase();
    questions.push({
      id: questionId,
      category,
      difficulty,
      topic_tag: topicTag,
      stem,
      explanation,
      image: null,
      distractors: options.map((o) => ({ id: o.id, text: o.text, correct: o.id === answerId }))
    });
  }

  if (!questions.length) {
    throw new Error("No questions were detected in the uploaded Aiken file.");
  }

  return questions;
}
