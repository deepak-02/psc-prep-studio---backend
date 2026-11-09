import { createSign } from "node:crypto";
import { getServiceAccount } from "./auth.js";

let cached = null;

async function accessToken() {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = getServiceAccount();
  if (!sa || !sa.client_email || !sa.private_key) {
    throw Object.assign(new Error("Analytics is not configured."), { status: 503 });
  }

  const now = Math.floor(Date.now() / 1000);
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });

  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw Object.assign(new Error(data.error_description || "Could not authorise Google Analytics."), { status: 502 });
  }
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function run(property, token, body) {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = data.error?.message ?? "Analytics request failed.";
    throw new Error(msg);
  }
  return data.rows ?? [];
}

export async function gaReport(days = 28) {
  const property = process.env.GA4_PROPERTY_ID?.trim();
  if (!property || !/^\d+$/.test(property)) {
    return { configured: false };
  }

  try {
    const token = await accessToken();
    const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "today" }];
    const [daily, pages, countries, sources, devices] = await Promise.all([
      run(property, token, {
        dateRanges,
        dimensions: [{ name: "date" }],
        metrics: [
          { name: "activeUsers" },
          { name: "newUsers" },
          { name: "sessions" },
          { name: "screenPageViews" },
        ],
        orderBys: [{ dimension: { dimensionName: "date" } }],
      }),
      run(property, token, {
        dateRanges,
        dimensions: [{ name: "pagePath" }],
        metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
        limit: 10,
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      }),
      run(property, token, {
        dateRanges,
        dimensions: [{ name: "country" }],
        metrics: [{ name: "activeUsers" }],
        limit: 8,
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      }),
      run(property, token, {
        dateRanges,
        dimensions: [{ name: "sessionDefaultChannelGroup" }],
        metrics: [{ name: "sessions" }],
        limit: 8,
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      }),
      run(property, token, {
        dateRanges,
        dimensions: [{ name: "deviceCategory" }],
        metrics: [{ name: "activeUsers" }],
      }),
    ]);

    const m = (r, i) => Number(r.metricValues?.[i]?.value ?? 0);
    const d = (r) => r.dimensionValues?.[0]?.value ?? "";

    return {
      configured: true,
      days,
      daily: daily.map((r) => ({
        date: d(r),
        activeUsers: m(r, 0),
        newUsers: m(r, 1),
        sessions: m(r, 2),
        views: m(r, 3),
      })),
      pages: pages.map((r) => ({ path: d(r), views: m(r, 0), users: m(r, 1) })),
      countries: countries.map((r) => ({ country: d(r), users: m(r, 0) })),
      sources: sources.map((r) => ({ channel: d(r), sessions: m(r, 0) })),
      devices: devices.map((r) => ({ device: d(r), users: m(r, 0) })),
    };
  } catch (e) {
    console.warn("[analytics] gaReport failed:", e.message);
    return { configured: false, error: e.message };
  }
}
