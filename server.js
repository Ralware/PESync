/* ============================================================
 * PES Timetable — static file server + Gemini vision backend
 * (zero dependencies, vanilla Node.js >= 18)
 *
 * Architecture (API key never leaves the server):
 *
 *   Browser
 *     -- POST /api/analyze-timetable (multipart image) -->
 *   server.js
 *     -- HTTPS (image + prompt, structured JSON) -->
 *   Google Gemini API
 *     -- structured timetable JSON -->
 *   server validation
 *     -- normalized JSON -->
 *   Browser (review -> confirm -> import)
 *
 *   npm install   (no dependencies, but keeps workflow standard)
 *   npm start     (serves the app on PORT, default 3000)
 *
 * Configuration via environment (.env file supported):
 *   GEMINI_API_KEY   required — server-side only, never sent out
 *   GEMINI_MODEL     optional — vision-capable model name
 *   PORT             optional — default 3000
 * ============================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

/* ---------- .env loader (no dotenv dependency) ---------- */
function loadDotEnv() {
  const envFile = path.join(ROOT, ".env");
  let raw;
  try {
    raw = fs.readFileSync(envFile, "utf8");
  } catch (e) {
    return; /* no .env: rely on real environment variables */
  }
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

loadDotEnv();

const PORT = parseInt(process.env.PORT || "3000", 10);
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; /* 10 MB, mirrored in frontend */
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};
const APP_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const SLOT_COUNT = 7;
const VALID_TYPES = ["lecture", "lab", "other"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* ============================================================
 * Gemini prompt — the uploaded image is the ONLY source of truth.
 * No predefined subjects / codes / faculty are ever mentioned,
 * so the model cannot map the screenshot onto this app's default
 * timetable.
 * ============================================================ */
const GEMINI_SYSTEM_PROMPT = [
  "You are analyzing a timetable screenshot.",
  "Your task is to reconstruct the timetable represented in the image.",
  "",
  "The image is the source of truth.",
  "Do not assume that the timetable belongs to any particular user, section,",
  "semester, college, or existing timetable.",
  "Do not use any predefined subject list.",
  "Do not use any predefined faculty list.",
  "Do not use any predefined course-code list.",
  "Do not replace an unfamiliar subject with a familiar one.",
  "",
  "Extract the actual text and structure visible in the screenshot:",
  "- Identify day rows (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday).",
  "- Identify class periods left-to-right as 7 class slots (slot 0..6).",
  "- IGNORED: break / lunch / recess columns are NOT class slots. Never create",
  "  a subject for a break column. Never shift class slots because of breaks.",
  "- Merged or multi-period cells (e.g. a 2-hour lab spanning two columns)",
  "  occupy EACH covered slot with the same class content. Preserve type=lab",
  "  when the image indicates a lab / laboratory / practical.",
  "- Empty cells are null. Do not convert blanks into 'Free', 'Break', 'N/A',",
  '  "-", or any invented subject unless that literal text is printed in the cell.',
  "- For each occupied cell extract: subject (full visible name, abbreviations",
  "  expanded only if the expansion is literally printed), courseCode (exactly as",
  "  printed, or null when absent), faculty (exactly as printed, or null when",
  "  absent), type ('lecture', 'lab', or 'other').",
  "- If information is not visible or cannot be determined confidently, use null.",
  "  Never hallucinate a subject, course code, or faculty name.",
  "  Never infer a faculty name from another day.",
  "  Never infer a course code.",
  "- Also extract timetable metadata only when it is visibly printed: batch,",
  "  className (class/semester), department, section, and room. Return null",
  "  for every metadata field that is absent or uncertain. Never infer metadata.",
  "- If a cell is ambiguous or hard to read, set needsReview=true so a human",
  "  checks it. Otherwise needsReview=false.",
  "",
  "Return ONLY the requested structured JSON. No prose, no markdown fences.",
].join("\n");

const GEMINI_USER_PROMPT = [
  "Analyze this timetable screenshot and return the timetable as structured JSON.",
  "Map the visible grid to days Monday..Saturday, each with exactly 7 class slots",
  "(breaks excluded). Extract visible timetable metadata when present. Image is",
  "source of truth. Missing information -> null.",
].join(" ");

const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    days: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          day: { type: "STRING" },
          slots: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              nullable: true,
              properties: {
                subject: { type: "STRING", nullable: true },
                courseCode: { type: "STRING", nullable: true },
                faculty: { type: "STRING", nullable: true },
                type: { type: "STRING", nullable: true },
                needsReview: { type: "BOOLEAN", nullable: true },
              },
            },
          },
        },
        required: ["day", "slots"],
      },
    },
    metadata: {
      type: "OBJECT",
      properties: {
        batch: { type: "STRING", nullable: true },
        className: { type: "STRING", nullable: true },
        department: { type: "STRING", nullable: true },
        section: { type: "STRING", nullable: true },
        room: { type: "STRING", nullable: true },
      },
      required: ["batch", "className", "department", "section", "room"],
    },
  },
  required: ["days", "metadata"],
};

