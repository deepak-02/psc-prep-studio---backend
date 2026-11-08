import { createHash } from "node:crypto";

export const PRODUCT_IDS = ["resource_bundle", "test_30", "test_50", "pro_monthly", "pro_annual"];
export const isProductId = (v) => typeof v === "string" && PRODUCT_IDS.includes(v);

export const DEFAULT_BILLING_CONFIG = {
  version: 1,
  currency: "INR",
  products: {
    resource_bundle: { active: true, price: 1000, label: "5 resources", quantity: 5 },
    test_30: { active: true, price: 500, label: "Mock test · up to 30 questions", maxQuestions: 30 },
    test_50: { active: true, price: 800, label: "Mock test · up to 50 questions", maxQuestions: 50 },
    pro_monthly: { active: true, price: 4900, label: "Pro · Monthly", durationDays: 30 },
    pro_annual: { active: true, price: 49900, label: "Pro · Annual", durationDays: 365 },
  },
  free: { maxTests: 10, maxQuestionsPerTest: 30, maxResources: 5, allowPyq: true, allowRetakes: true, monthlyAiAllowance: 0 },
  pro: { maxQuestionsPerTest: 50, unlimitedResources: true, monthlyAiAllowance: 0 },
  promotions: { enabled: false },
};

const int = (v, min, max, d) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d);
const bool = (v, d) => (typeof v === "boolean" ? v : d);
const str = (v, d, max = 80) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : d);

export function normaliseConfig(raw) {
  const r = (raw && typeof raw === "object" ? raw : {});
  const D = DEFAULT_BILLING_CONFIG;
  const products = {};
  for (const id of PRODUCT_IDS) {
    const p = r["products"]?.[id] ?? {};
    const d = D.products[id];
    products[id] = {
      active: bool(p["active"], d.active),
      price: int(p["price"], 100, 10_000_000, d.price),
      label: str(p["label"], d.label),
      ...(d.quantity !== undefined ? { quantity: int(p["quantity"], 1, 100, d.quantity) } : {}),
      ...(d.maxQuestions !== undefined ? { maxQuestions: int(p["maxQuestions"], 1, 200, d.maxQuestions) } : {}),
      ...(d.durationDays !== undefined ? { durationDays: int(p["durationDays"], 1, 3660, d.durationDays) } : {}),
    };
  }
  const f = r["free"] ?? {};
  const pr = r["pro"] ?? {};
  return {
    version: int(r["version"], 1, 1_000_000, 1),
    currency: "INR",
    products,
    free: {
      maxTests: int(f["maxTests"], 0, 1000, D.free.maxTests),
      maxQuestionsPerTest: int(f["maxQuestionsPerTest"], 1, 200, D.free.maxQuestionsPerTest),
      maxResources: int(f["maxResources"], 0, 1000, D.free.maxResources),
      allowPyq: bool(f["allowPyq"], D.free.allowPyq),
      allowRetakes: bool(f["allowRetakes"], D.free.allowRetakes),
      monthlyAiAllowance: int(f["monthlyAiAllowance"], 0, 100_000, D.free.monthlyAiAllowance),
    },
    pro: {
      maxQuestionsPerTest: int(pr["maxQuestionsPerTest"], 1, 200, D.pro.maxQuestionsPerTest),
      unlimitedResources: bool(pr["unlimitedResources"], D.pro.unlimitedResources),
      monthlyAiAllowance: int(pr["monthlyAiAllowance"], 0, 100_000, D.pro.monthlyAiAllowance),
    },
    promotions: { enabled: bool(r["promotions"]?.enabled, false) },
    ...(typeof r["updatedAt"] === "number" ? { updatedAt: r["updatedAt"] } : {}),
    ...(typeof r["updatedBy"] === "string" ? { updatedBy: r["updatedBy"] } : {}),
  };
}

export const emptyEntitlement = (uid, email = null) => ({
  uid,
  email: email ?? null,
  planId: "free",
  planStatus: "none",
  subscriptionStartedAt: null,
  subscriptionExpiresAt: null,
  subscriptionId: null,
  proSource: null,
  freeTestsUsed: 0,
  freeResourcesUsed: 0,
  credits: { test_30: 0, test_50: 0 },
  resourceCredits: 0,
  reservations: {},
  videoStudio: false,
  entitlementVersion: 2,
  updatedAt: 0,
});

