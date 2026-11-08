import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

// Bulk sync push (saves questions, attempts, resources in a batch)
router.post(
  "/push",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const { questions, attempts, resources } = req.body || {};

    let committed = 0;

    const saveBatch = async (colName, items) => {
      if (!Array.isArray(items) || !items.length) return;
      const ops = items
        .filter((item) => item && typeof item.id === "string")
        .map((item) => {
          const { id, ...rest } = item;
          return {
            updateOne: {
              filter: { _id: id, ownerId: uid },
              update: { $set: { ...rest, _id: id, ownerId: uid } },
              upsert: true,
            },
          };
        });

      if (ops.length) {
        const result = await db.collection(colName).bulkWrite(ops);
        committed += (result.upsertedCount || 0) + (result.modifiedCount || 0);
      }
    };

    await Promise.all([
      saveBatch("questions", questions),
      saveBatch("attempts", attempts),
      saveBatch("resources", resources),
    ]);

    res.json({ ok: true, committed });
  })
);

// Full sync pull for workspace loading
router.get(
  "/pull",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;

    const [questions, attempts, resources] = await Promise.all([
      db.collection("questions").find({ ownerId: uid }).toArray(),
      db.collection("attempts").find({ ownerId: uid }).sort({ createdAt: -1 }).toArray(),
      db.collection("resources").find({ ownerId: uid }).toArray(),
    ]);

    const normalize = (rows) =>
      rows.map(({ _id, ...rest }) => ({ id: _id, ...rest }));

    res.json({
      questions: normalize(questions),
      attempts: normalize(attempts),
      resources: normalize(resources),
      issues: [],
    });
  })
);

// Paginated attempts page
router.get(
  "/attempts",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const { afterCreatedAt, afterId } = req.query;

    const filter = { ownerId: uid };
    if (afterCreatedAt !== undefined && afterId !== undefined) {
      const ts =
        typeof afterCreatedAt === "string" && !isNaN(Number(afterCreatedAt))
          ? Number(afterCreatedAt)
          : afterCreatedAt;

      filter.$or = [
        { createdAt: { $lt: ts } },
        { createdAt: ts, _id: { $lt: String(afterId) } },
      ];
    }

    const docs = await db
      .collection("attempts")
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .toArray();

    const rows = docs.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
    const last = rows.at(-1);

    const next =
      rows.length === limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : undefined;

    res.json({ rows, next });
  })
);

export default router;
