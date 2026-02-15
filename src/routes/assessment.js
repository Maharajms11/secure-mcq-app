import { query, withTx } from "../db.js";
import { redis } from "../redis.js";
import { enforceRateLimit } from "../rate-limit.js";
import { fisherYates, randomUuid, sanitizeText, verifySecret } from "../utils.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return sanitizeText(value || "").toLowerCase();
}

function parseAllocations(assessment) {
  const fromJson = Array.isArray(assessment.bank_allocations) ? assessment.bank_allocations : [];
  const normalized = fromJson
    .map((a) => ({
      bankCode: sanitizeText(a.bankCode || a.bank_code || "").toLowerCase(),
      count: Number(a.count || 0)
    }))
    .filter((a) => a.bankCode && Number.isInteger(a.count) && a.count > 0);
  if (normalized.length) return normalized;
  const fallbackBank = sanitizeText(assessment.bank_code || "default").toLowerCase();
  const fallbackCount = Math.max(1, Number(assessment.draw_count || 1));
  return [{ bankCode: fallbackBank, count: fallbackCount }];
}

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
      bankCode: q.bank_code,
      category: q.category,
      topicTag: q.topic_tag || "",
      difficulty: q.difficulty,
      stem: q.stem,
      explanation: q.explanation,
      image: q.image,
      distractors: shuffledOptions
    };
  });
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

function getRemainingMs(session) {
  return Math.max(0, new Date(session.expires_at).getTime() - Date.now());
}

function getWindowRemainingMs(session) {
  if (!session.window_end_at) return getRemainingMs(session);
  return Math.max(0, new Date(session.window_end_at).getTime() - Date.now());
}

function buildSubmittedResponse(resultPayload, resultsReleased) {
  if (resultsReleased) {
    return { resultsReleased: true, result: resultPayload };
  }
  return {
    resultsReleased: false,
    token: resultPayload.token,
    submittedAt: resultPayload.submittedAt,
    message: "Submission received. Results will appear when released by the admin."
  };
}

