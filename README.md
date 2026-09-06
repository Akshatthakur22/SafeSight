# ISRO-Guard CUA
### On-Device Task-Aware Visual Privacy Firewall for Lightweight Browser Agents
**SIH 26171 — On-device Visual Perception for Lightweight Browser Agents (ISRO)**

> **Build status:** Stage 0 complete ✓ · Stage 1–7 in progress

---

## What this is

A Chromium Manifest V3 browser extension that sits between a user's browser and a remote cloud Vision-Language Model (VLM). It lets the cloud *reason* about a page without ever seeing raw private content, and never lets the cloud directly control the browser.

```
CLOUD  = BRAIN   → "What should happen next?"         (untrusted, stateless)
LOCAL  = BODY    → "What is on screen? What's         (trusted, final say on
                    sensitive? Is this allowed?         every action)
                    Execute."
```

See `ISRO-Guard_CUA_Master_PRD.md` in `docs/` for the full design specification.

---

## Repository structure

```
isro-guard-cua/
├── extension/
│   ├── manifest.json                # MV3 manifest
│   ├── background/
│   │   ├── service-worker.js        # pipeline orchestrator
│   │   ├── dmpr/                    # sensitive-data detection (FR-2)
│   │   │   ├── regex-rules.js       #   structured PII patterns
│   │   │   ├── ner-model.js         #   NER stub (real model in Stage 2)
│   │   │   └── index.js             #   unified DMPR entry point
│   │   ├── redaction/
│   │   │   ├── placeholder-map.js   # token↔value store + DOM redaction (FR-4/5)
│   │   │   └── task-relevance.js    # ABI cosine similarity scorer (FR-4a)
│   │   ├── policy/
│   │   │   ├── rules.json           # policy rule definitions (FR-7)
│   │   │   └── engine.js            # deterministic rule evaluator
│   │   ├── cloud-client.js          # VLM API wrapper — Anthropic / OpenAI / stub (FR-6)
│   │   ├── pre-send-scanner.js      # zero-secret-leak scanner (FR-5)
│   │   └── telemetry-logger.js      # per-step timing + decision log (FR-11)
│   ├── content-scripts/
│   │   ├── capture.js               # screenshot + DOM snapshot (FR-1)
│   │   ├── lockstep-sync.js         # bbox ↔ DOM node mapping (FR-3)
│   │   ├── grounding.js             # placeholder/text → coordinate (FR-8)
│   │   └── executor.js              # click/type/scroll dispatch (FR-8)
│   ├── popup/
│   │   ├── popup.html               # 3-tab UI: Agent / Log / Settings
│   │   └── popup.js
│   └── assets/                      # icons (add icon16/48/128.png before loading)
├── eval/
│   ├── dataset/                     # annotated test corpus (populated in Stage 7)
│   ├── run_eval.py                  # §12 evaluation harness
│   └── report_template.md           # unfilled report template
├── fixtures/
│   └── mock-portal/
│       ├── index.html               # MOSDAC-style portal with seeded fake PII
│       └── canvas-map-demo.html     # Stage 8 canvas/WebGL fixture
├── tests/
│   └── stage0.test.js               # Stage-0 exit test (Node + Puppeteer)
├── docs/
│   └── ISRO-Guard_CUA_Master_PRD.md
├── TASK_LOG.md
└── README.md  ← you are here
```

---

## Setup

### Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Chrome / Chromium | ≥ 120 | Extension host |
| Node.js | ≥ 18 | Test runner (Puppeteer) |
| Python | ≥ 3.10 | Evaluation harness |
| npm | ≥ 9 | Test dependencies |

### 1. Install test dependencies

```bash
npm install
```

This installs Puppeteer (for the Stage-0 exit test) and any future test tooling.
The extension itself has **zero runtime npm dependencies** — it runs entirely as
browser-native ES modules.

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. The ISRO-Guard popup icon should appear in your toolbar

> **Note:** You must add placeholder icon files before loading. Create three
> simple PNG files (16×16, 48×48, 128×128) at:
> `extension/assets/icon16.png`, `extension/assets/icon48.png`,
> `extension/assets/icon128.png`
>
> A quick way on macOS/Linux:
> ```bash
> npm run gen-icons   # generates minimal placeholder icons (see package.json)
> ```

### 3. Configure the API provider (optional — not needed for Stage-0 testing)

Open the extension popup → **Settings** tab:

