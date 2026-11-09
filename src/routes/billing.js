import { Router } from "express";
import crypto from "node:crypto";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import {
  DEFAULT_BILLING_CONFIG,
  normaliseConfig,
  normaliseEntitlement,
  emptyEntitlement,
  refreshSubscription,
  sweepReservations,
  decideTest,
  decideItem,
  applyReservation,
  releaseReservation,
  commitReservation,
  grantProduct,
  remainingQuotas,
  isPro,
  isFixedPaperSource,
  validItemKey,
  docId,
} from "../billing/plans.js";

const router = Router();

const RESERVATION_MS = 20 * 60_000;

async function readConfig(db) {
  const doc = await db.collection("billingConfig").findOne({ _id: "current" });
  return doc ? normaliseConfig(doc) : DEFAULT_BILLING_CONFIG;
}

async function loadEntitlement(db, uid, email = null) {
  const doc = await db.collection("entitlements").findOne({ _id: uid });
  const raw = doc ? normaliseEntitlement(uid, doc) : emptyEntitlement(uid, email);
  return sweepReservations(refreshSubscription(raw));
}

async function saveEntitlement(db, e, email = null) {
  await db.collection("entitlements").updateOne(
    { _id: e.uid },
    { $set: { ...e, email: email ?? e.email ?? null, updatedAt: Date.now() } },
    { upsert: true }
  );
}

// Public billing config
router.get(
  "/billing/config",
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const config = await readConfig(db);
    const keyId = process.env.RAZORPAY_KEY_ID?.trim() ?? null;
    res.json({ enabled: Boolean(keyId), keyId, config });
  })
);

// Current user entitlements and quotas
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const config = await readConfig(db);
    const entitlement = await loadEntitlement(db, uid, req.user.email);

    // Update user's lastSeen, profile & provider info on GET /me
    await db.collection("users").updateOne(
      { _id: uid },
      {
        $set: {
          email: req.user.email,
          name: req.user.name,
          emailVerified: req.user.emailVerified,
          providers: req.user.providers,
          lastSeen: Date.now(),
        },
        $setOnInsert: {
          createdAt: Date.now(),
        },
      },
      { upsert: true }
    );

    const adminEmail = process.env.ADMIN_EMAIL || "deepakck.ptf@gmail.com";
    const isAdmin = req.user.email === adminEmail && req.user.emailVerified;

    res.json({
      entitlement,
      quotas: remainingQuotas(config, entitlement),
      pro: isPro(entitlement),
      isAdmin,
    });
  })
);

// User payment history and owned items
// Monthly platform-AI allowance for this user
router.get(
  "/ai/allowance",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const config = await readConfig(db);
    const entitlement = await loadEntitlement(db, uid, req.user.email);
    const limit = entitlement.disabled
      ? 0
      : isPro(entitlement)
      ? config.pro?.monthlyAiAllowance ?? 0
      : config.free?.monthlyAiAllowance ?? 0;
    const month = new Date().toISOString().slice(0, 7).replace("-", "");
    const usageDoc = await db.collection("aiUsageMonthly").findOne({ _id: `${uid}_${month}` });
    const used = usageDoc?.generations || 0;
    res.json({
      limit,
      used,
      remaining: Math.max(0, limit - used),
      available: false,
    });
  })
);

