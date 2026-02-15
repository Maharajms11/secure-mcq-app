import XLSX from "xlsx";
import { query, withTx } from "../db.js";
import { config } from "../config.js";
import { parseQuestionUpload } from "../upload.js";
import {
  csvEscape,
  hashSecret,
  parseJsonArrayOrEmpty,
  parseJsonObjectOrEmpty,
  sanitizeText,
  verifySecret
} from "../utils.js";

function normalizeBankCode(value) {
  const cleaned = sanitizeText(value || "").toLowerCase();
  if (!cleaned) return "";
  return cleaned.replace(/[^a-z0-9_-]/g, "");
}

function bankCodeFromName(name) {
  const cleaned = sanitizeText(name || "").toLowerCase();
  const code = cleaned.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return code || "bank";
}

function normalizeQuestionPayload(body) {
  const id = sanitizeText(body.id);
  const category = sanitizeText(body.category || "General");
  const difficulty = sanitizeText(body.difficulty || "medium").toLowerCase();
  const stem = sanitizeText(body.stem);
  const explanation = sanitizeText(body.explanation || "");
  const topicTag = sanitizeText(body.topic_tag || body.topicTag || "") || null;
  const image = body.image ? sanitizeText(body.image) : null;
  const distractors = Array.isArray(body.distractors) ? body.distractors : [];

  const normalized = distractors
    .map((d) => ({
      option_key: sanitizeText(d.id || d.option_key || "").toLowerCase(),
      option_text: sanitizeText(d.text || d.option_text || ""),
      is_correct: !!d.correct || !!d.is_correct
    }))
    .filter((d) => d.option_key && d.option_text);

  return { id, category, difficulty, topic_tag: topicTag, stem, explanation, image, distractors: normalized };
}

function parseAllocations(value) {
  const arr = parseJsonArrayOrEmpty(value);
  return arr
    .map((x) => {
      const bankName = sanitizeText(x.bank_name || x.bankName || x.name || "");
      const bankCodeRaw = sanitizeText(x.bank_code || x.bankCode || "");
      const bankCode = normalizeBankCode(bankCodeRaw || bankCodeFromName(bankName));
      return {
        bankName,
        bankCode,
        count: Number(x.count)
      };
    })
    .filter((x) => x.bankCode || x.bankName);
}

function sanitizeAssessmentRow(row) {
  if (!row) return null;
  return {
    code: row.code,
    test_name: row.title,
    total_questions: row.total_questions,
    draw_count: row.draw_count,
    duration_minutes: row.duration_minutes,
    window_start: row.window_start,
    window_end: row.window_end,
    status: row.status,
    results_released: row.results_released,
    bank_allocations: parseJsonArrayOrEmpty(row.dataset_allocations).map((x) => ({
      bank_code: x.bankCode || x.bank_code,
      count: x.count
    })),
    allow_retakes: row.allow_retakes,
    fullscreen_enforcement: row.fullscreen_enforcement,
    show_post_review: row.show_post_review,
    tab_warn_threshold: row.tab_warn_threshold,
    tab_autosubmit_threshold: row.tab_autosubmit_threshold,
    assessment_date: row.assessment_date,
    is_active: row.status === "active",
    updated_at: row.updated_at,
    created_at: row.created_at
  };
}

async function ensureBank(clientOrQuery, bankCode, name = "Question Bank", description = "") {
  const run = clientOrQuery.query ? clientOrQuery.query.bind(clientOrQuery) : query;
  await run(
    `INSERT INTO question_banks (code, name, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (code)
     DO UPDATE SET name = EXCLUDED.name,
                   description = EXCLUDED.description,
                   updated_at = NOW()`,
    [bankCode, sanitizeText(name), sanitizeText(description)]
  );
}

async function resolveBankForAllocation(client, allocation) {
  const byCode = allocation.bankCode
    ? await client.query("SELECT code, name FROM question_banks WHERE code = $1", [allocation.bankCode])
    : { rows: [] };

  if (byCode.rows[0]) return byCode.rows[0];

  if (allocation.bankName) {
    const byName = await client.query(
      "SELECT code, name FROM question_banks WHERE LOWER(name) = LOWER($1) LIMIT 1",
      [allocation.bankName]
    );
    if (byName.rows[0]) return byName.rows[0];
  }

  return null;
}

