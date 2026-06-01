/**
 * build-workflow.js  (dev/build helper — NOT part of the runtime)
 * ---------------------------------------------------------------------------
 * Assembles `workflow.json` (the importable n8n workflow) from `prompt.md`.
 *
 *   node tools/build-workflow.js
 *
 * Why a build step? It guarantees the long Gemini prompt is embedded with
 * correct escaping, and keeps the prompt editable in one place (prompt.md).
 * NO secrets are written: the workflow references {{ $env.GEMINI_API_KEY }},
 * {{ $env.EVOLUTION_* }} and {{ $env.WHATSAPP_GROUP_JID }} at runtime, so the
 * generated workflow.json is safe to commit. The whole pipeline still runs
 * 100% inside n8n; this script only emits the file you import.
 * ---------------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PROMPT = fs.readFileSync(path.join(ROOT, "prompt.md"), "utf-8").trim();

// ── reusable node-factory helpers ──────────────────────────────────────────
let uid = 0;
const id = () => `nv-${String(++uid).padStart(4, "0")}`;

function code(name, jsCode, position, onError) {
  const node = {
    parameters: { jsCode: jsCode.trim() },
    id: id(),
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
  };
  if (onError) node.onError = onError;
  return node;
}

function ifError(name, leftValue, position) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [
          {
            id: "cond",
            leftValue,
            rightValue: "true",
            operator: { type: "boolean", operation: "equals", singleValue: true },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    id: id(),
    name,
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position,
  };
}

function completion(name, title, message, position) {
  return {
    parameters: {
      operation: "completion",
      completionTitle: title,
      completionMessage: message,
      options: {},
    },
    id: id(),
    name,
    type: "n8n-nodes-base.form",
    typeVersion: 1,
    position,
  };
}

function http(name, params, position, onError) {
  const node = {
    parameters: params,
    id: id(),
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
  };
  if (onError) node.onError = onError;
  return node;
}

// ── node definitions ────────────────────────────────────────────────────────
const formTrigger = {
  parameters: {
    path: "process-pdf",
    formTitle: "Niveshaay — Corporate Result Processor",
    formDescription:
      "Paste a BSE/NSE corporate result PDF link. The pipeline extracts the consolidated P&L and returns standardized JSON (and, if configured, posts a P&L image to WhatsApp).",
    formFields: {
      values: [
        {
          fieldLabel: "PDF Link",
          fieldType: "text",
          placeholder: "https://www.bseindia.com/xml-data/corpfiling/AttachLive/result.pdf",
          requiredField: true,
        },
      ],
    },
    options: {},
  },
  id: id(),
  name: "On form submission",
  type: "n8n-nodes-base.formTrigger",
  typeVersion: 2.2,
  position: [240, 400],
  webhookId: "process-pdf-form",
};

const validate = code(
  "Validate Input",
  `
const pdfUrl = String($input.first().json["PDF Link"] || "").trim();
if (!pdfUrl) {
  return [{ json: { error: true, message: "PDF URL is required" } }];
}
if (!pdfUrl.startsWith("https://")) {
  return [{ json: { error: true, message: "URL must start with https://" } }];
}
if (!pdfUrl.toLowerCase().includes(".pdf")) {
  return [{ json: { error: true, message: "URL must point to a PDF file (.pdf)" } }];
}
return [{ json: { pdfUrl, error: false } }];
`,
  [460, 400]
);

const isValid = ifError("Is Valid?", "={{ $json.error }}", [680, 400]);

const invalidInput = completion(
  "Invalid Input",
  "⚠ Invalid input",
  "={{ $json.message || 'Invalid request.' }}",
  [900, 560]
);

const downloadPdf = http(
  "Download PDF",
  {
    url: "={{ $('Validate Input').first().json.pdfUrl }}",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        {
          name: "User-Agent",
          value:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        { name: "Accept", value: "application/pdf,application/octet-stream,*/*" },
      ],
    },
    options: {
      response: { response: { responseFormat: "file" } },
      timeout: 30000,
    },
  },
  [900, 340],
  "continueErrorOutput"
);

