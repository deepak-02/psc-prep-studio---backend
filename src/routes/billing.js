import { Router } from "express";
import crypto from "node:crypto";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
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
router.get("/billing/config", async (req, res) => {
  const db = await getDb();
  const config = await readConfig(db);
  const keyId = process.env.RAZORPAY_KEY_ID ?? null;
  res.json({ enabled: Boolean(keyId), keyId, config });
});

// Current user entitlements and quotas
router.get("/me", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const config = await readConfig(db);
  const entitlement = await loadEntitlement(db, uid, req.user.email);

  await saveEntitlement(db, entitlement, req.user.email);
  await db.collection("users").updateOne(
    { _id: uid },
    { $set: { email: req.user.email, name: req.user.name, lastSeen: Date.now() } },
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
});

// User payment history and owned items
router.get("/me/payments", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;

  try {
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
  } catch (err) {
    console.error("[me/payments]", err);
    res.status(500).json({ error: "Failed to load payments." });
  }
});

// Check access to a resource / PYQ
router.post("/resources/check", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const key = String(req.body.key ?? "");

  if (!validItemKey(key)) return res.status(400).json({ error: "Invalid resource key." });

  const config = await readConfig(db);
  const entitlement = await loadEntitlement(db, uid, req.user.email);
  const owned = await db.collection("purchases").findOne({ _id: `${uid}_${docId(key)}` });

  res.json({ decision: decideItem(config, entitlement, key, Boolean(owned)) });
});

// Unlock a resource / PYQ
router.post("/resources/unlock", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const key = String(req.body.key ?? "");

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
});

// Reserve mock test
router.post("/tests/reserve", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const { requestId, count, testKey, source, pyqPaperId } = req.body;

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

  // Idempotent retry on same requestId
  if (entitlement.reservations[requestId]) {
    const r = entitlement.reservations[requestId];
    return res.json({ allowed: true, via: r.via, reservationId: requestId, entitlement });
  }

  // Official PYQ: user must own it or be Pro
  if (pyqPaperId) {
    const pyqKey = `pyq:${pyqPaperId}`;
    const owned = await db.collection("purchases").findOne({ _id: `${uid}_${docId(pyqKey)}` });
    const d = decideItem(config, entitlement, pyqKey, Boolean(owned));
    if (!d.allowed) {
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
});

// Commit mock test
router.post("/tests/commit", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const { reservationId, testKey, count } = req.body;

  const entitlement = await loadEntitlement(db, uid, req.user.email);
  const reservation = entitlement.reservations[reservationId];

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
});

// Release mock test reservation
router.post("/tests/release", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const { reservationId } = req.body;

  const entitlement = await loadEntitlement(db, uid, req.user.email);
  const next = releaseReservation(entitlement, reservationId);
  if (next !== entitlement) {
    await saveEntitlement(db, next, req.user.email);
  }

  res.json({ ok: true, entitlement: next });
});

// Create Razorpay Order
router.post("/payments/order", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const { product, items, idempotencyKey } = req.body;
  const config = await readConfig(db);

  const p = config.products[product];
  if (!p || !p.active) return res.status(400).json({ error: "Unavailable product." });

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return res.status(503).json({ error: "Payments are not configured." });

  // Idempotency
  if (idempotencyKey) {
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

  // Call Razorpay API
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
    items: Array.isArray(items) ? items : [],
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
});

// Verify Checkout and Settle
router.post("/payments/verify", requireAuth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return res.status(503).json({ error: "Payments not configured." });

  // Signature check
  const hmac = crypto.createHmac("sha256", keySecret);
  hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
  const expected = hmac.digest("hex");

  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: "Payment signature mismatch." });
  }

  const order = await db.collection("payments").findOne({ orderId: razorpay_order_id });
  if (!order) return res.status(404).json({ error: "Order not found." });

  const config = await readConfig(db);
  const entitlement = await loadEntitlement(db, uid, req.user.email);

  if (!order.entitlementGranted) {
    const next = grantProduct(config, entitlement, order.product, Date.now(), "payment", null);

    // If resource bundle, unlock the requested items
    if (order.product === "resource_bundle" && Array.isArray(order.items)) {
      const ops = order.items.map((k) => ({
        updateOne: {
          filter: { _id: `${uid}_${docId(k)}` },
          update: { $set: { uid, key: k, source: "payment", at: Date.now() } },
          upsert: true,
        },
      }));
      if (ops.length) await db.collection("purchases").bulkWrite(ops);
    }

    await Promise.all([
      saveEntitlement(db, next, req.user.email),
      db.collection("payments").updateOne(
        { orderId: razorpay_order_id },
        {
          $set: {
            status: "paid",
            entitlementGranted: true,
            paymentId: razorpay_payment_id,
            paidAt: Date.now(),
            settledVia: "verify",
          },
        }
      ),
    ]);

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
});

export default router;