router.get(
  "/me/payments",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;

    const [payments, purchases] = await Promise.all([
      db.collection("payments").find({ uid }).sort({ createdAt: -1 }).limit(100).toArray(),
      db.collection("purchases").find({ uid }).toArray(),
    ]);

    const attempted = (o) =>
      Boolean(o.paymentId) ||
      (o.failures?.length ?? 0) > 0 ||
      (o.autoRefunds?.length ?? 0) > 0 ||
      !["created", "expired"].includes(o.status);

    const rows = payments.filter(attempted).map((o) => ({
      orderId: o.orderId,
      internalOrderId: o.internalOrderId,
      product: o.product,
      productLabel: o.productLabel,
      items: o.items || [],
      amount: o.amount,
      currency: o.currency,
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt ?? null,
      paymentId: o.paymentId ?? null,
      method: o.method ?? null,
      refundedAmount: o.refundedAmount ?? 0,
    }));

    const items = purchases.map((p) => ({ key: p.key, source: p.source, at: p.at }));
    const unsettled = payments.some(
      (o) => o.status === "created" && Date.now() - o.createdAt > 3 * 60_000 && Date.now() - o.createdAt < 24 * 3_600_000
    );

    res.json({ payments: rows, items, unsettled });
  })
);

// Check access to a resource / PYQ
router.post(
  "/resources/check",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const key = String(req.body?.key ?? "");

    if (!validItemKey(key)) return res.status(400).json({ error: "Invalid resource key." });

    const config = await readConfig(db);
    const entitlement = await loadEntitlement(db, uid, req.user.email);
    const owned = await db.collection("purchases").findOne({ _id: `${uid}_${docId(key)}` });

    res.json({ decision: decideItem(config, entitlement, key, Boolean(owned)) });
  })
);

// Unlock a resource / PYQ
router.post(
  "/resources/unlock",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const key = String(req.body?.key ?? "");

    if (!validItemKey(key)) return res.status(400).json({ error: "Invalid resource key." });

    const adminEmail = process.env.ADMIN_EMAIL || "deepakck.ptf@gmail.com";
    if (req.user.email === adminEmail && req.user.emailVerified) {
      return res.json({ decision: { allowed: true, via: "pro" } });
    }

    const config = await readConfig(db);
    const entitlement = await loadEntitlement(db, uid, req.user.email);
    const owned = await db.collection("purchases").findOne({ _id: `${uid}_${docId(key)}` });

    const decision = decideItem(config, entitlement, key, Boolean(owned));
    if (!decision.allowed) {
      return res.json({ decision, entitlement });
    }

    if (decision.via === "free" || decision.via === "credit") {
      const next =
        decision.via === "free"
          ? { ...entitlement, freeResourcesUsed: entitlement.freeResourcesUsed + 1 }
          : { ...entitlement, resourceCredits: entitlement.resourceCredits - 1 };

      await Promise.all([
        db.collection("purchases").updateOne(
          { _id: `${uid}_${docId(key)}` },
          { $set: { uid, key, source: decision.via, at: Date.now() } },
          { upsert: true }
        ),
        saveEntitlement(db, next, req.user.email),
      ]);

      return res.json({ decision, entitlement: next });
    }

    res.json({ decision, entitlement });
  })
);

// Reserve mock test
router.post(
  "/tests/reserve",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const { requestId, count, testKey, source, pyqPaperId } = req.body || {};

    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
      return res.status(400).json({ error: "Invalid request id." });
    }

    const adminEmail = process.env.ADMIN_EMAIL || "deepakck.ptf@gmail.com";
    if (req.user.email === adminEmail && req.user.emailVerified) {
      return res.json({ allowed: true, via: "pro", reservationId: null });
    }

    const config = await readConfig(db);
    const entitlement = await loadEntitlement(db, uid, req.user.email);

    // Retake check: if paper already generated, it is free
    if (testKey) {
      const existing = await db.collection("tests").findOne({ _id: `${uid}_${docId(testKey)}` });
      if (existing) {
        return res.json({ allowed: true, via: "existing", reservationId: null, entitlement });
      }
    }

    // Idempotent retry on same requestId using hasOwn
    if (Object.hasOwn(entitlement.reservations, requestId)) {
      const r = entitlement.reservations[requestId];
      return res.json({ allowed: true, via: r.via, reservationId: requestId, entitlement });
    }

    // Official PYQ: user must own it or be Pro
    if (pyqPaperId) {
      const pyqKey = `pyq:${pyqPaperId}`;
      const owned = await db.collection("purchases").findOne({ _id: `${uid}_${docId(pyqKey)}` });
      const d = decideItem(config, entitlement, pyqKey, Boolean(owned));
      if (!d.allowed || (d.via !== "owned" && d.via !== "pro")) {
        return res.json({ allowed: false, decision: d, needsUnlock: true, entitlement });
      }
      return res.json({ allowed: true, via: "resource", reservationId: null, entitlement });
    }

    const decision = decideTest(config, entitlement, Number(count) || 1, Date.now(), {
      fixedPaper: isFixedPaperSource(source),
    });

    if (!decision.allowed) {
      return res.json({ allowed: false, decision, entitlement });
    }

    const reservation = {
      id: requestId,
      via: decision.via,
      ...(decision.credit ? { credit: decision.credit } : {}),
      count: Number(count),
      testKey: String(testKey || ""),
      createdAt: Date.now(),
      expiresAt: Date.now() + RESERVATION_MS,
    };

    const next = applyReservation(entitlement, reservation);
    await saveEntitlement(db, next, req.user.email);

    res.json({ allowed: true, via: decision.via, reservationId: requestId, entitlement: next });
  })
);

