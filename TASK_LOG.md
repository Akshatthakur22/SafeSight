# ISRO-Guard CUA — Task Log
_Append a short entry after every stage. Format: date · what was built · tests · deviations · open questions._

---

## Stage 0 — Scaffold
**Date:** 2026-09-06
**Status:** ✅ Complete

### What was built

| File | Purpose |
|---|---|
| `extension/manifest.json` | MV3 manifest — permissions, service worker (module), content scripts |
| `extension/background/service-worker.js` | Pipeline orchestrator; routes CAPTURE_AND_RUN / CAPTURE_ONLY / HARDCODED_CLICK / GET_LOG messages |
| `extension/background/dmpr/regex-rules.js` | 11 regex patterns: email, phone (Indian + intl), Aadhaar, PAN, passport, IPv4, JWT, hex tokens, lat/lon, name-prefix |
| `extension/background/dmpr/ner-model.js` | NER + embedding model stub (returns empty / zero-vector until Stage 2/4) |
| `extension/background/dmpr/index.js` | Unified DMPR entry point: DOM-signal heuristics + regex rules + NER (stub) |
| `extension/background/redaction/placeholder-map.js` | In-memory token↔real-value map; `getOrCreateToken`, `applyDOMRedaction`, `buildSanitizedPayload` (Stage 0/1 passthrough stub) |
| `extension/background/redaction/task-relevance.js` | Cosine-similarity ABI scorer (stub; real embeddings in Stage 4) |
| `extension/background/policy/rules.json` | 6 MVP policy rules: cross-origin credential type, external navigate with token, high-risk placeholder unconfirmed, unknown placeholder, raw-PII type, allow non-sensitive click |
| `extension/background/policy/engine.js` | Deterministic fail-closed rule evaluator; returns allow/block/ask_user |
| `extension/background/cloud-client.js` | Anthropic/OpenAI/stub provider; pre-send scanner gate; schema validator on response |
| `extension/background/pre-send-scanner.js` | FR-5 zero-secret-leak scanner; `setKnownSecrets` / `runPreSendScanner` |
| `extension/background/telemetry-logger.js` | FR-11 per-step log to `chrome.storage.local`; max 1000 entries |
| `extension/content-scripts/capture.js` | DOM snapshot walker; AR-1 hidden-element coverage; nodeId scheme (#id or tag[n]/tag[n]) |
| `extension/content-scripts/lockstep-sync.js` | `BUILD_LOCKSTEP_MAP` + `RESOLVE_BBOX` message handlers |
| `extension/content-scripts/grounding.js` | Two-tier grounder: exact placeholder → fuzzy Jaccard (threshold 0.45); `needsUserConfirmation` flag |
| `extension/content-scripts/executor.js` | `dispatchClick` (MouseEvent chain), `dispatchType` (React-compatible native setter), `dispatchScroll`; `GROUND_AND_EXECUTE` + `HARDCODED_CLICK_CONTENT` |
| `extension/popup/popup.html` | 3-tab UI: Agent / Decision Log / Settings; live log; iOS-style privacy toggle; API key field |
| `extension/popup/popup.js` | Tab switching; run/capture; settings save via `chrome.storage.local`; telemetry export; open mock portal |
| `fixtures/mock-portal/index.html` | MOSDAC-style fixture with 7 known-fixture secrets, 10+ `data-pii`-tagged fields, AR-1 injection bait, canvas map |
| `fixtures/mock-portal/canvas-map-demo.html` | Stage-8 canvas-only sensitive-text fixture |
| `eval/run_eval.py` | §12 harness: task success, P/R IoU, redaction IoU, resource (TBD manual), latency breakdown |
| `eval/report_template.md` | Unfilled template with honest [MEASURE]/[TARGET] labels |
| `tests/stage0.test.js` | 5 automated exit tests via Puppeteer |

### Tests (Stage-0 exit criteria)

Run `node tests/stage0.test.js` against the mock portal.

| # | Test | Expected |
|---|---|---|
| 1 | Mock portal loads, `window.__isroGuardTestReady === true` | PASS |
| 2 | Screenshot captured via Puppeteer `page.screenshot()` | PASS (PNG written to `tests/artifacts/`) |
| 3 | `#search-btn` found in DOM and clicked | PASS |
| 4 | Results table (`#results-card`) appears within 1 s of click | PASS |
| 5 | `window.__knownSecrets` array has 7 entries | PASS |

**Actual test results:** TBD — run `npm test` and record counts here before marking done.

### Deviations from PRD

| Item | PRD says | What was built | Reason |
|---|---|---|---|
| NER model | Local NER classifier (FR-2b) | Stub returning empty | PRD §16: zero-ML fuzzy-match first; NER is Stage-2 work |
| Embedding model | bge-micro via ONNX Runtime Web (FR-4a) | Stub returning zero vector | PRD §16: TF-IDF fallback first; real model in Stage 4 |
| Screenshot redaction | Bitmap placeholder painting (FR-3/4) | DOM-side only; bitmap painting in Stage 3 | Stage ordering; DOM redaction is prerequisite |
| `buildSanitizedPayload` | Full redaction | Passthrough stub | Stage 1 intentionally sends raw data (§15 Stage-1 note: "not private yet — that's the point of Stage 2") |

### Open questions for the human

- [ ] **API key:** Which provider will you use for Stage 1? (Anthropic / OpenAI). Paste the key into the popup Settings tab — do not share it in this file.
- [ ] **Icon assets:** `extension/assets/icon16/48/128.png` are missing. Run `npm run gen-icons` (add to `package.json`) or drop real icons in before loading the extension.
- [ ] **Test run confirmation:** Run `node tests/stage0.test.js` and paste the pass/fail counts back here so Stage 0 is formally verified before proceeding to Stage 1.

---

## Stage 1 — Naive end-to-end agent (no privacy yet)
**Date:** TBD
**Status:** 🔲 Not started

### What will be built
- Wire up `cloud-client.js` with a real API key (ask the human).
- Send raw screenshot + task to the configured VLM.
- Parse `{action, target_text}` response using the §10.2 schema validator.
- Ground by fuzzy visible-text match (Jaccard grounder already in place).
- Execute the click.

### Exit criterion
A 3–5 step task on `fixtures/mock-portal/` completes end-to-end.
This is intentionally NOT private — the baseline failure mode for the demo.

---

## Stage 2 — Privacy: detection + redaction + leak scanner
**Date:** TBD
**Status:** 🔲 Not started

### What will be built
- `buildSanitizedPayload` — replace stub with real DOM redaction using `applyDOMRedaction`.
- Arm `pre-send-scanner.js` with all 7 known-fixture secrets via `setKnownSecrets`.
- Add scanner call as a hard block in `cloud-client.js` (currently warn-only).
- Write automated test asserting zero known-secret substrings in every outbound request body.

### Exit criterion
Stage-1 task still succeeds; scanner confirms 0 violations on all outbound requests.

---

## Stage 3 — Cross-modal lockstep sync
**Date:** TBD
**Status:** 🔲 Not started

### What will be built
- Bitmap placeholder painting: for every detection with a bbox, paint a label box onto the screenshot PNG before sending.
- Wire `BUILD_LOCKSTEP_MAP` call into the pipeline.
- Automated bbox-overlap test against ground-truth coordinates from the mock portal.

### Exit criterion
≥ 90% of ≥10 known sensitive fields on the fixture page have a correctly positioned visual placeholder.

---

## Stage 4 — Task-aware redaction (ABI)
**Date:** TBD
**Status:** 🔲 Not started

---

## Stage 5 — Local policy engine
**Date:** TBD
**Status:** 🔲 Not started

---

## Stage 6 — Grounding robustness
**Date:** TBD
**Status:** 🔲 Not started

---

## Stage 7 — Evaluation harness
**Date:** TBD
**Status:** 🔲 Not started

---

## Stage 8 (stretch) — Canvas/WebGL interception
**Date:** TBD
**Status:** 🔲 Not started — only attempt after Stage 7 is demo-stable.

---

## Stage 9 (stretch) — PELH parallel exploration
**Date:** TBD
**Status:** 🔲 Not started — only attempt if Stages 0–7 are demo-stable with time to spare.

---

_Keep this file accurate. A discrepancy between the log and the actual code is a credibility problem in front of a jury._
