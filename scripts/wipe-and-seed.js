import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import { DEFAULT_BILLING_CONFIG } from "../src/billing/plans.js";

dotenv.config();

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/psc";
const client = new MongoClient(uri);

async function wipeAndSeed() {
  console.log("[wipe] Connecting to MongoDB at", uri);
  await client.connect();
  const db = client.db();

  const collections = [
    "users",
    "questions",
    "attempts",
    "resources",
    "sharedQuestions",
    "purchases",
    "tests",
    "payments",
    "entitlements",
    "support",
    "adminAuditLogs",
    "aiUsageMonthly",
    "aiUsageDaily",
  ];

  console.log("[wipe] Clearing collections...");
  for (const name of collections) {
    try {
      const res = await db.collection(name).deleteMany({});
      console.log(`  ✓ Cleared ${name} (${res.deletedCount} records deleted)`);
    } catch (e) {
      console.warn(`  ! Note on ${name}:`, e.message);
    }
  }

  console.log("[seed] Seeding fresh default billingConfig...");
  await db.collection("billingConfig").updateOne(
    { _id: "current" },
    { $set: { ...DEFAULT_BILLING_CONFIG, version: 1, updatedAt: Date.now() } },
    { upsert: true }
  );
  console.log("  ✓ billingConfig seeded");

  console.log("[indexes] Re-creating optimized database indexes...");
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }),
    db.collection("users").createIndex({ lastSeen: -1 }),
    db.collection("questions").createIndex({ ownerId: 1, updatedAt: -1 }),
    db.collection("questions").createIndex({ ownerId: 1, category: 1 }),
    db.collection("attempts").createIndex({ ownerId: 1, createdAt: -1, _id: -1 }),
    db.collection("resources").createIndex({ ownerId: 1 }),
    db.collection("sharedQuestions").createIndex({
      level: 1,
      category: 1,
      difficulty: 1,
      language: 1,
    }),
    db.collection("purchases").createIndex({ uid: 1, itemKey: 1 }),
    db.collection("tests").createIndex({ uid: 1 }),
    db.collection("payments").createIndex({ uid: 1, createdAt: -1 }),
    db.collection("payments").createIndex({ orderId: 1 }),
    db.collection("adminAuditLogs").createIndex({ at: -1 }),
    db.collection("support").createIndex({ createdAt: -1 }),
  ]);
  console.log("  ✓ All compound indexes created");

  console.log("\n[done] MongoDB has been completely wiped and freshly re-seeded!");
  await client.close();
}

wipeAndSeed().catch((err) => {
  console.error("[fatal] Wipe and seed failed:", err);
  process.exit(1);
});
