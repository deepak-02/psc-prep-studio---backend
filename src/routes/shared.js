import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

// Query shared community practice questions
router.get("/questions", requireAuth, async (req, res) => {
  const db = await getDb();
  const { level, category, regionalLanguage, difficulty, language, limit } = req.query;

  const query = {};
  if (level) query.level = String(level);
  if (category) query.category = String(category);
  if (regionalLanguage !== undefined) query.regionalLanguage = String(regionalLanguage);
  if (difficulty) query.difficulty = String(difficulty);
  if (language) query.language = String(language);

  const max = Math.max(1, Math.min(100, Number(limit) || 30));

  try {
    const docs = await db.collection("sharedQuestions").find(query).limit(max).toArray();
    res.json(docs);
  } catch (err) {
    console.error("[shared/questions-get]", err);
    res.status(500).json({ error: "Failed to query shared questions." });
  }
});

// Contribute a question to the shared practice pool
router.post("/questions", requireAuth, async (req, res) => {
  const db = await getDb();
  const record = req.body;
  const fp = record?.fingerprint;

  if (!fp || typeof fp !== "string" || !/^[a-f0-9]{64}$/.test(fp)) {
    return res.status(400).json({ error: "Invalid fingerprint." });
  }

  try {
    const result = await db.collection("sharedQuestions").updateOne(
      { _id: fp },
      { $setOnInsert: { ...record, _id: fp, createdAt: new Date() } },
      { upsert: true }
    );

    res.json({ result: result.upsertedCount > 0 ? "created" : "exists" });
  } catch (err) {
    console.error("[shared/questions-post]", err);
    res.status(500).json({ error: "Failed to store question." });
  }
});

// Fetch community imported official PYQ paper
router.get("/pyq/:paperId", requireAuth, async (req, res) => {
  const db = await getDb();
  const { paperId } = req.params;

  try {
    const doc = await db.collection("sharedPyq").findOne({ _id: paperId });
    if (!doc) return res.status(404).json(null);
    const { _id, ...paper } = doc;
    res.json(paper);
  } catch (err) {
    console.error("[shared/pyq-get]", err);
    res.status(500).json({ error: "Failed to load PYQ paper." });
  }
});

// Store community imported official PYQ paper
router.post("/pyq/:paperId", requireAuth, async (req, res) => {
  const db = await getDb();
  const { paperId } = req.params;
  const paper = req.body;

  if (!paper || paper.paperId !== paperId) {
    return res.status(400).json({ error: "Invalid paper data." });
  }

  try {
    const result = await db.collection("sharedPyq").updateOne(
      { _id: paperId },
      { $setOnInsert: { ...paper, _id: paperId, createdAt: new Date() } },
      { upsert: true }
    );

    res.json({ result: result.upsertedCount > 0 ? "created" : "exists" });
  } catch (err) {
    console.error("[shared/pyq-post]", err);
    res.status(500).json({ error: "Failed to store PYQ paper." });
  }
});

export default router;
