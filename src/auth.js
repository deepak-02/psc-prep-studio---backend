import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

function initFirebase() {
  if (admin.apps.length) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();

  let serviceAccount = null;
  if (raw) {
    try {
      serviceAccount = JSON.parse(raw);
    } catch (e) {
      console.warn("Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", e.message);
      throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT configuration.");
    }
  } else if (b64) {
    try {
      serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    } catch (e) {
      console.warn("Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64:", e.message);
      throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_BASE64 configuration.");
    }
  }

  if (serviceAccount?.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  } else {
    admin.initializeApp();
  }
}

initFirebase();

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? "";
  const token = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(header)?.[1];

  if (!token) {
    return res.status(401).json({ error: "Sign in required." });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token, true);
    req.user = {
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: decoded.email_verified === true,
      name: decoded.name ?? null,
    };
    next();
  } catch (err) {
    const code = err.code || "";
    if (/id-token-expired|id-token-revoked/.test(code)) {
      return res.status(401).json({ error: "Session expired. Sign in again." });
    }
    return res.status(401).json({ error: "Authentication failed." });
  }
}

export function requireAdmin(req, res, next) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || !req.user || req.user.email !== adminEmail || !req.user.emailVerified) {
    return res.status(403).json({ error: "Admin only." });
  }
  next();
}

export async function maybeAuth(req, res, next) {
  const header = req.headers.authorization ?? "";
  const token = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(header)?.[1];
  if (!token) return next();

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = {
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: decoded.email_verified === true,
      name: decoded.name ?? null,
    };
  } catch {
    // Ignore invalid token for optional auth
  }
  next();
}

export { admin };
