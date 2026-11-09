import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth, requireAdmin } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { reconcileOrders } from "./billing.js";
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

// Overview stats (strictly matches AdminPage.tsx Overview interface)
router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const now = Date.now();
    const day = 86_400_000;

    const [users, ents] = await Promise.all([
      db.collection("users").find({}).toArray(),
      db.collection("entitlements").find({}).toArray(),
    ]);

    const total = users.length;
    let verified = 0;
    let active7 = 0;
    const signups = {};

    for (let i = 0; i < 30; i++) {
      const d = new Date(now - (29 - i) * day).toISOString().slice(0, 10);
      signups[d] = 0;
    }

    for (const u of users) {
      if (u.emailVerified) verified++;
      const created = u.createdAt ? new Date(u.createdAt).getTime() : 0;
      const last = u.lastSeen ? new Date(u.lastSeen).getTime() : 0;
      if (created && now - created < 30 * day) {
        const k = new Date(created).toISOString().slice(0, 10);
        signups[k] = (signups[k] ?? 0) + 1;
      }
      if (last && now - last < 7 * day) {
        active7++;
      }
    }

    let pro = 0;
    let annual = 0;
    let expired = 0;
    let video = 0;

    for (const eDoc of ents) {
      const e = normaliseEntitlement(eDoc._id, eDoc);
      if (isPro(e, now)) {
        pro++;
        if (e.planId === "pro_annual") annual++;
      } else if (
        e.planStatus === "expired" ||
        (e.planId !== "free" && (e.subscriptionExpiresAt ?? 0) <= now)
      ) {
        expired++;
      }
      if (e.videoStudio) video++;
    }

    res.json({
      users: { total, verified, active7, signups },
      plans: { pro, annual, expired, video },
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
    const plan = req.query.plan ?? "";
    const sort = req.query.sort ?? "newest";

    const configDoc = await db.collection("billingConfig").findOne({ _id: "current" });
    const config = configDoc ? normaliseConfig(configDoc) : DEFAULT_BILLING_CONFIG;

    const [allUsers, allEnts] = await Promise.all([
      db.collection("users").find({}).toArray(),
      db.collection("entitlements").find({}).toArray(),
    ]);

    const entMap = new Map(allEnts.map((e) => [e._id, e]));

    let rows = allUsers.map((u) => {
      const raw = entMap.get(u._id);
      const e = raw ? normaliseEntitlement(u._id, raw) : emptyEntitlement(u._id, u.email);
      const pro = isPro(e);
      const providers = Array.isArray(u.providers) && u.providers.length > 0 ? u.providers : ["password"];
      const createdAt = u.createdAt ? (typeof u.createdAt === "number" ? u.createdAt : Date.parse(u.createdAt) || null) : null;
      const lastSignIn = u.lastSeen ? (typeof u.lastSeen === "number" ? u.lastSeen : Date.parse(u.lastSeen) || null) : null;
      return {
        uid: u._id,
        email: u.email ?? null,
        name: u.name ?? null,
        disabled: Boolean(u.disabled || e.disabled),
        verified: Boolean(u.emailVerified ?? u.verified ?? false),
        providers,
        createdAt,
        lastSignIn,
        entitlement: e,
        pro,
        quotas: remainingQuotas(config, e),
      };
    });

    const counts = {
      all: rows.length,
      pro: rows.filter((r) => r.pro).length,
      free: rows.filter((r) => !r.pro).length,
      video: rows.filter((r) => r.entitlement?.videoStudio).length,
      disabled: rows.filter((r) => r.disabled).length,
    };

    if (query) {
      rows = rows.filter(
        (u) =>
          (u.email ?? "").toLowerCase().includes(query) ||
          (u.name ?? "").toLowerCase().includes(query) ||
          u.uid.toLowerCase() === query
      );
    }

    if (plan === "pro") rows = rows.filter((r) => r.pro);
    else if (plan === "free") rows = rows.filter((r) => !r.pro);
    else if (plan === "video") rows = rows.filter((r) => r.entitlement?.videoStudio);
    else if (plan === "disabled") rows = rows.filter((r) => r.disabled);
    else if (plan === "unverified") rows = rows.filter((r) => !r.verified);

    rows.sort(
      sort === "active"
        ? (x, y) => (y.lastSignIn ?? 0) - (x.lastSignIn ?? 0)
        : sort === "name"
        ? (x, y) => (x.name || x.email || "").localeCompare(y.name || y.email || "")
        : sort === "oldest"
        ? (x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0)
        : (x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0)
    );

    const total = rows.length;
    const paginated = rows.slice((page - 1) * pageSize, page * pageSize);

    res.json({
      users: paginated,
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize) || 1,
      counts,
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

// Admin payments list with revenue summary
router.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(5, Math.min(100, Number(req.query.pageSize) || 25));
    const from = Number(req.query.from) || 0;
    const to = Number(req.query.to) || Date.now() + 86_400_000;

    const filter = {};
    if (from || to) {
      filter.createdAt = { $gte: from, $lt: to };
    }

    const [rows, total, allMatching] = await Promise.all([
      db
        .collection("payments")
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      db.collection("payments").countDocuments(filter),
      db.collection("payments").find(filter).toArray(),
    ]);

    const paid = allMatching.filter((r) => r.status === "paid" || r.status === "partially_refunded");
    const sum = (list) => list.reduce((n, r) => n + (r.amount || 0) - (r.refundedAmount || 0), 0);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const summary = {
      revenue: sum(paid),
      thisMonth: sum(paid.filter((r) => (r.paidAt || 0) >= monthStart.getTime())),
      annual: sum(paid.filter((r) => r.product === "pro_annual")),
      monthly: sum(paid.filter((r) => r.product === "pro_monthly")),
      payg: sum(paid.filter((r) => r.product && !r.product.startsWith("pro_"))),
      newSubscriptions: paid.filter((r) => r.product && r.product.startsWith("pro_")).length,
      failed: allMatching.filter((r) => r.status === "failed" || (r.failures?.length || 0) > 0).length,
      refunds: allMatching.reduce((n, r) => n + (r.refundedAmount || 0), 0),
      refundCount: allMatching.filter((r) => (r.refunds?.length || 0) > 0).length,
      count: allMatching.length,
    };

    const items = rows.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
    res.json({
      summary,
      payments: items,
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize) || 1,
    });
  })
);

