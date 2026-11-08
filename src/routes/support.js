import { Router } from "express";
import { getDb } from "../db.js";
import { maybeAuth } from "../auth.js";

const router = Router();

// Create support contact ticket
router.post("/ticket", maybeAuth, async (req, res) => {
  const db = await getDb();
  const body = req.body || {};

  // Honeypot check
  if (body.website) return res.json({ ok: true });

  const name = String(body.name ?? "").trim().slice(0, 80);
  const email = String(body.email ?? "").trim().slice(0, 200);
  const message = String(body.message ?? "").trim();
  const topic = String(body.topic ?? "general");
  const paymentId = typeof body.paymentId === "string" ? body.paymentId : null;

  if (!email.includes("@")) {
    return res.status(400).json({ error: "Enter a valid email so we can reply." });
  }
  if (message.length < 10) {
    return res.status(400).json({ error: "Please describe the issue in at least 10 characters." });
  }

  const id = `tkt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const reference = id.slice(-6).toUpperCase();

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

  try {
    await db.collection("support").insertOne(doc);
    res.json({ ok: true, reference, emailed: false });
  } catch (err) {
    console.error("[support/ticket]", err);
    res.status(500).json({ error: "Failed to create support ticket." });
  }
});

// Create feedback
router.post("/feedback", maybeAuth, async (req, res) => {
  const db = await getDb();
  const body = req.body || {};

  if (body.website) return res.json({ ok: true });

  const rating = Number(body.rating);
  const message = String(body.message ?? "").trim().slice(0, 2000);
  const area = String(body.area ?? "general").slice(0, 30);
  const email = String(body.email ?? "").trim();

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

  try {
    await db.collection("support").insertOne(doc);
    res.json({ ok: true });
  } catch (err) {
    console.error("[support/feedback]", err);
    res.status(500).json({ error: "Failed to submit feedback." });
  }
});

// Help Chat Assistant
router.post("/chat", async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const question = messages.at(-1)?.content ?? "";

  // Lightweight fallback: response indicating assistant is ready
  res.json({
    mode: "assistant",
    text: "You can find answers to most common questions in our Help Centre or contact us via the Contact form.",
    articles: [],
  });
});

export default router;