const downloadError = completion(
  "Download Error",
  "⚠ Download failed",
  "Failed to download the PDF. The link may be invalid, expired, or blocked. Please check the URL and try again.",
  [1120, 540]
);

const prepareGemini = code(
  "Prepare Gemini Request",
  `
const binaryDataBuffer = await this.helpers.getBinaryDataBuffer(0, 'data');
const base64Pdf = binaryDataBuffer.toString('base64');

const PROMPT = ${JSON.stringify(PROMPT)};

const requestBody = {
  contents: [
    {
      parts: [
        { inline_data: { mime_type: "application/pdf", data: base64Pdf } },
        { text: PROMPT }
      ]
    }
  ]
};

return [{ json: { requestBody } }];
`,
  [1120, 340]
);

const callGemini = http(
  "Call Gemini API",
  {
    method: "POST",
    url:
      '={{ "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + $env.GEMINI_API_KEY }}',
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify($json.requestBody) }}",
    options: { timeout: 120000 },
  },
  [1340, 340],
  "continueErrorOutput"
);

const geminiError = completion(
  "Gemini Call Error",
  "⚠ Gemini API error",
  "The Gemini API call failed. Please verify the GEMINI_API_KEY and quota, then try again.",
  [1560, 540]
);

const parseResponse = code(
  "Parse Response",
  `
const response = $input.first().json;
const candidates = response.candidates;
if (!candidates || candidates.length === 0) {
  return [{ json: { error: true, message: "No response from Gemini." } }];
}

let responseText = candidates[0].content?.parts?.[0]?.text || "";

if (responseText.trim().toLowerCase().includes("no pnl found")) {
  return [{ json: { error: true, message: "No P&L statement found in this PDF." } }];
}

// Strip markdown code fences without using backtick literals
let cleaned = responseText.trim();
const fence = String.fromCharCode(96, 96, 96);
if (cleaned.startsWith(fence + "json")) {
  cleaned = cleaned.slice(7);
} else if (cleaned.startsWith(fence)) {
  cleaned = cleaned.slice(3);
}
if (cleaned.endsWith(fence)) {
  cleaned = cleaned.slice(0, -3);
}
cleaned = cleaned.trim();

let parsedData;
try {
  parsedData = JSON.parse(cleaned);
} catch (e) {
  return [{ json: { error: true, message: "Failed to parse the Gemini response as JSON." } }];
}

return [{ json: { error: false, data: parsedData } }];
`,
  [1560, 340]
);

const parseOk = ifError("Parse OK?", "={{ $json.error }}", [1780, 340]);

const extractionError = completion(
  "Extraction Error",
  "⚠ Could not extract P&L",
  "={{ $json.message || 'Extraction failed.' }}",
  [2000, 540]
);

const prepareImage = code(
  "Prepare Image Payload",
  `
const data = $input.first().json.data;
const groupJid = String($env.WHATSAPP_GROUP_JID || "").trim();
// skip the image/WhatsApp branch entirely when no group JID is configured
return [{ json: { data, skip: !groupJid } }];
`,
  [2000, 300]
);

const whatsappConfigured = ifError("WhatsApp Configured?", "={{ $json.skip }}", [2220, 300]);

