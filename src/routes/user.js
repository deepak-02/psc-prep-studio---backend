import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

// Get remote user preferences
router.get(
  "/preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const userDoc = await db.collection("users").findOne({ _id: uid });
    res.json(userDoc?.preferences ?? null);
  })
);

// Save or sync remote preferences
router.put(
  "/preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const preferences = req.body || {};

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
  })
);

// Vault: get encrypted Gemini key
router.get(
  "/vault/gemini",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const userDoc = await db.collection("users").findOne({ _id: uid });
    res.json(userDoc?.geminiKey ?? null);
  })
);

// Vault: save encrypted Gemini key
router.put(
  "/vault/gemini",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const keyRecord = req.body;

    if (!keyRecord || keyRecord.ownerId !== uid) {
      return res.status(400).json({ error: "Invalid vault key record." });
    }

    await db.collection("users").updateOne(
      { _id: uid },
      { $set: { geminiKey: keyRecord, updatedAt: Date.now() } },
      { upsert: true }
    );
    res.json(keyRecord);
  })
);

// Vault: delete encrypted Gemini key
router.delete(
  "/vault/gemini",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;

    await db.collection("users").updateOne(
      { _id: uid },
      { $unset: { geminiKey: "" }, $set: { updatedAt: Date.now() } }
    );
    res.json({ ok: true });
  })
);

// Delete user account data
router.delete(
  "/data",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const isAdmin = req.user.email === process.env.ADMIN_EMAIL && req.user.emailVerified;
    const global = req.query.global === "true" && isAdmin;

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
  })
);

export default router;
