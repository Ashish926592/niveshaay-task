# Niveshaay — Automated Financial Results Processing Pipeline

Paste a BSE/NSE corporate-result **PDF link** → the pipeline downloads the PDF,
sends it to **Google Gemini 2.5 Flash** with a fixed extraction prompt, and returns
a **standardized P&L JSON** (calculated margins, EBITDA, PAT, EPS…). A polished web
UI shows the result as a **Table**, raw **JSON** (copyable), and a downloadable
**Image** (PNG).

> **Built fully in n8n.** A single n8n workflow both **serves the UI** and **runs the
> processing** — no separate frontend, no backend, no other services.
>
> - `GET  /webhook/ui`          → serves the web app (HTML/CSS/JS, from `ui.html`)
> - `POST /webhook/process-pdf` → validate → download PDF → Gemini → parse → **JSON**

## Screenshots

| Landing | Table | JSON | Image |
|---|---|---|---|
| ![landing](screenshots/01-landing.png) | ![table](screenshots/02-table.png) | ![json](screenshots/03-json.png) | ![image](screenshots/04-image.png) |

Responsive (mobile — the wide P&L table scrolls horizontally):

<img src="screenshots/05-mobile.png" width="320" alt="mobile" />

## What it does

1. Open the n8n-served page at **`/webhook/ui`** and paste a `.pdf` link → **Extract P&L**.
2. The page shows a staged loading animation while the workflow runs.
3. Workflow: **validate URL → download PDF → base64 → Gemini 2.5 Flash → parse JSON**.
4. The result appears in three tabs:
   - **📊 Table** — styled green P&L (like the iValue sample), negatives in red.
   - **{ } JSON** — pretty, with **Copy JSON**.
   - **🖼 Image** — the P&L card with **Download PNG** (rendered in-browser via html2canvas).
5. **Process another** resets; errors (bad link, no P&L, etc.) show a clear card.

## Architecture

```
                  ┌──────────────── single n8n workflow ─────────────────┐
  Browser ──GET /webhook/ui──▶  Webhook (GET) ─▶ Respond (HTML = ui.html) │  → serves the UI
          ◀───────── HTML ──────                                          │
          ──POST /webhook/process-pdf──▶ Webhook (POST)                    │
                                          → Validate → Download PDF        │
                                          → Prepare Gemini → Call Gemini   │
                                          → Parse → Respond (JSON)         │
          ◀──────── { success, data } ───                                 │
                  └───────────────────────────────────────────────────────┘
                                   │ ($env.GEMINI_API_KEY)
                                   ▼
                         Google Gemini 2.5 Flash
```

The UI and the API are the **same origin** (both served by n8n), so the page's
`fetch('/webhook/process-pdf')` needs no CORS setup. The image is rendered
client-side, so n8n needs **no Chromium/Puppeteer** for the core app.

Single source of truth for extraction logic: **`prompt.md`** (the exact task prompt).
`tools/build-workflow.js` embeds `prompt.md` + `ui.html` into `workflow.json`; no
secret is baked in (the Gemini node uses `{{ $env.GEMINI_API_KEY }}`).

## Prerequisites

- **Docker** (Docker Compose v2).
- A **Google Gemini API key** — <https://aistudio.google.com/apikey>.

## Setup & run

### 1. Configure the key

```bash
cp .env.example .env
# edit .env → set GEMINI_API_KEY=...
```

`workflow.json` is **secret-free** (uses `{{ $env.GEMINI_API_KEY }}`); never commit `.env`.

### 2. Start n8n

```bash
docker compose up -d n8n
```

> The compose file sets **`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`** — required, or the
> Gemini node fails with *"access to env vars denied"* (n8n blocks `$env` by default).

### 3. Import & activate the workflow

```bash
docker cp workflow.json niveshaay_n8n:/tmp/workflow.json
docker exec niveshaay_n8n n8n import:workflow --input=/tmp/workflow.json
docker restart niveshaay_n8n            # registers the webhooks on boot
```

