/**
 * build-workflow.js  (dev/build helper — NOT part of the runtime)
 * ---------------------------------------------------------------------------
 * Assembles `workflow.json` (the importable n8n workflow) from `prompt.md`
 * and `ui.html`. The pipeline runs 100% inside n8n and even SERVES ITS OWN UI:
 *
 *   GET  /webhook/ui            -> returns the polished HTML app (ui.html)
 *   POST /webhook/process-pdf   -> validate -> download -> Gemini -> parse -> JSON
 *
 * The UI (served by n8n) calls the POST webhook and renders Table / JSON / Image
 * with copy + download-PNG (html2canvas) + "process another".
 *
 *   node tools/build-workflow.js
 *
 * No secrets are written: the Gemini node references {{ $env.GEMINI_API_KEY }}.
 * Requires N8N_BLOCK_ENV_ACCESS_IN_NODE=false (set in docker-compose.yml).
 * ---------------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PROMPT = fs.readFileSync(path.join(ROOT, "prompt.md"), "utf-8").trim();
const UI_HTML = fs.readFileSync(path.join(ROOT, "ui.html"), "utf-8");

let uid = 0;
const id = () => `nv-${String(++uid).padStart(4, "0")}`;
const ACAO = { entries: [{ name: "Access-Control-Allow-Origin", value: "*" }] };

function code(name, jsCode, position, onError) {
  const n = { parameters: { jsCode: jsCode.trim() }, id: id(), name, type: "n8n-nodes-base.code", typeVersion: 2, position };
  if (onError) n.onError = onError;
  return n;
}
function ifError(name, leftValue, position) {
  return {
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: "c", leftValue, rightValue: "true", operator: { type: "boolean", operation: "equals", singleValue: true } }],
        combinator: "and" },
      options: {},
    },
    id: id(), name, type: "n8n-nodes-base.if", typeVersion: 2, position,
  };
}
function respondJson(name, bodyExpr, codeExpr, position) {
  return {
    parameters: { respondWith: "json", responseBody: bodyExpr,
      options: { responseCode: codeExpr, responseHeaders: ACAO } },
    id: id(), name, type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position,
  };
}
function http(name, params, position, onError) {
  const n = { parameters: params, id: id(), name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position };
  if (onError) n.onError = onError;
  return n;
}

// ── UI branch ────────────────────────────────────────────────────────────────
const webhookUi = {
  parameters: { httpMethod: "GET", path: "ui", responseMode: "responseNode", options: {} },
  id: id(), name: "Webhook UI", type: "n8n-nodes-base.webhook", typeVersion: 2,
  position: [240, 120], webhookId: "ui",
};
const serveUi = {
  parameters: {
    respondWith: "text",
    responseBody: UI_HTML,
    options: { responseHeaders: { entries: [{ name: "Content-Type", value: "text/html; charset=utf-8" }] } },
  },
  id: id(), name: "Serve UI", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [460, 120],
};

// ── Processing branch ─────────────────────────────────────────────────────────
const webhookProc = {
  parameters: { httpMethod: "POST", path: "process-pdf", responseMode: "responseNode", options: {} },
  id: id(), name: "Webhook Process", type: "n8n-nodes-base.webhook", typeVersion: 2,
  position: [240, 420], webhookId: "process-pdf",
};

const validate = code("Validate Input", `
const b = $input.first().json.body || $input.first().json;
const pdfUrl = String((b && b.pdfUrl) || "").trim();
if (!pdfUrl) return [{ json: { error: true, message: "PDF URL is required", statusCode: 400 } }];
if (!pdfUrl.startsWith("https://")) return [{ json: { error: true, message: "URL must start with https://", statusCode: 400 } }];
if (!pdfUrl.toLowerCase().includes(".pdf")) return [{ json: { error: true, message: "URL must point to a PDF file (.pdf)", statusCode: 400 } }];
return [{ json: { pdfUrl, error: false } }];
`, [460, 420]);

const isValid = ifError("Is Valid?", "={{ $json.error }}", [680, 420]);
const validationError = respondJson("Validation Error",
  '={{ JSON.stringify({ error: $json.message || "Invalid request" }) }}',
  "={{ $json.statusCode || 400 }}", [900, 640]);

// ── Cache (pure n8n via workflow static data; 7-day TTL) ──────────────────────
const checkCache = code("Check Cache", `
const pdfUrl = $json.pdfUrl;
const store = $getWorkflowStaticData('global');
store.cache = store.cache || {};
const TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const hit = store.cache[pdfUrl];
if (hit && hit.data && (Date.now() - (hit.ts || 0) < TTL)) {
  return [{ json: { cached: true, data: hit.data, pdfUrl } }];
}
return [{ json: { cached: false, pdfUrl } }];
`, [880, 420]);

const isCached = ifError("Is Cached?", "={{ $json.cached }}", [1080, 420]);

const cachedResponse = respondJson("Cached Response",
  '={{ JSON.stringify({ success: true, data: $json.data, cached: true }) }}',
  200, [1300, 240]);

const downloadPdf = http("Download PDF", {
  url: "={{ $('Validate Input').first().json.pdfUrl }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: "User-Agent", value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    { name: "Accept", value: "application/pdf,application/octet-stream,*/*" } ] },
  options: { response: { response: { responseFormat: "file" } }, timeout: 30000 },
}, [900, 420], "continueErrorOutput");

