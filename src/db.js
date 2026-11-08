import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/psc";
const client = new MongoClient(uri, {
  maxPoolSize: 20,
  minPoolSize: 2,
});

let db = null;

export async function getDb() {
  if (!db) {
    await client.connect();
    db = client.db();

    // Ensure essential indexes concurrently
    await Promise.all([
      db.collection("users").createIndex({ email: 1 }),
      db.collection("questions").createIndex({ ownerId: 1 }),
      db.collection("attempts").createIndex({ ownerId: 1, createdAt: -1 }),
      db.collection("resources").createIndex({ ownerId: 1 }),
      db.collection("sharedQuestions").createIndex({
        level: 1,
        category: 1,
        difficulty: 1,
        language: 1,
      }),
      db.collection("purchases").createIndex({ uid: 1 }),
      db.collection("tests").createIndex({ uid: 1 }),
      db.collection("payments").createIndex({ uid: 1, createdAt: -1 }),
      db.collection("adminAuditLogs").createIndex({ at: -1 }),
      db.collection("support").createIndex({ createdAt: -1 }),
    ]);
  }
  return db;
}

export async function closeDb() {
  if (client) {
    await client.close();
    db = null;
  }
}