// Commit mock test
router.post(
  "/tests/commit",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const { reservationId, testKey, count } = req.body || {};

    if (typeof reservationId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(reservationId)) {
      return res.status(400).json({ error: "Invalid reservation id." });
    }

    const entitlement = await loadEntitlement(db, uid, req.user.email);
    const hasReservation = Object.hasOwn(entitlement.reservations, reservationId);
    const reservation = hasReservation ? entitlement.reservations[reservationId] : null;

    if (!reservation) {
      if (testKey) {
        const done = await db.collection("tests").findOne({ _id: `${uid}_${docId(testKey)}` });
        if (done) return res.json({ ok: true, entitlement });
      }
      return res.status(409).json({ error: "Reservation expired." });
    }

    const key = testKey || reservation.testKey;
    const next = commitReservation(entitlement, reservationId);

    await Promise.all([
      saveEntitlement(db, next, req.user.email),
      key
        ? db.collection("tests").updateOne(
            { _id: `${uid}_${docId(key)}` },
            {
              $set: {
                uid,
                testKey: key,
                count: Number(count) || reservation.count,
                via: reservation.via,
                createdAt: Date.now(),
                reservationId,
              },
            },
            { upsert: true }
          )
        : Promise.resolve(),
    ]);

    res.json({ ok: true, entitlement: next });
  })
);

// Release mock test reservation
router.post(
  "/tests/release",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const { reservationId } = req.body || {};

    if (typeof reservationId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(reservationId)) {
      return res.status(400).json({ error: "Invalid reservation id." });
    }

    const entitlement = await loadEntitlement(db, uid, req.user.email);
    if (!Object.hasOwn(entitlement.reservations, reservationId)) {
      return res.json({ ok: true, entitlement });
    }

    const next = releaseReservation(entitlement, reservationId);
    await saveEntitlement(db, next, req.user.email);

    res.json({ ok: true, entitlement: next });
  })
);

