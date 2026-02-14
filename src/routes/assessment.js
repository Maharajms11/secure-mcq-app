import { query, withTx } from "../db.js";
import { redis } from "../redis.js";
import { fisherYates, parseJsonObjectOrEmpty, randomUuid, sanitizeText } from "../utils.js";

function buildSessionQuestions(rawQuestions) {
  return rawQuestions.map((q) => {
    const shuffledOptions = fisherYates(q.options || []).map((o, idx) => ({
      displayLabel: String.fromCharCode(65 + idx),
      originalId: o.option_key,
      text: o.option_text,
      correct: o.is_correct
    }));

    return {
      id: q.id,
      category: q.category,
      difficulty: q.difficulty,
      stem: q.stem,
      explanation: q.explanation,
      image: q.image,
      distractors: shuffledOptions
    };
  });
}

function pickQuestions(questionRows, drawCount, questionsPerCategory) {
  const byCategory = parseJsonObjectOrEmpty(questionsPerCategory);
  const hasStratifiedConfig = Object.keys(byCategory).length > 0;
  if (!hasStratifiedConfig) {
    return fisherYates(questionRows).slice(0, Math.min(drawCount, questionRows.length));
  }

  const selected = [];
  const pickedIds = new Set();

  Object.entries(byCategory).forEach(([category, count]) => {
    const pool = fisherYates(questionRows.filter((q) => q.category === category));
    const take = Math.max(0, Number(count) || 0);
    pool.slice(0, take).forEach((q) => {
      if (!pickedIds.has(q.id)) {
        selected.push(q);
        pickedIds.add(q.id);
      }
    });
  });

  if (selected.length < drawCount) {
    const fallback = fisherYates(questionRows.filter((q) => !pickedIds.has(q.id)));
    fallback.slice(0, drawCount - selected.length).forEach((q) => selected.push(q));
  }

  return fisherYates(selected).slice(0, Math.min(drawCount, questionRows.length));
}

function toQuestionForClient(session, index) {
  const question = session.questions_snapshot?.[index];
  if (!question) return null;
  return {
    token: session.token,
    questionIndex: index,
    totalQuestions: session.question_order.length,
    progressLabel: `Question ${index + 1} of ${session.question_order.length}`,
    question: {
      id: question.id,
      category: question.category,
      difficulty: question.difficulty,
      stem: question.stem,
      image: question.image,
      options: question.distractors.map((d) => ({
        displayLabel: d.displayLabel,
        originalId: d.originalId,
        text: d.text
      }))
    }
  };
}

async function finalizeSession(client, session, autoSubmitted) {
  if (session.status === "submitted") {
    const existing = await client.query(
      "SELECT result_payload FROM submissions WHERE session_token = $1",
      [session.token]
    );
    return existing.rows[0]?.result_payload || null;
  }

  const answerMap = new Map((session.answers || []).map((a) => [a.questionId, a.selectedOriginalId]));
  let score = 0;
  const details = (session.questions_snapshot || []).map((q) => {
    const selectedId = answerMap.get(q.id) || null;
    const selected = (q.distractors || []).find((d) => d.originalId === selectedId) || null;
    const correct = (q.distractors || []).find((d) => d.correct) || null;
    const isCorrect = !!selected && !!correct && selected.originalId === correct.originalId;
    if (isCorrect) score += 1;

    return {
      questionId: q.id,
      stem: q.stem,
      selected: selected ? selected.text : "Unanswered",
      correct: correct ? correct.text : "N/A",
      explanation: q.explanation,
      isCorrect
    };
  });

  const total = session.question_order.length;
  const percentage = total ? Math.round((score / total) * 100) : 0;
  const startedAt = new Date(session.started_at).getTime();
  const submittedAtIso = new Date().toISOString();
  const submittedAtMs = new Date(submittedAtIso).getTime();
  const timeTakenMs = Math.max(0, submittedAtMs - startedAt);

  const violationCountRow = await client.query(
    "SELECT COUNT(*)::int AS count FROM violation_events WHERE session_token = $1",
    [session.token]
  );
  const violationCount = violationCountRow.rows[0]?.count || 0;

  const resultPayload = {
    token: session.token,
    seed: session.seed,
    student: {
      fullName: session.student_name,
      studentId: session.student_id
    },
    score,
    total,
    percentage,
    timeTakenMs,
    violationCount,
    submittedAt: submittedAtIso,
    autoSubmitted: !!autoSubmitted,
    details
  };

  await client.query(
    `UPDATE sessions
     SET status = 'submitted', submitted_at = NOW(), score = $2, total = $3, auto_submitted = $4
     WHERE token = $1`,
    [session.token, score, total, !!autoSubmitted]
  );

  await client.query(
    `INSERT INTO submissions (
       session_token, assessment_id, student_name, student_id,
       score, total, percentage, time_taken_ms, violation_count, auto_submitted, result_payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (session_token) DO NOTHING`,
    [
      session.token,
      session.assessment_id,
      session.student_name,
      session.student_id,
      score,
      total,
      percentage,
      timeTakenMs,
      violationCount,
      !!autoSubmitted,
      JSON.stringify(resultPayload)
    ]
  );

  return resultPayload;
}

