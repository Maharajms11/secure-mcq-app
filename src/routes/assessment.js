import { query, withTx } from "../db.js";
import { redis } from "../redis.js";
import {
  fisherYates,
  parseJsonArrayOrEmpty,
  parseJsonObjectOrEmpty,
  randomUuid,
  sanitizeText,
  verifySecret
} from "../utils.js";

const inMemoryLoginLimits = new Map();

function nowIso() {
  return new Date().toISOString();
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
      bank_code: q.bank_code,
      category: q.category,
      difficulty: q.difficulty,
      topic_tag: q.topic_tag || null,
      stem: q.stem,
      explanation: q.explanation,
      image: q.image,
      distractors: shuffledOptions
    };
  });
}

function parseDatasetAllocations(value) {
  const arr = parseJsonArrayOrEmpty(value);
  return arr
    .map((x) => ({
      bankCode: sanitizeText(x.bankCode || x.bank_code || "").toLowerCase(),
      count: Math.max(0, Number(x.count || 0))
    }))
    .filter((x) => x.bankCode && Number.isInteger(x.count) && x.count > 0);
}

async function fetchBankQuestions(bankCode) {
  const questionsRes = await query(
    `SELECT q.bank_code, q.id, q.category, q.difficulty, q.topic_tag, q.stem, q.explanation, q.image,
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
     GROUP BY q.bank_code, q.id, q.category, q.difficulty, q.topic_tag, q.stem, q.explanation, q.image
     ORDER BY q.id`,
    [bankCode]
  );
  return questionsRes.rows;
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
      topicTag: question.topic_tag || null,
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

function resultVisibilityPayload(assessment, result) {
  if (assessment?.results_released) {
    return { released: true, result };
  }
  return {
    released: false,
    pendingRelease: true,
    message: "Results are not released yet."
  };
}

function computeAnswerMap(session) {
  const answerMap = new Map((session.answers || []).map((a) => [a.questionId, a.selectedOriginalId || null]));
  const drafts = session.draft_answers || {};
  Object.entries(drafts).forEach(([questionId, selectedOriginalId]) => {
    if (!answerMap.has(questionId)) {
      answerMap.set(questionId, selectedOriginalId || null);
    }
  });
  return answerMap;
}

async function finalizeSession(client, session, autoSubmitted, reason = "") {
  if (session.status === "submitted") {
    const existing = await client.query(
      "SELECT result_payload FROM submissions WHERE session_token = $1",
      [session.token]
    );
    return existing.rows[0]?.result_payload || null;
  }

  const answerMap = computeAnswerMap(session);
  let score = 0;
  const details = (session.questions_snapshot || []).map((q) => {
    const selectedId = answerMap.get(q.id) || null;
    const selected = (q.distractors || []).find((d) => d.originalId === selectedId) || null;
    const correct = (q.distractors || []).find((d) => d.correct) || null;
    const isCorrect = !!selected && !!correct && selected.originalId === correct.originalId;
    if (isCorrect) score += 1;

    return {
      questionId: q.id,
      bankName: q.bank_code,
      difficulty: q.difficulty,
      topicTag: q.topic_tag || null,
      stem: q.stem,
      selectedOriginalId: selected ? selected.originalId : null,
      selected: selected ? selected.text : "Unanswered",
      correctOriginalId: correct ? correct.originalId : null,
      correct: correct ? correct.text : "N/A",
      explanation: q.explanation,
      isCorrect
    };
  });

  const total = session.question_order.length;
  const percentage = total ? Math.round((score / total) * 100) : 0;
  const startedAt = new Date(session.started_at).getTime();
  const submittedAtIso = nowIso();
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
    terminationReason: reason || null,
    details
  };

  await client.query(
    `UPDATE sessions
     SET status = 'submitted',
         submitted_at = NOW(),
         score = $2,
         total = $3,
         auto_submitted = $4,
         termination_reason = CASE WHEN $5 = '' THEN termination_reason ELSE $5 END
     WHERE token = $1`,
    [session.token, score, total, !!autoSubmitted, reason]
  );

  await client.query(
    `INSERT INTO submissions (
       session_token, assessment_id, student_name, student_id,
       score, total, percentage, time_taken_ms, violation_count, auto_submitted, result_payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (session_token)
     DO UPDATE SET result_payload = EXCLUDED.result_payload,
                   score = EXCLUDED.score,
                   total = EXCLUDED.total,
                   percentage = EXCLUDED.percentage,
                   time_taken_ms = EXCLUDED.time_taken_ms,
                   violation_count = EXCLUDED.violation_count,
                   auto_submitted = EXCLUDED.auto_submitted,
                   submitted_at = NOW()`,
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

async function checkLoginRateLimit(ipAddress) {
  const key = `rate:auth:start:${ipAddress}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 600);
    }
    return count <= 25;
  } catch {
    const now = Date.now();
    const rec = inMemoryLoginLimits.get(key) || { count: 0, expiresAt: now + 600000 };
    if (now > rec.expiresAt) {
      rec.count = 0;
      rec.expiresAt = now + 600000;
    }
    rec.count += 1;
    inMemoryLoginLimits.set(key, rec);
    return rec.count <= 25;
  }
}

function normalizeWindow(assessment) {
  const ws = assessment.window_start ? new Date(assessment.window_start) : null;
  const we = assessment.window_end ? new Date(assessment.window_end) : null;
  return {
    start: ws && !Number.isNaN(ws.getTime()) ? ws : null,
    end: we && !Number.isNaN(we.getTime()) ? we : null
  };
}

async function selectQuestionsForAssessment(assessment) {
  const allocations = parseDatasetAllocations(assessment.dataset_allocations);
  const drawCount = Number(assessment.total_questions || assessment.draw_count || 0);

  if (allocations.length) {
    const selected = [];
    for (const part of allocations) {
      const rows = await fetchBankQuestions(part.bankCode);
      if (rows.length < part.count) {
        throw new Error(`insufficient_bank_questions:${part.bankCode}`);
      }
      selected.push(...fisherYates(rows).slice(0, part.count));
    }
    if (selected.length !== drawCount) {
      throw new Error("allocation_sum_mismatch");
    }
    return fisherYates(selected);
  }

  const bankCode = sanitizeText(assessment.bank_code || "default").toLowerCase();
  const rows = await fetchBankQuestions(bankCode);
  if (rows.length < drawCount) {
    throw new Error(`insufficient_bank_questions:${bankCode}`);
  }

  const byCategory = parseJsonObjectOrEmpty(assessment.questions_per_category);
  if (!Object.keys(byCategory).length) {
    return fisherYates(rows).slice(0, drawCount);
  }

  const picked = [];
  const pickedKeys = new Set();
  Object.entries(byCategory).forEach(([cat, count]) => {
    const pool = fisherYates(rows.filter((q) => q.category === cat));
    pool.slice(0, Math.max(0, Number(count) || 0)).forEach((q) => {
      const key = `${q.bank_code}:${q.id}`;
      if (!pickedKeys.has(key)) {
        picked.push(q);
        pickedKeys.add(key);
      }
    });
  });

  if (picked.length < drawCount) {
    fisherYates(rows.filter((q) => !pickedKeys.has(`${q.bank_code}:${q.id}`)))
      .slice(0, drawCount - picked.length)
      .forEach((q) => picked.push(q));
  }

  return fisherYates(picked).slice(0, drawCount);
}

export default async function assessmentRoutes(fastify) {
  fastify.get("/health", async () => ({ ok: true, service: "secure-mcq-backend" }));

  fastify.get("/assessment/active", async () => {
    const out = await query(
      `SELECT code, title, duration_seconds, duration_minutes, draw_count, total_questions,
              show_post_review, fullscreen_enforcement, tab_warn_threshold, tab_autosubmit_threshold,
              allow_retakes, integrity_notice, bank_code, dataset_allocations, assessment_date,
              status, window_start, window_end, results_released
       FROM assessments
       WHERE status = 'active'
       ORDER BY updated_at DESC
       LIMIT 1`
    );
    return out.rows[0] || null;
  });

  fastify.post("/auth/start", async (request, reply) => {
    const ipAddress = request.ip || request.headers["x-forwarded-for"] || "unknown";
    const allowed = await checkLoginRateLimit(String(ipAddress));
    if (!allowed) {
      return reply.code(429).send({ error: "too_many_requests", message: "Too many login attempts. Try again in 10 minutes." });
    }

    const body = request.body || {};
    const fullName = sanitizeText(body.fullName);
    const studentId = sanitizeText(body.studentId);
    const passcode = sanitizeText(body.passcode || "");
    const assessmentCode = sanitizeText(body.assessmentCode || "").toUpperCase();

    if (!fullName || !studentId) {
      return reply.code(400).send({ error: "fullName_and_studentId_required" });
    }

    const assessmentRes = await query(
      `SELECT * FROM assessments
       WHERE status = 'active' AND ($1 = '' OR code = $1)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [assessmentCode]
    );
    const assessment = assessmentRes.rows[0];
    if (!assessment) {
      return reply.code(404).send({ error: "assessment_not_found" });
    }

    const win = normalizeWindow(assessment);
    const now = new Date();
    if (win.start && now < win.start) {
      return reply.code(403).send({
        error: "exam_not_open_yet",
        windowStart: win.start.toISOString(),
        windowEnd: win.end ? win.end.toISOString() : null,
        opensInMs: win.start.getTime() - now.getTime()
      });
    }
    if (win.end && now > win.end) {
      return reply.code(403).send({
        error: "exam_window_closed",
        windowStart: win.start ? win.start.toISOString() : null,
        windowEnd: win.end.toISOString()
      });
    }

    if (!verifySecret(passcode, assessment.passcode_hash || assessment.passcode || "")) {
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

    const existingActive = await query(
      `SELECT *
       FROM sessions
       WHERE assessment_id = $1 AND student_id = $2 AND status = 'active'
       ORDER BY started_at DESC
       LIMIT 1`,
      [assessment.id, studentId]
    );
    const existingSession = existingActive.rows[0];
    if (existingSession) {
      await withTx(async (client) => {
        const lock = await client.query("SELECT * FROM sessions WHERE token = $1 FOR UPDATE", [existingSession.token]);
        const locked = lock.rows[0];
        if (locked && locked.status === "active") {
          await client.query(
            "UPDATE sessions SET disconnected_at = NOW(), termination_reason = $2 WHERE token = $1",
            [locked.token, "disconnect_reconnect"]
          );
          await finalizeSession(client, locked, true, "disconnect_reconnect");
        }
      });
      return reply.code(409).send({
        error: "session_terminated_on_reconnect",
        message: "Previous session was terminated due to disconnection. Sessions are not resumable."
      });
    }

    let selectedQuestions;
    try {
      selectedQuestions = await selectQuestionsForAssessment(assessment);
    } catch (err) {
      if (String(err.message || "").startsWith("insufficient_bank_questions:")) {
        const bank = String(err.message).split(":")[1] || "unknown";
        return reply.code(400).send({ error: "insufficient_bank_questions", bankCode: bank });
      }
      return reply.code(400).send({ error: err.message || "question_selection_failed" });
    }

    if (!selectedQuestions.length) {
      return reply.code(400).send({ error: "question_bank_empty" });
    }

    const snapshot = buildSessionQuestions(selectedQuestions);
    const token = randomUuid();
    const seed = randomUuid();
    const startedAtIso = nowIso();

    const durationMs = Number(assessment.duration_minutes || 0) * 60 * 1000;
    const personalEnd = new Date(Date.now() + durationMs);
    const windowEnd = win.end || null;
    const effectiveEnd = windowEnd && windowEnd.getTime() < personalEnd.getTime() ? windowEnd : personalEnd;
    const expiresAtIso = effectiveEnd.toISOString();

    await query(
      `INSERT INTO sessions (
         token, seed, assessment_id, student_name, student_id,
         user_agent, screen_resolution, started_at, expires_at,
         question_order, questions_snapshot, auth_user_id, exam_window_end_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
        JSON.stringify(snapshot.map((q) => `${q.bank_code}:${q.id}`)),
        JSON.stringify(snapshot),
        studentId,
        windowEnd ? windowEnd.toISOString() : null
      ]
    );

    try {
      await redis.setex(`session:${token}:meta`, 60 * 60 * 24, JSON.stringify({ token, studentId, startedAtIso }));
    } catch (err) {
      fastify.log.warn({ err }, "redis setex failed; continuing with postgres-backed session");
    }

    const sessionAccessToken = await reply.jwtSign(
      { role: "client", sessionToken: token, studentId },
      { expiresIn: `${Math.max(300, Math.ceil((new Date(expiresAtIso).getTime() - Date.now()) / 1000) + 600)}s` }
    );

    return {
      token,
      accessToken: sessionAccessToken,
      seed,
      startedAt: startedAtIso,
      expiresAt: expiresAtIso,
      windowEndAt: windowEnd ? windowEnd.toISOString() : null,
      assessment: {
        code: assessment.code,
        title: assessment.title,
        durationSeconds: assessment.duration_seconds,
        durationMinutes: assessment.duration_minutes,
        drawCount: assessment.draw_count,
        totalQuestions: assessment.total_questions,
        showPostReview: assessment.show_post_review,
        fullscreenEnforcement: assessment.fullscreen_enforcement,
        tabWarnThreshold: assessment.tab_warn_threshold,
        tabAutosubmitThreshold: assessment.tab_autosubmit_threshold,
        allowRetakes: assessment.allow_retakes,
        integrityNotice: assessment.integrity_notice,
        bankCode: assessment.bank_code,
        datasetAllocations: parseDatasetAllocations(assessment.dataset_allocations),
        assessmentDate: assessment.assessment_date,
        windowStart: win.start ? win.start.toISOString() : null,
        windowEnd: windowEnd ? windowEnd.toISOString() : null,
        resultsReleased: !!assessment.results_released
      }
    };
  });

  fastify.get("/session/:token/state", { preHandler: fastify.clientAuth }, async (request, reply) => {
    const session = await getSessionOrReply(reply, request.params.token);
    if (!session) return;

    const remainingMs = getRemainingMs(session);
    const answered = (session.answers || []).length;

    return {
      token: session.token,
      status: session.status,
      terminationReason: session.termination_reason || null,
      remainingMs,
      answered,
      total: (session.question_order || []).length,
      currentIndex: answered,
      examWindowEndAt: session.exam_window_end_at || null
    };
  });

  fastify.get("/session/:token/question", { preHandler: fastify.clientAuth }, async (request, reply) => {
    const session = await getSessionOrReply(reply, request.params.token);
    if (!session) return;

    if (session.status !== "active") {
      return reply.code(409).send({ error: "session_not_active", terminationReason: session.termination_reason || null });
    }

    if (getRemainingMs(session) <= 0) {
      const result = await withTx((client) => finalizeSession(client, session, true, "timer_expired"));
      const assessmentRes = await query("SELECT results_released FROM assessments WHERE id = $1", [session.assessment_id]);
      return reply.code(410).send({ error: "timer_expired", ...resultVisibilityPayload(assessmentRes.rows[0], result) });
    }

    const index = (session.answers || []).length;
    const questionPayload = toQuestionForClient(session, index);
    if (!questionPayload) {
      const result = await withTx((client) => finalizeSession(client, session, false));
      const assessmentRes = await query("SELECT results_released FROM assessments WHERE id = $1", [session.assessment_id]);
      return {
        status: "completed",
        ...resultVisibilityPayload(assessmentRes.rows[0], result)
      };
    }

    return {
      status: "ok",
      remainingMs: getRemainingMs(session),
      examWindowEndAt: session.exam_window_end_at || null,
      ...questionPayload
    };
  });

  fastify.post("/session/:token/autosave", { preHandler: fastify.clientAuth }, async (request, reply) => {
    const token = request.params.token;
    const body = request.body || {};
    const questionId = sanitizeText(body.questionId);
    const selectedOriginalId = sanitizeText(body.selectedOriginalId);

    if (!questionId || !selectedOriginalId) {
      return reply.code(400).send({ error: "questionId_and_selectedOriginalId_required" });
    }

    const result = await withTx(async (client) => {
      const row = await client.query("SELECT * FROM sessions WHERE token = $1 FOR UPDATE", [token]);
      const session = row.rows[0];
      if (!session) return { error: "session_not_found", code: 404 };
      if (session.status !== "active") return { error: "session_not_active", code: 409 };
      if (getRemainingMs(session) <= 0) {
        await finalizeSession(client, session, true, "timer_expired");
        return { error: "timer_expired", code: 410 };
      }

      const currentIndex = (session.answers || []).length;
      const expectedQuestion = session.questions_snapshot?.[currentIndex];
      if (!expectedQuestion || expectedQuestion.id !== questionId) {
        return { error: "invalid_question_sequence", code: 409 };
      }

      const validOption = (expectedQuestion.distractors || []).some((d) => d.originalId === selectedOriginalId);
      if (!validOption) return { error: "invalid_option_for_question", code: 400 };

      const newDrafts = { ...(session.draft_answers || {}), [questionId]: selectedOriginalId };
      await client.query("UPDATE sessions SET draft_answers = $2 WHERE token = $1", [token, JSON.stringify(newDrafts)]);
      return { ok: true };
    });

    if (result.error) return reply.code(result.code || 400).send(result);
    return { ok: true };
  });

  fastify.post("/session/:token/answer", { preHandler: fastify.clientAuth }, async (request, reply) => {
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
        return { error: "timer_expired", code: 410, result: finalized };
      }

      const currentIndex = (session.answers || []).length;
      const expectedQuestion = session.questions_snapshot?.[currentIndex];
      if (!expectedQuestion) {
        const finalized = await finalizeSession(client, session, false);
        return { done: true, result: finalized, assessmentId: session.assessment_id };
      }
      if (expectedQuestion.id !== questionId) {
        return { error: "invalid_question_sequence", code: 409 };
      }

      const drafts = session.draft_answers || {};
      const resolvedSelected = selectedOriginalId || drafts[questionId] || null;
      if (resolvedSelected) {
        const validOption = (expectedQuestion.distractors || []).some((d) => d.originalId === resolvedSelected);
        if (!validOption) {
          return { error: "invalid_option_for_question", code: 400 };
        }
      }

      const newAnswers = (session.answers || []).concat([{ questionId, selectedOriginalId: resolvedSelected }]);
      const newDrafts = { ...(session.draft_answers || {}) };
      delete newDrafts[questionId];

      await client.query(
        "UPDATE sessions SET answers = $2, draft_answers = $3 WHERE token = $1",
        [token, JSON.stringify(newAnswers), JSON.stringify(newDrafts)]
      );

      const nextQuestion = toQuestionForClient({ ...session, answers: newAnswers }, newAnswers.length);
      if (!nextQuestion) {
        const finalized = await finalizeSession(client, { ...session, answers: newAnswers, draft_answers: newDrafts }, false);
        return { done: true, result: finalized, assessmentId: session.assessment_id };
      }

      return {
        done: false,
        remainingMs: getRemainingMs(session),
        examWindowEndAt: session.exam_window_end_at || null,
        next: nextQuestion
      };
    });

    if (result.error) {
      return reply.code(result.code || 400).send(result);
    }

    if (result.done && result.result) {
      const assessmentRes = await query("SELECT results_released FROM assessments WHERE id = $1", [result.assessmentId]);
      return {
        done: true,
        ...resultVisibilityPayload(assessmentRes.rows[0], result.result)
      };
    }

    return result;
  });

  fastify.post("/session/:token/event", { preHandler: fastify.clientAuth }, async (request, reply) => {
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

  fastify.post("/session/:token/submit", { preHandler: fastify.clientAuth }, async (request, reply) => {
    const token = request.params.token;
    const autoSubmitted = !!request.body?.autoSubmitted;

    const sessionRes = await query("SELECT * FROM sessions WHERE token = $1", [token]);
    const session = sessionRes.rows[0];
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    const result = await withTx((client) => finalizeSession(client, session, autoSubmitted, autoSubmitted ? "auto_submit" : "manual_submit"));
    const assessmentRes = await query("SELECT results_released FROM assessments WHERE id = $1", [session.assessment_id]);

    return {
      status: "submitted",
      ...resultVisibilityPayload(assessmentRes.rows[0], result)
    };
  });

  fastify.get("/session/:token/result", { preHandler: fastify.clientAuth }, async (request, reply) => {
    const token = sanitizeText(request.params.token);
    const sessionRes = await query("SELECT assessment_id FROM sessions WHERE token = $1", [token]);
    const session = sessionRes.rows[0];
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    const assessmentRes = await query("SELECT results_released FROM assessments WHERE id = $1", [session.assessment_id]);
    const submissionRes = await query("SELECT result_payload FROM submissions WHERE session_token = $1", [token]);
    const resultPayload = submissionRes.rows[0]?.result_payload || null;

    if (!resultPayload) {
      return reply.code(404).send({ error: "result_not_found" });
    }

    return resultVisibilityPayload(assessmentRes.rows[0], resultPayload);
  });
}