const downloadError = respondJson("Download Error",
  '={{ JSON.stringify({ error: "Failed to download the PDF. The link may be invalid, expired, or blocked." }) }}',
  502, [1120, 600]);

const prepareGemini = code("Prepare Gemini Request", `
const binaryDataBuffer = await this.helpers.getBinaryDataBuffer(0, 'data');
const base64Pdf = binaryDataBuffer.toString('base64');
const PROMPT = ${JSON.stringify(PROMPT)};
const requestBody = { contents: [ { parts: [ { inline_data: { mime_type: "application/pdf", data: base64Pdf } }, { text: PROMPT } ] } ] };
return [{ json: { requestBody } }];
`, [1120, 420]);

const callGemini = http("Call Gemini API", {
  method: "POST",
  url: '={{ "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + $env.GEMINI_API_KEY }}',
  sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify($json.requestBody) }}",
  options: { timeout: 120000 },
}, [1340, 420], "continueErrorOutput");

const geminiError = respondJson("Gemini Call Error",
  '={{ JSON.stringify({ error: "Gemini API call failed. Verify GEMINI_API_KEY and quota." }) }}',
  502, [1560, 600]);

const parseResponse = code("Parse Response", `
const response = $input.first().json;
const candidates = response.candidates;
if (!candidates || candidates.length === 0) return [{ json: { error: true, message: "No response from Gemini.", statusCode: 502 } }];
let responseText = candidates[0].content?.parts?.[0]?.text || "";
if (responseText.trim().toLowerCase().includes("no pnl found")) return [{ json: { error: true, message: "No P&L statement found in this PDF.", statusCode: 400 } }];
let cleaned = responseText.trim();
const fence = String.fromCharCode(96, 96, 96);
if (cleaned.startsWith(fence + "json")) cleaned = cleaned.slice(7);
else if (cleaned.startsWith(fence)) cleaned = cleaned.slice(3);
if (cleaned.endsWith(fence)) cleaned = cleaned.slice(0, -3);
cleaned = cleaned.trim();
let parsedData;
try { parsedData = JSON.parse(cleaned); }
catch (e) { return [{ json: { error: true, message: "Failed to parse the Gemini response as JSON.", statusCode: 502 } }]; }
return [{ json: { error: false, data: parsedData } }];
`, [1560, 420]);

const parseOk = ifError("Parse OK?", "={{ $json.error }}", [1780, 420]);
const extractionError = respondJson("Extraction Error",
  '={{ JSON.stringify({ error: $json.message || "Extraction failed" }) }}',
  "={{ $json.statusCode || 502 }}", [2000, 600]);
const writeCache = code("Write Cache", `
const data = $json.data;
const pdfUrl = $('Check Cache').first().json.pdfUrl;
const store = $getWorkflowStaticData('global');
store.cache = store.cache || {};
store.cache[pdfUrl] = { data, ts: Date.now() };
return [{ json: { data } }];
`, [2220, 420]);

const successResponse = respondJson("Success Response",
  '={{ JSON.stringify({ success: true, data: $json.data, cached: false }) }}',
  200, [2440, 420]);

// ── WhatsApp delivery (after responding to the user) ──────────────────────────
// Fires on BOTH a fresh extraction AND a cache hit (both feed Prepare Send).
// `data` is taken from the incoming item (Write Cache or Check Cache both carry
// it through their respond node) so it works regardless of which path ran.
// Gated on WHATSAPP_GROUP_JID.
const prepareSend = code("Prepare Send", `
const data = $json.data;
const jid = String($env.WHATSAPP_GROUP_JID || "").trim();
return [{ json: { data, skip: !jid } }];
`, [2660, 420]);

const whatsappConfigured = ifError("WhatsApp Configured?", "={{ $json.skip }}", [2880, 420]);

const renderImage = http("Render Image", {
  method: "POST",
  url: '={{ $env.IMAGE_SERVICE_URL + "/generate-image" }}',
  sendBody: true, specifyBody: "json",
  jsonBody: '={{ JSON.stringify({ data: $json.data }) }}',
  options: { timeout: 30000 },
}, [3100, 360], "continueErrorOutput");

