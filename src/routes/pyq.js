import { Router } from "express";
import { getDb } from "../db.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

const KERALA_PSC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function cleanText(str) {
  if (!str) return "";
  return str
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, " ")
    .trim();
}

function normalizePaperCode(code) {
  if (!code) return "";
  return code.trim().replace(/\s+/g, " ").toUpperCase();
}

function parseCategoryCodes(raw) {
  if (!raw || !raw.trim()) return [];
  const matches = raw.match(/\b\d{1,4}\s*\/\s*\d{2,4}\b/g);
  if (matches && matches.length > 0) {
    return [...new Set(matches.map((m) => m.replace(/\s+/g, "")))];
  }
  const parts = raw
    .split(/[,;&\/]|\band\b/i)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(parts)];
}

function resolveKpscUrl(url, baseUrl = "https://www.keralapsc.gov.in") {
  if (!url) return "";
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return `${baseUrl}${trimmed}`;
  return `${baseUrl}/${trimmed}`;
}

async function fetchKpscPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": KERALA_PSC_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ml;q=0.8",
      },
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function parsePqpPage(html) {
  const records = [];
  const allTables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  if (allTables.length === 0) return records;

  const table = allTables[0][1];
  const trs = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (let i = 1; i < trs.length; i++) {
    const tr = trs[i][1];
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (tds.length < 4) continue;

    const yearText = cleanText(tds[0]);
    const examYear = parseInt(yearText, 10) || new Date().getFullYear();
    const titleTd = tds[1];
    const postName = cleanText(titleTd);

    const bodyTd = tds[2];
    const bodyText = cleanText(bodyTd);

    let paperCode = "";
    const codeMatch = bodyText.match(
      /(?:Paper\s*Code|QUESTION\s*CODE)\s*[:\-]+\s*([0-9A-Za-z\-\/]+(?:\s+[MKTmkt])?)/i
    );
    if (codeMatch) {
      paperCode = normalizePaperCode(codeMatch[1]);
    }

    let examDate = "";
    const dateMatch = bodyText.match(/Date\s*Of\s*Test\s*[:\-]+\s*([^\s;]+)/i);
    if (dateMatch) {
      examDate = dateMatch[1];
    }

    let categoryCodes = [];
    const catMatch = bodyText.match(
      /(?:Category|Cat)\.?\s*(?:Code|No(?:umber)?\.?|Number)?\s*[:\-]+\s*([\s\S]*?)(?=(?:Date\s*Of\s*Test|Exam|Medium|Paper\s*Code|$))/i
    );
    if (catMatch) {
      categoryCodes = parseCategoryCodes(catMatch[1]);
    }

    let trade = undefined;
    const tradeMatch = postName.match(/[\(\[]\s*([^\)\]]+)\s*[\)\]]/);
    if (tradeMatch) trade = tradeMatch[1].trim();

    let department = undefined;
    const deptMatch = postName.match(/^(.*?)\s*[-–]\s*(.*)$/);
    if (deptMatch && deptMatch[2]) {
      department = deptMatch[2].trim();
    }

    const downloadTd = tds[3] || "";
    const qpLinks = [...downloadTd.matchAll(/href=["']([^"']+)["']/gi)].map((m) =>
      resolveKpscUrl(m[1])
    );
    const questionPaperUrl = qpLinks[0] || undefined;

    if (!paperCode && !postName) continue;

    const safeCode = (paperCode || `PQP_${i}`).replace(/[^A-Z0-9_\-]/gi, "_");
    const safeLang = "ma";
    const id = `pyq-${examYear}-${safeCode}-${safeLang}`;

    records.push({
      id,
      examYear,
      postName: postName || "Kerala PSC Examination",
      department,
      trade,
      paperCode: paperCode || "UNKNOWN",
      categoryCodes,
      examDate: examDate || undefined,
      language: "Malayalam",
      questionPaperUrl,
      answerKeyStatus: "not_available",
      sourceType: "previous_question_papers",
      sourceDomain: "www.keralapsc.gov.in",
      ingestionStatus: questionPaperUrl ? "downloaded" : "discovered",
      extractedQuestionCount: 0,
      mockReadyCount: 0,
      requiresOcr: false,
      lastCheckedAt: new Date().toISOString(),
    });
  }

  return records;
}

