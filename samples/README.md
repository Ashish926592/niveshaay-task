# Sample JSON Outputs

These are real standardized-JSON outputs produced by this pipeline (n8n → Gemini
2.5 Flash) from BSE/NSE consolidated corporate-result PDFs. They satisfy
Deliverable #2 and demonstrate **both** quarter formats.

Each file is exactly what the UI's result screen shows (the `data` object the
prompt is required to return) — `company_name`, `quarter_type`, and `row1..rowN`.

| File | Company | Quarter | `quarter_type` | Columns |
|------|---------|---------|----------------|---------|
| `sample-1-standard-genus-q3fy25.json` | Genus Prime Infra Limited | Q3 FY25 | **standard** | 4 — Particulars + Q3 FY25 / Q2 FY25 / Q3 FY24 |
| `sample-2-extended-balaji-q2fy26.json` | Balaji Telefilms Ltd | Q2 FY26 | **extended** | 6 — adds H1 FY26 / H1 FY25 |
| `sample-3-extended-united-q4fy25.json` | UNITED INTERACTIVE LIMITED | Q4 FY25 | **extended** | 6 — adds FY25 / FY24 |
| `sample-4-extended-timex-q4fy26.json` | Timex Group India Limited | Q4 FY26 | **extended** | 6 — adds FY26 / FY25 |

`sample-4` was produced **live** by this n8n pipeline from a real BSE filing
(`bseindia.com/.../AttachHis/ff349118-…-fdbcbf36acb4.pdf`). Spot-checked: Gross
Profit 102.54 = Revenue 235.20 − (92.04 + 62.58 − 21.96); EBITDA 40.37 (17.16%);
PAT 27.34 (11.62%) — calculations tie out to the source.

Format rules (from the prompt):
- `standard` (Q1 / Q3) = 4 columns: Particulars + current Q + previous Q + same Q last year.
- `extended` (Q2 / Q4) = 6 columns: adds H1 totals (Q2) or full-year totals (Q4).
- All values are strings in Rs Crores, 2 decimals; margins carry a `%` suffix;
  `-`/blank → `0.00` (except EPS, which uses the printed value).

## Regenerate your own samples

Bring up the stack (see the root `README.md`), open the UI
(`http://localhost:5678/webhook/ui`), paste a BSE/NSE result PDF link, and submit.
The result screen prints the JSON — copy it from the **{ } JSON** tab into a new
file here.