export function normaliseEntitlement(uid, raw) {
  const r = (raw && typeof raw === "object" ? raw : {});
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const ts = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const planId = r["planId"] === "pro_monthly" || r["planId"] === "pro_annual" ? r["planId"] : "free";
  const reservations = {};
  if (r["reservations"] && typeof r["reservations"] === "object") {
    for (const [k, v] of Object.entries(r["reservations"]).slice(0, 20)) {
      if (v && typeof v === "object" && (v.via === "pro" || v.via === "free" || v.via === "credit")) {
        reservations[k] = {
          id: k,
          via: v.via,
          ...(v.credit === "test_30" || v.credit === "test_50" ? { credit: v.credit } : {}),
          count: n(v.count),
          testKey: String(v.testKey ?? ""),
          createdAt: n(v.createdAt),
          expiresAt: n(v.expiresAt),
        };
      }
    }
  }
  return {
    uid,
    email: typeof r["email"] === "string" ? r["email"] : null,
    planId,
    planStatus: r["planStatus"] === "active" || r["planStatus"] === "expired" ? r["planStatus"] : "none",
    subscriptionStartedAt: ts(r["subscriptionStartedAt"]),
    subscriptionExpiresAt: ts(r["subscriptionExpiresAt"]),
    subscriptionId: typeof r["subscriptionId"] === "string" ? r["subscriptionId"] : null,
    proSource: r["proSource"] === "payment" || r["proSource"] === "admin" ? r["proSource"] : null,
    freeTestsUsed: n(r["freeTestsUsed"]),
    freeResourcesUsed: n(r["freeResourcesUsed"]),
    credits: { test_30: n(r["credits"]?.test_30), test_50: n(r["credits"]?.test_50) },
    resourceCredits: n(r["resourceCredits"]),
    reservations,
    videoStudio: r["videoStudio"] === true,
    ...(r["disabled"] === true ? { disabled: true } : {}),
    entitlementVersion: n(r["entitlementVersion"]) || 2,
    updatedAt: n(r["updatedAt"]),
  };
}

export function isPro(e, now = Date.now()) {
  return !e.disabled && e.planId !== "free" && typeof e.subscriptionExpiresAt === "number" && e.subscriptionExpiresAt > now;
}

export function refreshSubscription(e, now = Date.now()) {
  if (e.planId !== "free" && (e.subscriptionExpiresAt ?? 0) <= now) {
    return { ...e, planId: "free", planStatus: "expired" };
  }
  if (e.planId !== "free" && e.planStatus !== "active") {
    return { ...e, planStatus: "active" };
  }
  return e;
}

export const validItemKey = (key) =>
  typeof key === "string" && /^(res|pyq):[A-Za-z0-9_.:\-/ ()&,]{1,200}$/.test(key) && !key.includes("..");

export const isFixedPaperSource = (source) => Boolean(source) && source !== "generated" && source !== "ai-only";

export function decideTest(c, e, count, now = Date.now(), opts = {}) {
  const proOffers = ["pro_monthly", "pro_annual"].filter((p) => c.products[p].active);
  if (e.disabled) return { allowed: false, reason: "disabled", maxQuestions: 0, offer: [] };
  if (isPro(e, now)) {
    if (opts.fixedPaper) return { allowed: true, via: "pro", maxQuestions: null };
    if (count <= c.pro.maxQuestionsPerTest) return { allowed: true, via: "pro", maxQuestions: c.pro.maxQuestionsPerTest };
    return { allowed: false, reason: "too-many-questions", maxQuestions: c.pro.maxQuestionsPerTest, offer: [] };
  }
  if (e.freeTestsUsed < c.free.maxTests && count <= c.free.maxQuestionsPerTest) {
    return { allowed: true, via: "free", maxQuestions: c.free.maxQuestionsPerTest };
  }
  const fits = (k) => count <= (c.products[k].maxQuestions ?? 0);
  for (const k of ["test_30", "test_50"]) {
    if (e.credits[k] > 0 && fits(k)) {
      return { allowed: true, via: "credit", credit: k, maxQuestions: c.products[k].maxQuestions ?? 0 };
    }
  }
  const testOffer = ["test_30", "test_50"].find((k) => c.products[k].active && fits(k));
  const largest = Math.max(c.pro.maxQuestionsPerTest, ...["test_30", "test_50"].map((k) => c.products[k].maxQuestions ?? 0));
  if (count > largest) return { allowed: false, reason: "too-many-questions", maxQuestions: largest, offer: [] };
  const freeLeft = e.freeTestsUsed < c.free.maxTests;
  return {
    allowed: false,
    reason: freeLeft ? "too-many-questions" : "quota",
    maxQuestions: freeLeft ? c.free.maxQuestionsPerTest : testOffer ? c.products[testOffer].maxQuestions ?? null : null,
    offer: [...(testOffer ? [testOffer] : []), ...(count <= c.pro.maxQuestionsPerTest ? proOffers : [])],
  };
}