- **Provider:** `Stub` (default, no network call) for Stage-0/Stage-1 baseline testing
- **Provider:** `Anthropic` or `OpenAI` once you have an API key
- **API Key:** Paste your key — it is stored in `chrome.storage.local` only,
  never in code, never sent anywhere except the chosen VLM endpoint

> **Security rule:** Never hardcode a key. Never commit a key. The extension
> will throw a clear error if you try to run a real network call without one.

---

## Running the Stage-0 exit test

The Stage-0 exit test uses Puppeteer to:
1. Open `fixtures/mock-portal/index.html` in a headless Chrome tab
2. Verify the page loaded and `window.__isroGuardTestReady === true`
3. Capture a screenshot via `Page.captureScreenshot()`
4. Find the `#search-btn` element, click it, and assert the result

```bash
npm test
# or explicitly:
node tests/stage0.test.js
```

**Expected output (all passing):**

```
[Stage 0] TEST 1: mock portal loads ................. PASS
[Stage 0] TEST 2: screenshot captured ............... PASS
[Stage 0] TEST 3: #search-btn found + clicked ........ PASS
[Stage 0] TEST 4: results table appeared ............. PASS
[Stage 0] TEST 5: window.__knownSecrets present ...... PASS
All 5 tests passed — Stage 0 exit criteria met.
```

---

## Running the evaluation harness (Stage 7)

Once you have:
- Run ≥10 tasks with the extension (builds telemetry in `chrome.storage.local`)
- Exported the telemetry via popup → Decision Log → **Export**
- Annotated ≥50 screenshots in `eval/dataset/ground-truth.jsonl`

Run:

```bash
python eval/run_eval.py \
  --log path/to/exported-telemetry.json \
  --gt  eval/dataset/ground-truth.jsonl \
  --out eval/
```

This produces `eval/report_<timestamp>.json` and `eval/report_<timestamp>.md`
with all five PRD §12 rubric metrics.

> **Honesty rule:** Every number in the report is a `[MEASURE]`d value from your
> own run. Never replace a `TBD` with a `[TARGET]` value from the PRD. See
> `eval/report_template.md` for the unfilled baseline.

---

## Demo script (§18 flow)

Full demo instructions are in `docs/demo-script.md` (created before the demo).
Short version:

1. Open `fixtures/mock-portal/index.html` — note the visible analyst name/email/session in the nav bar
2. **Baseline:** set provider to `Stub`, disable privacy toggle → run a task → show that raw PII would have been sent (network inspector or side panel)
3. **Protected:** re-enable privacy toggle → run same task → show sanitized screenshot with placeholders, decision log showing redacted fields
4. **Policy gate demo:** simulate an adversarial action (see `tests/stage0.test.js` adversarial fixtures) → show the block decision in the log
5. **Numbers:** show the `eval/` report (once Stage 7 is complete)

---

## Current limitations (honest scope statement for judges)

| Item | Status |
|---|---|
| NER model (FR-2b) | Stub — returns empty detections. Real ONNX model wired in Stage 2. |
| Embedding model (FR-4a) | Stub — cosine similarity returns 0. Real bge-micro or TF-IDF in Stage 4. |
| Screenshot redaction (FR-3/4) | DOM-side placeholder generation works; bitmap painting onto screenshot wired in Stage 3. |
| Canvas/WebGL interception (FR-9) | Not yet built — Stage 8 stretch goal. Canvas regions treated as "unknown — mask by default." |
| PELH latency hiding (FR-10) | Not yet built — Stage 9 stretch goal. |
| Evaluation dataset | 0 annotations — Stage 7 work. All metrics currently `TBD`. |
| Production hardening | Hackathon MVP. Not audited for Chrome Web Store submission. |
| RDF/BDI policy engine | JSON rule engine used (PRD §16.3 justifies this substitution). |

---

## Claim traceability (PRD §14 / Build Prompt Rule 8)

Every claim in this README is traceable to one of:
- A line in `ISRO-Guard_CUA_Master_PRD.md` (cited by section number), or
- A passing test in `tests/`, or
- A row in an `eval/report_*.json` output file

No benchmark numbers appear in this README — they will appear only in
`eval/report_*.md` once produced by the harness, and only with `[MEASURE]` tags
until confirmed by an actual run.

---

## Contributing / team workflow

See `TASK_LOG.md` for stage-by-stage progress, decisions, and deviations from
the PRD. Add an entry after every stage before merging.

Stretch features (Canvas/WebGL, PELH) must be built on separate branches and
merged only after their own regression tests pass without breaking Stages 0–7.
