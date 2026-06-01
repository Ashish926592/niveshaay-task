/**
 * Niveshaay image-service — Puppeteer P&L PNG renderer.
 * ---------------------------------------------------------------------------
 * The ONLY external service the WhatsApp branch needs. The n8n "Render Image"
 * node POSTs the standardized P&L JSON here; we render the same styled green
 * card the UI shows (ui.html) and return it as a PNG (base64), which the
 * "Send to WhatsApp" node forwards to Evolution sendMedia.
 *
 *   POST /generate-image   { data: { company_name, quarter_type, row1..rowN } }
 *                       ->  { base64: "<png-without-data-uri-prefix>" }
 *   GET  /health        ->  { ok: true }
 *
 * The styling / highlight / negative-number logic mirrors ui.html, so the
 * WhatsApp image matches the in-browser "Download PNG" exactly.
 * ---------------------------------------------------------------------------
 *
 * How it works, end to end:
 *   1. Build an HTML page from the P&L JSON   (buildPageHtml)
 *   2. Open that page in a headless Chromium  (getBrowser + renderPngBase64)
 *   3. Screenshot the card and return base64   (POST /generate-image)
 */

const express = require("express");
const puppeteer = require("puppeteer-core");

const PORT = process.env.PORT || 3001;
// Path to the system Chromium binary (set in the Dockerfile). puppeteer-core
// never downloads its own browser, so this must point at a real Chromium.
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

/* ════════════════════════════════════════════════════════════════════════
 * SECTION 1 — Turn the P&L JSON into an HTML page
 * (kept byte-for-byte in sync with ui.html so both renderers look identical)
 * ════════════════════════════════════════════════════════════════════════ */

// Rows whose label matches one of these are emphasised (bold + green tint).
const HIGHLIGHT_LABELS = [
  "revenue",
  "gross profit",
  "ebitda",
  "total expenses",
  "profit before tax",
  "profit/loss before tax",
  "pat",
  "eps",
];

/** True for "key" rows (Revenue, EBITDA, PAT, …) that should be highlighted. */
function isHighlightRow(label) {
  const text = String(label || "").toLowerCase();
  const matchesKeyword = HIGHLIGHT_LABELS.some(
    (keyword) => text === keyword || text.startsWith(keyword)
  );
  return matchesKeyword || text.includes("ebitda") || text === "revenue";
}

/** True if a cell holds a negative number (e.g. "-12.34" or "-5.6%"). */
function isNegativeValue(value) {
  if (!value) return false;
  const cleaned = String(value).replace(/[%,]/g, "").trim();
  const num = parseFloat(cleaned);
  return !isNaN(num) && num < 0;
}

/** Escape a value so it is safe to drop into HTML. */
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Collect the row1, row2, … arrays from the P&L object, in order, as a list of
 * string arrays. Row 1 is the header; the rest are data rows.
 */
function extractRows(data) {
  const rows = [];
  for (let i = 1; data["row" + i]; i++) {
    const row = data["row" + i];
    if (Array.isArray(row)) {
      rows.push(row.map((cell) => (cell == null ? "" : String(cell))));
    }
  }
  return rows;
}