/* ---------- helpers ---------- */
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function fail(res, status, message, logDetail) {
  if (logDetail) console.error("[analyze]", logDetail);
  sendJson(res, status, { success: false, error: message });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(
          Object.assign(new Error("Payload too large."), { status: 413 }),
        );
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* Minimal multipart parser (single-file upload, in memory only).
 * Returns { file: { mimeType, data: Buffer, filename } | null }. */
function parseMultipart(buffer, boundary) {
  const sep = Buffer.from("--" + boundary, "utf8");
  const endSep = Buffer.from("--" + boundary + "--", "utf8");
  const result = { file: null };
  let pos = 0;
  for (;;) {
    const start = buffer.indexOf(sep, pos);
    if (start === -1) break;
    if (
      buffer
        .subarray(start, start + endSep.length)
        .equals(endSep)
    )
      break;
    let headerEnd = buffer.indexOf("\r\n\r\n", start);
    let sepLen = 4;
    if (headerEnd === -1) {
      headerEnd = buffer.indexOf("\n\n", start);
      sepLen = 2;
      if (headerEnd === -1) break;
    }
    const headerText = buffer
      .subarray(start + sep.length, headerEnd)
      .toString("utf8");
    const next = buffer.indexOf(sep, headerEnd + sepLen);
    const bodyEnd =
      next === -1 ? buffer.length : next - 2; /* strip trailing CRLF */
    const data = buffer.subarray(headerEnd + sepLen, Math.max(bodyEnd, headerEnd + sepLen));
    const nameMatch = /name="([^"]*)"/.exec(headerText);
    const filenameMatch = /filename="([^"]*)"/.exec(headerText);
    const typeMatch = /content-type:\s*([^\s;]+)/i.exec(headerText);
    const fieldName = nameMatch ? nameMatch[1] : "";
    if (fieldName === "image" || (filenameMatch && !result.file)) {
      result.file = {
        filename: filenameMatch ? filenameMatch[1] : "upload",
        mimeType: typeMatch ? typeMatch[1].toLowerCase() : "",
        data: Buffer.from(data),
      };
    }
    if (next === -1) break;
    pos = next;
  }
  return result;
}

function sniffMime(buf) {
  if (!buf || buf.length < 12) return "";
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "image/jpeg";
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return "image/webp";
  return "";
}

function sanitizeStr(value, maxLen) {
  if (typeof value !== "string") return null;
  let s = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  s = s.replace(/\s+/g, " ");
  if (s === "") return null;
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/* Validate + normalize one Gemini slot cell. Returns null (empty) or a
 * clean { subject, courseCode, faculty, type, needsReview } object.
 * Throws on malformed (non-null, non-object) cells. */
function normalizeCell(raw, day, idx) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(day + " slot " + (idx + 1) + " is malformed.");
  }
  const subject = sanitizeStr(raw.subject, 200);
  const courseCode = sanitizeStr(raw.courseCode, 80);
  let faculty = sanitizeStr(raw.faculty, 120);
  if (faculty) {
    faculty = faculty.replace(/^(F\s*:\s*|Faculty\s*:\s*)/i, "").trim() || null;
  }
  let type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : null;
  if (type !== "lecture" && type !== "lab" && type !== "other") {
    if (subject && /(\blab\b|laboratory|practical)/i.test(subject)) type = "lab";
    else if (subject) type = "lecture";
    else type = null;
  }
  if (!subject && !courseCode && !faculty) return null; /* empty cell */
  if (!subject && (courseCode || faculty)) {
    /* A code/faculty with no readable subject name is not importable
     * as a class — flag it for human review instead of inventing one. */
    return {
      subject: courseCode || faculty,
      courseCode,
      faculty,
      type: type || "lecture",
      needsReview: true,
    };
  }
  return {
    subject,
    courseCode: courseCode || null,
    faculty: faculty || null,
    type: type || "lecture",
    needsReview: raw.needsReview === true,
  };
}

