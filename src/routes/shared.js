import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

// Query shared community practice questions
router.get(
  "/questions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { level, category, regionalLanguage, difficulty, language, limit } = req.query;

    const query = {};
    if (typeof level === "string") query.level = level.slice(0, 120);
    if (typeof category === "string") query.category = category.slice(0, 80);
    if (typeof regionalLanguage === "string") query.regionalLanguage = regionalLanguage.slice(0, 40);
    if (typeof difficulty === "string") query.difficulty = difficulty.slice(0, 20);
    if (typeof language === "string") query.language = language.slice(0, 10);

    const max = Math.max(1, Math.min(100, Number(limit) || 30));

    const docs = await db.collection("sharedQuestions").find(query).limit(max).toArray();
    res.json(docs);
  })
);

// Contribute a question to the shared practice pool
router.post(
  "/questions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const r = req.body || {};
    const fp = r.fingerprint;

    if (!fp || typeof fp !== "string" || !/^[a-f0-9]{64}$/.test(fp)) {
      return res.status(400).json({ error: "Invalid fingerprint." });
    }

    const cleanPair = (v) =>
      v && typeof v === "object"
        ? {
            ml: String(v.ml ?? "").slice(0, 2000),
            en: String(v.en ?? "").slice(0, 2000),
          }
        : { ml: "", en: "" };

    const cleanOptions = Array.isArray(r.options) && r.options.length === 4
      ? r.options.map(cleanPair)
      : [];

    const answer = Number.isInteger(r.answer) && r.answer >= 0 && r.answer < 4 ? r.answer : 0;

    const record = {
      _id: fp,
      fingerprint: fp,
      schemaVersion: 1,
      level: String(r.level ?? "").slice(0, 120),
      category: String(r.category ?? "").slice(0, 80),
      regionalLanguage: String(r.regionalLanguage ?? "").slice(0, 40),
      difficulty: ["Easy", "Moderate", "Hard"].includes(r.difficulty) ? r.difficulty : "Moderate",
      language: ["ml", "en"].includes(r.language) ? r.language : "ml",
      subject: String(r.subject ?? "").slice(0, 200),
      text: cleanPair(r.text),
      explanation: cleanPair(r.explanation),
      options: cleanOptions,
      answer,
      provenance: "ai-practice",
      status: "unreviewed",
      model: String(r.model ?? "").slice(0, 80),
      createdAt: new Date(),
    };

    const result = await db.collection("sharedQuestions").updateOne(
      { _id: fp },
      { $setOnInsert: record },
      { upsert: true }
    );

    res.json({ result: result.upsertedCount > 0 ? "created" : "exists" });
  })
);

// Fetch community imported official PYQ paper
router.get(
  "/pyq/:paperId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { paperId } = req.params;

    if (!paperId || !/^pyq-[A-Za-z0-9_.-]{1,120}$/.test(paperId)) {
      return res.status(400).json({ error: "Invalid paper id." });
    }

    const doc = await db.collection("sharedPyq").findOne({ _id: paperId });
    if (!doc) return res.status(404).json(null);
    const { _id, ...paper } = doc;
    res.json(paper);
  })
);

// Store community imported official PYQ paper
router.post(
  "/pyq/:paperId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { paperId } = req.params;
    const paper = req.body || {};

    if (!paperId || !/^pyq-[A-Za-z0-9_.-]{1,120}$/.test(paperId) || paper.paperId !== paperId) {
      return res.status(400).json({ error: "Invalid paper id." });
    }

    if (!Array.isArray(paper.q) || !paper.q.length) {
      return res.status(400).json({ error: "Questions list required." });
    }

    const cleanRows = paper.q.slice(0, 250).map((row) => {
      if (Array.isArray(row) && row.length >= 5) {
        return [
          Number(row[0]) || 0,
          String(row[1] ?? "").slice(0, 2000),
          Array.isArray(row[2]) ? row[2].slice(0, 4).map((o) => String(o ?? "").slice(0, 1000)) : [],
          String(row[3] ?? "").slice(0, 10),
          Number(row[4]) || 0,
        ];
      }
      return null;
    }).filter(Boolean);

    const doc = {
      _id: paperId,
      v: 1,
      paperId,
      paperCode: String(paper.paperCode ?? "").slice(0, 40),
      language: String(paper.language ?? "").slice(0, 40),
      categoryCodes: Array.isArray(paper.categoryCodes)
        ? paper.categoryCodes.slice(0, 40).map((c) => String(c).slice(0, 40))
        : [],
      key: ["final", "provisional"].includes(paper.key) ? paper.key : null,
      method: ["text", "ocr-gemini", "ocr-tesseract"].includes(paper.method) ? paper.method : "text",
      count: cleanRows.length,
      q: cleanRows,
      createdAt: new Date(),
    };

    const result = await db.collection("sharedPyq").updateOne(
      { _id: paperId },
      { $setOnInsert: doc },
      { upsert: true }
    );

    res.json({ result: result.upsertedCount > 0 ? "created" : "exists" });
  })
);

export default router;