const buildHtml = code(
  "Build P&L HTML",
  `
const data = $json.data || {};
const companyName = data.company_name || "Unknown Company";
const quarterType = data.quarter_type === "extended" ? "Extended (Q2/Q4)" : "Standard (Q1/Q3)";
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const rows = [];
let i = 1;
while (data["row" + i]) {
  if (Array.isArray(data["row" + i])) rows.push(data["row" + i].map((v) => String(v == null ? "" : v)));
  i++;
}
const header = rows[0] || [];
const body = rows.slice(1);

const isHi = (l) => { l = (l || "").toLowerCase(); return l.includes("ebitda") || l.includes("profit") || l.includes("pat") || l.includes("revenue") || l.includes("total expenses") || l.includes("eps"); };
const isNeg = (v) => { if (!v) return false; const c = v.replace(/[%,]/g, "").trim(); return !isNaN(parseFloat(c)) && parseFloat(c) < 0; };

const th = header.map((h) => '<th style="padding:10px 16px;text-align:' + (h === "Particulars" ? "left" : "right") + ';white-space:nowrap;font-weight:600;font-size:13px;">' + esc(h) + '</th>').join("");
const tr = body.map((r) => {
  const label = r[0] || "";
  const hi = isHi(label);
  const bg = hi ? "background-color:#e8f5e9;" : "";
  const fw = hi ? "font-weight:600;" : "font-weight:400;";
  const tds = r.map((c, idx) => {
    const al = idx === 0 ? "left" : "right";
    const col = idx > 0 && isNeg(c) ? "color:#d32f2f;" : "color:#1a1a1a;";
    return '<td style="padding:8px 16px;text-align:' + al + ';' + fw + col + 'font-size:13px;white-space:nowrap;">' + esc(c) + '</td>';
  }).join("");
  return '<tr style="' + bg + 'border-bottom:1px solid #e0e0e0;">' + tds + '</tr>';
}).join("");

const html = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"/>',
  '<style>* { margin:0; padding:0; box-sizing:border-box; } body { font-family: Segoe UI, Arial, sans-serif; background:#fff; padding:20px; } .container { max-width:1100px; border:2px solid #2e7d32; border-radius:8px; overflow:hidden; } .header { background:linear-gradient(135deg,#1b5e20,#2e7d32); padding:16px 20px; } .header h1 { color:#fff; font-size:20px; font-weight:700; } .header .subtitle { color:#c8e6c9; font-size:12px; margin-top:4px; } table { width:100%; border-collapse:collapse; } thead { background:#e8f5e9; } thead th { border-bottom:2px solid #2e7d32; } .footer { background:#f5f5f5; padding:8px 20px; text-align:right; font-size:10px; color:#888; border-top:1px solid #e0e0e0; }</style>',
  '</head><body><div class="container"><div class="header"><h1>' + esc(companyName) + '</h1><div class="subtitle">Quarterly Financial Results — ' + esc(quarterType) + ' | All values in Rs. Crores</div></div>',
  '<table><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>',
  '<div class="footer">Generated by Niveshaay Financial Results Processor</div></div></body></html>'
].join("");

const dataUrl = "data:text/html;charset=utf-8;base64," + Buffer.from(html, "utf-8").toString("base64");
return [{ json: { data, html, dataUrl } }];
`,
  [2220, 160]
);

const renderPng = {
  parameters: {
    operation: "getScreenshot",
    url: "={{ $json.dataUrl }}",
    fullPage: true,
    output: "binary",
    binaryProperty: "data",
    imageType: "png",
    options: {},
  },
  id: id(),
  name: "Render PNG",
  type: "n8n-nodes-puppeteer.puppeteer",
  typeVersion: 1,
  position: [2440, 160],
  onError: "continueErrorOutput",
};

const imageToBase64 = code(
  "Image to Base64",
  `
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
return [{ json: { base64: buf.toString('base64') } }];
`,
  [2660, 160]
);

const sendWhatsapp = http(
  "Send to WhatsApp",
  {
    method: "POST",
    url: '={{ $env.EVOLUTION_API_URL + "/message/sendMedia/" + $env.EVOLUTION_INSTANCE }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "apikey", value: "={{ $env.EVOLUTION_API_KEY }}" }] },
    sendBody: true,
    specifyBody: "json",
    jsonBody:
      '={{ JSON.stringify({ number: $env.WHATSAPP_GROUP_JID, mediatype: "image", mimetype: "image/png", media: $json.base64, fileName: "financial_results.png", caption: "P&L Results: " + ($(\'Prepare Image Payload\').first().json.data.company_name || "") }) }}',
    options: { timeout: 30000 },
  },
  [2880, 160],
  "continueErrorOutput"
);

