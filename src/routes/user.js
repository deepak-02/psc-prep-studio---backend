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
    res.json({ preferences: userDoc?.preferences ?? null });
  })
);

// Save or sync remote preferences
router.put(
  "/preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const preferences = req.body?.preferences ?? req.body ?? {};

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
    res.json({ key: userDoc?.geminiKey ?? null });
  })
);

// Vault: save encrypted Gemini key
router.put(
  "/vault/gemini",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const keyRecord = req.body?.key ?? req.body;

    if (!keyRecord || (keyRecord.ownerId && keyRecord.ownerId !== uid)) {
      return res.status(400).json({ error: "Invalid vault key record." });
    }

    const docToSave = { ...keyRecord, ownerId: uid };

    await db.collection("users").updateOne(
      { _id: uid },
      { $set: { geminiKey: docToSave, updatedAt: Date.now() } },
      { upsert: true }
    );
    res.json({ ok: true, key: docToSave });
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

    // Delete user questions, attempts, user entry, and purchases
    const [qRes, aRes, uRes, pRes] = await Promise.all([
      db.collection("questions").deleteMany({ ownerId: uid }),
      db.collection("attempts").deleteMany({ ownerId: uid }),
      db.collection("users").deleteOne({ _id: uid }),
      db.collection("purchases").deleteMany({ uid }),
    ]);

    res.json({
      ok: true,
      userDeleted: (qRes.deletedCount || 0) + (aRes.deletedCount || 0) + (uRes.deletedCount || 0),
      globalDeleted: 0,
    });
  })
);

export default router;
