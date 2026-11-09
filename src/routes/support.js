import { Router } from "express";
import { getDb } from "../db.js";
import { maybeAuth } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

// In-memory rate limiter for public forms
const ipHits = new Map();
function rateLimit(ip, max = 10, windowMs = 60_000) {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 2000) ipHits.clear();
  return true;
}

// Create support contact ticket
router.post(
  "/ticket",
  maybeAuth,
  asyncHandler(async (req, res) => {
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    if (!rateLimit(ip, 10)) {
      return res.status(429).json({ error: "Too many requests. Please retry in a minute." });
    }

    const db = await getDb();
    const body = req.body || {};

    // Honeypot check
    if (body.website) return res.json({ ok: true });

    const name = String(body.name ?? "").trim().slice(0, 80);
    const email = String(body.email ?? "").trim().slice(0, 200);
    const message = String(body.message ?? "").trim().slice(0, 5000);
    const topic = String(body.topic ?? "general").slice(0, 30);
    const paymentId =
      typeof body.paymentId === "string" && /^pay_[A-Za-z0-9]{6,40}$/.test(body.paymentId)
        ? body.paymentId
        : null;

    if (!email.includes("@")) {
      return res.status(400).json({ error: "Enter a valid email so we can reply." });
    }
    if (message.length < 10) {
      return res.status(400).json({ error: "Please describe the issue in at least 10 characters." });
    }

    const id = `tkt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const reference = id.split("_").pop().toUpperCase();

    const doc = {
      _id: id,
      id,
      reference,
      kind: "ticket",
      topic,
      name,
      email,
      message,
      paymentId,
      uid: req.user?.uid ?? null,
      status: "open",
      createdAt: Date.now(),
    };

    await db.collection("support").insertOne(doc);
    void import("../adminNotifier.js").then((m) =>
      m.notifySupportTicket(doc).catch(() => undefined)
    );
    res.json({ ok: true, reference, emailed: false });
  })
);

// Create feedback
router.post(
  "/feedback",
  maybeAuth,
  asyncHandler(async (req, res) => {
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    if (!rateLimit(ip, 10)) {
      return res.status(429).json({ error: "Too many requests. Please retry in a minute." });
    }

    const db = await getDb();
    const body = req.body || {};

    if (body.website) return res.json({ ok: true });

    const rating = Number(body.rating);
    const message = String(body.message ?? "").trim().slice(0, 2000);
    const area = String(body.area ?? "general").slice(0, 30);
    const email = String(body.email ?? "").trim().slice(0, 200);

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Choose a rating from 1 to 5." });
    }

    const id = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const doc = {
      _id: id,
      id,
      kind: "feedback",
      rating,
      area,
      message,
      email: email.includes("@") ? email : null,
      uid: req.user?.uid ?? null,
      status: "open",
      createdAt: Date.now(),
    };

    await db.collection("support").insertOne(doc);
    void import("../adminNotifier.js").then((m) =>
      m.notifyFeedback(doc).catch(() => undefined)
    );
    res.json({ ok: true });
  })
);

// Help Chat Assistant
router.post(
  "/chat",
  asyncHandler(async (req, res) => {
    res.json({
      mode: "assistant",
      text: "You can find answers to most common questions in our Help Centre or contact us via the Contact form.",
      articles: [],
    });
  })
);

export default router;
