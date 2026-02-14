import { query, withTx } from "../db.js";
import { config } from "../config.js";
import { csvEscape, parseJsonObjectOrEmpty, sanitizeText } from "../utils.js";

function normalizeQuestionPayload(body) {
  const id = sanitizeText(body.id);
  const category = sanitizeText(body.category);
  const difficulty = sanitizeText(body.difficulty || "medium");
  const stem = sanitizeText(body.stem);
  const explanation = sanitizeText(body.explanation || "");
  const image = body.image ? sanitizeText(body.image) : null;
  const distractors = Array.isArray(body.distractors) ? body.distractors : [];

  const normalized = distractors
    .map((d) => ({
      option_key: sanitizeText(d.id || d.option_key),
      option_text: sanitizeText(d.text || d.option_text),
      is_correct: !!d.correct || !!d.is_correct
    }))
    .filter((d) => d.option_key && d.option_text);

  return { id, category, difficulty, stem, explanation, image, distractors: normalized };
}

export default async function adminRoutes(fastify) {
  fastify.post("/admin/login", async (request, reply) => {
    const password = sanitizeText(request.body?.password || "");
    if (password !== config.adminPassword) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const token = await reply.jwtSign({ role: "admin" }, { expiresIn: "8h" });
    return { token };
  });

  fastify.get("/admin/config", { preHandler: fastify.adminAuth }, async () => {
    const out = await query(
      "SELECT * FROM assessments WHERE is_active = true ORDER BY created_at DESC LIMIT 1"
    );
    return out.rows[0] || null;
  });

  fastify.put("/admin/config", { preHandler: fastify.adminAuth }, async (request) => {
    const body = request.body || {};
    const currentRes = await query(
      "SELECT * FROM assessments WHERE is_active = true ORDER BY created_at DESC LIMIT 1"
    );
    const current = currentRes.rows[0];
    if (!current) {
      return { error: "active_assessment_not_found" };
    }

    const title = sanitizeText(body.title || current.title);
    const passcode = sanitizeText(body.passcode ?? current.passcode);
    const integrityNotice = sanitizeText(body.integrity_notice || current.integrity_notice);

    const out = await query(
      `UPDATE assessments SET
         title = $1,
         passcode = $2,
         duration_seconds = $3,
         draw_count = $4,
         questions_per_category = $5,
         show_post_review = $6,
         fullscreen_enforcement = $7,
         tab_warn_threshold = $8,
         tab_autosubmit_threshold = $9,
         allow_retakes = $10,
         integrity_notice = $11,
         updated_at = NOW()
       WHERE id = (SELECT id FROM assessments WHERE is_active = true ORDER BY created_at DESC LIMIT 1)
       RETURNING *`,
      [
        title,
        passcode,
        Math.max(60, Number(body.duration_seconds || current.duration_seconds)),
        Math.max(1, Number(body.draw_count || current.draw_count)),
        JSON.stringify(parseJsonObjectOrEmpty(body.questions_per_category ?? current.questions_per_category)),
        body.show_post_review ?? current.show_post_review,
        body.fullscreen_enforcement ?? current.fullscreen_enforcement,
        Math.max(1, Number(body.tab_warn_threshold || current.tab_warn_threshold)),
        Math.max(2, Number(body.tab_autosubmit_threshold || current.tab_autosubmit_threshold)),
        Math.max(0, Number(body.allow_retakes || current.allow_retakes)),
        integrityNotice
      ]
    );
    return out.rows[0];
  });

  fastify.get("/admin/questions", { preHandler: fastify.adminAuth }, async () => {
    const out = await query(
      `SELECT q.id, q.category, q.difficulty, q.stem, q.explanation, q.image,
              COALESCE(json_agg(json_build_object(
                'id', o.option_key,
                'text', o.option_text,
                'correct', o.is_correct
              ) ORDER BY o.option_key) FILTER (WHERE o.id IS NOT NULL), '[]'::json) AS distractors
       FROM questions q
       LEFT JOIN question_options o ON o.question_id = q.id
       GROUP BY q.id
       ORDER BY q.id`
    );
    return out.rows;
  });

  fastify.post("/admin/questions", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const q = normalizeQuestionPayload(request.body || {});
    if (!q.id || !q.category || !q.stem || q.distractors.length < 2 || q.distractors.length > 6) {
      return reply.code(400).send({ error: "invalid_question_payload" });
    }

    await withTx(async (client) => {
      await client.query(
        `INSERT INTO questions (id, category, difficulty, stem, explanation, image)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id)
         DO UPDATE SET category = EXCLUDED.category,
                       difficulty = EXCLUDED.difficulty,
                       stem = EXCLUDED.stem,
                       explanation = EXCLUDED.explanation,
                       image = EXCLUDED.image,
                       updated_at = NOW()`,
        [q.id, q.category, q.difficulty, q.stem, q.explanation, q.image]
      );

      await client.query("DELETE FROM question_options WHERE question_id = $1", [q.id]);
      for (const option of q.distractors) {
        await client.query(
          `INSERT INTO question_options (question_id, option_key, option_text, is_correct)
           VALUES ($1,$2,$3,$4)`,
          [q.id, option.option_key, option.option_text, option.is_correct]
        );
      }
    });

    return { ok: true, id: q.id };
  });

  fastify.delete("/admin/questions/:id", { preHandler: fastify.adminAuth }, async (request) => {
    const id = sanitizeText(request.params.id);
    await query("DELETE FROM questions WHERE id = $1", [id]);
    return { ok: true };
  });

  fastify.post("/admin/questions/import", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const payload = request.body?.questions;
    if (!Array.isArray(payload) || !payload.length) {
      return reply.code(400).send({ error: "questions_array_required" });
    }

    await withTx(async (client) => {
      await client.query("TRUNCATE question_options CASCADE");
      await client.query("TRUNCATE questions CASCADE");

      for (const raw of payload) {
        const q = normalizeQuestionPayload(raw);
        if (!q.id || !q.category || !q.stem || q.distractors.length < 2 || q.distractors.length > 6) {
          continue;
        }
        await client.query(
          `INSERT INTO questions (id, category, difficulty, stem, explanation, image)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [q.id, q.category, q.difficulty, q.stem, q.explanation, q.image]
        );
        for (const option of q.distractors) {
          await client.query(
            `INSERT INTO question_options (question_id, option_key, option_text, is_correct)
             VALUES ($1,$2,$3,$4)`,
            [q.id, option.option_key, option.option_text, option.is_correct]
          );
        }
      }
    });

    return { ok: true, imported: payload.length };
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

  fastify.get("/admin/results.csv", { preHandler: fastify.adminAuth }, async (request, reply) => {
    const out = await query(
      `SELECT session_token, student_name, student_id, score, total, percentage,
              time_taken_ms, violation_count, submitted_at
       FROM submissions
       ORDER BY submitted_at DESC
       LIMIT 5000`
    );

    const lines = ["token,name,id,score,total,percentage,timeTakenMs,violations,submittedAt"];
    out.rows.forEach((r) => {
      lines.push([
        csvEscape(r.session_token),
        csvEscape(r.student_name),
        csvEscape(r.student_id),
        r.score,
        r.total,
        r.percentage,
        r.time_taken_ms,
        r.violation_count,
        csvEscape(new Date(r.submitted_at).toISOString())
      ].join(","));
    });

    reply.header("Content-Type", "text/csv");
    return lines.join("\n");
  });
}