router.post(
  "/payments/reconcile",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const result = await reconcileOrders(db, { maxAgeMs: 7 * 86_400_000 });
    await logAudit(db, req.user.email, "reconcile", "payments", result.summary);
    res.json(result);
  })
);

router.get(
  "/payments/:id",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { id } = req.params;
    const doc = await db.collection("payments").findOne({
      $or: [{ _id: id }, { orderId: id }, { internalOrderId: id }, { paymentId: id }],
    });
    if (!doc) return res.status(404).json({ error: "Payment not found." });
    const { _id, ...rest } = doc;
    res.json({ payment: { id: _id, ...rest } });
  })
);

// Get & Update billing config
router.get(
  "/billing-config",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const [doc, history] = await Promise.all([
      db.collection("billingConfig").findOne({ _id: "current" }),
      db.collection("billingConfigHistory").find({}).sort({ version: -1 }).limit(10).toArray(),
    ]);
    res.json({
      config: doc ? normaliseConfig(doc) : DEFAULT_BILLING_CONFIG,
      history: history.map((h) => ({
        version: h.version,
        updatedAt: h.updatedAt,
        updatedBy: h.updatedBy ?? null,
      })),
    });
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
      db
        .collection("adminAuditLogs")
        .find({})
        .sort({ at: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
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

router.post(
  "/support/:kind/:id",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { id } = req.params;
    const { status, note } = req.body || {};
    const update = { status: status || "open" };
    if (note !== undefined) update.adminNote = note;
    await db.collection("support").updateOne({ _id: id }, { $set: update });
    await logAudit(db, req.user.email, "support_update", id, update);
    res.json({ ok: true });
  })
);

router.post(
  "/support/tickets/:id/reply",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { id } = req.params;
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ error: "Message is required" });
    const reply = { at: Date.now(), by: req.user.email, text: message };
    await db.collection("support").updateOne(
      { _id: id },
      { $push: { replies: reply }, $set: { status: "in_progress" } }
    );
    await logAudit(db, req.user.email, "support_reply", id, { text: message.slice(0, 100) });
    res.json({ ok: true });
  })
);

const DEFAULT_AI_CONFIG = {
  version: 1,
  order: [],
  providers: {
    gemini: { enabled: true, model: "gemini-2.5-flash", inputCostPerM: 0.1, outputCostPerM: 0.4 },
    openai: { enabled: true, model: "gpt-4o-mini", inputCostPerM: 0.15, outputCostPerM: 0.6 },
  },
  retry: { maxRetriesPerKey: 1, rateLimitCooldownSec: 60, quotaCooldownMin: 360, authCooldownMin: 1440 },
  limits: { requestTimeoutMs: 90000, maxOutputTokens: 32768, maxQuestionsPerRequest: 20, dailyCostLimitUsd: 2, maxTotalMs: 240000 },
  usdToInr: 88,
};

