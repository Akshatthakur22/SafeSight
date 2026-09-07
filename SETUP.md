# ISRO-Guard CUA — Complete Setup & Validation Guide

This guide walks you through loading the extension, running the mock portal, and executing the final end-to-end integration test.

---

## Prerequisites

Verify you have:

```bash
# Check Chrome/Chromium
google-chrome --version  # or chromium, or brave, etc. (≥94 for MV3)

# Check Node.js
node --version           # should be ≥18.0.0

# Check npm
npm --version            # should be ≥8.0.0

# Check Python
python3 --version        # should be ≥3.10

# (Optional) Groq API key
# Get from https://console.groq.com/keys
# Then: export GROQ_API_KEY="gsk_..."
```

---

## Part 1: Setup Extension Environment

```bash
# 1. Navigate to the workspace
cd /Users/akshatthakur22/Desktop/open\ source/SIH26171

# 2. Verify all critical files exist
ls -lh extension/manifest.json
ls -lh extension/assets/tesseract/eng.traineddata  # 22MB, bundled offline language model
ls -lh extension/background/service-worker.js
ls -lh extension/content-scripts/capture.js

# 3. Verify all test suites exist
ls -lh tests/stage*.test.js
ls -lh eval/*.py eval/generate-test-telemetry.js

# 4. Verify ground truth + screenshots exist
wc -l eval/dataset/ground-truth.jsonl              # should show 50
ls eval/dataset/screenshots/ | wc -l               # should show 50

# 5. Install any missing npm dependencies (if not already done)
npm install 2>&1 | grep -E "added|up to date"
```

Expected output:
```
extension/manifest.json
extension/assets/tesseract/eng.traineddata
extension/background/service-worker.js
extension/content-scripts/capture.js
tests/stage0.test.js
tests/stage1.test.js
tests/stage5-policy.test.js
tests/stage6-grounding.test.js
eval/run_eval.py
eval/generate-test-telemetry.js
50 eval/dataset/ground-truth.jsonl
50 screenshots
```

---

## Part 2: Run Automated Test Suite

This verifies all code is syntactically correct and the extension logic works in isolation.

### 2.1: Stage 0 — Portal Fixture Validation

```bash
node tests/stage0.test.js
```

Expected output:
```
  ✓  TEST 1: Mock portal loads and window.__isroGuardTestReady === true
  ✓  TEST 2: Screenshot captured (573ms, saved to tests/artifacts/stage0-screenshot.png)
  ✓  TEST 3: DOM snapshot — ≥10 data-pii elements found (found 15)
  ✓  TEST 4: #search-btn found + clicked → results table appeared (4 rows)
  ✓  TEST 5: window.__knownSecrets has all 7 fixture secrets (found 7)
  ✓  TEST 6: Known-secret values confirmed present in raw portal HTML (scanner fixture valid)
  ✓  TEST 7: AR-1 injection bait present and visually hidden (tiny font)
✓  All 7 tests passed — Stage 0 exit criteria met.
```

**Status:** ✅ If all pass, the mock portal is valid.

### 2.2: Stage 1 — End-to-End Agent

```bash
node tests/stage1.test.js
```

Expected output:
```
[Tests running … 32 test cases covering search → filter → download task sequences]
✓  All 32 tests passed — Stage 1 exit criteria met.
   3–5 step task sequence validated end-to-end on mock portal.
```

**Status:** ✅ If all pass, the full pipeline (capture → detect → plan → execute) works.

### 2.3: Stage 5 — Policy Engine (Adversarial + Legitimate)

```bash
node tests/stage5-policy.test.js
```

Expected output:
```
Adversarial: 20/20 correctly blocked (target: 20/20)
Legitimate:  20/20 correctly allowed (target: 20/20)
Total: 40/40 PASS
```

**Status:** ✅ If all pass, the policy gate correctly blocks malicious actions while allowing legitimate ones.

### 2.4: Stage 6 — Grounding Robustness

```bash
node tests/stage6-grounding.test.js
```

Expected output:
```
[Tests running … 30 test cases covering element localization, confidence thresholds, token resolution]
✓  All 30 tests passed — Stage 6 grounding robustness verified.
```

**Status:** ✅ If all pass, the grounding engine robustly finds target elements.

### 2.5: Summary

```bash
# Run all tests in sequence
for test in tests/stage{0,1,5,6}.test.js; do
  echo "Running $test..."
  node "$test" 2>&1 | tail -1
done
```

Expected output:
```
Running tests/stage0.test.js...
✓  All 7 tests passed — Stage 0 exit criteria met.
Running tests/stage1.test.js...
✓  All 32 tests passed — Stage 1 exit criteria met.
Running tests/stage5-policy.test.js...
Total: 40/40 PASS
Running tests/stage6-grounding.test.js...
✓  All 30 tests passed — Stage 6 grounding robustness verified.
```

**Grand Total:** 109/109 PASS ✅

---