async function getSessionOrReply(reply, token) {
  const res = await query("SELECT * FROM sessions WHERE token = $1", [token]);
  const session = res.rows[0];
  if (!session) {
    reply.code(404).send({ error: "session_not_found" });
    return null;
  }
  return session;
}

function getRemainingMs(session) {
  return Math.max(0, new Date(session.expires_at).getTime() - Date.now());
}

export default async function assessmentRoutes(fastify) {
  fastify.get("/health", async () => ({ ok: true, service: "secure-mcq-backend" }));

  fastify.get("/assessment/active", async () => {
    const out = await query(
      `SELECT code, title, duration_seconds, draw_count, show_post_review,
              fullscreen_enforcement, tab_warn_threshold, tab_autosubmit_threshold,
              allow_retakes, integrity_notice, bank_code
       FROM assessments
       WHERE is_active = true
       ORDER BY created_at DESC
       LIMIT 1`
    );
    return out.rows[0] || null;
  });

  fastify.post("/auth/start", async (request, reply) => {
    const body = request.body || {};
    const fullName = sanitizeText(body.fullName);
    const studentId = sanitizeText(body.studentId);
    const passcode = sanitizeText(body.passcode || "");
    const assessmentCode = sanitizeText(body.assessmentCode || "");

    if (!fullName || !studentId) {
      return reply.code(400).send({ error: "fullName_and_studentId_required" });
    }

    const assessmentRes = await query(
      `SELECT * FROM assessments WHERE is_active = true AND ($1 = '' OR code = $1) ORDER BY created_at DESC LIMIT 1`,
      [assessmentCode]
    );
    const assessment = assessmentRes.rows[0];
    if (!assessment) {
      return reply.code(404).send({ error: "assessment_not_found" });
    }

    if ((assessment.passcode || "") !== (passcode || "")) {
      return reply.code(403).send({ error: "invalid_passcode" });
    }

    const attemptsRes = await query(
      `SELECT COUNT(*)::int AS count
       FROM submissions
       WHERE assessment_id = $1 AND student_id = $2`,
      [assessment.id, studentId]
    );
    const attempts = attemptsRes.rows[0]?.count || 0;
    if (attempts > Number(assessment.allow_retakes || 0)) {
      return reply.code(403).send({ error: "attempt_limit_reached", attempts });
    }

    const bankCode = sanitizeText(assessment.bank_code || "default");
    const questionsRes = await query(
      `SELECT q.id, q.category, q.difficulty, q.stem, q.explanation, q.image,
              COALESCE(json_agg(json_build_object(
                'option_key', o.option_key,
                'option_text', o.option_text,
                'is_correct', o.is_correct
              ) ORDER BY o.option_key) FILTER (WHERE o.option_key IS NOT NULL), '[]'::json) AS options
       FROM bank_questions q
       LEFT JOIN bank_question_options o
         ON o.bank_code = q.bank_code
        AND o.question_id = q.id
       WHERE q.bank_code = $1
       GROUP BY q.id
       ORDER BY q.id`
      ,
      [bankCode]
    );

    const selectedQuestions = pickQuestions(
      questionsRes.rows,
      Number(assessment.draw_count),
      assessment.questions_per_category
    );

    if (!selectedQuestions.length) {
      return reply.code(400).send({ error: "question_bank_empty" });
    }

    const snapshot = buildSessionQuestions(selectedQuestions);
    const token = randomUuid();
    const seed = randomUuid();
    const startedAtIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.now() + Number(assessment.duration_seconds) * 1000).toISOString();

    await query(
      `INSERT INTO sessions (
         token, seed, assessment_id, student_name, student_id,
         user_agent, screen_resolution, started_at, expires_at,
         question_order, questions_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        token,
        seed,
        assessment.id,
        fullName,
        studentId,
        request.headers["user-agent"] || "unknown",
        sanitizeText(body.screenResolution || "unknown"),
        startedAtIso,
        expiresAtIso,
        JSON.stringify(snapshot.map((q) => q.id)),
        JSON.stringify(snapshot)
      ]
    );

    try {
      await redis.setex(`session:${token}:meta`, 60 * 60 * 24, JSON.stringify({ token, studentId, startedAtIso }));
    } catch (err) {
      fastify.log.warn({ err }, "redis setex failed; continuing with postgres-backed session");
    }

    return {
      token,
      seed,
      startedAt: startedAtIso,
      expiresAt: expiresAtIso,
      assessment: {
        code: assessment.code,
        title: assessment.title,
        durationSeconds: assessment.duration_seconds,
        drawCount: assessment.draw_count,
        showPostReview: assessment.show_post_review,
        fullscreenEnforcement: assessment.fullscreen_enforcement,
        tabWarnThreshold: assessment.tab_warn_threshold,
        tabAutosubmitThreshold: assessment.tab_autosubmit_threshold,
        allowRetakes: assessment.allow_retakes,
        integrityNotice: assessment.integrity_notice,
        bankCode
      }
    };
  });

  fastify.get("/session/:token/state", async (request, reply) => {
    const session = await getSessionOrReply(reply, request.params.token);
    if (!session) return;

    const remainingMs = getRemainingMs(session);
    const answered = (session.answers || []).length;

    return {
      token: session.token,
      status: session.status,
      remainingMs,
      answered,
      total: (session.question_order || []).length,
      currentIndex: answered
    };
  });

  fastify.get("/session/:token/question", async (request, reply) => {
    const session = await getSessionOrReply(reply, request.params.token);
    if (!session) return;

    if (session.status !== "active") {
      return reply.code(409).send({ error: "session_not_active" });
    }

    if (getRemainingMs(session) <= 0) {
      const result = await withTx((client) => finalizeSession(client, session, true));
      return reply.code(410).send({ error: "timer_expired", result });
    }

    const index = (session.answers || []).length;
    const questionPayload = toQuestionForClient(session, index);
    if (!questionPayload) {
      const result = await withTx((client) => finalizeSession(client, session, false));
      return { status: "completed", result };
    }

    return {
      status: "ok",
      remainingMs: getRemainingMs(session),
      ...questionPayload
    };
  });

  fastify.post("/session/:token/answer", async (request, reply) => {
    const token = request.params.token;
    const body = request.body || {};
    const questionId = sanitizeText(body.questionId);
    const selectedOriginalId = body.selectedOriginalId == null ? null : sanitizeText(body.selectedOriginalId);

    if (!questionId) {
      return reply.code(400).send({ error: "questionId_required" });
    }

    const result = await withTx(async (client) => {
      const row = await client.query("SELECT * FROM sessions WHERE token = $1 FOR UPDATE", [token]);
      const session = row.rows[0];
      if (!session) return { error: "session_not_found", code: 404 };
      if (session.status !== "active") return { error: "session_not_active", code: 409 };
      if (getRemainingMs(session) <= 0) {
        const finalized = await finalizeSession(client, session, true);
        return { error: "timer_expired", code: 410, result: finalized };
      }

      const currentIndex = (session.answers || []).length;
      const expectedQuestion = session.questions_snapshot?.[currentIndex];
      if (!expectedQuestion) {
        const finalized = await finalizeSession(client, session, false);
        return { done: true, result: finalized };
      }
      if (expectedQuestion.id !== questionId) {
        return { error: "invalid_question_sequence", code: 409 };
      }

      if (selectedOriginalId) {
        const validOption = (expectedQuestion.distractors || []).some((d) => d.originalId === selectedOriginalId);
        if (!validOption) {
          return { error: "invalid_option_for_question", code: 400 };
        }
      }

      const newAnswers = (session.answers || []).concat([{ questionId, selectedOriginalId }]);
      await client.query("UPDATE sessions SET answers = $2 WHERE token = $1", [token, JSON.stringify(newAnswers)]);

      const nextQuestion = toQuestionForClient({ ...session, answers: newAnswers }, newAnswers.length);
      if (!nextQuestion) {
        const finalized = await finalizeSession(client, { ...session, answers: newAnswers }, false);
        return { done: true, result: finalized };
      }

      return {
        done: false,
        remainingMs: getRemainingMs(session),
        next: nextQuestion
      };
    });

    if (result.error) {
      return reply.code(result.code || 400).send(result);
    }
    return result;
  });

  fastify.post("/session/:token/event", async (request, reply) => {
    const token = request.params.token;
    const body = request.body || {};
    const eventType = sanitizeText(body.eventType);
    const details = sanitizeText(body.details || "");
    const questionIndex = Number.isInteger(body.questionIndex) ? body.questionIndex : null;

    if (!eventType) {
      return reply.code(400).send({ error: "eventType_required" });
    }

    const session = await getSessionOrReply(reply, token);
    if (!session) return;

    await query(
      `INSERT INTO violation_events (session_token, event_type, details, question_index)
       VALUES ($1, $2, $3, $4)`,
      [token, eventType, details, questionIndex]
    );

    try {
      await redis.incr(`session:${token}:violations`);
      await redis.expire(`session:${token}:violations`, 60 * 60 * 24);
    } catch (err) {
      fastify.log.warn({ err }, "redis violation counter update failed; continuing");
    }

    return { ok: true };
  });

  fastify.post("/session/:token/submit", async (request, reply) => {
    const token = request.params.token;
    const autoSubmitted = !!request.body?.autoSubmitted;

    const sessionRes = await query("SELECT * FROM sessions WHERE token = $1", [token]);
    const session = sessionRes.rows[0];
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    const result = await withTx((client) => finalizeSession(client, session, autoSubmitted));
    return { status: "submitted", result };
  });
}