const successCompletion = completion(
  "Success",
  "={{ '✓ ' + ($('Parse Response').first().json.data.company_name || 'Result') + ' — ' + ($('Parse Response').first().json.data.quarter_type || '') }}",
  "={{ JSON.stringify($('Parse Response').first().json.data, null, 2) }}",
  [2660, 360]
);

// ── assemble ─────────────────────────────────────────────────────────────────
const workflow = {
  id: "niveshaayfinres1",
  name: "Niveshaay — Automated Financial Results Processor",
  nodes: [
    formTrigger,
    validate,
    isValid,
    invalidInput,
    downloadPdf,
    downloadError,
    prepareGemini,
    callGemini,
    geminiError,
    parseResponse,
    parseOk,
    extractionError,
    prepareImage,
    whatsappConfigured,
    buildHtml,
    renderPng,
    imageToBase64,
    sendWhatsapp,
    successCompletion,
  ],
  connections: {
    "On form submission": { main: [[{ node: "Validate Input", type: "main", index: 0 }]] },
    "Validate Input": { main: [[{ node: "Is Valid?", type: "main", index: 0 }]] },
    "Is Valid?": {
      main: [
        [{ node: "Invalid Input", type: "main", index: 0 }], // true  = error
        [{ node: "Download PDF", type: "main", index: 0 }], //  false = ok
      ],
    },
    "Download PDF": {
      main: [
        [{ node: "Prepare Gemini Request", type: "main", index: 0 }], // success
        [{ node: "Download Error", type: "main", index: 0 }], //         error out
      ],
    },
    "Prepare Gemini Request": { main: [[{ node: "Call Gemini API", type: "main", index: 0 }]] },
    "Call Gemini API": {
      main: [
        [{ node: "Parse Response", type: "main", index: 0 }], // success
        [{ node: "Gemini Call Error", type: "main", index: 0 }], // error out
      ],
    },
    "Parse Response": { main: [[{ node: "Parse OK?", type: "main", index: 0 }]] },
    "Parse OK?": {
      main: [
        [{ node: "Extraction Error", type: "main", index: 0 }], // true  = error
        [{ node: "Prepare Image Payload", type: "main", index: 0 }], // false = ok
      ],
    },
    "Prepare Image Payload": { main: [[{ node: "WhatsApp Configured?", type: "main", index: 0 }]] },
    "WhatsApp Configured?": {
      main: [
        [{ node: "Success", type: "main", index: 0 }], //       true  = skip -> show JSON
        [{ node: "Build P&L HTML", type: "main", index: 0 }], // false = render + send
      ],
    },
    "Build P&L HTML": { main: [[{ node: "Render PNG", type: "main", index: 0 }]] },
    "Render PNG": {
      main: [
        [{ node: "Image to Base64", type: "main", index: 0 }], // success
        [{ node: "Success", type: "main", index: 0 }], //         render failed -> still show JSON
      ],
    },
    "Image to Base64": { main: [[{ node: "Send to WhatsApp", type: "main", index: 0 }]] },
    "Send to WhatsApp": {
      main: [
        [{ node: "Success", type: "main", index: 0 }], // sent OK   -> show JSON
        [{ node: "Success", type: "main", index: 0 }], // send fail -> still show JSON
      ],
    },
  },
  active: false,
  settings: { executionOrder: "v1" },
  pinData: {},
};

fs.writeFileSync(path.join(ROOT, "workflow.json"), JSON.stringify(workflow, null, 2));
console.log("✓ Wrote workflow.json (" + workflow.nodes.length + " nodes)");
