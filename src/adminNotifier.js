// Admin Mailing & Alerting Module for PSC Prep Studio
// Handles transactional administrator emails using Nodemailer (SMTP) with Resend fallback.
// Completely isolated, asynchronous, non-blocking, and logs every dispatch to MongoDB `emailLog`.

import nodemailer from "nodemailer";
import { getDb } from "./db.js";

const DEFAULT_ADMIN_EMAIL = "deepakck.ptf@gmail.com";
const SITE_URL = process.env.VITE_SITE_URL || "https://psc-prep-studio.vercel.app";
const LOGO_URL = `${SITE_URL}/email-logo.png`;

// In-memory throttling map for critical error alerts (avoids email storming)
const errorThrottleMap = new Map();
const ERROR_THROTTLE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Format timestamp as "DD-MM-YYYY, hh:mm:ss AM/PM" (IST)
 */
export function formatSubjectDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = date.getFullYear();
  let hours = date.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${day}-${month}-${year}, ${pad(hours)}:${minutes}:${seconds} ${ampm}`;
}

export function formatDateTime(ms = Date.now()) {
  return new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let cachedTransporter = null;
function getSmtpTransporter() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const port = Number(process.env.SMTP_PORT) || 465;

  if (!host || !user || !pass) return null;

  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return cachedTransporter;
}

/**
 * Base dispatcher: Attempts Nodemailer SMTP first, then Resend API fallback.
 * Always records status to MongoDB `emailLog`.
 */
export async function sendAdminMail({ template, subjectPrefix, htmlContent, textContent, ref = null, metadata = {} }) {
  const adminEmail = process.env.ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL;
  const fromAddress = process.env.EMAIL_FROM?.trim() || `PSC Prep Studio <${adminEmail}>`;
  const subject = `${subjectPrefix} | ${formatSubjectDate()}`;

  let success = false;
  let providerUsed = "none";
  let errorMessage = null;
  let messageId = null;

  const transport = getSmtpTransporter();

  if (transport) {
    try {
      providerUsed = "nodemailer_smtp";
      const info = await transport.sendMail({
        from: fromAddress,
        to: adminEmail,
        subject,
        html: htmlContent,
        text: textContent,
      });
      success = true;
      messageId = info.messageId || null;
    } catch (smtpErr) {
      errorMessage = `SMTP Error: ${smtpErr.message}`;
      console.error("[adminNotifier] SMTP send failed:", smtpErr.message);
    }
  }

  // Resend HTTP API Fallback
  if (!success && process.env.RESEND_API_KEY?.trim()) {
    try {
      providerUsed = "resend";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [adminEmail],
          subject,
          html: htmlContent,
          text: textContent,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        success = true;
        messageId = data.id || null;
        errorMessage = null;
      } else {
        errorMessage = `Resend Error (${res.status}): ${data.message || "Failed"}`;
      }
    } catch (resendErr) {
      errorMessage = (errorMessage ? `${errorMessage} | ` : "") + `Resend Error: ${resendErr.message}`;
      console.error("[adminNotifier] Resend fallback failed:", resendErr.message);
    }
  }

  if (!transport && !process.env.RESEND_API_KEY?.trim()) {
    errorMessage = "No email transport configured (set SMTP_HOST/USER/PASS or RESEND_API_KEY).";
    console.warn(`[adminNotifier] Skipped sending "${subject}": ${errorMessage}`);
  }

  // Non-blocking log persistence to MongoDB
  try {
    const db = await getDb();
    await db.collection("emailLog").insertOne({
      _id: `em_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      template,
      to: adminEmail,
      subject,
      provider: providerUsed,
      ok: success,
      messageId,
      error: errorMessage,
      ref,
      metadata,
    });
  } catch (dbErr) {
    console.error("[adminNotifier] Failed to write email log:", dbErr.message);
  }

  return { ok: success, subject, error: errorMessage, provider: providerUsed };
}

