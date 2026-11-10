import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { getDb, closeDb } from "./db.js";
import syncRoutes from "./routes/sync.js";
import userRoutes from "./routes/user.js";
import sharedRoutes from "./routes/shared.js";
import billingRoutes from "./routes/billing.js";
import supportRoutes from "./routes/support.js";
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import pyqRoutes from "./routes/pyq.js";
import { apiLimiter, authLimiter, syncPushLimiter, paymentLimiter, aiLimiter } from "./rateLimiter.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Trust the first reverse proxy hop (Nginx) so req.ip and express-rate-limit accurately identify client IPs
app.set("trust proxy", 1);

// Frontend origin allowlist
const defaultAllowedOrigins = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "https://psc-prep-studio.vercel.app",
];

const envAllowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOriginsSet = new Set([...defaultAllowedOrigins, ...envAllowed]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // Non-browser / same-origin / mobile apps / server-to-server
  if (allowedOriginsSet.has(origin)) return true;
  // Allow Vercel preview deployments (e.g. psc-prep-studio-git-feat-...vercel.app)
  if (/^https:\/\/psc-prep-studio(-[a-z0-9-]+)?\.vercel\.app$/.test(origin)) return true;
  return false;
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        // Disallow arbitrary cross-origin requests
        callback(null, false);
      }
    },
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "x-razorpay-signature",
      "x-razorpay-event-id",
    ],
  })
);
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    const has = (k) => Boolean(process.env[k]?.trim());
    res.json({
      status: "ok",
      database: "mongodb",
      time: new Date().toISOString(),
      firebase: {
        serviceAccountJson: "mongodb-backend",
        serviceAccountBase64: "none",
        serviceAccountProject: process.env.FIREBASE_PROJECT_ID || "psc-prep-studio",
        siteProject: process.env.FIREBASE_PROJECT_ID || "psc-prep-studio",
        projectsMatch: true,
        conflictingAccounts: false,
        firestore: "ok",
        firestoreError: null,
      },
      razorpay: {
        keyId: has("RAZORPAY_KEY_ID"),
        mode: process.env.RAZORPAY_KEY_ID?.startsWith("rzp_live_") ? "live" : process.env.RAZORPAY_KEY_ID ? "test" : null,
        keySecret: has("RAZORPAY_KEY_SECRET"),
        webhookSecret: has("RAZORPAY_WEBHOOK_SECRET"),
      },
      aiMasterKey: has("AI_KEYS_MASTER_KEY"),
      cronSecret: has("CRON_SECRET"),
      ga4Property: has("GA4_PROPERTY_ID"),
      email: {
        configured: has("RESEND_API_KEY") || (has("SMTP_HOST") && has("SMTP_USER")),
        provider: has("RESEND_API_KEY") ? "resend" : has("SMTP_HOST") ? "smtp" : null,
        from: has("EMAIL_FROM"),
      },
    });
  } catch (err) {
    res.status(503).json({
      status: "error",
      database: "mongodb",
      error: err.message,
    });
  }
});

// Rate limiters for security and anti-spam protection
app.use("/api", apiLimiter);
app.use("/api/auth", authLimiter);
app.use("/api/sync/push", syncPushLimiter);
app.use("/api/payments/order", paymentLimiter);
app.use("/api/ai", aiLimiter);

// Mount modular routes
app.use("/api/sync", syncRoutes);
app.use("/api/user", userRoutes);
app.use("/api/shared", sharedRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/pyq", pyqRoutes);
app.use("/api", syncRoutes); // mounts /api/attempts, etc.
app.use("/api", billingRoutes); // mounts /api/me, /api/billing/config, /api/ai/allowance, etc.

// Global 404
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("[error]", err);
  void import("./adminNotifier.js").then((m) =>
    m.notifyCriticalError({
      error: err,
      context: `${req.method} ${req.originalUrl || req.url}`,
      req,
    }).catch(() => undefined)
  );
  res.status(500).json({ error: "Internal server error" });
});

async function start() {
  try {
    await getDb();
    console.log("[db] Connected to MongoDB");
    const server = app.listen(PORT, "127.0.0.1", () => {
      console.log(`[server] PSC Express backend listening on http://127.0.0.1:${PORT}`);
    });

    const shutdown = async () => {
      console.log("\n[server] Shutting down...");
      server.close(async () => {
        await closeDb();
        console.log("[db] MongoDB connection closed.");
        process.exit(0);
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    console.error("[fatal] Failed to start server:", err);
    process.exit(1);
  }
}

export { app };
export default app;

start();
