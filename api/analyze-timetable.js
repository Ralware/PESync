"use strict";

/* Vercel serverless entry point. The analysis implementation is shared with
 * server.js so local development and production validate the exact same
 * uploads and Gemini responses. */
const { handleAnalyze } = require("../server");

module.exports = async function analyzeTimetable(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ success: false, error: "Method not allowed." }));
    return;
  }
  try {
    await handleAnalyze(req, res);
  } catch (error) {
    console.error("[analyze] unexpected", error && error.message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ success: false, error: "Analysis failed. Please try again." }));
    }
  }
};

/* FormData must reach the shared multipart parser as an unconsumed stream. */
module.exports.config = {
  api: { bodyParser: false },
};