export function applyReservation(e, r) {
  const next = { ...e, reservations: { ...e.reservations, [r.id]: r } };
  if (r.via === "free") next.freeTestsUsed = e.freeTestsUsed + 1;
  if (r.via === "credit" && r.credit) next.credits = { ...e.credits, [r.credit]: Math.max(0, e.credits[r.credit] - 1) };
  return next;
}

export function releaseReservation(e, id) {
  const r = e.reservations[id];
  if (!r) return e;
  const { [id]: _gone, ...rest } = e.reservations;
  const next = { ...e, reservations: rest };
  if (r.via === "free") next.freeTestsUsed = Math.max(0, e.freeTestsUsed - 1);
  if (r.via === "credit" && r.credit) next.credits = { ...e.credits, [r.credit]: e.credits[r.credit] + 1 };
  return next;
}

export function commitReservation(e, id) {
  if (!e.reservations[id]) return e;
  const { [id]: _done, ...rest } = e.reservations;
  return { ...e, reservations: rest };
}

export function sweepReservations(e, now = Date.now()) {
  let next = e;
  for (const r of Object.values(e.reservations)) {
    if (r.expiresAt <= now) next = releaseReservation(next, r.id);
  }
  return next;
}

export function decideItem(c, e, key, owned, now = Date.now()) {
  if (e.disabled) return { allowed: false, reason: "disabled", maxQuestions: null, offer: [] };
  if (owned) return { allowed: true, via: "owned" };
  if (isPro(e, now) && c.pro.unlimitedResources) return { allowed: true, via: "pro" };
  const offers = ["resource_bundle", "pro_monthly", "pro_annual"].filter((p) => c.products[p].active);
  if (key.startsWith("pyq:") && !c.free.allowPyq) {
    return { allowed: false, reason: "pyq-pro-only", maxQuestions: null, offer: offers.filter((o) => o !== "resource_bundle") };
  }
  if (e.resourceCredits > 0) return { allowed: true, via: "credit" };
  if (e.freeResourcesUsed < c.free.maxResources) return { allowed: true, via: "free" };
  return { allowed: false, reason: "quota", maxQuestions: null, offer: offers };
}

export function grantProduct(c, e, product, now = Date.now(), source = "payment", subscriptionId = null, daysOverride = undefined) {
  if (product === "test_30" || product === "test_50") {
    return { ...e, credits: { ...e.credits, [product]: e.credits[product] + 1 } };
  }
  if (product === "resource_bundle") return e;
  const days = daysOverride ?? c.products[product].durationDays ?? (product === "pro_annual" ? 365 : 30);
  const active = isPro(e, now);
  const base = active ? e.subscriptionExpiresAt ?? now : now;
  return {
    ...e,
    planId: product === "pro_annual" || (active && e.planId === "pro_annual") ? "pro_annual" : "pro_monthly",
    planStatus: "active",
    subscriptionStartedAt: active ? e.subscriptionStartedAt ?? now : now,
    subscriptionExpiresAt: base + days * 86_400_000,
    subscriptionId: subscriptionId ?? e.subscriptionId,
    proSource: source,
  };
}

export const revokePro = (e, now = Date.now()) => ({
  ...e,
  planId: "free",
  planStatus: "expired",
  subscriptionExpiresAt: Math.min(e.subscriptionExpiresAt ?? now, now),
});

export const remainingQuotas = (c, e) => ({
  testsLeft: Math.max(0, c.free.maxTests - e.freeTestsUsed),
  resourcesLeft: Math.max(0, c.free.maxResources - e.freeResourcesUsed),
  credits: e.credits,
  resourceCredits: e.resourceCredits,
  totalTests: Math.max(0, c.free.maxTests - e.freeTestsUsed) + e.credits.test_30 + e.credits.test_50,
  totalResources: Math.max(0, c.free.maxResources - e.freeResourcesUsed) + e.resourceCredits,
});

export const docId = (key) => createHash("sha256").update(key).digest("hex").slice(0, 40);
