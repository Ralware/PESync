"use strict";

/* Local-development only. Vercel serves static files itself and invokes only
 * api/analyze-timetable.js for production analysis requests. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleAnalyze, sendJson } = require("./lib/timetable-analysis");

const ROOT = __dirname;
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

try {
  fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/).forEach((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  });
} catch (_) { /* Environment variables may be supplied by the shell. */ }

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^[/\\]+/, "");
  const file = path.resolve(ROOT, requested);
  const relative = path.relative(ROOT, file);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || path.basename(file) === ".env" || path.basename(file).startsWith(".git")) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (error, data) => {
    if (error) { res.statusCode = 404; return res.end("Not found"); }
    res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/analyze-timetable" && req.method === "POST") {
    handleAnalyze(req, res).catch((error) => { console.error("[analyze] unexpected", error && error.message); if (!res.headersSent) sendJson(res, 500, { success: false, error: "Analysis failed. Please try again." }); });
    return;
  }
  if (url.pathname === "/api/health" && req.method === "GET") return sendJson(res, 200, { ok: true, configured: Boolean(process.env.GEMINI_API_KEY), model: (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim() });
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, url.pathname);
  sendJson(res, 405, { success: false, error: "Method not allowed." });
}).listen(PORT, "127.0.0.1", () => console.log(`PES timetable: http://127.0.0.1:${PORT}`));