// AI tab
router.get(
  "/ai",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { secretsConfigured } = await import("../aiSecrets.js");
    const doc = await db.collection("aiConfig").findOne({ _id: "current" });
    const keys = await db.collection("aiKeys").find({}).toArray();
    res.json({
      config: doc ? { ...DEFAULT_AI_CONFIG, ...doc } : DEFAULT_AI_CONFIG,
      keys: keys.map(({ _id, ...k }) => ({ id: _id, ...k })),
      usage: [],
      secretsConfigured: secretsConfigured(),
      maxKeysPerProvider: 5,
    });
  })
);

router.put(
  "/ai/config",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const config = { ...DEFAULT_AI_CONFIG, ...(req.body.config || {}) };
    await db.collection("aiConfig").updateOne({ _id: "current" }, { $set: config }, { upsert: true });
    await logAudit(db, req.user.email, "ai_config_update", "aiConfig", config);
    res.json({ ok: true, config });
  })
);

router.post(
  "/ai/keys",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { secretsConfigured, seal, mask, testProviderKey } = await import("../aiSecrets.js");
    const { provider, label, apiKey, test } = req.body || {};

    if (provider !== "gemini" && provider !== "openai") {
      return res.status(400).json({ error: "Unknown provider." });
    }
    const key = String(apiKey || "").trim();
    if (key.length < 20 || key.length > 300 || /\s/.test(key)) {
      return res.status(400).json({ error: "That does not look like a valid API key." });
    }
    if (!secretsConfigured()) {
      return res.status(503).json({ error: "Set AI_KEYS_MASTER_KEY on the backend server before adding keys." });
    }

    const existingKeys = await db.collection("aiKeys").find({ provider }).toArray();
    if (existingKeys.length >= 5) {
      return res.status(409).json({ error: `Up to 5 ${provider} keys allowed.` });
    }

    if (test !== false) {
      try {
        await testProviderKey(provider, key);
      } catch (err) {
        return res.status(400).json({ error: `Key test failed: ${err.message}` });
      }
    }

    const id = `${provider}_${Math.random().toString(36).slice(2, 14)}`;
    const sealed = seal(key, id);
    const meta = {
      _id: id,
      id,
      provider,
      label: String(label || "").trim().slice(0, 40) || `${provider} key`,
      masked: mask(key),
      enabled: true,
      createdAt: Date.now(),
      health: "healthy",
      failureCount: 0,
      consecutiveFailures: 0,
      lastSuccessAt: Date.now(),
      lastFailureAt: null,
      lastError: null,
      cooldownUntil: null,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };

    await db.collection("aiSecrets").updateOne({ _id: id }, { $set: { _id: id, sealed, provider, updatedAt: Date.now() } }, { upsert: true });
    await db.collection("aiKeys").updateOne({ _id: id }, { $set: meta }, { upsert: true });

    const doc = await db.collection("aiConfig").findOne({ _id: "current" });
    const order = doc?.order || [];
    if (!order.includes(id)) {
      await db.collection("aiConfig").updateOne({ _id: "current" }, { $set: { order: [...order, id] } }, { upsert: true });
    }

    await logAudit(db, req.user.email, "ai_key_add", id, { provider, label: meta.label, masked: meta.masked });
    res.json({ ok: true, key: meta, ...meta });
  })
);

router.post(
  "/ai/keys/:id",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { seal, mask, secretsConfigured } = await import("../aiSecrets.js");
    const { id } = req.params;
    const { label, enabled, apiKey } = req.body || {};

    const existing = await db.collection("aiKeys").findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: "Key not found." });

    const change = {};
    if (typeof label === "string") change.label = label.trim().slice(0, 40) || existing.label;
    if (typeof enabled === "boolean") {
      change.enabled = enabled;
      if (enabled) {
        change.cooldownUntil = null;
        change.consecutiveFailures = 0;
      }
    }
    if (typeof apiKey === "string" && apiKey.trim()) {
      const key = apiKey.trim();
      if (key.length < 20 || /\s/.test(key)) return res.status(400).json({ error: "Invalid API key format." });
      if (!secretsConfigured()) return res.status(503).json({ error: "AI_KEYS_MASTER_KEY is not configured." });
      const sealed = seal(key, id);
      await db.collection("aiSecrets").updateOne({ _id: id }, { $set: { sealed, updatedAt: Date.now() } });
      change.masked = mask(key);
      change.health = "healthy";
      change.consecutiveFailures = 0;
      change.cooldownUntil = null;
      change.lastError = null;
    }

    await db.collection("aiKeys").updateOne({ _id: id }, { $set: change });
    await logAudit(db, req.user.email, apiKey ? "ai_key_replace" : "ai_key_update", id, change);
    res.json({ key: { ...existing, ...change } });
  })
);