## Part 3: Load Extension in Chrome

### 3.1: Open Chrome Developer Mode

1. Open **Chrome** (or Chromium, Brave, Edge)
2. Navigate to **chrome://extensions**
3. In the **top-right**, toggle **Developer mode** ON
4. You should now see **Load unpacked** button

### 3.2: Load the Extension

1. Click **Load unpacked**
2. Navigate to: `/Users/akshatthakur22/Desktop/open source/SIH26171/extension`
3. Select the **extension** folder
4. Click **Select Folder** (or **Open** depending on your OS)

Expected result:
- ISRO-Guard card appears in the extensions list
- Status shows **"Active"**
- You see the ISRO-Guard icon in the Chrome toolbar (top-right, near address bar)

### 3.3: Verify Extension Loaded

```bash
# Check Chrome console for any errors:
# chrome://extensions → ISRO-Guard → "Errors" button (if red count shown)
# chrome://extensions → ISRO-Guard → "background page" (opens DevTools for service worker)
```

If you see errors like:
- `"eng.traineddata" not found` → verify file exists at `extension/assets/tesseract/eng.traineddata`
- `"Manifest permission denied"` → check `manifest.json` syntax (use `npm run lint`)

---

## Part 4: Serve Mock Portal

### 4.1: Start Local HTTP Server

In a new terminal:

```bash
cd /Users/akshatthakur22/Desktop/open\ source/SIH26171

# Option A: Python (recommended)
python3 -m http.server 5500 --directory .

# Option B: Node (if you prefer)
npx serve . -p 5500

# Option C: npm script (if configured)
npm run serve
```

Expected output:
```
Serving HTTP on 127.0.0.1 port 5500 (http://127.0.0.1:5500/) ...
```

### 4.2: Open Mock Portal

In **a new Chrome tab**:
```
http://127.0.0.1:5500/fixtures/mock-portal/index.html
```

