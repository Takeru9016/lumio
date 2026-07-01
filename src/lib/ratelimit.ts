import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "@/lib/redis";

export const tutorRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "lumio:ai:tutor",
});

export const quizRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1 m"),
  prefix: "lumio:ai:quiz",
});

export const summaryRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "lumio:ai:summary",
});

export const pathRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(2, "1 m"),
  prefix: "lumio:ai:path",
});
