import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth, requireAdmin } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import {
  DEFAULT_BILLING_CONFIG,
  normaliseConfig,
  normaliseEntitlement,
  emptyEntitlement,
  grantProduct,
  revokePro,
  isPro,
  remainingQuotas,
} from "../billing/plans.js";

const router = Router();

// Apply auth and admin check to all routes
router.use(requireAuth, requireAdmin);

async function logAudit(db, adminEmail, action, target, detail = null) {
  await db.collection("adminAuditLogs").insertOne({
    at: Date.now(),
    admin: adminEmail,
    action,
    target,
    detail,
  });
}

// Overview stats
router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const [totalUsers, activePro, paymentsCount, ticketsOpen] = await Promise.all([
      db.collection("users").countDocuments(),
      db.collection("entitlements").countDocuments({ planId: { $ne: "free" }, subscriptionExpiresAt: { $gt: Date.now() } }),
      db.collection("payments").countDocuments({ status: "paid" }),
      db.collection("support").countDocuments({ status: "open" }),
    ]);

    res.json({
      users: { total: totalUsers, activePro },
      payments: { paidCount: paymentsCount },
      support: { openCount: ticketsOpen },
    });
  })
);

// List users with entitlements
router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(5, Math.min(100, Number(req.query.pageSize) || 20));
    const query = (req.query.q ?? "").trim().toLowerCase();

    const filter = {};
    if (query) {
      filter.$or = [
        { email: { $regex: query, $options: "i" } },
        { name: { $regex: query, $options: "i" } },
        { _id: query },
      ];
    }

    const configDoc = await db.collection("billingConfig").findOne({ _id: "current" });
    const config = configDoc ? normaliseConfig(configDoc) : DEFAULT_BILLING_CONFIG;

    const [users, total] = await Promise.all([
      db.collection("users").find(filter).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      db.collection("users").countDocuments(filter),
    ]);

    const uids = users.map((u) => u._id);
    const entitlements = await db.collection("entitlements").find({ _id: { $in: uids } }).toArray();
    const entMap = new Map(entitlements.map((e) => [e._id, e]));

    const items = users.map((u) => {
      const raw = entMap.get(u._id);
      const e = raw ? normaliseEntitlement(u._id, raw) : emptyEntitlement(u._id, u.email);
      return {
        uid: u._id,
        email: u.email ?? null,
        name: u.name ?? null,
        lastSignIn: u.lastSeen ?? null,
        entitlement: e,
        pro: isPro(e),
        quotas: remainingQuotas(config, e),
      };
    });

    res.json({
      users: items,
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize) || 1,
    });
  })
);

// Update user entitlement
router.post(
  "/users/:uid",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { uid } = req.params;
    const { action, product, days, count, credit, enabled, disabled } = req.body || {};

    const raw = await db.collection("entitlements").findOne({ _id: uid });
    let e = raw ? normaliseEntitlement(uid, raw) : emptyEntitlement(uid);
    const configDoc = await db.collection("billingConfig").findOne({ _id: "current" });
    const config = configDoc ? normaliseConfig(configDoc) : DEFAULT_BILLING_CONFIG;

    switch (action) {
      case "grant_pro":
        if (product !== "pro_monthly" && product !== "pro_annual") {
          return res.status(400).json({ error: "Choose a Pro plan." });
        }
        e = grantProduct(config, e, product, Date.now(), "admin", null, Number(days) || undefined);
        break;
      case "revoke_pro":
        e = revokePro(e);
        break;
      case "set_video":
        e = { ...e, videoStudio: enabled === true };
        break;
      case "add_test_credits": {
        const k = credit === "test_50" ? "test_50" : "test_30";
        e = { ...e, credits: { ...e.credits, [k]: (e.credits[k] || 0) + (Number(count) || 0) } };
        break;
      }
      case "add_resource_credits":
        e = { ...e, resourceCredits: (e.resourceCredits || 0) + (Number(count) || 0) };
        break;
      case "reset_usage":
        e = { ...e, freeTestsUsed: 0, freeResourcesUsed: 0 };
        break;
      case "set_disabled":
        e = { ...e, disabled: disabled === true };
        break;
      default:
        return res.status(400).json({ error: "Unknown action." });
    }

    e.updatedAt = Date.now();
    await db.collection("entitlements").updateOne({ _id: uid }, { $set: e }, { upsert: true });
    await logAudit(db, req.user.email, action, uid, req.body);

    res.json({
      entitlement: e,
      pro: isPro(e),
      quotas: remainingQuotas(config, e),
    });
  })
);

// Admin payments list
router.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(5, Math.min(100, Number(req.query.pageSize) || 25));

    const [payments, total] = await Promise.all([
      db.collection("payments").find({}).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      db.collection("payments").countDocuments({}),
    ]);

    const items = payments.map(({ _id, ...rest }) => rest);
    res.json({
      payments: items,
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize) || 1,
    });
  })
);

// Get & Update billing config
router.get(
  "/billing-config",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const doc = await db.collection("billingConfig").findOne({ _id: "current" });
    res.json({ config: doc ? normaliseConfig(doc) : DEFAULT_BILLING_CONFIG });
  })
);

router.put(
  "/billing-config",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const nextConfig = normaliseConfig(req.body.config);
    nextConfig.version = (nextConfig.version || 1) + 1;
    nextConfig.updatedAt = Date.now();
    nextConfig.updatedBy = req.user.email;

    await db.collection("billingConfig").updateOne({ _id: "current" }, { $set: nextConfig }, { upsert: true });
    await logAudit(db, req.user.email, "billing_config_update", "billingConfig", nextConfig);

    res.json({ config: nextConfig });
  })
);

// Audit logs
router.get(
  "/audit",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(5, Math.min(100, Number(req.query.pageSize) || 25));

    const [logs, total] = await Promise.all([
      db.collection("adminAuditLogs").find({}).sort({ at: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      db.collection("adminAuditLogs").countDocuments({}),
    ]);

    res.json({
      logs: logs.map(({ _id, ...rest }) => ({ id: _id, ...rest })),
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize) || 1,
      actions: [],
    });
  })
);

// Support items
router.get(
  "/support",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const kind = req.query.kind === "feedback" ? "feedback" : "ticket";

    const items = await db.collection("support").find({ kind }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({
      items: items.map(({ _id, ...rest }) => ({ id: _id, ...rest })),
      total: items.length,
      pages: 1,
      page: 1,
      pageSize: 100,
    });
  })
);

export default router;