function normalizeMetadata(raw) {
  const metadata = {
    batch: null,
    className: null,
    department: null,
    section: null,
    room: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return metadata;
  Object.keys(metadata).forEach((key) => {
    metadata[key] = sanitizeStr(raw[key], 80);
  });
  return metadata;
}

function normalizeGeminiPayload(obj) {
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.days)) {
    throw new Error("Model returned a malformed timetable.");
  }
  const byDay = new Map();
  obj.days.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const dayName =
      typeof entry.day === "string"
        ? entry.day.trim().charAt(0).toUpperCase() +
          entry.day.trim().slice(1).toLowerCase()
        : "";
    if (APP_DAYS.indexOf(dayName) === -1) return; /* ignore Sunday etc. */
    if (!Array.isArray(entry.slots) || entry.slots.length !== SLOT_COUNT) {
      throw new Error(
        dayName + ": expected " + SLOT_COUNT + " class slots.",
      );
    }
    if (!byDay.has(dayName)) byDay.set(dayName, entry.slots);
  });
  if (byDay.size === 0) {
    throw new Error("No recognizable timetable days were found in the image.");
  }
  const days = APP_DAYS.map((day) => {
    const rawSlots = byDay.get(day) || [null, null, null, null, null, null, null];
    return {
      day,
      slots: rawSlots.map((raw, idx) => normalizeCell(raw, day, idx)),
    };
  });
  const occupied = days.reduce(
    (n, d) => n + d.slots.filter((s) => s !== null).length,
    0,
  );
  if (occupied === 0) {
    throw new Error("No classes were detected in this image. Please try a clearer timetable screenshot.");
  }
  return { days, metadata: normalizeMetadata(obj.metadata) };
}

function extractJsonFromModelText(text) {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model returned a malformed timetable.");
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new Error("Model returned invalid JSON.");
  }
}

async function callGemini(imageBuffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error(
      "Timetable analysis is not configured on this server (missing API key).",
    );
    err.status = 503;
    err.code = "GEMINI_KEY_MISSING";
    throw err;
  }
  const base64 = imageBuffer.toString("base64");
  /* Keep the credential out of the URL. It is sent only in the server-side
   * provider header, so it cannot leak through a browser URL, history, or
   * request logging that records query strings. */
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(GEMINI_MODEL) +
    ":generateContent";
  let httpRes;
  try {
    httpRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
        contents: [
          {
            parts: [
              { text: GEMINI_USER_PROMPT },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: GEMINI_RESPONSE_SCHEMA,
          temperature: 0.1,
          maxOutputTokens: 8192,
        },
      }),
    });
  } catch (e) {
    const err = new Error(
      "Could not reach the analysis service. Check your connection and try again.",
    );
    err.status = 502;
    err.code = "GEMINI_NETWORK";
    err.causeDetail = e && e.message;
    throw err;
  }
  let payload = null;
  try {
    payload = await httpRes.json();
  } catch (e) {
    payload = null;
  }
  if (!httpRes.ok) {
    const serverMsg =
      payload && payload.error && payload.error.message
        ? String(payload.error.message)
        : "";
    const status = httpRes.status;
    console.error(
      "[analyze] gemini HTTP " + status + (serverMsg ? " " + serverMsg.slice(0, 200) : ""),
    );
    const err = new Error("Analysis failed. Please try again.");
    err.status = 502;
    if (status === 400 && /api key/i.test(serverMsg)) {
      err.message = "Timetable analysis is misconfigured on this server.";
      err.status = 503;
      err.code = "GEMINI_AUTH";
    } else if (status === 401 || status === 403) {
      err.message = "Timetable analysis is misconfigured on this server.";
      err.status = 503;
      err.code = "GEMINI_AUTH";
    } else if (status === 429) {
      err.message = "Analysis is temporarily rate-limited. Please wait a minute and try again.";
      err.status = 429;
      err.code = "GEMINI_QUOTA";
    } else if (status >= 500) {
      err.message = "The analysis service is temporarily unavailable. Please try again.";
      err.code = "GEMINI_SERVER";
    } else if (status === 400) {
      err.message = "That image could not be analyzed. Please try a clearer screenshot.";
      err.code = "GEMINI_BAD_REQUEST";
    }
    throw err;
  }
  try {
    const parts =
      payload &&
      payload.candidates &&
      payload.candidates[0] &&
      payload.candidates[0].content &&
      payload.candidates[0].content.parts;
    const text = parts && parts.map((p) => p.text || "").join("\n");
    if (!text || !text.trim()) throw new Error("empty model response");
    return extractJsonFromModelText(text);
  } catch (e) {
    const err = new Error(
      "The analysis returned an unreadable result. Please try a clearer screenshot.",
    );
    err.status = 502;
    err.code = "GEMINI_MALFORMED";
    err.causeDetail = e && e.message;
    throw err;
  }
}