function parseOmrAnswerKeyPage(html, pageNum = 0) {
  const records = [];
  const allTables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  const tableWrapper = allTables.find((t) => {
    const trs = [...t[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    return trs.length > 3;
  });

  if (!tableWrapper) return records;

  const trs = [...tableWrapper[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (let i = 1; i < trs.length; i++) {
    const tr = trs[i][1];
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (tds.length < 5) continue;

    const postName = cleanText(tds[0]);
    const detailsText = cleanText(tds[1]);
    const typeText = cleanText(tds[2]);
    const qpTd = tds[3] || "";
    const akTd = tds[4] || "";

    let paperCode = "";
    const codeMatch = detailsText.match(
      /(?:Question\s*(?:Paper)?\s*Code|QUESTION\s*CODE|Paper\s*Code)\s*[:\-]+\s*([0-9A-Za-z\-\/]+(?:\s+[MKTmkt])?)/i
    );
    if (codeMatch) paperCode = normalizePaperCode(codeMatch[1]);

    let categoryCodes = [];
    const catMatch = detailsText.match(
      /(?:Category|Cat)\.?\s*(?:Code|No(?:umber)?\.?|Number)?\s*[:\-]+\s*([\s\S]*?)(?=(?:Name\s*Of\s*Post|Post|Department|Dept|Date\s*Of\s*Test|Date\s*of\s*Test|Exam|Medium|Language|Question\s*(?:Paper)?\s*Code|Paper\s*Code|QUESTION\s*CODE|$))/i
    );
    if (catMatch) categoryCodes = parseCategoryCodes(catMatch[1]);

    let examDate = "";
    const dateMatch = detailsText.match(/Date\s*Of\s*Test\s*[:\-]+\s*([0-9A-Za-z\-\.\/]+)/i);
    if (dateMatch) examDate = dateMatch[1];

    let medium = "Malayalam";
    const medMatch = detailsText.match(
      /(?:Question\s*Paper\s*)?Medium\s*(?:of\s*Question)?\s*[:\-]+\s*([^\s;,]+)/i
    );
    if (medMatch) {
      const m = medMatch[1].toLowerCase();
      if (m.includes("eng")) medium = "English";
      else if (m.includes("tam")) medium = "Tamil";
      else if (m.includes("kan")) medium = "Kannada";
      else medium = "Malayalam";
    }

    let department = undefined;
    const deptMatch = detailsText.match(
      /(?:Name\s*Of\s*Post\s*&\s*)?Department\s*[:\-]+\s*(.+?)(?=\s+Date|\s*Category|\s*$)/i
    );
    if (deptMatch) department = deptMatch[1].trim();

    let trade = undefined;
    const tradeMatch = postName.match(/[\(\[]\s*([^\)\]]+)\s*[\)\]]/);
    if (tradeMatch) trade = tradeMatch[1].trim();

    const isFinal = typeText.toLowerCase().includes("final");
    const answerKeyStatus = isFinal ? "final" : "provisional";

    const qpLinks = [...qpTd.matchAll(/href=["']([^"']+)["']/gi)].map((m) =>
      resolveKpscUrl(m[1])
    );
    const akLinks = [...akTd.matchAll(/href=["']([^"']+)["']/gi)].map((m) =>
      resolveKpscUrl(m[1])
    );

    const questionPaperUrl = qpLinks[0] || undefined;
    const answerKeyUrl = akLinks[0] || undefined;

    let examYear = new Date().getFullYear();
    if (examDate) {
      const yM = examDate.match(/20\d\d|19\d\d/);
      if (yM) examYear = parseInt(yM[0], 10);
    } else if (paperCode) {
      const yM = paperCode.match(/(\d{4})|\-(\d{2})$/);
      if (yM) {
        if (yM[1]) examYear = parseInt(yM[1], 10);
        else if (yM[2]) examYear = 2000 + parseInt(yM[2], 10);
      }
    }

    if (!paperCode && !postName) continue;

    const safeCode = (paperCode || `OMR_${pageNum}_${i}`).replace(/[^A-Z0-9_\-]/gi, "_");
    const safeLang = medium.toLowerCase().slice(0, 2);
    const id = `pyq-${examYear}-${safeCode}-${safeLang}`;

    records.push({
      id,
      examYear,
      postName: postName || "Kerala PSC Examination",
      department,
      trade,
      paperCode: paperCode || "UNKNOWN",
      categoryCodes,
      examDate: examDate || undefined,
      language: medium,
      questionPaperUrl,
      answerKeyUrl,
      answerKeyStatus,
      sourceType: "omr_answer_key",
      sourceDomain: "www.keralapsc.gov.in",
      ingestionStatus: questionPaperUrl ? "downloaded" : "discovered",
      extractedQuestionCount: 0,
      mockReadyCount: 0,
      requiresOcr: false,
      lastCheckedAt: new Date().toISOString(),
    });
  }

  return records;
}

// In-memory cache for recent crawl runs (10-minute TTL)
let cacheTime = 0;
let cachedDiscovered = [];

async function crawlOfficialArchives(force = false) {
  const now = Date.now();
  if (!force && now - cacheTime < 10 * 60 * 1000 && cachedDiscovered.length > 0) {
    return cachedDiscovered;
  }

  const [omrHtml0, omrHtml1, pqpHtml0] = await Promise.all([
    fetchKpscPage("https://www.keralapsc.gov.in/answerkey_omrexams?page=0"),
    fetchKpscPage("https://www.keralapsc.gov.in/answerkey_omrexams?page=1"),
    fetchKpscPage("https://www.keralapsc.gov.in/previous-question-papers?page=0"),
  ]);

  const discovered = [
    ...parseOmrAnswerKeyPage(omrHtml0, 0),
    ...parseOmrAnswerKeyPage(omrHtml1, 1),
    ...parsePqpPage(pqpHtml0),
  ];

  if (discovered.length > 0) {
    cacheTime = now;
    cachedDiscovered = discovered;

    // Upsert into MongoDB crawledPyqPapers in background
    try {
      const db = await getDb();
      const col = db.collection("crawledPyqPapers");
      const bulkOps = discovered.map((p) => ({
        updateOne: {
          filter: { _id: p.id },
          update: { $set: { ...p, _id: p.id, updatedAt: new Date().toISOString() } },
          upsert: true,
        },
      }));
      if (bulkOps.length > 0) {
        await col.bulkWrite(bulkOps, { ordered: false });
      }
    } catch {
      // Non-blocking
    }
  }

  return discovered;
}

/**
 * GET /api/pyq/discover
 * Filter-driven discovery: checks live Kerala PSC official archives for newly available papers
 * matching post, categoryCode, trade, year, or search term.
 */
router.get(
  "/discover",
  asyncHandler(async (req, res) => {
    const { post, categoryCode, trade, year, search, refresh } = req.query;

    // 1. Fetch newly crawled papers from live site or cache
    const livePapers = await crawlOfficialArchives(Boolean(refresh));

    // 2. Fetch any previously stored crawled papers from MongoDB
    let dbPapers = [];
    try {
      const db = await getDb();
      dbPapers = await db.collection("crawledPyqPapers").find({}).limit(500).toArray();
    } catch {
      dbPapers = [];
    }

    // Merge without duplicates by ID
    const map = new Map();
    for (const p of dbPapers) map.set(p.id || p._id, p);
    for (const p of livePapers) map.set(p.id, p);
    const allDiscovered = [...map.values()];

    // 3. Filter strictly matching the user's active filter criteria
    const matching = allDiscovered.filter((p) => {
      if (post && !p.postName?.toLowerCase().includes(String(post).toLowerCase().trim())) {
        return false;
      }
      if (
        categoryCode &&
        !p.categoryCodes?.some((c) =>
          c.toLowerCase().includes(String(categoryCode).toLowerCase().trim())
        )
      ) {
        return false;
      }
      if (trade && p.trade?.toLowerCase() !== String(trade).toLowerCase().trim()) {
        return false;
      }
      if (year && String(p.examYear) !== String(year).trim()) {
        return false;
      }
      if (search) {
        const q = String(search).toLowerCase().trim();
        const mPost = p.postName?.toLowerCase().includes(q);
        const mCode = p.paperCode?.toLowerCase().includes(q);
        const mCat = p.categoryCodes?.some((c) => c.toLowerCase().includes(q));
        const mDept = p.department?.toLowerCase().includes(q);
        const mTrade = p.trade?.toLowerCase().includes(q);
        if (!mPost && !mCode && !mCat && !mDept && !mTrade) return false;
      }
      return true;
    });

    res.json({
      status: "ok",
      papers: matching,
      totalCrawled: allDiscovered.length,
      matchedCount: matching.length,
    });
  })
);

export default router;