// Create Razorpay Order
router.post(
  "/payments/order",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const { product, items, idempotencyKey } = req.body || {};
    const config = await readConfig(db);

    const p = config.products[product];
    if (!p || !p.active) return res.status(400).json({ error: "Unavailable product." });

    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!keyId || !keySecret) return res.status(503).json({ error: "Payments are not configured." });

    // Validate and cap items for resource_bundle
    const cleanItems =
      product === "resource_bundle"
        ? [...new Set((Array.isArray(items) ? items : []).filter(validItemKey))].slice(0, p.quantity ?? 5)
        : [];

    if (product === "resource_bundle" && !cleanItems.length) {
      return res.status(400).json({ error: "Pick at least one resource to unlock." });
    }

    // Idempotency
    if (idempotencyKey && typeof idempotencyKey === "string") {
      const prior = await db.collection("payments").findOne({ uid, idempotencyKey });
      if (prior && prior.status === "created") {
        return res.json({
          orderId: prior.orderId,
          amount: prior.amount,
          currency: "INR",
          keyId,
          product,
          label: p.label,
          items: prior.items || [],
          email: req.user.email,
          name: req.user.name,
        });
      }
    }

    const internalOrderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Call Razorpay API with 15s timeout
    const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: p.price,
        currency: "INR",
        receipt: internalOrderId,
        notes: { app: "psc-prep-studio", uid, product, internalOrderId },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!rzpRes.ok) {
      const rzpErr = await rzpRes.text();
      console.error("[razorpay/createOrder]", rzpErr);
      return res.status(502).json({ error: "Failed to create payment order." });
    }

    const order = await rzpRes.json();

    const doc = {
      orderId: order.id,
      internalOrderId,
      uid,
      email: req.user.email,
      product,
      productLabel: p.label,
      items: cleanItems,
      amount: p.price,
      currency: "INR",
      configVersion: config.version,
      status: "created",
      entitlementGranted: false,
      idempotencyKey: idempotencyKey || null,
      createdAt: Date.now(),
    };

    await db.collection("payments").insertOne(doc);

    res.json({
      orderId: order.id,
      amount: p.price,
      currency: "INR",
      keyId,
      product,
      label: p.label,
      items: doc.items,
      email: req.user.email,
      name: req.user.name,
    });
  })
);

// Verify Checkout and Settle (Atomic Claim)
router.post(
  "/payments/verify",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!keySecret) return res.status(503).json({ error: "Payments not configured." });

    // Signature check
    const hmac = crypto.createHmac("sha256", keySecret);
    hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const expected = hmac.digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: "Payment signature mismatch." });
    }

    const order = await db.collection("payments").findOne({ orderId: razorpay_order_id, uid });
    if (!order) return res.status(404).json({ error: "Order not found." });

    // Atomically claim the order
    const claim = await db.collection("payments").updateOne(
      { orderId: razorpay_order_id, uid, entitlementGranted: false },
      {
        $set: {
          status: "paid",
          entitlementGranted: true,
          paymentId: razorpay_payment_id,
          paidAt: Date.now(),
          settledVia: "verify",
        },
      }
    );

    const config = await readConfig(db);
    const entitlement = await loadEntitlement(db, uid, req.user.email);

    if (claim.modifiedCount === 1) {
      const next = grantProduct(config, entitlement, order.product, Date.now(), "payment", null);

      if (order.product === "resource_bundle" && Array.isArray(order.items)) {
        const ops = order.items.filter(validItemKey).map((k) => ({
          updateOne: {
            filter: { _id: `${uid}_${docId(k)}` },
            update: { $set: { uid, key: k, source: "payment", at: Date.now() } },
            upsert: true,
          },
        }));
        if (ops.length) await db.collection("purchases").bulkWrite(ops);
      }

      await saveEntitlement(db, next, req.user.email);

      return res.json({
        verified: true,
        entitlement: next,
        quotas: remainingQuotas(config, next),
      });
    }

    res.json({
      verified: true,
      entitlement,
      quotas: remainingQuotas(config, entitlement),
    });
  })
);

export async function settleOrder(db, order, paymentId, settledVia = "verify", email = null) {
  const claim = await db.collection("payments").updateOne(
    { orderId: order.orderId, uid: order.uid, entitlementGranted: false },
    {
      $set: {
        status: "paid",
        entitlementGranted: true,
        paymentId,
        paidAt: Date.now(),
        settledVia,
      },
    }
  );

  const config = await readConfig(db);
  const entitlement = await loadEntitlement(db, order.uid, email);

  if (claim.modifiedCount === 1) {
    const next = grantProduct(config, entitlement, order.product, Date.now(), "payment", null);

    if (order.product === "resource_bundle" && Array.isArray(order.items)) {
      const ops = order.items.filter(validItemKey).map((k) => ({
        updateOne: {
          filter: { _id: `${order.uid}_${docId(k)}` },
          update: { $set: { uid: order.uid, key: k, source: "payment", at: Date.now() } },
          upsert: true,
        },
      }));
      if (ops.length) await db.collection("purchases").bulkWrite(ops);
    }

    await saveEntitlement(db, next, email);
    return { settled: true, entitlement: next, quotas: remainingQuotas(config, next) };
  }

  return { settled: false, entitlement, quotas: remainingQuotas(config, entitlement) };
}