Expected result:
- Fake ISRO portal loads (styled like a real data portal)
- Contains search bar, results table, profile/settings sections
- Displays sensitive data (API keys, personal names, government IDs, email addresses, phone numbers)
- All displayed in clear, readable form (the extension's job is to detect and redact this before sending to cloud)

### 4.3: Verify Portal is Instrumented

In the **browser console** (F12):
```javascript
window.__isroGuardTestReady
window.__knownSecrets
```

Expected:
- `__isroGuardTestReady` === `true`
- `__knownSecrets` is an array of 7 fixture secret strings

---

## Part 5: Run a Task Via the Extension

### 5.1: Open Extension Popup

1. Click the **ISRO-Guard icon** in the Chrome toolbar (top-right)
2. You should see a popup with tabs: **Agent** | **Decision Log** | **Settings**

### 5.2: Run a Task

1. Click the **Agent** tab
2. In the text field, paste:
   ```
   Find and download the seasonal vegetation index tile for Grid-Zone 12
   ```
3. Click **Run Task**

### 5.3: Watch the Live-Log

As the task runs, you'll see events like:
```
[Pipeline] Starting task: "Find and download..."
[Capture] Screenshot captured (567ms)
[Capture] DOM snapshot: 15 elements scanned
[Detect] DMPR: 12 PII detections found (8 DOM, 4 OCR)
[Detect] Labels: email(2), phone(1), gov_id(3), credential(4), person_name(2)
[Relevance] Task score computed: 8/12 keep plaintext (task-relevant)
[Redact] DOM: 4 tokens created
[Redact] Screenshot: 4 boxes painted
[Scanner] Pre-send scan: ✓ no violations
[Cloud] Calling Groq (or stub)...
[Cloud] Response: action[0] = click target="select:Grid Zone"
[Policy] Evaluation: ALLOW (same-origin, low-risk field)
[Ground] Locating target: confidence=0.87 ✓ found
[Execute] click [345, 231] ✓ done

[Step 1] Success — continuing to step 2...
[Step 2] Executing: select text="GZ-12" ...
...
[Step 5] Task complete!
```

### 5.4: Confirm Task Completed

Once "Task complete!" appears:
- The extension has successfully executed all 5 steps
- The mock portal's download table should show a new row with "GZ-12 tile" in download status
- Total time should be ~10–15s (mostly Groq API latency)

---

## Part 6: Review Decision Log

1. In the popup, click **Decision Log**
2. You'll see a structured log of the completed task:
   - **Detections**: label, bbox, confidence, redaction status
   - **Redactions**: placeholder tokens created
   - **Policy Decision**: allow/block/ask_user reasoning
   - **Grounding**: confidence score and element found
   - **Execution**: action type, target, success/fail

3. Click **Export** to save the telemetry as JSON
   - This is what you'd use to compute real [MEASURE]d eval metrics

---

## Part 7: Run Evaluation Harness (Optional)

This generates [SIMULATED] metric numbers to verify the harness works:

```bash
# Generate simulated telemetry
node eval/generate-test-telemetry.js

# Run evaluation
python3 eval/run_eval.py \
  --log eval/test-telemetry.json \
  --gt eval/dataset/ground-truth.jsonl \
  --out eval/

# View results
cat eval/report_*.md | head -40
```

Expected:
- Task Success (protected): 90.0% [SIMULATED]
- Task Success (baseline): 85.0% [SIMULATED]
- PII Detection Precision: 98.0% [SIMULATED]
- PII Detection Recall: 100.0% [SIMULATED]
- Latency breakdown: capture, detect, redact, network, policy, ground, execute

---

## Part 8: Advanced — Live Groq API (Optional)

To use the real Groq API instead of stub:

### 8.1: Get API Key

1. Go to https://console.groq.com/keys
2. Generate a new key
3. Copy it

### 8.2: Set Environment Variable

```bash
export GROQ_API_KEY="gsk_..."  # paste your key
```

### 8.3: Run Groq Integration Tests

```bash
npm run test:groq
```

Expected (depending on quota):
```
✓  TEST 1.1: Groq API reachable (330ms)
✓  TEST 2.1: finish_reason=stop with new minimal prompt
...
✓  All tests passed (some may be rate-limited on rapid repeat runs)
```

### 8.4: Update Extension Settings

1. In the popup → **Settings** tab:
   - **Provider:** groq
   - **Model:** qwen-2.5-32b (or qwen-3.6-27b for longer context)
   - **API Key:** paste your key from above

2. Close and reopen the popup
3. Run a task — you'll see real Groq responses (not stub)

---

## Troubleshooting

### Q: Extension icon doesn't appear in toolbar
**A:** Refresh the page. If still missing, check `chrome://extensions` → ISRO-Guard → **Details** → ensure "Allowed on this site" is checked.

### Q: Portal loads but no PII visible
**A:** Check browser console (F12) for errors. If portal is blank, ensure `http://127.0.0.1:5500/fixtures/mock-portal/index.html` is the correct URL.

### Q: Task hangs on "Calling Groq..."
**A:** If using stub (default), should return immediately. If using real Groq, wait — API call takes 2–5s. Check Chrome DevTools (F12) Network tab to see the API request.

### Q: Task fails with "Policy blocked"
**A:** Intentional — the policy engine blocked a risky action. Check Decision Log to see which rule fired. For testing, use tasks from the mock portal fixtures.

### Q: OCR detections always empty
**A:** Tesseract may have failed to initialise. Check extension error logs:
   - `chrome://extensions` → ISRO-Guard → **Errors** button
   - Verify `extension/assets/tesseract/eng.traineddata` is 22MB
   - Refresh extension

### Q: "Grounding confidence too low, ask user"
**A:** The element wasn't found reliably. Check the Decision Log for what the target was and whether it exists on the page. For testing, use fixture-validated tasks.

---

## Validation Checklist

- [ ] **Automated tests:** 109/109 PASS (all 4 stage test suites)
- [ ] **Extension loads:** Icon appears, no error logs
- [ ] **Portal serves:** http://127.0.0.1:5500/fixtures/mock-portal/index.html loads
- [ ] **Portal instrumented:** `window.__isroGuardTestReady === true`
- [ ] **Task runs:** Execute 1 full task from start to finish
- [ ] **Decision log created:** View structured telemetry for the task
- [ ] **5-stage pipeline complete:**
  1. ✅ Capture (screenshot + DOM)
  2. ✅ Detect (PII found via DOM + OCR)
  3. ✅ Plan (cloud planner called)
  4. ✅ Redact (tokens + painted screenshot)
  5. ✅ Execute (actions performed)

---

## What's Working (No Stubs)

| Component | Status |
|---|---|
| Tesseract.js OCR (offline, bundled) | ✅ Real |
| DOM PII detection (regex + signals) | ✅ Real |
| Task-relevance scoring (TF-IDF) | ✅ Real |
| DOM redaction (token replacement) | ✅ Real |
| Screenshot redaction (OffscreenCanvas) | ✅ Real |
| Pre-send scanner (hard-block) | ✅ Real |
| Groq API client (with fallback stub) | ✅ Real |
| Policy engine (6 rules) | ✅ Real |
| Grounding (element localization) | ✅ Real |
| Executor (click/type/scroll) | ✅ Real |

---

## Next Steps After Validation

1. **Export Real Telemetry**: Run ≥50 tasks in Chrome with privacy ON, ≥20 with privacy OFF. Export via Decision Log.
2. **Re-Run Evaluation**: `python3 eval/run_eval.py --log <real_export.json> --gt eval/dataset/ground-truth.jsonl`
3. **Measure RAM/CPU**: Follow §12.4 steps in `eval/run_eval.py` comments
4. **Generate Final Report**: Review `eval/report_*.md` for all 5 SIH metrics [MEASURE]d

---

**Status:** ✅ All setup steps complete. Extension is ready for final end-to-end evaluation.
