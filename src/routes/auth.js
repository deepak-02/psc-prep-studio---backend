import { Router } from "express";
import { maybeAuth } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

// Welcome email on sign-up / first sign-in
router.post(
  "/welcome",
  maybeAuth,
  asyncHandler(async (req, res) => {
    // If SMTP is not actively dispatching or client sends welcome ping
    res.json({ ok: true, sent: false });
  })
);

// Resend verification email
router.post(
  "/verify-email",
  maybeAuth,
  asyncHandler(async (req, res) => {
    res.json({ ok: true, sent: false });
  })
);

// Password reset email request
router.post(
  "/password-reset",
  asyncHandler(async (req, res) => {
    res.json({ ok: true, fallback: true });
  })
);

export default router;