/** Render the <table> (header row + data rows) for the P&L. */
function buildTableHtml(data) {
  const rows = extractRows(data);
  if (rows.length === 0) return "<p>No rows.</p>";

  const headerCells = rows[0];
  const dataRows = rows.slice(1);

  const headerHtml = headerCells.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("");

  const bodyHtml = dataRows
    .map((row) => {
      const label = row[0] || "";
      // A "section heading" row (e.g. "Expenses") has no values in its other cells.
      const isSectionHeading = row.slice(1).every((cell) => cell === "");

      let rowClass = "";
      if (isHighlightRow(label)) rowClass = "hl";
      else if (isSectionHeading) rowClass = "sub";

      const cellsHtml = row
        .map((cell, index) => {
          // First column is the label; the rest are numeric values.
          const negativeClass = index > 0 && isNegativeValue(cell) ? ' class="neg"' : "";
          return `<td${negativeClass}>${escapeHtml(cell)}</td>`;
        })
        .join("");

      return `<tr class="${rowClass}">${cellsHtml}</tr>`;
    })
    .join("");

  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

/**
 * Build the full HTML page (the green P&L card) that Chromium will screenshot.
 * NOTE: the markup/CSS here is intentionally identical to ui.html's card so the
 * WhatsApp image matches the browser "Download PNG". Edit both together.
 */
function buildPageHtml(data) {
  const quarterLabel =
    data.quarter_type === "extended" ? "Extended (Q2/Q4)" : "Standard (Q1/Q3)";
  const companyName = escapeHtml(data.company_name || "Unknown Company");

  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><style>
    :root{--green-900:#0f3d1e;--green-800:#1b5e20;--green-700:#2e7d32;--green-100:#e8f5e9;--ink:#10231a;--muted:#5b6b62;--line:#e3e9e5;--red:#d32f2f;}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'DejaVu Sans','Liberation Sans',system-ui,Segoe UI,Arial,sans-serif;background:#fff;color:var(--ink);-webkit-font-smoothing:antialiased}
    .frame{display:inline-block;padding:24px;background:#fff}
    .pnl{border:1.5px solid var(--green-700);border-radius:12px;overflow:hidden;width:max-content;max-width:none}
    .pnl-head{background:linear-gradient(135deg,var(--green-800),var(--green-700));color:#fff;padding:14px 18px}
    .pnl-head .h1{font-size:17px;font-weight:800}
    .pnl-head .sub{font-size:11.5px;color:#cfe8d3;margin-top:2px}
    table{width:100%;border-collapse:collapse}
    thead th{background:var(--green-100);border-bottom:2px solid var(--green-700);padding:10px 14px;font-size:12.5px;font-weight:700;white-space:nowrap;text-align:right}
    thead th:first-child{text-align:left}
    tbody td{padding:9px 14px;font-size:12.5px;white-space:nowrap;text-align:right;border-bottom:1px solid var(--line);color:var(--ink)}
    tbody td:first-child{text-align:left}
    tbody tr.hl{background:var(--green-100)}
    tbody tr.hl td{font-weight:700}
    tbody tr.sub td:first-child{color:var(--muted);padding-left:26px;font-weight:500}
    td.neg{color:var(--red)}
    .pnl-foot{background:#f5f8f6;padding:7px 16px;text-align:right;font-size:10px;color:var(--muted);border-top:1px solid var(--line)}
  </style></head><body>
    <div class="frame"><div class="pnl">
      <div class="pnl-head"><div class="h1">${companyName}</div>
      <div class="sub">Quarterly Financial Results — ${quarterLabel} · All values in ₹ Crores</div></div>
      ${buildTableHtml(data)}
      <div class="pnl-foot">Generated by Niveshaay Financial Results Processor</div>
    </div></div>
  </body></html>`;
}

/* ════════════════════════════════════════════════════════════════════════
 * SECTION 2 — Headless Chromium (reused across requests)
 * ════════════════════════════════════════════════════════════════════════ */

// Launching Chromium is slow, so we keep ONE browser alive and reuse it.
// `browserPromise` caches the in-flight/last launch; if the browser has died
// we relaunch transparently.
let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      if (browser.connected) return browser;
    } catch (_) {
      // Previous launch failed or the browser crashed — fall through to relaunch.
    }
  }

  browserPromise = puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    // Flags required to run Chromium inside a container as a non-root/limited user.
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  return browserPromise;
}

/* ════════════════════════════════════════════════════════════════════════
 * SECTION 3 — Render the P&L JSON to a PNG (base64)
 * ════════════════════════════════════════════════════════════════════════ */

async function renderPngBase64(data) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Render at 2x for a crisp image; the card sizes itself to its content.
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });
    await page.setContent(buildPageHtml(data), { waitUntil: "networkidle0" });

    // Screenshot just the ".frame" element (the card + its white padding),
    // falling back to the whole page if the selector isn't found.
    const target = (await page.$(".frame")) || page;
    const pngBuffer = await target.screenshot({ type: "png" });
    return Buffer.from(pngBuffer).toString("base64");
  } finally {
    await page.close(); // always release the tab, even on error
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * SECTION 4 — HTTP server
 * ════════════════════════════════════════════════════════════════════════ */

const app = express();
app.use(express.json({ limit: "5mb" })); // base64 PDFs/images can be large

// Liveness check used by docker / the README troubleshooting steps.
app.get("/health", (_req, res) => res.json({ ok: true }));

// Main endpoint: P&L JSON in, PNG (base64) out.
app.post("/generate-image", async (req, res) => {
  // Accept either { data: {...} } (how n8n sends it) or the bare P&L object.
  const data = (req.body && req.body.data) || req.body;

  if (!data || typeof data !== "object" || !data.row1) {
    return res.status(400).json({ error: "Expected JSON body { data: { row1, ... } }" });
  }

  try {
    const base64 = await renderPngBase64(data);
    res.json({ base64 });
  } catch (err) {
    console.error("render failed:", err);
    const message = err && err.message ? err.message : String(err);
    res.status(500).json({ error: "Failed to render image: " + message });
  }
});

app.listen(PORT, () => console.log(`image-service listening on :${PORT} (chromium=${CHROMIUM_PATH})`));
