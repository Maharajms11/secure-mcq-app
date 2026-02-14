CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  passcode TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL,
  draw_count INTEGER NOT NULL,
  questions_per_category JSONB NOT NULL DEFAULT '{}'::jsonb,
  show_post_review BOOLEAN NOT NULL DEFAULT true,
  fullscreen_enforcement BOOLEAN NOT NULL DEFAULT true,
  tab_warn_threshold INTEGER NOT NULL DEFAULT 3,
  tab_autosubmit_threshold INTEGER NOT NULL DEFAULT 5,
  allow_retakes INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  integrity_notice TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  stem TEXT NOT NULL,
  explanation TEXT NOT NULL,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS question_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option_key TEXT NOT NULL,
  option_text TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL,
  UNIQUE (question_id, option_key)
);

CREATE TABLE IF NOT EXISTS sessions (
  token UUID PRIMARY KEY,
  seed UUID NOT NULL,
  assessment_id UUID NOT NULL REFERENCES assessments(id),
  student_name TEXT NOT NULL,
  student_id TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  screen_resolution TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  submitted_at TIMESTAMPTZ,
  question_order JSONB NOT NULL,
  questions_snapshot JSONB NOT NULL,
  answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  score INTEGER,
  total INTEGER,
  auto_submitted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_assessment ON sessions(assessment_id);

CREATE TABLE IF NOT EXISTS violation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token UUID NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  question_index INTEGER,
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_violations_session ON violation_events(session_token);

CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token UUID UNIQUE NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
  assessment_id UUID NOT NULL REFERENCES assessments(id),
  student_name TEXT NOT NULL,
  student_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  percentage INTEGER NOT NULL,
  time_taken_ms BIGINT NOT NULL,
  violation_count INTEGER NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  auto_submitted BOOLEAN NOT NULL DEFAULT false,
  result_payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_submissions_assessment ON submissions(assessment_id);
CREATE INDEX IF NOT EXISTS idx_submissions_date ON submissions(submitted_at DESC);

CREATE TABLE IF NOT EXISTS question_banks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_questions (
  bank_code TEXT NOT NULL REFERENCES question_banks(code) ON DELETE CASCADE,
  id TEXT NOT NULL,
  category TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  stem TEXT NOT NULL,
  explanation TEXT NOT NULL,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bank_code, id)
);

CREATE TABLE IF NOT EXISTS bank_question_options (
  bank_code TEXT NOT NULL,
  question_id TEXT NOT NULL,
  option_key TEXT NOT NULL,
  option_text TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL,
  PRIMARY KEY (bank_code, question_id, option_key),
  FOREIGN KEY (bank_code, question_id)
    REFERENCES bank_questions(bank_code, id)
    ON DELETE CASCADE
);

INSERT INTO question_banks (code, name, description)
VALUES ('default', 'Default Bank', 'Default seeded question bank')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS bank_code TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_assessments_bank_code ON assessments(bank_code);
CREATE INDEX IF NOT EXISTS idx_bank_questions_bank_code ON bank_questions(bank_code);

-- Backfill legacy global questions into default bank if this bank is empty.
INSERT INTO bank_questions (bank_code, id, category, difficulty, stem, explanation, image)
SELECT 'default', q.id, q.category, q.difficulty, q.stem, q.explanation, q.image
FROM questions q
WHERE NOT EXISTS (
  SELECT 1 FROM bank_questions bq WHERE bq.bank_code = 'default' AND bq.id = q.id
);

INSERT INTO bank_question_options (bank_code, question_id, option_key, option_text, is_correct)
SELECT 'default', qo.question_id, qo.option_key, qo.option_text, qo.is_correct
FROM question_options qo
WHERE NOT EXISTS (
  SELECT 1
  FROM bank_question_options bqo
  WHERE bqo.bank_code = 'default'
    AND bqo.question_id = qo.question_id
    AND bqo.option_key = qo.option_key
);
