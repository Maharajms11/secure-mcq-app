import { pool } from "../db.js";
import { config } from "../config.js";
import { INTEGRITY_NOTICE } from "../utils.js";

const questions = [
  {
    id: "q001", category: "General", difficulty: "easy",
    stem: "Which planet is closest to the Sun?",
    distractors: [
      { id: "a", text: "Venus", correct: false },
      { id: "b", text: "Mercury", correct: true },
      { id: "c", text: "Mars", correct: false },
      { id: "d", text: "Earth", correct: false }
    ],
    explanation: "Mercury is the innermost planet in our solar system.",
    image: null
  },
  {
    id: "q002", category: "General", difficulty: "easy",
    stem: "What is the chemical symbol for water?",
    distractors: [
      { id: "a", text: "O2", correct: false },
      { id: "b", text: "CO2", correct: false },
      { id: "c", text: "H2O", correct: true },
      { id: "d", text: "NaCl", correct: false }
    ],
    explanation: "Water consists of two hydrogen atoms bonded to one oxygen atom.",
    image: null
  },
  {
    id: "q003", category: "General", difficulty: "medium",
    stem: "Which of the following is NOT a programming language?",
    distractors: [
      { id: "a", text: "Python", correct: false },
      { id: "b", text: "Hadoop", correct: true },
      { id: "c", text: "Ruby", correct: false },
      { id: "d", text: "Swift", correct: false }
    ],
    explanation: "Hadoop is a big-data framework, not a programming language.",
    image: null
  },
  {
    id: "q004", category: "General", difficulty: "medium",
    stem: "What does RAM stand for?",
    distractors: [
      { id: "a", text: "Read Access Memory", correct: false },
      { id: "b", text: "Random Access Memory", correct: true },
      { id: "c", text: "Rapid Application Module", correct: false },
      { id: "d", text: "Runtime Allocation Memory", correct: false }
    ],
    explanation: "RAM stands for Random Access Memory, used for temporary data storage.",
    image: null
  },
  {
    id: "q005", category: "General", difficulty: "hard",
    stem: "In which year did the World Wide Web become publicly available?",
    distractors: [
      { id: "a", text: "1985", correct: false },
      { id: "b", text: "1999", correct: false },
      { id: "c", text: "1991", correct: true },
      { id: "d", text: "1995", correct: false }
    ],
    explanation: "Tim Berners-Lee made the World Wide Web publicly available in 1991.",
    image: null
  },
  {
    id: "q006", category: "Science", difficulty: "easy",
    stem: "What is the powerhouse of the cell?",
    distractors: [
      { id: "a", text: "Nucleus", correct: false },
      { id: "b", text: "Ribosome", correct: false },
      { id: "c", text: "Mitochondria", correct: true },
      { id: "d", text: "Golgi apparatus", correct: false }
    ],
    explanation: "Mitochondria produce ATP, the cell's primary energy currency.",
    image: null
  },
  {
    id: "q007", category: "Science", difficulty: "medium",
    stem: "What is the speed of light in a vacuum (approximate)?",
    distractors: [
      { id: "a", text: "300,000 km/s", correct: true },
      { id: "b", text: "150,000 km/s", correct: false },
      { id: "c", text: "1,080,000 km/h", correct: false },
      { id: "d", text: "30,000 km/s", correct: false }
    ],
    explanation: "Light travels at approximately 299,792 km/s in a vacuum.",
    image: null
  },
  {
    id: "q008", category: "Mathematics", difficulty: "easy",
    stem: "What is the value of pi (pi) to two decimal places?",
    distractors: [
      { id: "a", text: "3.12", correct: false },
      { id: "b", text: "3.41", correct: false },
      { id: "c", text: "3.14", correct: true },
      { id: "d", text: "3.16", correct: false }
    ],
    explanation: "Pi is approximately 3.14159, which rounds to 3.14.",
    image: null
  },
  {
    id: "q009", category: "Mathematics", difficulty: "medium",
    stem: "What is the square root of 144?",
    distractors: [
      { id: "a", text: "11", correct: false },
      { id: "b", text: "14", correct: false },
      { id: "c", text: "12", correct: true },
      { id: "d", text: "13", correct: false }
    ],
    explanation: "12 × 12 = 144, so the square root of 144 is 12.",
    image: null
  },
  {
    id: "q010", category: "History", difficulty: "medium",
    stem: "In which year did the First World War begin?",
    distractors: [
      { id: "a", text: "1916", correct: false },
      { id: "b", text: "1914", correct: true },
      { id: "c", text: "1918", correct: false },
      { id: "d", text: "1912", correct: false }
    ],
    explanation: "World War I began in 1914 following the assassination of Archduke Franz Ferdinand.",
    image: null
  }
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO assessments (
         code, title, passcode, duration_seconds, draw_count, questions_per_category,
         show_post_review, fullscreen_enforcement, tab_warn_threshold, tab_autosubmit_threshold,
         allow_retakes, integrity_notice, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
       ON CONFLICT (code)
       DO UPDATE SET title = EXCLUDED.title,
                     passcode = EXCLUDED.passcode,
                     duration_seconds = EXCLUDED.duration_seconds,
                     draw_count = EXCLUDED.draw_count,
                     questions_per_category = EXCLUDED.questions_per_category,
                     show_post_review = EXCLUDED.show_post_review,
                     fullscreen_enforcement = EXCLUDED.fullscreen_enforcement,
                     tab_warn_threshold = EXCLUDED.tab_warn_threshold,
                     tab_autosubmit_threshold = EXCLUDED.tab_autosubmit_threshold,
                     allow_retakes = EXCLUDED.allow_retakes,
                     integrity_notice = EXCLUDED.integrity_notice,
                     updated_at = NOW()`,
      [
        config.defaults.code,
        "Secure MCQ Assessment",
        config.defaults.passcode,
        config.defaults.durationMinutes * 60,
        config.defaults.drawCount,
        JSON.stringify({}),
        config.defaults.showReview,
        config.defaults.fullscreen,
        config.defaults.tabWarnThreshold,
        config.defaults.tabAutosubmitThreshold,
        config.defaults.allowRetakes,
        INTEGRITY_NOTICE
      ]
    );

    for (const q of questions) {
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
      for (const d of q.distractors) {
        await client.query(
          `INSERT INTO question_options (question_id, option_key, option_text, is_correct)
           VALUES ($1,$2,$3,$4)`,
          [q.id, d.id, d.text, d.correct]
        );
      }
    }

    await client.query("COMMIT");
    console.log("Seed complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
