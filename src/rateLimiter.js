import rateLimit from "express-rate-limit";

/**
 * Standard API rate limiter for all general endpoints.
 * Allows 600 requests per 15-minute window per IP.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

/**
 * Strict limiter for sensitive authentication endpoints (/api/auth/*).
 * Allows 30 requests per 15-minute window per IP to prevent credential brute-forcing.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts, please try again after 15 minutes." },
});

/**
 * Sync pusher limiter (/api/sync/push).
 * Protects against runaway browser state sync loops while allowing legitimate study sessions.
 * Allows 120 push requests per minute per IP.
 */
export const syncPushLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Sync rate limit reached. Retrying automatically shortly." },
});

/**
 * Payment order creation limiter (/api/payments/order).
 * Prevents spamming Razorpay order creation.
 * Allows 30 order creations per 15-minute window per IP.
 */
export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment requests, please try again later." },
});

/**
 * AI generation limiter (/api/ai/*).
 * Protects platform AI keys and limits rapid generation queries.
 * Allows 40 requests per minute per IP.
 */
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "AI generation rate limit reached. Please wait a moment." },
});
