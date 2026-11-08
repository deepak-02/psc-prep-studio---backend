import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

// Get remote user preferences
router.get("/preferences", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;

  try {
    const userDoc = await db.collection("users").findOne({ _id: uid });
    res.json(userDoc?.preferences ?? null);
  } catch (err) {
    console.error("[preferences/get]", err);
    res.status(500).json({ error: "Failed to load preferences." });
  }
});

// Save or sync remote preferences
router.put("/preferences", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const preferences = req.body;

  try {
    await db.collection("users").updateOne(
      { _id: uid },
      {
        $set: {
          preferences: { ...preferences, ownerId: uid, updatedAt: Date.now() },
          email: req.user.email,
          lastSeen: Date.now(),
        },
      },
      { upsert: true }
    );
    res.json({ ok: true, preferences });
  } catch (err) {
    console.error("[preferences/put]", err);
    res.status(500).json({ error: "Failed to save preferences." });
  }
});

// Vault: get encrypted Gemini key
router.get("/vault/gemini", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;

  try {
    const userDoc = await db.collection("users").findOne({ _id: uid });
    res.json(userDoc?.geminiKey ?? null);
  } catch (err) {
    console.error("[vault/get]", err);
    res.status(500).json({ error: "Failed to load vault key." });
  }
});

// Vault: save encrypted Gemini key
router.put("/vault/gemini", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const keyRecord = req.body;

  if (!keyRecord || keyRecord.ownerId !== uid) {
    return res.status(400).json({ error: "Invalid vault key record." });
  }

  try {
    await db.collection("users").updateOne(
      { _id: uid },
      { $set: { geminiKey: keyRecord, updatedAt: Date.now() } },
      { upsert: true }
    );
    res.json(keyRecord);
  } catch (err) {
    console.error("[vault/put]", err);
    res.status(500).json({ error: "Failed to save vault key." });
  }
});

// Vault: delete encrypted Gemini key
router.delete("/vault/gemini", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;

  try {
    await db.collection("users").updateOne(
      { _id: uid },
      { $unset: { geminiKey: "" }, $set: { updatedAt: Date.now() } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[vault/delete]", err);
    res.status(500).json({ error: "Failed to delete vault key." });
  }
});

// Delete user account data
router.delete("/data", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const isAdmin = req.user.email === process.env.ADMIN_EMAIL && req.user.emailVerified;
  const global = req.query.global === "true" && isAdmin;

  try {
    let userDeleted = 0;
    const [qDel, aDel, rDel] = await Promise.all([
      db.collection("questions").deleteMany(isAdmin && global ? {} : { ownerId: uid }),
      db.collection("attempts").deleteMany(isAdmin && global ? {} : { ownerId: uid }),
      db.collection("resources").deleteMany(isAdmin && global ? {} : { ownerId: uid }),
    ]);

    userDeleted = (qDel.deletedCount || 0) + (aDel.deletedCount || 0) + (rDel.deletedCount || 0);

    let globalDeleted = 0;
    if (global) {
      const [sqDel, spyqDel] = await Promise.all([
        db.collection("sharedQuestions").deleteMany({}),
        db.collection("sharedPyq").deleteMany({}),
      ]);
      globalDeleted = (sqDel.deletedCount || 0) + (spyqDel.deletedCount || 0);
    }

    res.json({ userDeleted, globalDeleted });
  } catch (err) {
    console.error("[user/data-delete]", err);
    res.status(500).json({ error: "Failed to delete data." });
  }
});

export default router;