(Or open <http://localhost:5678>, import `workflow.json`, and toggle **Active**.)
> Edit the prompt in `prompt.md` or the UI in `ui.html`, then
> `node tools/build-workflow.js` and re-import.

### 4. Use it

Open **<http://localhost:5678/webhook/ui>**, paste a BSE/NSE consolidated-result PDF
link, and click **Extract P&L**. Or hit the API directly:

```bash
curl -X POST http://localhost:5678/webhook/process-pdf \
  -H 'Content-Type: application/json' \
  -d '{"pdfUrl":"https://www.bseindia.com/xml-data/corpfiling/AttachHis/<file>.pdf"}'
```

See `samples/` for example outputs.

## Error handling

| Case | API status | UI |
|------|-----------|----|
| Empty / non-`https` / non-`.pdf` | 400 | "Invalid input" with the reason |
| Download failed / expired / blocked | 502 | error card |
| Gemini API/network failure | 502 | error card |
| No P&L in the PDF | 400 | "No P&L statement found in this PDF" |
| Gemini returned non-JSON | 502 | "Failed to parse…" |

## JSON output contract (from `prompt.md`)

- `company_name`, `quarter_type` (`standard` | `extended`), `row1..rowN`.
- **Q1/Q3 → standard** (4 cols). **Q2 → extended** (6 cols, +H1). **Q4 → extended** (6 cols, +FY).
- Consolidated only (standalone if no consolidated); no P&L at all → `no pnl found`.
- Values are strings in Rs Crores, 2 decimals; margins carry `%`; `-`/null→0 except EPS.
- Calculated when missing: Gross Profit, GP Margin, Total Expenses, EBITDA, EBITDA
  Margin, Profit-before-Exceptional, PBT, PAT, PAT Margin. EPS uses the printed value.

## Project structure

```
.
├── README.md
├── .env.example            # copy → .env (GEMINI_API_KEY)
├── docker-compose.yml      # n8n (stock image) + optional evolution/postgres (whatsapp profile)
├── workflow.json           # the importable n8n workflow — serves UI + JSON API (secret-free)
├── ui.html                 # the web app n8n serves at /webhook/ui
├── prompt.md               # the exact Gemini extraction prompt (single source of truth)
├── tools/build-workflow.js # regenerates workflow.json from prompt.md + ui.html
├── samples/                # real outputs (standard + extended) + notes
└── Dockerfile.n8n          # ONLY for the optional WhatsApp-image extension (see below)
```

## Optional: WhatsApp delivery (advanced)

The core app shows/downloads the image in-browser. If you also want n8n to render the
P&L as a PNG and **post it to a WhatsApp group**, that path uses the
`n8n-nodes-puppeteer` community node (needs Chromium → build with `Dockerfile.n8n`) and
the **Evolution API** (`docker compose --profile whatsapp up -d`). It's kept separate so
the core app stays a single stock-n8n container. Ask if you want it wired into this UI.

## Security

- The Gemini key lives only in `.env` (gitignored), referenced via `{{ $env… }}`.
- `workflow.json` is secret-free; verify: `git grep -nE 'AIza[0-9A-Za-z_-]{20,}'` → no matches.

## Verified

Run live on **n8n 2.22.5** against a real BSE filing
(`AttachHis/ff349118-…-fdbcbf36acb4.pdf`): the UI is served at `/webhook/ui`, and a
POST to `/webhook/process-pdf` returns standardized JSON for **Timex Group India Ltd
(Q4 FY26, extended)** in ~55s. Spot-checked calculations tie out (Gross Profit 102.54,
EBITDA 40.37 / 17.16%, PAT 27.34 / 11.62%). See
`samples/sample-4-extended-timex-q4fy26.json`.

## Troubleshooting

- **"access to env vars denied"** → set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (compose does this).
- **Webhook 404 right after start** → the workflow must be **Active**; n8n registers webhooks
  on boot, so `docker restart niveshaay_n8n` after import/activate.
- **BSE link "download failed"** → BSE/NSE attachment URLs expire; re-copy a fresh link.
- **Large PDF** → Gemini node timeout is 120s; a ~2.6 MB PDF takes ~55s.
- **html2canvas not loading** (image download) → the page loads it from a CDN; needs internet.
