import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function masterKey() {
  const raw = process.env.AI_KEYS_MASTER_KEY?.trim();
  if (!raw || raw.length < 32) return null;
  return createHash("sha256").update(raw).digest();
}

export const secretsConfigured = () => masterKey() !== null;

export function seal(plain, aad) {
  const key = masterKey();
  if (!key) throw new Error("AI_KEYS_MASTER_KEY is not configured on the server (needs 32+ characters).");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function open(sealed, aad) {
  const key = masterKey();
  if (!key) throw new Error("AI_KEYS_MASTER_KEY is not configured on the server.");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(sealed.data, "base64")), d.final()]).toString("utf8");
}

export function mask(key) {
  if (!key || key.length <= 10) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

import { testKey } from "./aiProviders.js";

export async function testProviderKey(provider, key) {
  try {
    return await testKey(provider, key);
  } catch (err) {
    throw new Error(`${provider} key test failed: ${err.message}`);
  }
}