router.post(
  "/ai/keys/:id/test",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { open, testProviderKey } = await import("../aiSecrets.js");
    const { id } = req.params;

    const sec = await db.collection("aiSecrets").findOne({ _id: id });
    if (!sec) return res.status(404).json({ error: "Key secret not found." });

    try {
      const rawKey = open(sec.sealed, id);
      await testProviderKey(sec.provider, rawKey);
      await db.collection("aiKeys").updateOne({ _id: id }, { $set: { health: "healthy", lastSuccessAt: Date.now(), lastError: null } });
      await logAudit(db, req.user.email, "ai_key_test", id, { ok: true });
      res.json({ ok: true });
    } catch (e) {
      await db.collection("aiKeys").updateOne({ _id: id }, { $set: { health: "failing", lastFailureAt: Date.now(), lastError: e.message } });
      await logAudit(db, req.user.email, "ai_key_test", id, { ok: false, error: e.message });
      res.json({ ok: false, kind: e.message });
    }
  })
);

router.post(
  "/ai/keys/:id/delete",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { id } = req.params;
    await db.collection("aiSecrets").deleteOne({ _id: id });
    await db.collection("aiKeys").deleteOne({ _id: id });
    const doc = await db.collection("aiConfig").findOne({ _id: "current" });
    if (doc?.order) {
      await db.collection("aiConfig").updateOne({ _id: "current" }, { $set: { order: doc.order.filter((x) => x !== id) } });
    }
    await logAudit(db, req.user.email, "ai_key_remove", id);
    res.json({ ok: true });
  })
);

// Email test
router.post(
  "/email/test",
  asyncHandler(async (req, res) => {
    res.json({ ok: true, to: req.user.email });
  })
);

// Filtered, searchable, paginated email log
router.get(
  "/email/log",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(5, Math.min(100, Number(req.query.pageSize) || 20));
    const template = req.query.template ? String(req.query.template).trim() : "";
    const status = req.query.status ? String(req.query.status).trim() : "";
    const q = req.query.q ? String(req.query.q).trim() : "";
    const sort = req.query.sort === "oldest" ? 1 : -1;

    const filter = {};
    if (template) filter.template = template;
    if (status === "sent") filter.ok = true;
    if (status === "failed") filter.ok = false;
    if (q) {
      filter.$or = [
        { to: { $regex: q, $options: "i" } },
        { subject: { $regex: q, $options: "i" } },
        { template: { $regex: q, $options: "i" } },
        { ref: { $regex: q, $options: "i" } },
        { error: { $regex: q, $options: "i" } },
      ];
    }

    const [items, total, templatesList] = await Promise.all([
      db
        .collection("emailLog")
        .find(filter)
        .sort({ at: sort })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      db.collection("emailLog").countDocuments(filter),
      db.collection("emailLog").distinct("template"),
    ]);

    res.json({
      items: items.map(({ _id, ...rest }) => ({ id: _id, ...rest })),
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize) || 1,
      templates: templatesList.filter(Boolean).sort(),
    });
  })
);

// Trigger sending weekly executive report to admin on demand
router.post(
  "/email/send-weekly",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { sendWeeklyDigest } = await import("../adminNotifier.js");
    const result = await sendWeeklyDigest();
    await logAudit(db, req.user.email, "send_weekly_report", "email", result);
    res.json(result);
  })
);

// Payment refund
router.post(
  "/payments/:orderId/refund",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { orderId } = req.params;
    const { amount, reason, revoke } = req.body || {};
    const payment = await db.collection("payments").findOne({ orderId });
    if (!payment) return res.status(404).json({ error: "Order not found" });
    const refundObj = {
      id: `ref_${Date.now()}`,
      amount: Number(amount) || payment.amount,
      status: "processed",
      at: Date.now(),
      by: req.user.email,
      revoked: Boolean(revoke),
      reason: reason || "Admin refund",
    };
    await db.collection("payments").updateOne(
      { orderId },
      {
        $push: { refunds: refundObj },
        $inc: { refundedAmount: refundObj.amount },
        $set: { status: "refunded" },
      }
    );
    await logAudit(db, req.user.email, "refund", orderId, refundObj);
    res.json({ status: "processed" });
  })
);

// Analytics report from Google Analytics Data API
router.get(
  "/analytics",
  asyncHandler(async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 28));
    const { gaReport } = await import("../analytics.js");
    const report = await gaReport(days);
    res.json(report);
  })
);

export default router;