const sendWhatsapp = http("Send to WhatsApp", {
  method: "POST",
  url: '={{ $env.EVOLUTION_API_URL + "/message/sendMedia/" + $env.EVOLUTION_INSTANCE }}',
  sendHeaders: true,
  headerParameters: { parameters: [{ name: "apikey", value: "={{ $env.EVOLUTION_API_KEY }}" }] },
  sendBody: true, specifyBody: "json",
  jsonBody: '={{ JSON.stringify({ number: $env.WHATSAPP_GROUP_JID, mediatype: "image", mimetype: "image/png", media: $json.base64, fileName: "pnl.png", caption: "P&L Results: " + ($(\'Prepare Send\').first().json.data.company_name || "") }) }}',
  options: { timeout: 30000 },
}, [3320, 360], "continueErrorOutput");

const workflow = {
  id: "niveshaayfinres1",
  name: "Niveshaay — Financial Results Processor (UI + API)",
  nodes: [
    webhookUi, serveUi,
    webhookProc, validate, isValid, validationError,
    checkCache, isCached, cachedResponse,
    downloadPdf, downloadError, prepareGemini, callGemini, geminiError,
    parseResponse, parseOk, extractionError, writeCache, successResponse,
    prepareSend, whatsappConfigured, renderImage, sendWhatsapp,
  ],
  connections: {
    "Webhook UI": { main: [[{ node: "Serve UI", type: "main", index: 0 }]] },
    "Webhook Process": { main: [[{ node: "Validate Input", type: "main", index: 0 }]] },
    "Validate Input": { main: [[{ node: "Is Valid?", type: "main", index: 0 }]] },
    "Is Valid?": { main: [
      [{ node: "Validation Error", type: "main", index: 0 }],
      [{ node: "Check Cache", type: "main", index: 0 }],
    ] },
    "Check Cache": { main: [[{ node: "Is Cached?", type: "main", index: 0 }]] },
    "Is Cached?": { main: [
      [{ node: "Cached Response", type: "main", index: 0 }],
      [{ node: "Download PDF", type: "main", index: 0 }],
    ] },
    // Cache hit: respond to the user with the cached JSON, then ALSO deliver the
    // image to WhatsApp (same Prepare Send -> Render -> Send path as a fresh run).
    "Cached Response": { main: [[{ node: "Prepare Send", type: "main", index: 0 }]] },
    "Download PDF": { main: [
      [{ node: "Prepare Gemini Request", type: "main", index: 0 }],
      [{ node: "Download Error", type: "main", index: 0 }],
    ] },
    "Prepare Gemini Request": { main: [[{ node: "Call Gemini API", type: "main", index: 0 }]] },
    "Call Gemini API": { main: [
      [{ node: "Parse Response", type: "main", index: 0 }],
      [{ node: "Gemini Call Error", type: "main", index: 0 }],
    ] },
    "Parse Response": { main: [[{ node: "Parse OK?", type: "main", index: 0 }]] },
    "Parse OK?": { main: [
      [{ node: "Extraction Error", type: "main", index: 0 }],
      [{ node: "Write Cache", type: "main", index: 0 }],
    ] },
    "Write Cache": { main: [[{ node: "Success Response", type: "main", index: 0 }]] },
    "Success Response": { main: [[{ node: "Prepare Send", type: "main", index: 0 }]] },
    "Prepare Send": { main: [[{ node: "WhatsApp Configured?", type: "main", index: 0 }]] },
    "WhatsApp Configured?": { main: [
      [], // true  = skip (no JID configured) -> end
      [{ node: "Render Image", type: "main", index: 0 }], // false = send
    ] },
    "Render Image": { main: [
      [{ node: "Send to WhatsApp", type: "main", index: 0 }], // success
      [], // render error -> end quietly
    ] },
  },
  active: false,
  settings: { executionOrder: "v1" },
  pinData: {},
};

// tidy left-to-right canvas layout
const POS = {
  "Webhook UI": [240, 80], "Serve UI": [460, 80],
  "Webhook Process": [240, 460], "Validate Input": [440, 460], "Is Valid?": [640, 460], "Validation Error": [640, 720],
  "Check Cache": [840, 460], "Is Cached?": [1040, 460], "Cached Response": [1260, 280],
  "Download PDF": [1260, 500], "Download Error": [1480, 720], "Prepare Gemini Request": [1480, 500],
  "Call Gemini API": [1700, 500], "Gemini Call Error": [1920, 720], "Parse Response": [1920, 500],
  "Parse OK?": [2140, 500], "Extraction Error": [2360, 720], "Write Cache": [2360, 500], "Success Response": [2580, 500],
  "Prepare Send": [2800, 500], "WhatsApp Configured?": [3020, 500], "Render Image": [3240, 380], "Send to WhatsApp": [3460, 380],
};
for (const n of workflow.nodes) if (POS[n.name]) n.position = POS[n.name];

fs.writeFileSync(path.join(ROOT, "workflow.json"), JSON.stringify(workflow, null, 2));
console.log("✓ Wrote workflow.json (" + workflow.nodes.length + " nodes; serves UI + JSON API + cache)");