async function validateAllocations(client, allocations, totalQuestions) {
  if (!Number.isInteger(totalQuestions) || totalQuestions <= 0) {
    return { ok: false, error: "total_questions_must_be_positive_integer" };
  }

  if (!allocations.length) {
    return { ok: false, error: "bank_allocations_required" };
  }

  const normalized = [];
  let sum = 0;
  for (const item of allocations) {
    if (!Number.isInteger(item.count) || item.count <= 0) {
      return { ok: false, error: "allocation_counts_must_be_positive_integers" };
    }

    const bank = await resolveBankForAllocation(client, item);
    if (!bank) {
      return {
        ok: false,
        error: "bank_not_found",
        detail: `Bank not found: ${item.bankName || item.bankCode}`
      };
    }

    const countRes = await client.query(
      "SELECT COUNT(*)::int AS count FROM bank_questions WHERE bank_code = $1",
      [bank.code]
    );
    const available = countRes.rows[0]?.count || 0;
    if (available < item.count) {
      return {
        ok: false,
        error: "insufficient_bank_questions",
        detail: `${bank.code} is short by ${item.count - available} questions.`
      };
    }

    normalized.push({ bankCode: bank.code, count: item.count });
    sum += item.count;
  }

  if (sum !== totalQuestions) {
    return {
      ok: false,
      error: "allocation_total_mismatch",
      detail: `Allocation total ${sum} does not match total_questions ${totalQuestions}.`
    };
  }

  return { ok: true, allocations: normalized };
}

async function upsertQuestionsToBank(client, bankCode, questions, mode) {
  const seenIds = new Set();
  const deduped = [];
  const duplicateInFile = [];

  for (const q of questions) {
    if (seenIds.has(q.id)) {
      duplicateInFile.push(q.id);
      continue;
    }
    seenIds.add(q.id);
    deduped.push(q);
  }

  if (mode === "replace") {
    await client.query("DELETE FROM bank_question_options WHERE bank_code = $1", [bankCode]);
    await client.query("DELETE FROM bank_questions WHERE bank_code = $1", [bankCode]);
  }

  const existingRes = await client.query("SELECT id FROM bank_questions WHERE bank_code = $1", [bankCode]);
  const existing = new Set(existingRes.rows.map((r) => r.id));

  let added = 0;
  let skippedDuplicates = duplicateInFile.length;

  for (const q of deduped) {
    if (mode !== "replace" && existing.has(q.id)) {
      skippedDuplicates += 1;
      continue;
    }

    await client.query(
      `INSERT INTO bank_questions (bank_code, id, category, difficulty, topic_tag, stem, explanation, image)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (bank_code, id)
       DO UPDATE SET category = EXCLUDED.category,
                     difficulty = EXCLUDED.difficulty,
                     topic_tag = EXCLUDED.topic_tag,
                     stem = EXCLUDED.stem,
                     explanation = EXCLUDED.explanation,
                     image = EXCLUDED.image,
                     updated_at = NOW()`,
      [bankCode, q.id, q.category, q.difficulty, q.topic_tag || null, q.stem, q.explanation, q.image || null]
    );

    await client.query(
      "DELETE FROM bank_question_options WHERE bank_code = $1 AND question_id = $2",
      [bankCode, q.id]
    );

    for (const option of q.distractors) {
      await client.query(
        `INSERT INTO bank_question_options (bank_code, question_id, option_key, option_text, is_correct)
         VALUES ($1,$2,$3,$4,$5)`,
        [bankCode, q.id, option.id || option.option_key, option.text || option.option_text, !!(option.correct || option.is_correct)]
      );
    }

    added += 1;
  }

  return { added, skippedDuplicates, duplicateInFile };
}

function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  rows.forEach((row) => {
    lines.push(columns.map((col) => csvEscape(row[col])).join(","));
  });
  return lines.join("\n");
}