async function finalizeSession(client, session, autoSubmitted, terminatedReason = null) {
  const assessmentRes = await client.query(
    "SELECT code, title, results_released FROM assessments WHERE id = $1",
    [session.assessment_id]
  );
  const assessment = assessmentRes.rows[0] || { code: "", title: "", results_released: false };

  if (session.status === "submitted") {
    const existing = await client.query(
      "SELECT result_payload FROM submissions WHERE session_token = $1",
      [session.token]
    );
    return {
      resultPayload: existing.rows[0]?.result_payload || null,
      resultsReleased: !!assessment.results_released
    };
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
      bankCode: q.bankCode || "",
      topicTag: q.topicTag || "",
      difficulty: q.difficulty || "",
      stem: q.stem,
      selectedOriginalId: selected ? selected.originalId : "",
      selectedLabel: selected ? selected.displayLabel : "",
      selectedText: selected ? selected.text : "Unanswered",
      correctOriginalId: correct ? correct.originalId : "",
      correctLabel: correct ? correct.displayLabel : "",
      correctText: correct ? correct.text : "N/A",
      explanation: q.explanation || "",
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
    resultAccessToken: session.result_access_token || null,
    assessmentCode: assessment.code || "",
    assessmentTitle: assessment.title || "",
    student: {
      fullName: session.student_name,
      studentId: session.student_id,
      email: session.student_email || ""
    },
    score,
    total,
    percentage,
    timeTakenMs,
    violationCount,
    submittedAt: submittedAtIso,
    autoSubmitted: !!autoSubmitted,
    terminatedReason: terminatedReason || null,
    details
  };

  await client.query(
    `UPDATE sessions
     SET status = 'submitted',
         submitted_at = NOW(),
         score = $2,
         total = $3,
         auto_submitted = $4,
         terminated_reason = COALESCE($5, terminated_reason)
     WHERE token = $1`,
    [session.token, score, total, !!autoSubmitted, terminatedReason]
  );

  await client.query(
    `INSERT INTO submissions (
       session_token, assessment_id, student_name, student_id,
       student_email, score, total, percentage, time_taken_ms, violation_count, auto_submitted, result_payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (session_token) DO UPDATE SET
       student_email = EXCLUDED.student_email,
       score = EXCLUDED.score,
       total = EXCLUDED.total,
       percentage = EXCLUDED.percentage,
       time_taken_ms = EXCLUDED.time_taken_ms,
       violation_count = EXCLUDED.violation_count,
       auto_submitted = EXCLUDED.auto_submitted,
       result_payload = EXCLUDED.result_payload`,
    [
      session.token,
      session.assessment_id,
      session.student_name,
      session.student_id,
      session.student_email || "",
      score,
      total,
      percentage,
      timeTakenMs,
      violationCount,
      !!autoSubmitted,
      JSON.stringify(resultPayload)
    ]
  );

  return {
    resultPayload,
    resultsReleased: !!assessment.results_released
  };
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

function nowIso() {
  return new Date().toISOString();
}

function sessionJwtExpirySeconds(session) {
  const ms = Math.max(60_000, new Date(session.expires_at).getTime() - Date.now());
  return Math.max(60, Math.ceil(ms / 1000));
}

export default async function assessmentRoutes(fastify) {
  fastify.get("/health", async () => ({ ok: true, service: "secure-mcq-backend" }));

  fastify.get("/assessment/active", async () => {
    const out = await query(
      `SELECT code, title, duration_seconds, duration_minutes, draw_count, show_post_review,
              fullscreen_enforcement, tab_warn_threshold, tab_autosubmit_threshold,
              allow_retakes, integrity_notice, bank_code, bank_allocations,
              window_start, window_end, status, results_released
       FROM assessments
       WHERE status = 'active'
       ORDER BY updated_at DESC
       LIMIT 1`
    );
    const active = out.rows[0] || null;
    if (!active) return null;
    const now = Date.now();
    const startMs = new Date(active.window_start).getTime();
    const endMs = new Date(active.window_end).getTime();
    const availability = now < startMs ? "not_open" : now > endMs ? "closed" : "open";
    return {
      ...active,
      availability,
      serverNow: nowIso(),
      opensInMs: availability === "not_open" ? startMs - now : 0,
      closesInMs: availability === "open" ? endMs - now : 0
    };
  });

  fastify.post("/auth/start", async (request, reply) => {
    const ipKey = String(request.ip || "unknown");
    const limiter = await enforceRateLimit("student_login", ipKey, 20, 300);
    if (!limiter.allowed) {
      return reply.code(429).send({ error: "too_many_login_attempts" });
    }

    const body = request.body || {};
    const fullName = sanitizeText(body.fullName);
    const studentId = sanitizeText(body.studentId);
    const studentEmail = normalizeEmail(body.email || body.studentEmail);
    const passcode = sanitizeText(body.passcode || "");
    const assessmentCode = sanitizeText(body.assessmentCode || "");

    if (!fullName || !studentId || !studentEmail) {
      return reply.code(400).send({ error: "fullName_studentId_email_required" });
    }
    if (!EMAIL_RE.test(studentEmail)) {
      return reply.code(400).send({ error: "invalid_email" });
    }

    const assessmentRes = await query(
      `SELECT *
       FROM assessments
       WHERE ($1 = '' AND status = 'active') OR code = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [assessmentCode]
    );
    const assessment = assessmentRes.rows[0];
    if (!assessment) {
      return reply.code(404).send({ error: "assessment_not_found" });
    }

    if (assessment.status !== "active") {
      return reply.code(403).send({ error: "assessment_not_active" });
    }

    const nowMs = Date.now();
    const windowStartMs = new Date(assessment.window_start).getTime();
    const windowEndMs = new Date(assessment.window_end).getTime();
    if (nowMs < windowStartMs) {
      return reply.code(403).send({
        error: "assessment_not_open",
        opensAt: assessment.window_start,
        opensInMs: windowStartMs - nowMs
      });
    }
    if (nowMs > windowEndMs) {
      return reply.code(403).send({
        error: "assessment_closed",
        closedAt: assessment.window_end
      });
    }

    const passcodeOk = assessment.passcode_hash
      ? verifySecret(passcode, assessment.passcode_hash)
      : (assessment.passcode || "") === passcode;
    if (!passcodeOk) {
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

    const existingSessionRes = await query(
      `SELECT *
       FROM sessions
       WHERE assessment_id = $1 AND student_id = $2 AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [assessment.id, studentId]
    );
    const existing = existingSessionRes.rows[0];

    if (existing) {
      if (existing.disconnect_count >= 2) {
        const finalized = await withTx((client) =>
          finalizeSession(client, existing, true, "second_disconnect")
        );
        return reply.code(409).send({
          error: "session_terminated_after_second_disconnect",
          ...buildSubmittedResponse(finalized.resultPayload, finalized.resultsReleased)
        });
      }

      if (getRemainingMs(existing) <= 0) {
        const finalized = await withTx((client) => finalizeSession(client, existing, true, "timer_expired"));
        return reply.code(410).send({
          error: "timer_expired",
          ...buildSubmittedResponse(finalized.resultPayload, finalized.resultsReleased)
        });
      }

      await withTx(async (client) => {
        if (existing.disconnect_count === 0) {
          await client.query(
          `UPDATE sessions
             SET disconnect_count = 1, last_disconnect_at = NOW(), student_email = $2
             WHERE token = $1`,
            [existing.token, studentEmail]
          );
        }
        await client.query(
          `INSERT INTO violation_events (session_token, event_type, details)
           VALUES ($1, 'reconnect_resume', 'session resumed after disconnect')`,
          [existing.token]
        );
      });

      const sessionJwt = await reply.jwtSign(
        {
          role: "session",
          sessionToken: existing.token,
          studentId: existing.student_id,
          assessmentId: existing.assessment_id
        },
        { expiresIn: sessionJwtExpirySeconds(existing) }
      );

      return {
        token: existing.token,
        seed: existing.seed,
        startedAt: existing.started_at,
        expiresAt: existing.expires_at,
        resumed: true,
        reconnectWarning: "Disconnected once. Another disconnect will auto-submit this exam.",
        sessionAuthToken: sessionJwt,
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
          windowStart: assessment.window_start,
          windowEnd: assessment.window_end
        }
      };
    }

    const allocations = parseAllocations(assessment);
    const bankCodes = allocations.map((a) => a.bankCode);
    const questionsRes = await query(
      `SELECT q.bank_code, q.id, q.category, q.topic_tag, q.difficulty, q.stem, q.explanation, q.image,
              COALESCE(json_agg(json_build_object(
                'option_key', o.option_key,
                'option_text', o.option_text,
                'is_correct', o.is_correct
              ) ORDER BY o.option_key) FILTER (WHERE o.option_key IS NOT NULL), '[]'::json) AS options
       FROM bank_questions q
       LEFT JOIN bank_question_options o
         ON o.bank_code = q.bank_code
        AND o.question_id = q.id
       WHERE q.bank_code = ANY($1)
       GROUP BY q.bank_code, q.id, q.category, q.topic_tag, q.difficulty, q.stem, q.explanation, q.image
       ORDER BY q.bank_code, q.id`,
      [bankCodes]
    );

    const byBank = new Map();
    for (const row of questionsRes.rows) {
      const bankList = byBank.get(row.bank_code) || [];
      bankList.push(row);
      byBank.set(row.bank_code, bankList);
    }

    const selected = [];
    for (const allocation of allocations) {
      const pool = fisherYates(byBank.get(allocation.bankCode) || []);
      if (pool.length < allocation.count) {
        return reply.code(400).send({
          error: "insufficient_questions_in_bank",
          bankCode: allocation.bankCode,
          requested: allocation.count,
          available: pool.length
        });
      }
      selected.push(...pool.slice(0, allocation.count));
    }

    if (!selected.length) {
      return reply.code(400).send({ error: "question_bank_empty" });
    }

    const snapshot = buildSessionQuestions(fisherYates(selected));
    const token = randomUuid();
    const seed = randomUuid();
    const startedAtIso = nowIso();
    const personalEndMs = nowMs + Number(assessment.duration_minutes || 60) * 60 * 1000;
    const expiresAtMs = Math.min(personalEndMs, windowEndMs);
    if (expiresAtMs <= nowMs) {
      return reply.code(403).send({ error: "assessment_closed" });
    }
    const expiresAtIso = new Date(expiresAtMs).toISOString();

    const inserted = await query(
      `INSERT INTO sessions (
         token, seed, assessment_id, student_name, student_id,
         student_email, user_agent, screen_resolution, started_at, expires_at, window_end_at,
         result_access_token,
         question_order, questions_snapshot, disconnect_count
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0)
       RETURNING *`,
      [
        token,
        seed,
        assessment.id,
        fullName,
        studentId,
        studentEmail,
        request.headers["user-agent"] || "unknown",
        sanitizeText(body.screenResolution || "unknown"),
        startedAtIso,
        expiresAtIso,
        assessment.window_end,
        randomUuid(),
        JSON.stringify(snapshot.map((q) => q.id)),
        JSON.stringify(snapshot)
      ]
    );
    const session = inserted.rows[0];

    try {
      await redis.setex(`session:${token}:meta`, 60 * 60 * 24, JSON.stringify({ token, studentId, startedAtIso }));
    } catch (err) {
      fastify.log.warn({ err }, "redis setex failed; continuing with postgres-backed session");
    }

    const sessionJwt = await reply.jwtSign(
      {
        role: "session",
        sessionToken: token,
        studentId,
        assessmentId: assessment.id
      },
      { expiresIn: sessionJwtExpirySeconds(session) }
    );

    return {
      token,
      seed,
      startedAt: startedAtIso,
      expiresAt: expiresAtIso,
      sessionAuthToken: sessionJwt,
      resumed: false,
      assessment: {
        code: assessment.code,
        title: assessment.title,
        durationSeconds: Number(assessment.duration_minutes || 60) * 60,
        drawCount: assessment.draw_count,
        showPostReview: assessment.show_post_review,
        fullscreenEnforcement: assessment.fullscreen_enforcement,
        tabWarnThreshold: assessment.tab_warn_threshold,
        tabAutosubmitThreshold: assessment.tab_autosubmit_threshold,
        allowRetakes: assessment.allow_retakes,
        integrityNotice: assessment.integrity_notice,
        windowStart: assessment.window_start,
        windowEnd: assessment.window_end
      }
    };
  });

  fastify.get("/session/:token/state", { preHandler: fastify.sessionAuth }, async (request, reply) => {
    const session = await getSessionOrReply(reply, request.params.token);
    if (!session) return;

    if (session.status === "active" && getRemainingMs(session) <= 0) {
      const finalized = await withTx((client) => finalizeSession(client, session, true, "timer_expired"));
      return {
        status: "submitted",
        remainingMs: 0,
        windowRemainingMs: 0,
        ...buildSubmittedResponse(finalized.resultPayload, finalized.resultsReleased)
      };
    }

    const answered = (session.answers || []).length;
    return {
      token: session.token,
      status: session.status,
      remainingMs: getRemainingMs(session),
      windowRemainingMs: getWindowRemainingMs(session),
      answered,
      total: (session.question_order || []).length,
      currentIndex: answered,
      disconnectCount: Number(session.disconnect_count || 0)
    };
  });

  fastify.get("/session/:token/question", { preHandler: fastify.sessionAuth }, async (request, reply) => {
    const session = await getSessionOrReply(reply, request.params.token);
    if (!session) return;

    if (session.status !== "active") {
      return reply.code(409).send({ error: "session_not_active" });
    }

    if (getRemainingMs(session) <= 0) {
      const finalized = await withTx((client) => finalizeSession(client, session, true, "timer_expired"));
      return reply.code(410).send({
        error: "timer_expired",
        ...buildSubmittedResponse(finalized.resultPayload, finalized.resultsReleased)
      });
    }

    const index = (session.answers || []).length;
    const questionPayload = toQuestionForClient(session, index);
    if (!questionPayload) {
      const finalized = await withTx((client) => finalizeSession(client, session, false, "completed"));
      return {
        status: "completed",
        remainingMs: getRemainingMs(session),
        windowRemainingMs: getWindowRemainingMs(session),
        ...buildSubmittedResponse(finalized.resultPayload, finalized.resultsReleased)
      };
    }

    return {
      status: "ok",
      remainingMs: getRemainingMs(session),
      windowRemainingMs: getWindowRemainingMs(session),
      ...questionPayload
    };
  });

  fastify.post("/session/:token/answer", { preHandler: fastify.sessionAuth }, async (request, reply) => {
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
        const finalized = await finalizeSession(client, session, true, "timer_expired");
        return {
          error: "timer_expired",
          code: 410,
          submission: buildSubmittedResponse(finalized.resultPayload, finalized.resultsReleased)
        };
      }

      const currentIndex = (session.answers || []).length;
      const expectedQuestion = session.questions_snapshot?.[currentIndex];
      if (!expectedQuestion) {
        const finalized = await finalizeSession(client, session, false, "completed");
        return {
          done: true,
          submission: buildSubmittedResponse(finalized.resultPayload, finalized.resultsReleased)
        };
      }
      if (expectedQuestion.id !== questionId) {
        return { error: "invalid_question_sequence", code: 409 };
      }

      const validOption = (expectedQuestion.distractors || []).some((d) => d.originalId === selectedOriginalId);
      if (!validOption) {
        return { error: "invalid_option_for_question", code: 400 };
      }

      const newAnswers = (session.answers || []).concat([{ questionId, selectedOriginalId }]);
      await client.query("UPDATE sessions SET answers = $2 WHERE token = $1", [token, JSON.stringify(newAnswers)]);

      const nextQuestion = toQuestionForClient({ ...session, answers: newAnswers }, newAnswers.length);
      if (!nextQuestion) {
        const finalized = await finalizeSession(client, { ...session, answers: newAnswers }, false, "completed");
        return {
          done: true,
          submission: buildSubmittedResponse(finalized.resultPayload, finalized.resultsReleased)
        };
      }

      return {
        done: false,
        remainingMs: getRemainingMs(session),
        windowRemainingMs: getWindowRemainingMs(session),
        next: nextQuestion
      };
    });

    if (result.error) {
      return reply.code(result.code || 400).send(result);
    }
    return result;
  });

  fastify.post("/session/:token/event", { preHandler: fastify.sessionAuth }, async (request, reply) => {
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

  fastify.post("/session/:token/disconnect", { preHandler: fastify.sessionAuth }, async (request, reply) => {
    const token = request.params.token;
    const result = await withTx(async (client) => {
      const row = await client.query("SELECT * FROM sessions WHERE token = $1 FOR UPDATE", [token]);
      const session = row.rows[0];
      if (!session) return { error: "session_not_found", code: 404 };
      if (session.status !== "active") return { terminated: true, reason: "already_submitted" };

      const nextCount = Number(session.disconnect_count || 0) + 1;
      await client.query(
        `UPDATE sessions
         SET disconnect_count = $2, last_disconnect_at = NOW()
         WHERE token = $1`,
        [token, nextCount]
      );
      await client.query(
        `INSERT INTO violation_events (session_token, event_type, details)
         VALUES ($1, 'disconnect', $2)`,
        [token, `disconnect_count=${nextCount}`]
      );

      if (nextCount >= 2) {
        const finalized = await finalizeSession(client, { ...session, disconnect_count: nextCount }, true, "second_disconnect");
        return {
          terminated: true,
          disconnectCount: nextCount,
          ...buildSubmittedResponse(finalized.resultPayload, finalized.resultsReleased)
        };
      }
      return { terminated: false, disconnectCount: nextCount };
    });

    if (result.error) return reply.code(result.code || 400).send(result);
    return result;
  });

  fastify.post("/session/:token/submit", { preHandler: fastify.sessionAuth }, async (request, reply) => {
    const token = request.params.token;
    const autoSubmitted = !!request.body?.autoSubmitted;

    const sessionRes = await query("SELECT * FROM sessions WHERE token = $1", [token]);
    const session = sessionRes.rows[0];
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    const finalized = await withTx((client) => finalizeSession(client, session, autoSubmitted, "manual_submit"));
    return { status: "submitted", ...buildSubmittedResponse(finalized.resultPayload, finalized.resultsReleased) };
  });

  fastify.get("/session/:token/result", { preHandler: fastify.sessionAuth }, async (request, reply) => {
    const token = request.params.token;
    const out = await query(
      `SELECT s.result_payload, a.results_released
       FROM submissions s
       JOIN sessions se ON se.token = s.session_token
       JOIN assessments a ON a.id = se.assessment_id
       WHERE s.session_token = $1`,
      [token]
    );
    if (!out.rows[0]) {
      return reply.code(404).send({ error: "result_not_found" });
    }
    if (!out.rows[0].results_released) {
      return reply.code(403).send({ error: "results_not_released" });
    }
    return out.rows[0].result_payload;
  });

  // Public result endpoint for email deep-links.
  fastify.get("/results/:accessToken", async (request, reply) => {
    const accessToken = sanitizeText(request.params.accessToken || "");
    if (!accessToken) return reply.code(400).send({ error: "access_token_required" });

    const out = await query(
      `SELECT sub.result_payload, a.results_released
       FROM sessions se
       JOIN submissions sub ON sub.session_token = se.token
       JOIN assessments a ON a.id = se.assessment_id
       WHERE se.result_access_token::text = $1
       LIMIT 1`,
      [accessToken]
    );
    if (!out.rows[0]) {
      return reply.code(404).send({ error: "result_not_found" });
    }
    if (!out.rows[0].results_released) {
      return reply.code(403).send({ error: "results_not_released" });
    }
    return out.rows[0].result_payload;
  });
}
