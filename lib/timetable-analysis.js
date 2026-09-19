"use strict";

const Busboy = require("busboy");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const APP_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SLOT_COUNT = 7;

const SYSTEM_PROMPT = [
  "You are analyzing a timetable screenshot. The image is the only source of truth.",
  "Do not use predefined subjects, faculty, course codes, sections, or timetable data.",
  "Reconstruct Monday through Saturday into exactly seven class slots per day; ignore break columns.",
  "Merged multi-period classes occupy every covered slot. Empty cells are null.",
  "Extract visible subject, courseCode, faculty, type (lecture, lab, other), and needsReview.",
  "Extract batch, className, department, section, and room only when visibly printed; otherwise null.",
  "Never guess or infer missing information. Return only the requested JSON.",
].join("\n");

const RESPONSE_SCHEMA = {
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
              type: "OBJECT", nullable: true,
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

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(json);
}

function fail(res, status, error, detail) {
  if (detail) console.error("[analyze]", detail);
  sendJson(res, status, { success: false, error });
}

function sniffMime(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).equals(Buffer.from("RIFF")) && buf.subarray(8, 12).equals(Buffer.from("WEBP"))) return "image/webp";
  return "";
}

function readUpload(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers["content-type"] || "");
    if (!type.startsWith("multipart/form-data")) return reject(Object.assign(new Error("Invalid upload."), { status: 400 }));
    let upload = null;
    let tooLarge = false;
    let parser;
    try { parser = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_IMAGE_BYTES } }); }
    catch (error) { return reject(Object.assign(new Error("Invalid upload."), { status: 400, detail: error.message })); }
    parser.on("file", (field, stream, info) => {
      if (field !== "image" || upload) { stream.resume(); return; }
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => { tooLarge = true; });
      stream.on("end", () => { upload = { data: Buffer.concat(chunks), mimeType: String(info.mimeType || "").toLowerCase() }; });
    });
    parser.on("error", (error) => reject(Object.assign(error, { status: 400 })));
    parser.on("finish", () => {
      if (tooLarge) return reject(Object.assign(new Error("Image is too large."), { status: 413 }));
      if (!upload || !upload.data.length) return reject(Object.assign(new Error("No image was uploaded."), { status: 400 }));
      resolve(upload);
    });
    req.pipe(parser);
  });
}

function clean(value, max) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function normalizeCell(raw, day, index) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${day} slot ${index + 1} is malformed.`);
  const subject = clean(raw.subject, 200);
  const courseCode = clean(raw.courseCode, 80);
  const faculty = clean(raw.faculty, 120);
  if (!subject && !courseCode && !faculty) return null;
  let type = typeof raw.type === "string" ? raw.type.toLowerCase().trim() : "";
  if (!["lecture", "lab", "other"].includes(type)) type = subject && /\b(lab|laboratory|practical)\b/i.test(subject) ? "lab" : "lecture";
  return { subject: subject || courseCode || faculty, courseCode, faculty, type, needsReview: raw.needsReview === true || !subject };
}

function normalizeMetadata(raw) {
  const result = { batch: null, className: null, department: null, section: null, room: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  Object.keys(result).forEach((key) => { result[key] = clean(raw[key], 80); });
  return result;
}

function normalizeModel(raw) {
  if (!raw || !Array.isArray(raw.days)) throw new Error("Model returned a malformed timetable.");
  const received = new Map();
  raw.days.forEach((entry) => {
    const day = clean(entry && entry.day, 20);
    const canonical = day && day.charAt(0).toUpperCase() + day.slice(1).toLowerCase();
    if (!APP_DAYS.includes(canonical)) return;
    if (!Array.isArray(entry.slots) || entry.slots.length !== SLOT_COUNT) throw new Error(`${canonical}: expected ${SLOT_COUNT} class slots.`);
    if (!received.has(canonical)) received.set(canonical, entry.slots);
  });
  if (!received.size) throw new Error("No recognizable timetable days were found in the image.");
  const days = APP_DAYS.map((day) => ({ day, slots: (received.get(day) || Array(SLOT_COUNT).fill(null)).map((cell, i) => normalizeCell(cell, day, i)) }));
  if (!days.some((day) => day.slots.some(Boolean))) throw new Error("No classes were detected in this image. Please try a clearer timetable screenshot.");
  return { days, metadata: normalizeMetadata(raw.metadata) };
}

async function callGemini(image, mimeType) {
  const key = process.env.GEMINI_API_KEY;
  const model = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
  if (!key) throw Object.assign(new Error("Timetable analysis is not configured on this server."), { status: 503 });
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ parts: [{ text: "Analyze this timetable screenshot. Return structured JSON only.", }, { inlineData: { mimeType, data: image.toString("base64") } }] }], generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0.1, maxOutputTokens: 8192 } }),
    });
  } catch (error) { throw Object.assign(new Error("Could not reach the analysis service. Please try again."), { status: 502, detail: error.message }); }
  let payload; try { payload = await response.json(); } catch (_) { payload = null; }
  if (!response.ok) {
    const provider = payload && payload.error && payload.error.message;
    const status = response.status === 429 ? 429 : (response.status === 401 || response.status === 403 ? 503 : 502);
    const message = status === 429 ? "Analysis is temporarily rate-limited. Please try again shortly." : (status === 503 ? "Timetable analysis is misconfigured on this server." : "The analysis service is temporarily unavailable. Please try again.");
    throw Object.assign(new Error(message), { status, detail: `Gemini ${response.status}: ${String(provider || "").slice(0, 200)}` });
  }
  const text = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content && payload.candidates[0].content.parts && payload.candidates[0].content.parts.map((part) => part.text || "").join("\n");
  try { return JSON.parse(String(text || "").replace(/^```json\s*/i, "").replace(/\s*```$/, "")); }
  catch (_) { throw Object.assign(new Error("The analysis returned an unreadable result. Please try a clearer screenshot."), { status: 502 }); }
}

async function handleAnalyze(req, res) {
  let upload;
  try { upload = await readUpload(req); }
  catch (error) { return fail(res, error.status || 400, error.status === 413 ? "Image is too large. Please choose a file under 10 MB." : "No valid image was uploaded. Please choose a PNG, JPG or WEBP image.", error.detail || error.message); }
  const sniffed = sniffMime(upload.data);
  if (!ALLOWED_MIME.has(sniffed) || (upload.mimeType && !ALLOWED_MIME.has(upload.mimeType))) return fail(res, 415, "Unsupported file type. Please choose a PNG, JPG or WEBP image.");
  let model;
  try { model = normalizeModel(await callGemini(upload.data, sniffed)); }
  catch (error) { return fail(res, error.status || 502, error.message || "Analysis failed. Please try again.", error.detail); }
  return sendJson(res, 200, { success: true, days: model.days, metadata: model.metadata, meta: { model: (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim(), slotsPerDay: SLOT_COUNT } });
}

module.exports = { handleAnalyze, sendJson };
