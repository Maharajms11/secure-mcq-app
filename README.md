# Secure MCQ Backend (Fastify + PostgreSQL + Redis)

## Run with Docker

1. Copy env:
   - `cp .env.example .env`
2. Start stack:
   - `docker compose up --build`
3. API:
   - `http://localhost:3000/api/health`

## Local Run (without Docker)

1. Provision PostgreSQL + Redis.
2. Set `DATABASE_URL` and `REDIS_URL` in `.env`.
3. Install and run:
   - `npm install`
   - `npm run migrate`
   - `npm run seed`
   - `npm run dev`

## Main Endpoints

### Public
- `GET /api/health`
- `GET /api/assessment/active`
- `POST /api/auth/start`
- `GET /api/session/:token/state`
- `GET /api/session/:token/question`
- `POST /api/session/:token/answer`
- `POST /api/session/:token/event`
- `POST /api/session/:token/disconnect`
- `POST /api/session/:token/submit`
- `GET /api/session/:token/result`

### Admin
- `POST /api/admin/login`
- `GET /api/admin/banks`
- `POST /api/admin/banks`
- `DELETE /api/admin/banks/:code`
- `POST /api/admin/banks/upload`
- `GET /api/admin/tests`
- `POST /api/admin/tests`
- `PUT /api/admin/tests/:code`
- `POST /api/admin/tests/:code/status`
- `POST /api/admin/tests/:code/release`
- `GET /api/admin/questions`
- `POST /api/admin/questions`
- `DELETE /api/admin/questions/:id`
- `GET /api/admin/results`
- `GET /api/admin/results/:token`
- `GET /api/admin/analytics/questions`
- `GET /api/admin/results.csv`

Use `Authorization: Bearer <admin_jwt>` for admin endpoints.

## Notes

- Timer integrity is enforced from server `expires_at` on every question/answer action.
- Per-client paper generation supports multi-bank allocations, and question/distractor order is randomized once at session initialization and stored immutably in `sessions.questions_snapshot`.
- Violation events are persisted in PostgreSQL and counted in final results.
- Result visibility is automatic at test window close (admin can still enable early release via `results_released`).
- Student email is captured at login for future workflow use, but no email notifications are sent.
- Redis is used for ephemeral counters/cache and can be extended for live proctoring dashboards.