function flattenSubmissionRows(submissions) {
  const rows = [];
  submissions.forEach((sub) => {
    const details = parseJsonArrayOrEmpty(sub.result_payload?.details || []);
    details.forEach((d) => {
      rows.push({
        client_username: sub.student_id,
        client_name: sub.student_name,
        total_score: sub.score,
        score_percent: sub.percentage,
        question_id: d.questionId || "",
        bank_name: d.bankName || "",
        client_answer: d.selectedOriginalId || "",
        correct_answer: d.correctOriginalId || "",
        is_correct: d.isCorrect ? "true" : "false",
        difficulty: d.difficulty || "",
        topic_tag: d.topicTag || ""
      });
    });
  });
  return rows;
}

function computeQuestionAnalytics(flatRows, filters) {
  const grouped = new Map();

  flatRows.forEach((r) => {
    if (filters.bank && r.bank_name !== filters.bank) return;
    if (filters.topicTag && r.topic_tag !== filters.topicTag) return;
    if (filters.difficulty && r.difficulty !== filters.difficulty) return;

    const key = `${r.bank_name}|${r.question_id}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        bank_name: r.bank_name,
        question_id: r.question_id,
        difficulty: r.difficulty,
        topic_tag: r.topic_tag,
        total_served: 0,
        total_correct: 0,
        choice_distribution: {}
      });
    }

    const item = grouped.get(key);
    item.total_served += 1;
    if (r.is_correct === "true") item.total_correct += 1;
    const answer = r.client_answer || "unanswered";
    item.choice_distribution[answer] = (item.choice_distribution[answer] || 0) + 1;
  });

  return Array.from(grouped.values()).map((x) => ({
    ...x,
    percent_correct: x.total_served ? Number(((x.total_correct * 100) / x.total_served).toFixed(2)) : 0
  }));
}

export default async function adminRoutes(fastify) {
  fastify.post("/admin/login", async (request, reply) => {
    const password = sanitizeText(request.body?.password || "");
    const ok = config.adminPasswordHash
      ? verifySecret(password, config.adminPasswordHash)
      : password === config.adminPassword;

    if (!ok) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const token = await reply.jwtSign({ role: "admin" }, { expiresIn: "8h" });
    return { token };
  });

  fastify.get("/admin/banks", { preHandler: fastify.adminAuth }, async () => {
    const out = await query(
      `SELECT b.code, b.name, b.description, b.created_at, b.updated_at,
              COALESCE(COUNT(q.id), 0)::int AS question_count
       FROM question_banks b
       LEFT JOIN bank_questions q ON q.bank_code = b.code
       GROUP BY b.code
       ORDER BY b.code`
    );
    return out.rows;
  });

  fastify.post("/admin/banks", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const body = request.body || {};
    const name = sanitizeText(body.name || "");
    const explicitCode = normalizeBankCode(body.code || "");
    const code = explicitCode || bankCodeFromName(name);
    if (!code) {
      return reply.code(400).send({ error: "bank_name_or_code_required" });
    }

    await ensureBank(query, code, name || code, sanitizeText(body.description || ""));
    return { ok: true, code };
  });

  fastify.delete("/admin/banks/:code", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const code = normalizeBankCode(request.params.code || "");
    const confirm = String(request.query?.confirm || "") === "yes";
    if (!confirm) {
      return reply.code(400).send({ error: "confirmation_required", message: "Use ?confirm=yes to delete bank." });
    }
    if (!code) return reply.code(400).send({ error: "invalid_bank_code" });

    const inUse = await query(
      `SELECT COUNT(*)::int AS count
       FROM assessments
       WHERE bank_code = $1
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(dataset_allocations) AS x
            WHERE COALESCE(x->>'bankCode', x->>'bank_code') = $1
          )`,
      [code]
    );
    if ((inUse.rows[0]?.count || 0) > 0) {
      return reply.code(409).send({ error: "bank_in_use", message: "Bank is referenced by one or more test configurations." });
    }

    await query("DELETE FROM question_banks WHERE code = $1", [code]);
    return { ok: true, code };
  });

  fastify.post("/admin/banks/upload", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "file_required" });

    const fields = file.fields || {};
    const bankName = sanitizeText(fields.bankName?.value || fields.bank_name?.value || "");
    const bankCodeInput = sanitizeText(fields.bankCode?.value || fields.bank_code?.value || "");
    const modeRaw = sanitizeText(fields.mode?.value || "append").toLowerCase();
    const mode = modeRaw === "replace" ? "replace" : "append";

    const bankCode = normalizeBankCode(bankCodeInput || bankCodeFromName(bankName));
    if (!bankCode) {
      return reply.code(400).send({ error: "bank_name_required" });
    }

    const buffer = await file.toBuffer();
    const parsed = parseQuestionUpload(file.filename, buffer);
    if (parsed.errors.length) {
      return reply.code(400).send({
        error: "invalid_upload",
        message: "Upload failed schema validation.",
        errors: parsed.errors.slice(0, 25)
      });
    }

    if (!parsed.questions.length) {
      return reply.code(400).send({ error: "no_questions_found" });
    }

    const summary = await withTx(async (client) => {
      await ensureBank(client, bankCode, bankName || bankCode, "Question bank upload");
      return upsertQuestionsToBank(client, bankCode, parsed.questions, mode);
    });

    return {
      ok: true,
      bankCode,
      bankName: bankName || bankCode,
      mode,
      questionsInFile: parsed.questions.length,
      questionsAdded: summary.added,
      duplicatesSkipped: summary.skippedDuplicates,
      errors: []
    };
  });

  fastify.get("/admin/test-configs", { preHandler: fastify.adminAuth }, async () => {
    const out = await query(
      `SELECT *
       FROM assessments
       ORDER BY COALESCE(window_start, created_at) DESC`
    );
    return out.rows.map(sanitizeAssessmentRow);
  });

  fastify.post("/admin/test-configs", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const body = request.body || {};
    const code = sanitizeText(body.code || body.test_code || "").toUpperCase();
    const testName = sanitizeText(body.test_name || body.title || code);
    const totalQuestions = Number(body.total_questions);
    const allocations = parseAllocations(body.bank_allocations || body.dataset_allocations || []);
    const durationMinutes = Number(body.duration_minutes);
    const windowStart = body.window_start ? new Date(body.window_start) : null;
    const windowEnd = body.window_end ? new Date(body.window_end) : null;
    const status = sanitizeText(body.status || "draft").toLowerCase();
    const resultsReleased = !!body.results_released;
    const passcode = sanitizeText(body.passcode || "");

    if (!code) return reply.code(400).send({ error: "test_code_required" });
    if (!["draft", "active", "closed"].includes(status)) {
      return reply.code(400).send({ error: "invalid_status" });
    }
    if (!windowStart || Number.isNaN(windowStart.getTime()) || !windowEnd || Number.isNaN(windowEnd.getTime())) {
      return reply.code(400).send({ error: "window_start_and_window_end_required" });
    }
    if (windowEnd <= windowStart) {
      return reply.code(400).send({ error: "window_end_must_be_after_start" });
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      return reply.code(400).send({ error: "duration_minutes_must_be_positive_integer" });
    }

    const windowLengthMinutes = Math.floor((windowEnd.getTime() - windowStart.getTime()) / 60000);
    if (durationMinutes > windowLengthMinutes) {
      return reply.code(400).send({
        error: "duration_exceeds_window",
        detail: `duration_minutes (${durationMinutes}) must be <= window length (${windowLengthMinutes}).`
      });
    }

    const save = await withTx(async (client) => {
      const valid = await validateAllocations(client, allocations, totalQuestions);
      if (!valid.ok) return valid;

      if (status === "active") {
        await client.query("UPDATE assessments SET status = 'closed', is_active = false WHERE status = 'active'");
      }

      const passcodeHash = passcode ? hashSecret(passcode) : null;

      const out = await client.query(
        `INSERT INTO assessments (
           code, title, passcode, passcode_hash,
           duration_seconds, duration_minutes,
           draw_count, total_questions,
           questions_per_category,
           show_post_review, fullscreen_enforcement,
           tab_warn_threshold, tab_autosubmit_threshold,
           allow_retakes, integrity_notice,
           bank_code, dataset_allocations,
           assessment_date,
           window_start, window_end,
           status, is_active, results_released
         ) VALUES (
           $1,$2,'',$3,
           $4,$5,
           $6,$7,
           '{}'::jsonb,
           $8,$9,
           $10,$11,
           $12,$13,
           $14,$15,
           $16,
           $17,$18,
           $19,$20,$21
         )
         ON CONFLICT (code)
         DO UPDATE SET title = EXCLUDED.title,
                       passcode = CASE WHEN EXCLUDED.passcode_hash IS NOT NULL THEN '' ELSE assessments.passcode END,
                       passcode_hash = COALESCE(EXCLUDED.passcode_hash, assessments.passcode_hash),
                       duration_seconds = EXCLUDED.duration_seconds,
                       duration_minutes = EXCLUDED.duration_minutes,
                       draw_count = EXCLUDED.draw_count,
                       total_questions = EXCLUDED.total_questions,
                       show_post_review = EXCLUDED.show_post_review,
                       fullscreen_enforcement = EXCLUDED.fullscreen_enforcement,
                       tab_warn_threshold = EXCLUDED.tab_warn_threshold,
                       tab_autosubmit_threshold = EXCLUDED.tab_autosubmit_threshold,
                       allow_retakes = EXCLUDED.allow_retakes,
                       integrity_notice = EXCLUDED.integrity_notice,
                       bank_code = EXCLUDED.bank_code,
                       dataset_allocations = EXCLUDED.dataset_allocations,
                       assessment_date = EXCLUDED.assessment_date,
                       window_start = EXCLUDED.window_start,
                       window_end = EXCLUDED.window_end,
                       status = EXCLUDED.status,
                       is_active = EXCLUDED.is_active,
                       results_released = EXCLUDED.results_released,
                       updated_at = NOW()
         RETURNING *`,
        [
          code,
          testName,
          passcodeHash,
          durationMinutes * 60,
          durationMinutes,
          totalQuestions,
          totalQuestions,
          body.show_post_review ?? true,
          body.fullscreen_enforcement ?? true,
          Math.max(1, Number(body.tab_warn_threshold || 3)),
          Math.max(2, Number(body.tab_autosubmit_threshold || 5)),
          Math.max(0, Number(body.allow_retakes || 0)),
          sanitizeText(body.integrity_notice || "") || "ASSESSMENT INTEGRITY NOTICE",
          valid.allocations[0]?.bankCode || "default",
          JSON.stringify(valid.allocations),
          body.assessment_date || null,
          windowStart.toISOString(),
          windowEnd.toISOString(),
          status,
          status === "active",
          resultsReleased
        ]
      );

      return { ok: true, row: out.rows[0] };
    });

    if (!save.ok) {
      return reply.code(400).send({ error: save.error, detail: save.detail || null });
    }

    return sanitizeAssessmentRow(save.row);
  });

  fastify.patch("/admin/test-configs/:code", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const code = sanitizeText(request.params.code || "").toUpperCase();
    const body = request.body || {};

    if (!code) return reply.code(400).send({ error: "test_code_required" });

    const currentRes = await query("SELECT * FROM assessments WHERE code = $1", [code]);
    const current = currentRes.rows[0];
    if (!current) return reply.code(404).send({ error: "test_not_found" });

    const status = body.status ? sanitizeText(body.status).toLowerCase() : current.status;
    if (!["draft", "active", "closed"].includes(status)) {
      return reply.code(400).send({ error: "invalid_status" });
    }

    if (status === "active") {
      await query("UPDATE assessments SET status = 'closed', is_active = false WHERE status = 'active' AND code <> $1", [code]);
    }

    const out = await query(
      `UPDATE assessments
       SET status = $2,
           is_active = $3,
           results_released = $4,
           updated_at = NOW()
       WHERE code = $1
       RETURNING *`,
      [code, status, status === "active", body.results_released ?? current.results_released]
    );

    return sanitizeAssessmentRow(out.rows[0]);
  });

  fastify.get("/admin/questions", { preHandler: fastify.adminAuth }, async (request) => {
    const bankCode = normalizeBankCode(request.query?.bankCode || request.query?.bank_code || "default");
    const out = await query(
      `SELECT q.id, q.category, q.difficulty, q.topic_tag, q.stem, q.explanation, q.image,
              COALESCE(json_agg(json_build_object(
                'id', o.option_key,
                'text', o.option_text,
                'correct', o.is_correct
              ) ORDER BY o.option_key) FILTER (WHERE o.option_key IS NOT NULL), '[]'::json) AS distractors
       FROM bank_questions q
       LEFT JOIN bank_question_options o
         ON o.bank_code = q.bank_code
        AND o.question_id = q.id
       WHERE q.bank_code = $1
       GROUP BY q.id, q.category, q.difficulty, q.topic_tag, q.stem, q.explanation, q.image
       ORDER BY q.id`,
      [bankCode]
    );
    return out.rows;
  });

  fastify.post("/admin/questions", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const bankCode = normalizeBankCode(request.body?.bankCode || request.body?.bank_code || "default");
    const q = normalizeQuestionPayload(request.body || {});
    if (!q.id || !q.category || !q.stem || q.distractors.length !== 4) {
      return reply.code(400).send({ error: "invalid_question_payload" });
    }

    await withTx(async (client) => {
      await ensureBank(client, bankCode, bankCode, "Question bank");
      await client.query(
        `INSERT INTO bank_questions (bank_code, id, category, difficulty, topic_tag, stem, explanation, image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (bank_code, id)
         DO UPDATE SET category = EXCLUDED.category,
                       difficulty = EXCLUDED.difficulty,
                       topic_tag = EXCLUDED.topic_tag,
                       stem = EXCLUDED.stem,
                       explanation = EXCLUDED.explanation,
                       image = EXCLUDED.image,
                       updated_at = NOW()`,
        [bankCode, q.id, q.category, q.difficulty, q.topic_tag || null, q.stem, q.explanation, q.image]
      );

      await client.query("DELETE FROM bank_question_options WHERE bank_code = $1 AND question_id = $2", [bankCode, q.id]);
      for (const option of q.distractors) {
        await client.query(
          `INSERT INTO bank_question_options (bank_code, question_id, option_key, option_text, is_correct)
           VALUES ($1,$2,$3,$4,$5)`,
          [bankCode, q.id, option.option_key, option.option_text, option.is_correct]
        );
      }
    });

    return { ok: true, id: q.id, bankCode };
  });

  fastify.delete("/admin/questions/:id", { preHandler: fastify.adminAuth }, async (request) => {
    const bankCode = normalizeBankCode(request.query?.bankCode || request.query?.bank_code || "default");
    const id = sanitizeText(request.params.id);
    await query("DELETE FROM bank_questions WHERE bank_code = $1 AND id = $2", [bankCode, id]);
    return { ok: true, bankCode };
  });

  fastify.get("/admin/results", { preHandler: fastify.adminAuth }, async (request) => {
    const q = request.query || {};
    const minScore = Number.isFinite(Number(q.minScore)) ? Number(q.minScore) : 0;
    const maxScore = Number.isFinite(Number(q.maxScore)) ? Number(q.maxScore) : 100;
    const withViolations = q.withViolations === "true" ? true : q.withViolations === "false" ? false : null;

    const out = await query(
      `SELECT *
       FROM submissions
       WHERE percentage BETWEEN $1 AND $2
         AND ($3::boolean IS NULL OR (violation_count > 0) = $3)
       ORDER BY submitted_at DESC
       LIMIT 500`,
      [minScore, maxScore, withViolations]
    );

    return out.rows;
  });

  fastify.get("/admin/results/:token", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const out = await query(
      "SELECT result_payload FROM submissions WHERE session_token = $1",
      [sanitizeText(request.params.token)]
    );
    if (!out.rows[0]) {
      return reply.code(404).send({ error: "result_not_found" });
    }
    return out.rows[0].result_payload;
  });

  fastify.get("/admin/analytics/questions", { preHandler: fastify.adminAuth }, async (request) => {
    const filters = {
      bank: sanitizeText(request.query?.bank || ""),
      topicTag: sanitizeText(request.query?.topic_tag || ""),
      difficulty: sanitizeText(request.query?.difficulty || "").toLowerCase()
    };

    const out = await query(
      `SELECT student_id, student_name, score, percentage, result_payload
       FROM submissions
       ORDER BY submitted_at DESC
       LIMIT 5000`
    );
    const flat = flattenSubmissionRows(out.rows);
    return computeQuestionAnalytics(flat, filters);
  });

  fastify.get("/admin/results/export.csv", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const assessmentCode = sanitizeText(request.query?.assessment_code || "").toUpperCase();
    const out = assessmentCode
      ? await query(
        `SELECT s.*
         FROM submissions s
         JOIN assessments a ON a.id = s.assessment_id
         WHERE a.code = $1
         ORDER BY s.submitted_at DESC`,
        [assessmentCode]
      )
      : await query("SELECT * FROM submissions ORDER BY submitted_at DESC LIMIT 5000");

    const rows = flattenSubmissionRows(out.rows);
    const csv = toCsv(rows, [
      "client_username",
      "client_name",
      "total_score",
      "score_percent",
      "question_id",
      "bank_name",
      "client_answer",
      "correct_answer",
      "is_correct",
      "difficulty",
      "topic_tag"
    ]);

    reply.header("Content-Type", "text/csv");
    return csv;
  });

  fastify.get("/admin/results/export.xlsx", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const assessmentCode = sanitizeText(request.query?.assessment_code || "").toUpperCase();
    const out = assessmentCode
      ? await query(
        `SELECT s.*
         FROM submissions s
         JOIN assessments a ON a.id = s.assessment_id
         WHERE a.code = $1
         ORDER BY s.submitted_at DESC`,
        [assessmentCode]
      )
      : await query("SELECT * FROM submissions ORDER BY submitted_at DESC LIMIT 5000");

    const rows = flattenSubmissionRows(out.rows);
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Results");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", "attachment; filename=results.xlsx");
    return buf;
  });

  // Backward-compatible aliases.
  fastify.get("/admin/tests", { preHandler: fastify.adminAuth }, async () => {
    const out = await query("SELECT * FROM assessments ORDER BY COALESCE(window_start, created_at) DESC");
    return out.rows.map(sanitizeAssessmentRow);
  });

  fastify.post("/admin/tests", { preHandler: fastify.adminAuth }, async (request, reply) => {
    return fastify.inject({
      method: "POST",
      url: "/api/admin/test-configs",
      headers: { authorization: request.headers.authorization || "" },
      payload: request.body
    }).then((res) => {
      reply.code(res.statusCode);
      return JSON.parse(res.body || "{}");
    });
  });

  fastify.post("/admin/tests/:code/activate", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const code = sanitizeText(request.params.code || "").toUpperCase();
    const out = await fastify.inject({
      method: "PATCH",
      url: `/api/admin/test-configs/${code}`,
      headers: { authorization: request.headers.authorization || "" },
      payload: { status: "active" }
    });
    reply.code(out.statusCode);
    return JSON.parse(out.body || "{}");
  });

  fastify.get("/admin/config", { preHandler: fastify.adminAuth }, async () => {
    const out = await query(
      "SELECT * FROM assessments WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1"
    );
    return sanitizeAssessmentRow(out.rows[0]) || null;
  });

  fastify.put("/admin/config", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const active = await query("SELECT code FROM assessments WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1");
    const code = active.rows[0]?.code;
    if (!code) {
      return reply.code(404).send({ error: "active_assessment_not_found" });
    }
    const out = await fastify.inject({
      method: "PATCH",
      url: `/api/admin/test-configs/${code}`,
      headers: { authorization: request.headers.authorization || "" },
      payload: request.body
    });
    reply.code(out.statusCode);
    return JSON.parse(out.body || "{}");
  });

  fastify.get("/admin/results.csv", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const out = await fastify.inject({
      method: "GET",
      url: "/api/admin/results/export.csv",
      headers: { authorization: request.headers.authorization || "" }
    });
    reply.header("Content-Type", "text/csv");
    reply.code(out.statusCode);
    return out.body;
  });
}
