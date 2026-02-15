import { redis } from "./redis.js";

const fallbackHits = new Map();

function nowMs() {
  return Date.now();
}

function cleanupFallback(key) {
  const row = fallbackHits.get(key);
  if (!row) return;
  if (row.expiresAt <= nowMs()) fallbackHits.delete(key);
}

function fallbackRateLimit(key, limit, windowSeconds) {
  cleanupFallback(key);
  const existing = fallbackHits.get(key);
  if (!existing) {
    fallbackHits.set(key, { count: 1, expiresAt: nowMs() + windowSeconds * 1000 });
    return { allowed: true, remaining: limit - 1 };
  }
  existing.count += 1;
  fallbackHits.set(key, existing);
  return { allowed: existing.count <= limit, remaining: Math.max(0, limit - existing.count) };
}

export async function enforceRateLimit(scope, identity, limit, windowSeconds) {
  const key = `ratelimit:${scope}:${identity}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch {
    return fallbackRateLimit(key, limit, windowSeconds);
  }
}