export async function reconcileOrders(db, { uid, maxAgeMs = 7 * 86_400_000, limit = 50 } = {}) {
  const now = Date.now();
  const since = now - maxAgeMs;
  const query = {
    createdAt: { $gte: since },
    status: { $nin: ["refunded", "expired"] },
    entitlementGranted: { $ne: true },
  };
  if (uid) query.uid = uid;

  const orders = await db.collection("payments").find(query).sort({ createdAt: -1 }).limit(limit).toArray();
  const summary = { checked: orders.length, granted: 0, pending: 0, expired: 0, error: 0 };

  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();

  for (const o of orders) {
    try {
      if (!keyId || !keySecret) {
        summary.pending++;
        continue;
      }

      // Check with Razorpay REST API
      const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
      const rzpRes = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(o.orderId)}/payments`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!rzpRes.ok) {
        summary.error++;
        continue;
      }

      const data = await rzpRes.json();
      const items = Array.isArray(data.items) ? data.items : [];
      const live = items.find((p) => p.status === "captured" || p.status === "authorized");

      if (live) {
        const res = await settleOrder(db, o, live.id, "reconcile", o.email);
        if (res.settled) {
          summary.granted++;
        } else {
          summary.pending++;
        }
      } else {
        // Expire if older than 24 hours
        if (now - o.createdAt > 24 * 3_600_000 && o.status === "created") {
          await db.collection("payments").updateOne({ orderId: o.orderId }, { $set: { status: "expired", expiredAt: now } });
          summary.expired++;
        } else {
          summary.pending++;
        }
      }
    } catch {
      summary.error++;
    }
  }

  return { checked: orders.length, summary };
}

// Reconcile user's own unsettled payments
router.post(
  "/payments/reconcile-mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const uid = req.user.uid;
    const result = await reconcileOrders(db, { uid, maxAgeMs: 3 * 86_400_000 });
    res.json(result);
  })
);

// Razorpay webhook
router.post(
  "/payments/webhook",
  asyncHandler(async (req, res) => {
    const signature = req.headers["x-razorpay-signature"] ?? "";
    const eventId = req.headers["x-razorpay-event-id"] || null;
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) return res.status(503).json({ error: "Webhook secret not configured." });

    const rawBody = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body);
    const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    if (expected !== signature) {
      return res.status(400).json({ error: "Bad signature." });
    }

    const event = req.body || {};
    const db = await getDb();
    const evId = eventId || docId(rawBody);

    const first = await db.collection("webhookEvents").updateOne(
      { _id: evId },
      { $setOnInsert: { event: event.event ?? null, receivedAt: Date.now(), processed: false } },
      { upsert: true }
    );
    if (!first.upsertedCount) return res.json({ ok: true, duplicate: true });

    const p = event.payload?.payment?.entity;
    if ((event.event === "payment.captured" || event.event === "order.paid") && p?.order_id && p.status === "captured") {
      const order = await db.collection("payments").findOne({ orderId: p.order_id });
      if (order && !order.entitlementGranted) {
        await settleOrder(db, order, p.id, "webhook", order.email);
      }
    }

    await db.collection("webhookEvents").updateOne({ _id: evId }, { $set: { processed: true, processedAt: Date.now() } });
    res.json({ ok: true });
  })
);

export default router;
