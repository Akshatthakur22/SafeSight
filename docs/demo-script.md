# ISRO-Guard CUA — Demo Script
### §18 Flow: 5–8 Minute Live Demo

**Audience:** SIH judges, mentors, ISRO evaluators.
**Setup:** Chrome with the extension loaded (Developer mode), mock portal open,
a second "unprotected" tab ready (or a screen recording of the baseline).

---

## Pre-demo checklist (do this 30 minutes before)

- [ ] Extension loaded at `chrome://extensions` (Developer mode, load unpacked → `extension/`)
- [ ] Icons visible in toolbar (if missing: `node scripts/gen-icons.js`, reload extension)
- [ ] Mock portal open: `fixtures/mock-portal/index.html` (open as file:// or via local server)
- [ ] API key entered in popup → Settings:
  - For a live API demo: paste Anthropic or OpenAI key, provider set correctly
  - For a safe offline demo: leave provider as **Stub** (default) — the stub runs the full pipeline without any network call
- [ ] Privacy toggle is **ON** (default)
- [ ] Network inspector / DevTools Network tab open in the background for the baseline beat
- [ ] Backup screen recording ready (in case of live demo failure — see §19 risk register)

---

## Beat 1 — Frame the problem (30 s)

Open the mock portal. Point out:

> "This is a simplified version of ISRO's MOSDAC data portal. Notice the top bar —
> the analyst's name, department, and session token are visible on every page.
> A typical browser AI assistant would send this entire screenshot to a cloud API
> to decide what to click next."

Show the profile section (sidebar → My Profile) briefly — name, email, phone, PAN,
Aadhaar, session token all visible.

State the task:
> "Our task: find and download the seasonal vegetation index tile for Grid-Zone 12."

---

## Beat 2 — Baseline failure mode (60 s)

**Option A (live):** In the extension popup → Settings, temporarily set Privacy
toggle to **OFF**. Run the task. Open DevTools → Network → find the POST request
to the VLM API. Click it → Preview → show that the request body contains:
`"Dr. Test Analyst"`, `"test.analyst@example.invalid"`, `"MOSDAC-SESSION-abc123def456"`.

**Option B (pre-recorded):** Play the 30-second screen recording of the unprotected
run. Pause on the network inspector showing the raw payload.

Say:
> "Without ISRO-Guard, the analyst's identity, session token, and search intent
> were transmitted to a third-party cloud model in plain text. This is exactly
> the operational-behavior leakage problem AgentDAM and GUIGuard-Bench document
> in the research literature."

Re-enable the Privacy toggle before continuing.

---

## Beat 3 — Run with ISRO-Guard ON (90 s)

1. Open the popup → Agent tab. The stage badge should read **Stage 1**.
2. Type the task: `Find and download the seasonal vegetation index tile for Grid-Zone 12`
3. Click **▶ Run Task**.
4. Watch the Live Log in the popup:
   - `▶ Task: "Find and download…"`
   - Each step appears: `Step s-0001-01: success`, `s-0001-02: success`, etc.
   - Timings line shows `capture:Xms | detect:Xms | network:Xms | ground:Xms | execute:Xms`

**While it runs**, point at the mock portal tab — judges can watch the clicks happening
live: the dropdown selects Grid-Zone 12, the dataset type changes, Search fires,
Download is clicked.

5. After the final step, show the Decision Log tab — each step has a row.

> "The cloud only saw a structural JSON of the page with all sensitive fields replaced
> by typed placeholders like [EMAIL_REDACTED#xxxx]. The analyst's identity never left
> the device."

*(Note: in Stage 1 the sanitised payload is functionally the same as raw because
redaction is not yet applied — Stage 2 will fix that. Be honest about this with
judges if they ask — see Beat 5.)*

---

## Beat 4 — Policy gate live demo (60 s)

To demonstrate FR-7, open the browser console on the mock portal page and inject
a simulated malicious cloud response:

```javascript
// Paste in the DevTools console of the mock portal tab
chrome.runtime.sendMessage({
  type: '__STAGE1_POLICY_TEST__',
  action: {
    type: 'type',
    target_text: 'session token field',
    target_placeholder: '[SESSION_REDACTED#fake]',
    value: 'MOSDAC-SESSION-abc123def456',
    destination_origin: 'https://evil.example.com'
  }
});
```

The popup Decision Log will show a red **block** entry:
`Policy: BLOCK — block-cross-origin-credential-type`

> "Even if the cloud model were compromised and instructed to exfiltrate the
> session token, the local policy engine catches it before any real event
> is dispatched. The browser action never happens."

---

## Beat 5 — Show your numbers (60–90 s)

Pull up the `eval/report_template.md` (or a filled-in version if Stage 7 is done).

If Stage 7 has run: show the real table.
If Stage 7 is not yet run: show the template and say:
> "We have the evaluation harness built — `eval/run_eval.py`. The [MEASURE] tags
> will be replaced with real numbers after our annotation run. We do not present
> target values as results."

Either way, show the stacked-latency breakdown from the popup's timing log.
Point to the `local-only` row:
> "Our privacy layer — capture, detect, redact, policy, grounding — adds X ms
> on average per step. The bulk of the wall-clock time is the cloud network
> round-trip, which is outside our control."

---

## Beat 6 — Close on the thesis (30 s)

> "The cloud can reason, but it never sees raw private state — by architecture.
> And it never directly controls the browser — every action goes through a
> deterministic local policy gate first. We can demonstrate both properties
> live, and we have the test suite to back them up."

Point to the popup → Decision Log → Export button:
> "Every redaction decision, every policy decision, every timing measurement is
> logged locally and exportable. This is our proof-of-work artifact."

---

## Judge Q&A — honest answers

| Question | Answer |
|---|---|
| "Isn't this just PII masking?" | "No — naive masking blacks out the region and the agent loses context. We keep the region as a typed placeholder so the agent still understands the layout. And we decide *which* sensitive fields to redact based on task-relevance, not a blanket rule." |
| "Did you invent ABI / GoClick?" | "No. 'Available-but-invisible' redaction and GoClick are existing research (2026 papers, cited in our PRD §14). Our contribution is the browser-native DOM+screenshot lockstep sync and extending this to ISRO's canvas/WebGL map widgets — which is a less-covered niche." |
| "How do you know your PII detector works?" | Point to `eval/run_eval.py` and the §12.2 protocol. If Stage 7 is done, show the P/R table. If not: "We have the harness built; annotation run is in progress." |
| "What if the cloud tries something malicious?" | Demo Beat 4 — live policy block. |
| "What's your resource footprint?" | Show §12.4 measured numbers (or "TBD — manual DevTools measurement, steps documented in eval/report_template.md"). |
| "Why not just run a local LLM?" | "A 7B local model adds 6–8 GB RAM and 140+ s per step on a mid-range laptop (per published benchmarks we're independently verifying). Our architecture lets you use a state-of-the-art cloud model while keeping private state on device — best of both worlds." |
| "Stage 1 sends raw data — isn't that unsafe?" | "Correct — and intentional. Stage 1 is the *baseline* we compare against in the §18 demo. The privacy layer lands in Stage 2. Our build order follows PRD §15 exactly, and we haven't claimed Stage 2 is done yet." |
| "Can this scale to production?" | "This is a hackathon MVP proving the architecture. Production would need Chrome Web Store review, a full RDF-based policy engine, and expanded canvas/WebGL coverage — all on our roadmap, not built yet." |

---

## Backup plan

If the live task run fails during the demo:
1. Switch to the pre-recorded backup video (2–4 min, same §18.1 flow).
2. Show `tests/artifacts/stage0-results.json` and `tests/artifacts/stage0-screenshot.png`
   as proof that the pipeline ran successfully before the demo.
3. Walk through the code — `extension/background/service-worker.js` pipeline loop,
   `extension/background/policy/engine.js` rule evaluator — to explain the architecture.

The backup video should be recorded the morning of the demo after a clean test run.
