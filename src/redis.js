import Redis from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false
});

redis.on("error", () => {
  // Redis is used for short-lived counters/cache; API still relies on PostgreSQL as source of truth.
});