// ---------------------------------------------------------------------------
// HTML Email Shell Generator (Responsive, High-Contrast, Professional Design)
// ---------------------------------------------------------------------------
function renderEmailShell({ title, badgeText, badgeColor = "#14594b", badgeBg = "#ecfdf5", contentHtml, ctaText, ctaUrl }) {
  const currentYear = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e293b;line-height:1.5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">
          <!-- Header -->
          <tr>
            <td style="padding-bottom:18px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;width:40px;">
                    <img src="${LOGO_URL}" width="36" height="36" alt="Logo" style="display:block;border-radius:9px;border:0;" />
                  </td>
                  <td style="vertical-align:middle;padding-left:12px;">
                    <span style="font-size:18px;font-weight:700;color:#0f172a;letter-spacing:-0.02em;">PSC Prep Studio</span>
                    <span style="display:block;font-size:12px;color:#64748b;font-weight:500;">Admin Management System</span>
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <span style="display:inline-block;padding:4px 10px;border-radius:9999px;font-size:11px;font-weight:700;letter-spacing:0.02em;background-color:${badgeBg};color:${badgeColor};border:1px solid ${badgeColor}33;">
                      ${escapeHtml(badgeText)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Card -->
          <tr>
            <td style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:32px 28px;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
              <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#0f172a;line-height:1.3;">
                ${escapeHtml(title)}
              </h1>
              ${contentHtml}

              ${
                ctaUrl && ctaText
                  ? `<div style="margin-top:24px;padding-top:18px;border-top:1px solid #f1f5f9;">
                      <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background-color:#14594b;color:#ffffff;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px;text-decoration:none;letter-spacing:-0.01em;">
                        ${escapeHtml(ctaText)} &rarr;
                      </a>
                    </div>`
                  : ""
              }
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding-top:20px;text-align:center;font-size:12px;color:#94a3b8;line-height:1.6;">
              Automated operational notification · Sent to System Administrator<br>
              <a href="${SITE_URL}/admin" style="color:#14594b;text-decoration:none;font-weight:600;">Open Admin Console</a> · 
              PSC Prep Studio &copy; ${currentYear}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderTableRows(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse;">
    ${rows
      .map(
        ([label, value, isHighlight]) => `
      <tr>
        <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b;width:35%;">${escapeHtml(label)}</td>
        <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:${isHighlight ? "#047857" : "#0f172a"};font-weight:${isHighlight ? "700" : "500"};text-align:right;">
          ${escapeHtml(value)}
        </td>
      </tr>`
      )
      .join("")}
  </table>`;
}

// ---------------------------------------------------------------------------
// 1. New User Registration Alert
// ---------------------------------------------------------------------------
export async function notifyNewUser({ uid, email, name, provider }) {
  const title = "New User Registration";
  const rows = [
    ["User Name", name || "Not provided"],
    ["Email Address", email || "No email"],
    ["User ID (UID)", uid],
    ["Sign-in Provider", provider || "firebase"],
    ["Registered Time", formatDateTime()],
  ];

  const contentHtml = `
    <p style="margin:0 0 14px;font-size:14px;color:#334155;">
      A new user has just registered on <strong>PSC Prep Studio</strong>.
    </p>
    ${renderTableRows(rows)}
  `;

  const textContent = `New User Registered on PSC Prep Studio\n\nName: ${name || "—"}\nEmail: ${email}\nUID: ${uid}\nProvider: ${provider}\nTime: ${formatDateTime()}\n\nView user: ${SITE_URL}/admin?tab=users&q=${uid}`;

  return sendAdminMail({
    template: "new_user",
    subjectPrefix: `New User Registration: ${name || email || uid}`,
    htmlContent: renderEmailShell({
      title,
      badgeText: "NEW USER",
      badgeColor: "#0284c7",
      badgeBg: "#f0f9ff",
      contentHtml,
      ctaText: "View in Admin Users",
      ctaUrl: `${SITE_URL}/admin?tab=users&q=${encodeURIComponent(uid)}`,
    }),
    textContent,
    ref: uid,
    metadata: { uid, email, name, provider },
  });
}

// ---------------------------------------------------------------------------
// 2. Successful Payment & Purchase Alert
// ---------------------------------------------------------------------------
export async function notifyPurchase({ orderId, paymentId, amount, productLabel, product, email, name, method }) {
  const formattedAmount = `₹${(amount / 100).toLocaleString("en-IN")}`;
  const title = `Payment Received: ${formattedAmount}`;
  const rows = [
    ["Product", productLabel || product],
    ["Amount Paid", formattedAmount, true],
    ["Buyer Name", name || "—"],
    ["Buyer Email", email || "—"],
    ["Payment ID", paymentId || "—"],
    ["Order ID", orderId || "—"],
    ["Payment Method", method ? String(method).toUpperCase() : "Razorpay Checkout"],
    ["Time", formatDateTime()],
  ];

  const contentHtml = `
    <p style="margin:0 0 14px;font-size:14px;color:#334155;">
      A customer has completed a payment. Entitlements have been granted in the database.
    </p>
    ${renderTableRows(rows)}
  `;

  const textContent = `Payment Received on PSC Prep Studio\n\nProduct: ${productLabel}\nAmount: ${formattedAmount}\nBuyer: ${name} <${email}>\nPayment ID: ${paymentId}\nOrder ID: ${orderId}\nTime: ${formatDateTime()}\n\nView order: ${SITE_URL}/admin?tab=transactions&q=${orderId}`;

  return sendAdminMail({
    template: "purchase",
    subjectPrefix: `Payment Received: ${formattedAmount} (${productLabel || product})`,
    htmlContent: renderEmailShell({
      title,
      badgeText: "PAYMENT SUCCESS",
      badgeColor: "#059669",
      badgeBg: "#ecfdf5",
      contentHtml,
      ctaText: "View in Transactions",
      ctaUrl: `${SITE_URL}/admin?tab=transactions&q=${encodeURIComponent(orderId)}`,
    }),
    textContent,
    ref: orderId,
    metadata: { orderId, paymentId, amount, product, email },
  });
}

// ---------------------------------------------------------------------------
// 3. User Feedback & Support Ticket Notifications
// ---------------------------------------------------------------------------
export async function notifySupportTicket({ reference, topic, name, email, message, paymentId, uid }) {
  const title = `Support Ticket #${reference}`;
  const rows = [
    ["Ticket Reference", reference],
    ["From", `${name || "User"} <${email}>`],
    ["Topic", topic || "General"],
    ["Account UID", uid || "Guest / Unauthenticated"],
    ["Related Payment ID", paymentId || "None"],
    ["Received Time", formatDateTime()],
  ];

  const contentHtml = `
    <p style="margin:0 0 14px;font-size:14px;color:#334155;">
      A user has submitted a support inquiry:
    </p>
    ${renderTableRows(rows)}
    <div style="margin:16px 0;padding:14px;background-color:#f8fafc;border-left:3px solid #14594b;border-radius:6px;font-size:13px;line-height:1.6;color:#1e293b;">
      ${escapeHtml(message).replace(/\n/g, "<br>")}
    </div>
  `;

  const textContent = `Support Ticket #${reference}\nFrom: ${name} <${email}>\nTopic: ${topic}\nMessage:\n${message}\n\nReply in Admin: ${SITE_URL}/admin?tab=support`;

  return sendAdminMail({
    template: "support_ticket",
    subjectPrefix: `Support Ticket #${reference}: ${topic || "New Inquiry"}`,
    htmlContent: renderEmailShell({
      title,
      badgeText: "SUPPORT TICKET",
      badgeColor: "#d97706",
      badgeBg: "#fffbeb",
      contentHtml,
      ctaText: "Reply in Admin Support",
      ctaUrl: `${SITE_URL}/admin?tab=support`,
    }),
    textContent,
    ref: reference,
    metadata: { reference, email, topic },
  });
}

export async function notifyFeedback({ rating, area, message, email, uid }) {
  const stars = "★".repeat(Math.max(1, Math.min(5, rating))) + "☆".repeat(Math.max(0, 5 - rating));
  const title = `User Feedback: ${stars}`;
  const rows = [
    ["Rating", `${stars} (${rating}/5)`, true],
    ["Area", area || "General"],
    ["User Email", email || "Anonymous"],
    ["User UID", uid || "Not signed in"],
    ["Submitted Time", formatDateTime()],
  ];

  const contentHtml = `
    <p style="margin:0 0 14px;font-size:14px;color:#334155;">
      New user rating received for <strong>PSC Prep Studio</strong>:
    </p>
    ${renderTableRows(rows)}
    ${
      message
        ? `<div style="margin:14px 0;padding:12px;background-color:#f8fafc;border-left:3px solid #f59e0b;border-radius:6px;font-size:13px;color:#1e293b;">
            ${escapeHtml(message).replace(/\n/g, "<br>")}
          </div>`
        : ""
    }
  `;

  const textContent = `User Feedback: ${stars} (${rating}/5)\nArea: ${area}\nFrom: ${email || "Anonymous"}\nComments: ${message || "None"}\n\nView in Admin: ${SITE_URL}/admin?tab=support`;

  return sendAdminMail({
    template: "feedback",
    subjectPrefix: `User Feedback: ${stars} (${area || "App"})`,
    htmlContent: renderEmailShell({
      title,
      badgeText: "USER FEEDBACK",
      badgeColor: "#f59e0b",
      badgeBg: "#fffbeb",
      contentHtml,
      ctaText: "View Feedback in Admin",
      ctaUrl: `${SITE_URL}/admin?tab=support`,
    }),
    textContent,
    metadata: { rating, area, email },
  });
}

// ---------------------------------------------------------------------------
// 4. Critical Error Alerting (With 15-Minute Deduplication)
// ---------------------------------------------------------------------------
export async function notifyCriticalError({ error, context = "Backend Server", req = null, extra = {} }) {
  const errName = error?.name || "Error";
  const errMsg = error?.message || String(error);
  const errStack = (error?.stack || "").split("\n").slice(0, 8).join("\n");
  const signature = `${context}:${errName}:${errMsg.slice(0, 80)}`;

  const now = Date.now();
  const existing = errorThrottleMap.get(signature);

  if (existing && now - existing.lastSentAt < ERROR_THROTTLE_WINDOW_MS) {
    existing.count++;
    return { ok: true, throttled: true, count: existing.count };
  }

  errorThrottleMap.set(signature, { lastSentAt: now, count: 1 });

  // Clean old throttle entries
  if (errorThrottleMap.size > 200) {
    for (const [k, v] of errorThrottleMap.entries()) {
      if (now - v.lastSentAt > ERROR_THROTTLE_WINDOW_MS) errorThrottleMap.delete(k);
    }
  }

  const title = `Error Alert: ${errName}`;
  const rows = [
    ["Context / Route", context],
    ["HTTP Method", req?.method || "—"],
    ["URL", req?.originalUrl || req?.url || "—"],
    ["IP Address", req?.ip || "—"],
    ["Occurred At", formatDateTime()],
  ];

  const contentHtml = `
    <div style="background-color:#fef2f2;border:1px solid #fecaca;padding:12px;border-radius:8px;margin-bottom:16px;">
      <span style="display:block;font-size:14px;font-weight:700;color:#991b1b;">${escapeHtml(errMsg)}</span>
    </div>
    ${renderTableRows(rows)}
    ${
      errStack
        ? `<div style="margin-top:14px;">
            <span style="font-size:12px;font-weight:700;color:#64748b;display:block;margin-bottom:6px;">STACK TRACE (EXCERPT):</span>
            <pre style="margin:0;padding:12px;background-color:#0f172a;color:#f8fafc;border-radius:6px;font-size:11px;overflow-x:auto;font-family:Consolas,Monaco,monospace;">${escapeHtml(errStack)}</pre>
          </div>`
        : ""
    }
  `;

  const textContent = `CRITICAL ERROR ALERT\n\nError: ${errName}: ${errMsg}\nContext: ${context}\nURL: ${req?.originalUrl || "—"}\nTime: ${formatDateTime()}\n\nStack:\n${errStack}`;

  return sendAdminMail({
    template: "error_alert",
    subjectPrefix: `Error Report: ${errMsg.slice(0, 45)}`,
    htmlContent: renderEmailShell({
      title,
      badgeText: "CRITICAL ALERT",
      badgeColor: "#dc2626",
      badgeBg: "#fef2f2",
      contentHtml,
      ctaText: "Check Admin Logs",
      ctaUrl: `${SITE_URL}/admin?tab=audit`,
    }),
    textContent,
    ref: signature,
    metadata: { context, errMsg, extra },
  });
}

// ---------------------------------------------------------------------------
// 5. Weekly Business & Product Digest
// ---------------------------------------------------------------------------
export async function sendWeeklyDigest() {
  const db = await getDb();
  const now = Date.now();
  const dayMs = 86400000;
  const thisWeekStart = now - 7 * dayMs;
  const lastWeekStart = now - 14 * dayMs;

  // Run aggregations across collections
  const [
    totalUsers,
    thisWeekUsers,
    prevWeekUsers,
    thisWeekPayments,
    prevWeekPayments,
    thisWeekAttempts,
    prevWeekAttempts,
    thisWeekAiDaily,
    prevWeekAiDaily,
    thisWeekTickets,
    thisWeekFeedback,
  ] = await Promise.all([
    db.collection("users").countDocuments({}),
    db.collection("users").countDocuments({ createdAt: { $gte: thisWeekStart } }),
    db.collection("users").countDocuments({ createdAt: { $gte: lastWeekStart, $lt: thisWeekStart } }),
    db.collection("payments").find({ status: "paid", paidAt: { $gte: thisWeekStart } }).toArray(),
    db.collection("payments").find({ status: "paid", paidAt: { $gte: lastWeekStart, $lt: thisWeekStart } }).toArray(),
    db.collection("attempts").countDocuments({ createdAt: { $gte: thisWeekStart } }),
    db.collection("attempts").countDocuments({ createdAt: { $gte: lastWeekStart, $lt: thisWeekStart } }),
    db.collection("aiUsageDaily").find({}).sort({ _id: -1 }).limit(7).toArray(),
    db.collection("aiUsageDaily").find({}).sort({ _id: -1 }).skip(7).limit(7).toArray(),
    db.collection("support").countDocuments({ kind: "ticket", createdAt: { $gte: thisWeekStart } }),
    db.collection("support").find({ kind: "feedback", createdAt: { $gte: thisWeekStart } }).toArray(),
  ]);

  const sumRevenue = (list) => list.reduce((acc, p) => acc + (p.amount || 0) - (p.refundedAmount || 0), 0);
  const thisRevenue = sumRevenue(thisWeekPayments);
  const prevRevenue = sumRevenue(prevWeekPayments);

  const calcChange = (curr, prev) => {
    if (prev === 0) return curr > 0 ? "+100%" : "0%";
    const pct = Math.round(((curr - prev) / prev) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  };

  const avgFeedback =
    thisWeekFeedback.length > 0
      ? (thisWeekFeedback.reduce((a, f) => a + (Number(f.rating) || 0), 0) / thisWeekFeedback.length).toFixed(1)
      : "—";

  const thisAiCost = thisWeekAiDaily.reduce((a, d) => a + (d.costUsd || 0), 0);
  const thisAiReqs = thisWeekAiDaily.reduce((a, d) => a + (d.requests || 0), 0);

  const title = "Weekly Product & Operations Report";
  const rows = [
    ["Total Registered Users", totalUsers.toLocaleString("en-IN")],
    ["New Signups (This Week)", `${thisWeekUsers} (${calcChange(thisWeekUsers, prevWeekUsers)} vs last week)`],
    ["Revenue (This Week)", `₹${(thisRevenue / 100).toLocaleString("en-IN")} (${calcChange(thisRevenue, prevRevenue)})`, true],
    ["Completed Mock Tests", `${thisWeekAttempts} (${calcChange(thisWeekAttempts, prevWeekAttempts)})`],
    ["Support Tickets Opened", `${thisWeekTickets}`],
    ["User Feedback Average", avgFeedback !== "—" ? `★ ${avgFeedback} / 5.0 (${thisWeekFeedback.length} reviews)` : "None this week"],
    ["Platform AI Generations", `${thisAiReqs.toLocaleString("en-IN")} requests ($${thisAiCost.toFixed(2)})`],
    ["Report Period", `${formatDateTime(thisWeekStart)} – ${formatDateTime(now)}`],
  ];

  const contentHtml = `
    <p style="margin:0 0 14px;font-size:14px;color:#334155;">
      Here is your weekly executive summary of user growth, revenue, mock tests, and system performance on <strong>PSC Prep Studio</strong>.
    </p>
    ${renderTableRows(rows)}
  `;

  const textContent = `WEEKLY EXECUTIVE REPORT\n\nTotal Users: ${totalUsers}\nNew Users: ${thisWeekUsers} (${calcChange(thisWeekUsers, prevWeekUsers)})\nRevenue: ₹${(thisRevenue / 100).toLocaleString("en-IN")} (${calcChange(thisRevenue, prevRevenue)})\nExams Attempted: ${thisWeekAttempts}\nAI Usage: ${thisAiReqs} requests ($${thisAiCost.toFixed(2)})\nSupport Tickets: ${thisWeekTickets}\nFeedback: ${avgFeedback}/5\n\nOpen Admin: ${SITE_URL}/admin`;

  return sendAdminMail({
    template: "weekly_report",
    subjectPrefix: "Weekly Executive Report",
    htmlContent: renderEmailShell({
      title,
      badgeText: "WEEKLY DIGEST",
      badgeColor: "#14594b",
      badgeBg: "#ecfdf5",
      contentHtml,
      ctaText: "Open Full Admin Dashboard",
      ctaUrl: `${SITE_URL}/admin`,
    }),
    textContent,
    metadata: { thisRevenue, thisWeekUsers, thisWeekAttempts },
  });
}
