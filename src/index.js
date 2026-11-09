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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: true, credentials: true }));
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
    res.json({
      status: "ok",
      database: "mongodb",
      time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: "error",
      database: "mongodb",
      error: err.message,
    });
  }
});

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
  res.status(500).json({ error: "Internal server error" });
});

async function start() {
  try {
    await getDb();
    console.log("[db] Connected to MongoDB");
    const server = app.listen(PORT, "0.0.0.0", () => {
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

start();