async function handleAnalyze(req, res) {
  const contentType = String(req.headers["content-type"] || "");
  let imageBuffer = null;
  let mimeType = "";

  if (contentType.startsWith("multipart/form-data")) {
    const boundaryMatch = /boundary=(.+)$/.exec(contentType);
    if (!boundaryMatch) {
      return fail(res, 400, "Invalid upload. Please try again.", "missing multipart boundary");
    }
    let body;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      return fail(res, e.status || 413, "Image is too large. Please choose a file under 10 MB.", e.message);
    }
    const parsed = parseMultipart(body, boundaryMatch[1].trim().replace(/^"|"$/g, ""));
    if (!parsed.file || !parsed.file.data || parsed.file.data.length === 0) {
      return fail(res, 400, "No image was uploaded. Please choose a PNG, JPG or WEBP image.");
    }
    imageBuffer = parsed.file.data;
    mimeType = (parsed.file.mimeType || "").toLowerCase();
    if (!ALLOWED_MIME[mimeType]) {
      const sniffed = sniffMime(imageBuffer);
      if (ALLOWED_MIME[sniffed]) mimeType = sniffed;
    }
  } else if (contentType.includes("application/json")) {
    let body;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      return fail(res, e.status || 413, "Image is too large. Please choose a file under 10 MB.", e.message);
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch (e) {
      return fail(res, 400, "Invalid upload. Please try again.");
    }
    const dataUrl = parsed && typeof parsed.image === "string" ? parsed.image : "";
    const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) {
      return fail(res, 400, "No image was uploaded. Please choose a PNG, JPG or WEBP image.");
    }
    mimeType = m[1] === "image/jpeg" ? "image/jpeg" : m[1];
    imageBuffer = Buffer.from(m[3], "base64");
  } else {
    return fail(res, 400, "Invalid upload. Please try again.", "unsupported content-type: " + contentType);
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    return fail(res, 400, "No image was uploaded. Please choose a PNG, JPG or WEBP image.");
  }
  if (imageBuffer.length > MAX_IMAGE_BYTES) {
    return fail(res, 413, "Image is too large. Please choose a file under 10 MB.");
  }
  if (!ALLOWED_MIME[mimeType]) {
    const sniffed = sniffMime(imageBuffer);
    if (ALLOWED_MIME[sniffed]) {
      mimeType = sniffed;
    } else {
      return fail(res, 415, "Unsupported file type. Please choose a PNG, JPG or WEBP image.", "rejected mime: " + mimeType);
    }
  }

  console.log(
    "[analyze] image " + mimeType + " " + imageBuffer.length + " bytes -> " + GEMINI_MODEL,
  );

  let raw;
  try {
    raw = await callGemini(imageBuffer, mimeType);
  } catch (e) {
    /* Never leak the API key or raw provider errors to the browser. */
    return fail(res, e.status || 502, e.message || "Analysis failed. Please try again.", e.code + (e.causeDetail ? ": " + e.causeDetail : ""));
  }

  let normalized;
  try {
    normalized = normalizeGeminiPayload(raw);
  } catch (e) {
    return fail(res, 422, e.message || "Could not understand this timetable image.", "validation: " + e.message);
  }

  return sendJson(res, 200, {
    success: true,
    days: normalized.days,
    metadata: normalized.metadata,
    meta: { model: GEMINI_MODEL, slotsPerDay: SLOT_COUNT },
  });
}

/* ---------- static serving ---------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  const safe = path.normalize(rel).replace(/^([/\\])+/, "");
  const file = path.resolve(ROOT, safe);
  /* startsWith(ROOT) alone would accept a sibling such as "ROOT-backup".
   * A relative-path check correctly rejects all paths outside the app. */
  const relative = path.relative(ROOT, file);
  if (relative === "" || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const base = path.basename(file);
  if (base === ".env" || base.startsWith(".git")) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": data.length,
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/analyze-timetable" && req.method === "POST") {
    handleAnalyze(req, res).catch((e) => {
      console.error("[analyze] unexpected", e && e.message);
      if (!res.headersSent) {
        fail(res, 500, "Analysis failed. Please try again.");
      }
    });
    return;
  }
  if (url.pathname === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      model: GEMINI_MODEL,
      configured: Boolean(process.env.GEMINI_API_KEY),
    });
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, url.pathname);
    return;
  }
  res.writeHead(405);
  res.end();
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`PES timetable: http://127.0.0.1:${PORT}`);
    console.log(
      `Gemini model: ${GEMINI_MODEL} (${process.env.GEMINI_API_KEY ? "API key configured" : "GEMINI_API_KEY missing — /api/analyze-timetable will return 503"})`,
    );
  });
}

module.exports = { server, handleAnalyze };
