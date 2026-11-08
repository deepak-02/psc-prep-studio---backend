import admin from "firebase-admin";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

// 1. Initialize Firebase Admin
const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
let serviceAccount = null;

if (raw) {
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", e.message);
  }
} else if (b64) {
  try {
    serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64:", e.message);
  }
}

if (!serviceAccount) {
  console.error("No valid Firebase service account found in .env");
  process.exit(1);
}

if (serviceAccount.private_key) {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
});

const firestore = admin.firestore();

// 2. Initialize MongoDB
const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/psc";
const mongoClient = new MongoClient(mongoUri);

async function migrate() {
  console.log("Starting Firebase to MongoDB migration...");
  await mongoClient.connect();
  const mdb = mongoClient.db();

  console.log(`Connected to MongoDB at ${mongoUri.replace(/\/\/[^@/]+@/, "//***@")}`);
  const failedSteps = [];

  // Helper to convert Firestore Timestamps to Date or numbers
  const sanitize = (val) => {
    if (!val) return val;
    if (typeof val.toDate === "function") return val.toDate();
    if (Array.isArray(val)) return val.map(sanitize);
    if (typeof val === "object") {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = sanitize(v);
      }
      return out;
    }
    return val;
  };

  // Helper to insert or upsert a batch
  async function upsertBatch(colName, docs) {
    if (!docs.length) return 0;
    const ops = docs.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: doc },
        upsert: true,
      },
    }));
    const res = await mdb.collection(colName).bulkWrite(ops);
    return (res.upsertedCount || 0) + (res.modifiedCount || 0);
  }

  // 1. Migrate Shared Questions
  console.log("Migrating sharedQuestions...");
  try {
    const snap = await firestore.collection("sharedQuestions").get();
    const docs = snap.docs.map((d) => ({ _id: d.id, ...sanitize(d.data()) }));
    const count = await upsertBatch("sharedQuestions", docs);
    console.log(`  -> sharedQuestions: ${count} documents migrated.`);
  } catch (e) {
    console.warn("  -> Error reading sharedQuestions:", e.message);
    failedSteps.push("sharedQuestions");
  }

  // 2. Migrate Shared PYQs
  console.log("Migrating sharedPyq...");
  try {
    const snap = await firestore.collection("sharedPyq").get();
    const docs = snap.docs.map((d) => ({ _id: d.id, ...sanitize(d.data()) }));
    const count = await upsertBatch("sharedPyq", docs);
    console.log(`  -> sharedPyq: ${count} documents migrated.`);
  } catch (e) {
    console.warn("  -> Error reading sharedPyq:", e.message);
    failedSteps.push("sharedPyq");
  }

  // 3. Migrate Billing Config & History
  console.log("Migrating billingConfig...");
  try {
    const snap = await firestore.collection("billingConfig").get();
    const docs = snap.docs.map((d) => ({ _id: d.id, ...sanitize(d.data()) }));
    const count = await upsertBatch("billingConfig", docs);
    console.log(`  -> billingConfig: ${count} documents migrated.`);
  } catch (e) {
    console.warn("  -> Error reading billingConfig:", e.message);
    failedSteps.push("billingConfig");
  }

  // 4. Migrate Entitlements
  console.log("Migrating entitlements...");
  try {
    const snap = await firestore.collection("entitlements").get();
    const docs = snap.docs.map((d) => ({ _id: d.id, ...sanitize(d.data()) }));
    const count = await upsertBatch("entitlements", docs);
    console.log(`  -> entitlements: ${count} documents migrated.`);
  } catch (e) {
    console.warn("  -> Error reading entitlements:", e.message);
    failedSteps.push("entitlements");
  }

  // 5. Migrate Payments
  console.log("Migrating payments...");
  try {
    const snap = await firestore.collection("payments").get();
    const docs = snap.docs.map((d) => ({ _id: d.id, ...sanitize(d.data()) }));
    const count = await upsertBatch("payments", docs);
    console.log(`  -> payments: ${count} documents migrated.`);
  } catch (e) {
    console.warn("  -> Error reading payments:", e.message);
    failedSteps.push("payments");
  }

  // 6. Migrate Support Tickets & Feedback
  console.log("Migrating support tickets & feedback...");
  try {
    const [tSnap, fSnap] = await Promise.all([
      firestore.collection("supportTickets").get(),
      firestore.collection("feedback").get(),
    ]);

    const docs = [
      ...tSnap.docs.map((d) => ({ _id: d.id, kind: "ticket", ...sanitize(d.data()) })),
      ...fSnap.docs.map((d) => ({ _id: d.id, kind: "feedback", ...sanitize(d.data()) })),
    ];
    const count = await upsertBatch("support", docs);
    console.log(`  -> support items: ${count} documents migrated.`);
  } catch (e) {
    console.warn("  -> Error reading support:", e.message);
    failedSteps.push("support");
  }

  // 7. Migrate Admin Audit Logs
  console.log("Migrating adminAuditLogs...");
  try {
    const snap = await firestore.collection("adminAuditLogs").get();
    const docs = snap.docs.map((d) => ({ _id: d.id, ...sanitize(d.data()) }));
    const count = await upsertBatch("adminAuditLogs", docs);
    console.log(`  -> adminAuditLogs: ${count} documents migrated.`);
  } catch (e) {
    console.warn("  -> Error reading adminAuditLogs:", e.message);
    failedSteps.push("adminAuditLogs");
  }

  // 8. Migrate User subcollections: questions, attempts, resources, preferences, geminiKey
  console.log("Migrating user-owned questions, attempts, resources...");
  try {
    const [qSnap, aSnap, rSnap] = await Promise.all([
      firestore.collectionGroup("questions").get(),
      firestore.collectionGroup("attempts").get(),
      firestore.collectionGroup("resources").get(),
    ]);

    const parseOwner = (ref) => {
      // path is users/{uid}/questions/{id}
      const parts = ref.path.split("/");
      return parts[1] || null;
    };

    const qDocs = qSnap.docs.map((d) => {
      const ownerId = d.data().ownerId || parseOwner(d.ref);
      return {
        _id: `${ownerId}:${d.id}`,
        id: d.id,
        ownerId,
        ...sanitize(d.data()),
      };
    });
    const aDocs = aSnap.docs.map((d) => {
      const ownerId = d.data().ownerId || parseOwner(d.ref);
      return {
        _id: `${ownerId}:${d.id}`,
        id: d.id,
        ownerId,
        ...sanitize(d.data()),
      };
    });
    const rDocs = rSnap.docs.map((d) => {
      const ownerId = d.data().ownerId || parseOwner(d.ref);
      return {
        _id: `${ownerId}:${d.id}`,
        id: d.id,
        ownerId,
        ...sanitize(d.data()),
      };
    });

    const [qCount, aCount, rCount] = await Promise.all([
      upsertBatch("questions", qDocs),
      upsertBatch("attempts", aDocs),
      upsertBatch("resources", rDocs),
    ]);

    console.log(`  -> user questions: ${qCount} documents migrated.`);
    console.log(`  -> user attempts: ${aCount} documents migrated.`);
    console.log(`  -> user resources: ${rCount} documents migrated.`);
  } catch (e) {
    console.warn("  -> Error reading user collection groups:", e.message);
    failedSteps.push("userCollectionGroups");
  }

  // 9. Migrate user purchases and user tests
  console.log("Migrating userPurchases & userTests...");
  try {
    const pSnap = await firestore.collectionGroup("items").get();

    const purchases = [];
    const tests = [];

    for (const d of pSnap.docs) {
      const parts = d.ref.path.split("/"); // userPurchases/{uid}/items/{id} or userTests/{uid}/items/{id}
      const root = parts[0];
      const uid = parts[1];
      const data = sanitize(d.data());
      if (root === "userPurchases") {
        purchases.push({ _id: `${uid}_${d.id}`, uid, ...data });
      } else if (root === "userTests") {
        tests.push({ _id: `${uid}_${d.id}`, uid, ...data });
      }
    }

    const [pCount, tCount] = await Promise.all([
      upsertBatch("purchases", purchases),
      upsertBatch("tests", tests),
    ]);
    console.log(`  -> purchases: ${pCount}, tests: ${tCount} migrated.`);
  } catch (e) {
    console.warn("  -> Error reading items collection group:", e.message);
    failedSteps.push("userPurchases/userTests");
  }

  // 10. Migrate user profiles & settings
  console.log("Migrating users preferences and settings...");
  try {
    const usersSnap = await firestore.collection("users").get();
    for (const uDoc of usersSnap.docs) {
      const uid = uDoc.id;
      const [prefSnap, keySnap] = await Promise.all([
        firestore.doc(`users/${uid}/settings/preferences`).get().catch(() => null),
        firestore.doc(`users/${uid}/private/geminiKey`).get().catch(() => null),
      ]);

      const userUpdate = {
        _id: uid,
        ...sanitize(uDoc.data()),
      };
      if (prefSnap?.exists) userUpdate.preferences = sanitize(prefSnap.data());
      if (keySnap?.exists) userUpdate.geminiKey = sanitize(keySnap.data());

      await mdb.collection("users").updateOne(
        { _id: uid },
        { $set: userUpdate },
        { upsert: true }
      );
    }
    console.log(`  -> users settings migrated for ${usersSnap.docs.length} users.`);
  } catch (e) {
    console.warn("  -> Error reading user settings:", e.message);
    failedSteps.push("usersSettings");
  }

  if (failedSteps.length > 0) {
    console.error(`\nMigration completed with failures in: ${failedSteps.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nMigration completed successfully!");
  }
  await mongoClient.close();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
