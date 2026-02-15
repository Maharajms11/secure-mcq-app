import { query, withTx } from "../db.js";
import { config } from "../config.js";
import { parseAikenText } from "../aiken.js";
import { enforceRateLimit } from "../rate-limit.js";
import {
  csvEscape,
  hashSecret,
  parseJsonObjectOrEmpty,
  sanitizeText,
  verifySecret
} from "../utils.js";

function normalizeBankCode(value) {
  const cleaned = sanitizeText(value || "").toLowerCase();
  return cleaned.replace(/[^a-z0-9_-]/g, "");
}

function normalizeTestCode(value, fallbackName) {
  const raw = sanitizeText(value || fallbackName || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return raw || `test-${Date.now()}`;
}

function normalizeTestStatus(value) {
  const status = sanitizeText(value || "draft").toLowerCase();
  return ["draft", "active", "closed"].includes(status) ? status : "draft";
}

function normalizeQuestionPayload(body) {
  const id = sanitizeText(body.id || body.question_id);
  const category = sanitizeText(body.category || body.topic_tag || "General");
  const topicTag = sanitizeText(body.topic_tag || "");
  const difficulty = sanitizeText(body.difficulty || "medium").toLowerCase();
  const stem = sanitizeText(body.stem || body.question_text);
  const explanation = sanitizeText(body.explanation || "");
  const image = body.image ? sanitizeText(body.image) : null;
  const distractors = Array.isArray(body.distractors) ? body.distractors : [];

  const normalized = distractors
    .map((d) => ({
      option_key: sanitizeText(d.id || d.option_key).toLowerCase(),
      option_text: sanitizeText(d.text || d.option_text),
      is_correct: !!d.correct || !!d.is_correct
    }))
    .filter((d) => d.option_key && d.option_text);

  return { id, category, topicTag, difficulty, stem, explanation, image, distractors: normalized };
}

function normalizeAllocations(rawAllocations) {
  const list = Array.isArray(rawAllocations) ? rawAllocations : [];
  return list
    .map((entry) => ({
      bankCode: normalizeBankCode(entry.bankCode || entry.bank_name || entry.bank || ""),
      count: Number(entry.count || 0)
    }))
    .filter((entry) => entry.bankCode && Number.isInteger(entry.count) && entry.count > 0);
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

async function validateAllocationsOrThrow(totalQuestions, allocations) {
  if (!Number.isInteger(totalQuestions) || totalQuestions < 1) {
    return { error: "total_questions_must_be_positive_integer" };
  }
  if (!allocations.length) {
    return { error: "bank_allocations_required" };
  }

  const sum = allocations.reduce((acc, a) => acc + a.count, 0);
  if (sum !== totalQuestions) {
    return { error: "allocation_sum_mismatch", expected: totalQuestions, actual: sum };
  }

  const bankCodes = allocations.map((a) => a.bankCode);
  const countsRes = await query(
    `SELECT bank_code AS code, COUNT(*)::int AS count
     FROM bank_questions
     WHERE bank_code = ANY($1)
     GROUP BY bank_code`,
    [bankCodes]
  );
  const countsByBank = new Map(countsRes.rows.map((r) => [r.code, Number(r.count)]));

  for (const allocation of allocations) {
    const available = countsByBank.get(allocation.bankCode) || 0;
    if (available < allocation.count) {
      return {
        error: "insufficient_questions_in_bank",
        bankCode: allocation.bankCode,
        requested: allocation.count,
        available,
        deficit: allocation.count - available
      };
    }
  }

  return null;
}

function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function parseCsvList(value) {
  return String(value || "")
    .split(",")
    .map((v) => sanitizeText(v))
    .filter(Boolean);
}

function buildSubmissionExportSql(filter) {
  const params = [];
  const clauses = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter.bankCode) clauses.push(`COALESCE(d.detail->>'bankCode','') = ${push(filter.bankCode)}`);
  if (filter.topicTag) clauses.push(`COALESCE(d.detail->>'topicTag','') = ${push(filter.topicTag)}`);
  if (filter.difficulty) clauses.push(`COALESCE(d.detail->>'difficulty','') = ${push(filter.difficulty)}`);
  if (filter.testCodes?.length) clauses.push(`a.code = ANY(${push(filter.testCodes)}::text[])`);
  if (filter.studentIds?.length) clauses.push(`s.student_id = ANY(${push(filter.studentIds)}::text[])`);

  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    SELECT
      s.session_token,
      s.student_id AS client_username,
      s.student_name AS client_name,
      s.score AS total_score,
      s.percentage AS score_percent,
      d.detail->>'questionId' AS question_id,
      COALESCE(d.detail->>'bankCode','') AS bank_name,
      COALESCE(d.detail->>'selectedOriginalId','') AS client_answer,
      COALESCE(d.detail->>'correctOriginalId','') AS correct_answer,
      COALESCE((d.detail->>'isCorrect')::boolean, false) AS is_correct,
      COALESCE(d.detail->>'difficulty','') AS difficulty,
      COALESCE(d.detail->>'topicTag','') AS topic_tag
    FROM submissions s
    JOIN assessments a ON a.id = s.assessment_id
    CROSS JOIN LATERAL jsonb_array_elements(s.result_payload->'details') AS d(detail)
    ${whereSql}
    ORDER BY s.submitted_at DESC
  `;

  return { sql, params };
}

export default async function adminRoutes(fastify) {
  fastify.post("/admin/login", async (request, reply) => {
    const limiter = await enforceRateLimit("admin_login", String(request.ip || "unknown"), 12, 300);
    if (!limiter.allowed) {
      return reply.code(429).send({ error: "too_many_login_attempts" });
    }

    const password = sanitizeText(request.body?.password || "");
    const valid = config.adminPasswordHash
      ? verifySecret(password, config.adminPasswordHash)
      : password === config.adminPassword;

    if (!valid) {
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
       GROUP BY b.code, b.name, b.description, b.created_at, b.updated_at
       ORDER BY b.code`
    );
    return out.rows;
  });

  fastify.post("/admin/banks", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const code = normalizeBankCode(request.body?.code || request.body?.bankCode || "");
    const name = sanitizeText(request.body?.name || code);
    const description = sanitizeText(request.body?.description || "");
    if (!code) {
      return reply.code(400).send({ error: "bank_code_required" });
    }
    await ensureBank(query, code, name, description);
    return { ok: true, code };
  });

  fastify.delete("/admin/banks/:code", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const bankCode = normalizeBankCode(request.params.code || "");
    if (!bankCode) return reply.code(400).send({ error: "bank_code_required" });
    if (bankCode === "default") return reply.code(400).send({ error: "default_bank_cannot_be_deleted" });

    const refs = await query(
      `SELECT COUNT(*)::int AS count
       FROM assessments a
       WHERE a.bank_code = $1
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(a.bank_allocations) alloc
            WHERE alloc->>'bankCode' = $1
          )`,
      [bankCode]
    );
    if ((refs.rows[0]?.count || 0) > 0) {
      return reply.code(409).send({ error: "bank_in_use_by_test_configs" });
    }

    await query("DELETE FROM question_banks WHERE code = $1", [bankCode]);
    return { ok: true, code: bankCode };
  });

  fastify.post("/admin/banks/:code/clear", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const bankCode = normalizeBankCode(request.params.code || "");
    if (!bankCode) return reply.code(400).send({ error: "bank_code_required" });
    if (bankCode === "default") return reply.code(400).send({ error: "default_bank_cannot_be_cleared" });

    const refs = await query(
      `SELECT COUNT(*)::int AS count
       FROM assessments a
       WHERE a.bank_code = $1
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(a.bank_allocations) alloc
            WHERE alloc->>'bankCode' = $1
          )`,
      [bankCode]
    );
    if ((refs.rows[0]?.count || 0) > 0) {
      return reply.code(409).send({ error: "bank_in_use_by_test_configs" });
    }

    const cleared = await withTx(async (client) => {
      const options = await client.query("DELETE FROM bank_question_options WHERE bank_code = $1", [bankCode]);
      const questions = await client.query("DELETE FROM bank_questions WHERE bank_code = $1", [bankCode]);
      return { optionsDeleted: options.rowCount || 0, questionsDeleted: questions.rowCount || 0 };
    });

    return { ok: true, code: bankCode, ...cleared };
  });

  fastify.post("/admin/banks/upload", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const bankCode = normalizeBankCode(request.body?.bankCode || request.body?.bank_name || "");
    const bankName = sanitizeText(request.body?.bankName || request.body?.bank_name || bankCode);
    const mode = sanitizeText(request.body?.mode || "append").toLowerCase() === "replace" ? "replace" : "append";
    const fileText = String(request.body?.fileText || "");

    if (!bankCode) return reply.code(400).send({ error: "bank_code_required" });
    if (!fileText.trim()) return reply.code(400).send({ error: "file_content_required" });

    let parsedQuestions;
    try {
      parsedQuestions = parseAikenText(fileText);
    } catch (err) {
      return reply.code(400).send({ error: "invalid_aiken_file", message: err.message });
    }

    const seenIds = new Set();
    const deduped = [];
    let fileDuplicateCount = 0;
    for (const q of parsedQuestions) {
      if (seenIds.has(q.id)) {
        fileDuplicateCount += 1;
        continue;
      }
      seenIds.add(q.id);
      deduped.push(q);
    }

    const summary = await withTx(async (client) => {
      await ensureBank(client, bankCode, bankName || bankCode, "Uploaded Aiken bank");
      if (mode === "replace") {
        await client.query("DELETE FROM bank_question_options WHERE bank_code = $1", [bankCode]);
        await client.query("DELETE FROM bank_questions WHERE bank_code = $1", [bankCode]);
      }

      const existingRows = await client.query(
        "SELECT id FROM bank_questions WHERE bank_code = $1",
        [bankCode]
      );
      const existingIds = new Set(existingRows.rows.map((r) => r.id));

      let added = 0;
      let skipped = 0;
      for (const q of deduped) {
        if (existingIds.has(q.id)) {
          skipped += 1;
          continue;
        }

        await client.query(
          `INSERT INTO bank_questions (bank_code, id, category, difficulty, stem, explanation, image, topic_tag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [bankCode, q.id, q.category, q.difficulty, q.stem, q.explanation, q.image, q.topic_tag || ""]
        );
        for (const d of q.distractors) {
          await client.query(
            `INSERT INTO bank_question_options (bank_code, question_id, option_key, option_text, is_correct)
             VALUES ($1,$2,$3,$4,$5)`,
            [bankCode, q.id, d.id, d.text, !!d.correct]
          );
        }
        added += 1;
      }

      return {
        mode,
        bankCode,
        totalParsed: parsedQuestions.length,
        added,
        duplicatesSkipped: skipped + fileDuplicateCount,
        errors: []
      };
    });

    return { ok: true, summary };
  });

  fastify.get("/admin/tests", { preHandler: fastify.adminAuth }, async () => {
    const out = await query(
      `SELECT id, code, title AS test_name, draw_count AS total_questions, duration_minutes,
              window_start, window_end, status, results_released, bank_allocations,
              show_post_review, fullscreen_enforcement, tab_warn_threshold, tab_autosubmit_threshold,
              allow_retakes, integrity_notice, created_at, updated_at
       FROM assessments
       ORDER BY created_at DESC`
    );
    return out.rows;
  });

  fastify.post("/admin/tests", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const body = request.body || {};
    const testName = sanitizeText(body.test_name || body.testName || "");
    const code = normalizeTestCode(body.code, testName);
    const totalQuestions = Number(body.total_questions || body.totalQuestions || 0);
    const allocations = normalizeAllocations(body.bank_allocations || body.bankAllocations);
    const durationMinutes = Math.max(1, Number(body.duration_minutes || body.durationMinutes || 60));
    const windowStart = parseDateOrNull(body.window_start || body.windowStart);
    const windowEnd = parseDateOrNull(body.window_end || body.windowEnd);
    const status = normalizeTestStatus(body.status);
    const resultsReleased = !!body.results_released || !!body.resultsReleased;
    const passcode = sanitizeText(body.passcode || "");

    if (!testName) return reply.code(400).send({ error: "test_name_required" });
    if (!windowStart || !windowEnd || windowEnd <= windowStart) {
      return reply.code(400).send({ error: "invalid_window_start_end" });
    }
    const windowMinutes = Math.floor((windowEnd.getTime() - windowStart.getTime()) / 60000);
    if (durationMinutes > windowMinutes) {
      return reply.code(400).send({ error: "duration_exceeds_window", windowMinutes });
    }

    const allocationError = await validateAllocationsOrThrow(totalQuestions, allocations);
    if (allocationError) return reply.code(400).send(allocationError);

    const out = await query(
      `INSERT INTO assessments (
         code, title, passcode, passcode_hash, duration_seconds, duration_minutes, draw_count, questions_per_category,
         show_post_review, fullscreen_enforcement, tab_warn_threshold, tab_autosubmit_threshold,
         allow_retakes, integrity_notice, is_active, bank_code, bank_allocations, window_start, window_end, status, results_released
       ) VALUES ($1,$2,'',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        code,
        testName,
        hashSecret(passcode),
        durationMinutes * 60,
        durationMinutes,
        totalQuestions,
        JSON.stringify(parseJsonObjectOrEmpty(body.questions_per_category || {})),
        body.show_post_review ?? true,
        body.fullscreen_enforcement ?? true,
        Math.max(1, Number(body.tab_warn_threshold || 3)),
        Math.max(2, Number(body.tab_autosubmit_threshold || 5)),
        Math.max(0, Number(body.allow_retakes || 0)),
        sanitizeText(body.integrity_notice || ""),
        allocations[0].bankCode,
        JSON.stringify(allocations),
        windowStart.toISOString(),
        windowEnd.toISOString(),
        status,
        resultsReleased
      ]
    );
    return out.rows[0];
  });

  fastify.put("/admin/tests/:code", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const code = normalizeTestCode(request.params.code || "");
    const body = request.body || {};
    const testName = sanitizeText(body.test_name || body.testName || "");
    const totalQuestions = Number(body.total_questions || body.totalQuestions || 0);
    const allocations = normalizeAllocations(body.bank_allocations || body.bankAllocations);
    const durationMinutes = Math.max(1, Number(body.duration_minutes || body.durationMinutes || 60));
    const windowStart = parseDateOrNull(body.window_start || body.windowStart);
    const windowEnd = parseDateOrNull(body.window_end || body.windowEnd);
    const status = normalizeTestStatus(body.status);
    const resultsReleased = !!body.results_released || !!body.resultsReleased;
    const passcode = sanitizeText(body.passcode || "");

    if (!testName) return reply.code(400).send({ error: "test_name_required" });
    if (!windowStart || !windowEnd || windowEnd <= windowStart) {
      return reply.code(400).send({ error: "invalid_window_start_end" });
    }
    const windowMinutes = Math.floor((windowEnd.getTime() - windowStart.getTime()) / 60000);
    if (durationMinutes > windowMinutes) {
      return reply.code(400).send({ error: "duration_exceeds_window", windowMinutes });
    }

    const allocationError = await validateAllocationsOrThrow(totalQuestions, allocations);
    if (allocationError) return reply.code(400).send(allocationError);

    const passcodeHash = passcode ? hashSecret(passcode) : null;
    const out = await query(
      `UPDATE assessments SET
         title = $2,
         duration_seconds = $3,
         duration_minutes = $4,
         draw_count = $5,
         bank_code = $6,
         bank_allocations = $7,
         window_start = $8,
         window_end = $9,
         status = $10,
         results_released = $11,
         passcode_hash = COALESCE($12, passcode_hash),
         show_post_review = $13,
         fullscreen_enforcement = $14,
         tab_warn_threshold = $15,
         tab_autosubmit_threshold = $16,
         allow_retakes = $17,
         updated_at = NOW()
       WHERE code = $1
       RETURNING *`,
      [
        code,
        testName,
        durationMinutes * 60,
        durationMinutes,
        totalQuestions,
        allocations[0].bankCode,
        JSON.stringify(allocations),
        windowStart.toISOString(),
        windowEnd.toISOString(),
        status,
        resultsReleased,
        passcodeHash,
        body.show_post_review ?? true,
        body.fullscreen_enforcement ?? true,
        Math.max(1, Number(body.tab_warn_threshold || 3)),
        Math.max(2, Number(body.tab_autosubmit_threshold || 5)),
        Math.max(0, Number(body.allow_retakes || 0))
      ]
    );
    if (!out.rows[0]) return reply.code(404).send({ error: "test_not_found" });
    return out.rows[0];
  });

  fastify.post("/admin/tests/:code/status", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const code = normalizeTestCode(request.params.code || "");
    const status = normalizeTestStatus(request.body?.status);
    const out = await withTx(async (client) => {
      if (status === "active") {
        await client.query("UPDATE assessments SET status = 'draft' WHERE code <> $1 AND status = 'active'", [code]);
      }
      return client.query("UPDATE assessments SET status = $2, updated_at = NOW() WHERE code = $1 RETURNING *", [code, status]);
    });
    if (!out.rows[0]) return reply.code(404).send({ error: "test_not_found" });
    return out.rows[0];
  });

  fastify.post("/admin/tests/:code/release", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const code = normalizeTestCode(request.params.code || "");
    const released = !!request.body?.results_released || !!request.body?.resultsReleased;
    const out = await query(
      "UPDATE assessments SET results_released = $2, updated_at = NOW() WHERE code = $1 RETURNING *",
      [code, released]
    );
    if (!out.rows[0]) return reply.code(404).send({ error: "test_not_found" });
    return {
      ...out.rows[0],
      notificationSummary: {
        recipients: 0,
        notified: 0,
        failed: 0,
        skipped: 0,
        skippedDetails: ["Email notifications are disabled. Results become visible at test window close."]
      }
    };
  });

  fastify.delete("/admin/tests/:code", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const code = normalizeTestCode(request.params.code || "");
    if (!code) return reply.code(400).send({ error: "test_code_required" });
    if (code === normalizeTestCode(config.defaults.code)) {
      return reply.code(400).send({ error: "default_test_cannot_be_deleted" });
    }

    const deleted = await withTx(async (client) => {
      const test = await client.query("SELECT id FROM assessments WHERE code = $1", [code]);
      if (!test.rows[0]) return { notFound: true };
      const assessmentId = test.rows[0].id;
      await client.query("DELETE FROM sessions WHERE assessment_id = $1", [assessmentId]);
      const out = await client.query("DELETE FROM assessments WHERE id = $1", [assessmentId]);
      return { notFound: out.rowCount === 0 };
    });

    if (deleted.notFound) return reply.code(404).send({ error: "test_not_found" });
    return { ok: true, code };
  });

  fastify.post("/admin/tests/:code/clear-attempts", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const code = normalizeTestCode(request.params.code || "");
    if (!code) return reply.code(400).send({ error: "test_code_required" });

    const summary = await withTx(async (client) => {
      const test = await client.query("SELECT id FROM assessments WHERE code = $1", [code]);
      if (!test.rows[0]) return { notFound: true };
      const assessmentId = test.rows[0].id;
      const sessions = await client.query("DELETE FROM sessions WHERE assessment_id = $1", [assessmentId]);
      return { notFound: false, sessionsDeleted: sessions.rowCount || 0 };
    });

    if (summary.notFound) return reply.code(404).send({ error: "test_not_found" });
    return { ok: true, code, sessionsDeleted: summary.sessionsDeleted };
  });

  fastify.post("/admin/reset-uploaded-data", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const confirm = sanitizeText(request.body?.confirm || "");
    if (confirm !== "RESET") {
      return reply.code(400).send({ error: "confirm_must_equal_RESET" });
    }

    const summary = await withTx(async (client) => {
      const submissions = await client.query("DELETE FROM submissions");
      const violations = await client.query("DELETE FROM violation_events");
      const sessions = await client.query("DELETE FROM sessions");
      const bankOptions = await client.query("DELETE FROM bank_question_options WHERE bank_code <> 'default'");
      const bankQuestions = await client.query("DELETE FROM bank_questions WHERE bank_code <> 'default'");
      const banks = await client.query("DELETE FROM question_banks WHERE code <> 'default'");
      const tests = await client.query("DELETE FROM assessments WHERE code <> $1", [config.defaults.code]);
      return {
        submissionsDeleted: submissions.rowCount || 0,
        violationsDeleted: violations.rowCount || 0,
        sessionsDeleted: sessions.rowCount || 0,
        bankOptionsDeleted: bankOptions.rowCount || 0,
        bankQuestionsDeleted: bankQuestions.rowCount || 0,
        banksDeleted: banks.rowCount || 0,
        testsDeleted: tests.rowCount || 0
      };
    });

    return { ok: true, summary };
  });

  fastify.get("/admin/questions", { preHandler: fastify.adminAuth }, async (request) => {
    const bankCode = normalizeBankCode(request.query?.bankCode || "default") || "default";
    const out = await query(
      `SELECT q.id, q.category, q.topic_tag, q.difficulty, q.stem, q.explanation, q.image,
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
       GROUP BY q.id, q.category, q.topic_tag, q.difficulty, q.stem, q.explanation, q.image
       ORDER BY q.id`,
      [bankCode]
    );
    return out.rows;
  });

  fastify.post("/admin/questions", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const bankCode = normalizeBankCode(request.body?.bankCode || "default") || "default";
    const q = normalizeQuestionPayload(request.body || {});
    if (!q.id || !q.category || !q.stem || q.distractors.length !== 4 || !["easy", "medium", "hard"].includes(q.difficulty)) {
      return reply.code(400).send({ error: "invalid_question_payload" });
    }
    if (!q.distractors.some((d) => d.is_correct)) {
      return reply.code(400).send({ error: "one_correct_answer_required" });
    }

    await withTx(async (client) => {
      await ensureBank(client, bankCode, `${bankCode} bank`, "Question bank");
      await client.query(
        `INSERT INTO bank_questions (bank_code, id, category, difficulty, stem, explanation, image, topic_tag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (bank_code, id)
         DO UPDATE SET category = EXCLUDED.category,
                       difficulty = EXCLUDED.difficulty,
                       stem = EXCLUDED.stem,
                       explanation = EXCLUDED.explanation,
                       image = EXCLUDED.image,
                       topic_tag = EXCLUDED.topic_tag,
                       updated_at = NOW()`,
        [bankCode, q.id, q.category, q.difficulty, q.stem, q.explanation, q.image, q.topicTag]
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
    const bankCode = normalizeBankCode(request.query?.bankCode || "default") || "default";
    const id = sanitizeText(request.params.id);
    await query("DELETE FROM bank_questions WHERE bank_code = $1 AND id = $2", [bankCode, id]);
    return { ok: true, bankCode };
  });

  fastify.get("/admin/results", { preHandler: fastify.adminAuth }, async (request) => {
    const q = request.query || {};
    const minScore = Number.isFinite(Number(q.minScore)) ? Number(q.minScore) : 0;
    const maxScore = Number.isFinite(Number(q.maxScore)) ? Number(q.maxScore) : 100;
    const withViolations = q.withViolations === "true" ? true : q.withViolations === "false" ? false : null;
    const testCodes = parseCsvList(q.testCodes || q.testCode);
    const studentIds = parseCsvList(q.studentIds || q.studentId);

    const out = await query(
      `SELECT s.*, a.code AS test_code, a.title AS test_name, a.results_released
       FROM submissions s
       JOIN assessments a ON a.id = s.assessment_id
       WHERE s.percentage BETWEEN $1 AND $2
         AND ($3::boolean IS NULL OR (s.violation_count > 0) = $3)
         AND (cardinality($4::text[]) = 0 OR a.code = ANY($4::text[]))
         AND (cardinality($5::text[]) = 0 OR s.student_id = ANY($5::text[]))
       ORDER BY s.submitted_at DESC
       LIMIT 500`,
      [minScore, maxScore, withViolations, testCodes, studentIds]
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
      bankCode: normalizeBankCode(request.query?.bankCode || ""),
      topicTag: sanitizeText(request.query?.topicTag || ""),
      difficulty: sanitizeText(request.query?.difficulty || "").toLowerCase()
    };
    const { sql, params } = buildSubmissionExportSql(filters);
    const out = await query(sql, params);
    const map = new Map();

    for (const row of out.rows) {
      const key = `${row.bank_name}::${row.question_id}`;
      const current = map.get(key) || {
        bank_name: row.bank_name,
        question_id: row.question_id,
        difficulty: row.difficulty,
        topic_tag: row.topic_tag,
        served_count: 0,
        correct_count: 0,
        choice_distribution: {}
      };
      current.served_count += 1;
      if (row.is_correct) current.correct_count += 1;
      const choice = row.client_answer || "unanswered";
      current.choice_distribution[choice] = (current.choice_distribution[choice] || 0) + 1;
      map.set(key, current);
    }

    return [...map.values()].map((entry) => ({
      ...entry,
      correct_percent: entry.served_count ? Math.round((entry.correct_count / entry.served_count) * 10000) / 100 : 0
    }));
  });

  fastify.get("/admin/results.csv", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const filters = {
      bankCode: normalizeBankCode(request.query?.bankCode || ""),
      topicTag: sanitizeText(request.query?.topicTag || ""),
      difficulty: sanitizeText(request.query?.difficulty || "").toLowerCase(),
      testCodes: parseCsvList(request.query?.testCodes || request.query?.testCode),
      studentIds: parseCsvList(request.query?.studentIds || request.query?.studentId)
    };
    const { sql, params } = buildSubmissionExportSql(filters);
    const out = await query(sql, params);

    const header = [
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
    ];
    const lines = [header.join(",")];
    out.rows.forEach((r) => {
      lines.push([
        csvEscape(r.client_username),
        csvEscape(r.client_name),
        r.total_score,
        r.score_percent,
        csvEscape(r.question_id),
        csvEscape(r.bank_name),
        csvEscape(r.client_answer),
        csvEscape(r.correct_answer),
        r.is_correct ? "true" : "false",
        csvEscape(r.difficulty),
        csvEscape(r.topic_tag)
      ].join(","));
    });

    reply.header("Content-Type", "text/csv");
    return lines.join("\n");
  });
}
