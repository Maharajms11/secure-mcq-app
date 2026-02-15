import dotenv from "dotenv";

dotenv.config();

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.APP_DATABASE_URL || process.env.DATABASE_URL || "postgres://mcq:mcq@localhost:5432/mcq",
  dbSsl: String(process.env.DB_SSL || "true") === "true",
  dbSslRejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || "false") === "true",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  jwtSecret: process.env.JWT_SECRET || "replace-me",
  adminPassword: process.env.ADMIN_PASSWORD || "change-me",
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || "",
  defaults: {
    code: process.env.DEFAULT_ASSESSMENT_CODE || "ASSESS-2026",
    passcode: process.env.DEFAULT_ASSESSMENT_PASSCODE || "",
    durationMinutes: Number(process.env.DEFAULT_DURATION_MINUTES || 60),
    drawCount: Number(process.env.DEFAULT_DRAW_COUNT || 10),
    allowRetakes: Number(process.env.DEFAULT_ALLOW_RETAKES || 0),
    showReview: String(process.env.DEFAULT_SHOW_REVIEW || "true") === "true",
    fullscreen: String(process.env.DEFAULT_FULLSCREEN || "true") === "true",
    tabWarnThreshold: Number(process.env.DEFAULT_TAB_WARN_THRESHOLD || 3),
    tabAutosubmitThreshold: Number(process.env.DEFAULT_TAB_AUTOSUBMIT_THRESHOLD || 5),
    windowHours: Number(process.env.DEFAULT_WINDOW_HOURS || 2)
  }
};
