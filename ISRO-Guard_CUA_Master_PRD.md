# ISRO-Guard CUA — Master Product Requirements Document (PRD)
### On-Device Task-Aware Visual Privacy Firewall for Lightweight Browser Agents
**SIH 26171 — On-device Visual Perception for Lightweight Browser Agents (ISRO)**

Version 1.0 · Prepared as a build-ready master reference · Status: Draft for team execution

---

## How to use this document

This is the single source of truth for the team. It is organized so that:

- **Sections 1–6** are what you show a judge or mentor to explain *what* you're building and *why*.
- **Sections 7–13** are what your engineers open every day while building — architecture, requirements, schemas, security model.
- **Section 14 (Citation & Claims Integrity Ledger)** is the most important section for your credibility in front of an ISRO jury. Read it before you finalize your slides. It tells you exactly which numbers in the earlier draft are real, which are targets, and which are currently wrong or unverifiable.
- **Sections 15–19** are the execution plan — what to build first, what to cut if you're short on time, and how to run the demo.

Everywhere a number appears, it is tagged:
- **[VERIFIED]** — confirmed against the primary source during this PRD's preparation.
- **[TARGET]** — your engineering goal. Not yet measured. Do not present as a result.
- **[MEASURE]** — you must generate this number yourself from your own benchmark run before the demo.
- **[UNVERIFIED / DO NOT QUOTE]** — appeared in an earlier draft, could not be confirmed, and in some cases appears to be wrong. Do not put this in front of a jury until you've personally opened the source and confirmed it.

---

## Table of Contents

1. Executive Summary
2. Problem Statement (Verified vs. Proposed)
3. Goals, Non-Goals, and Scope
4. Users, Personas, and Core Use Cases
5. Success Criteria (Mapped to Official SIH Rubric)
6. One-Sentence Thesis and Mental Model
7. System Architecture
8. Functional Requirements (FR-1 … FR-11)
9. Non-Functional Requirements
10. Data Contracts & Schemas
11. Security & Trust Model
12. Evaluation Protocol (How to Actually Measure Each Rubric Metric)
13. Prompt-Injection & Adversarial Robustness Requirements
14. Citation & Claims Integrity Ledger
15. Build Plan: MVP → Full System (Phased, De-risked)
16. Technology Stack & Justified Substitutions
17. Repository Structure
18. Demo Script & Judge Q&A Prep
19. Risk Register
20. Proof-of-Work Deliverables Checklist
21. Team Roles (RACI)
22. Appendix A: Glossary
23. Appendix B: Reference List (with integrity flags)

---

## 1. Executive Summary

Autonomous browser/GUI agents ("Computer-Using Agents", CUAs) plan their next action by sending a screenshot and/or page structure to a cloud Vision-Language Model (VLM). This is a real and actively studied privacy problem: research such as GUIGuard-Bench and AgentDAM show that agents routinely see and can leak sensitive on-screen data, and that simple redaction (blurring/blacking out) destroys enough context that the agent stops working reliably. **[VERIFIED — see §14]**

**ISRO-Guard CUA** is a Chromium browser extension (Manifest V3) that sits between the user's browser and a remote cloud planner. It:

1. **Perceives** the page through two channels — the rendered screenshot and the DOM/accessibility tree.
2. **Detects** sensitive regions in both channels using a local, on-device pipeline (rules + a lightweight local model), and keeps the two channels in sync so nothing sensitive is redacted in one channel but left exposed in the other.
3. **Redacts semantically, not visually** — sensitive values are replaced with typed placeholders (e.g. `[EMAIL_REDACTED#b8]`) rather than blacked out, so the cloud planner still understands the page layout and can still reason about it.
4. **Sends only the sanitized representation** to the cloud VLM, which acts purely as a planner and never receives raw private content.
5. **Never lets the cloud act directly.** The cloud returns an abstract, human-readable action ("click the Download button"). A local, deterministic policy engine checks whether that action is allowed; only if approved does a local grounding step translate it into a real click at a real coordinate, executed entirely on-device.

The product is **not** a claim to have invented browser agents, GUI grounding, or privacy-preserving agents — all three already exist as active research areas (OSWorld, GoClick, GUIGuard, MobileExplorer, AgentDAM — see §14). The product's actual contribution is the **integration**: a working browser-native trust boundary that keeps raw screen state local, keeps DOM and visual redaction in lockstep, and keeps final execution control on the device — built specifically for public ISRO portals (Bhuvan, MOSDAC, VEDAS) where the workflow is public but the *analyst's behavior and identity* should not be.

---

## 2. Problem Statement (Verified vs. Proposed)

### 2.1 What SIH26171 is actually asking

> Build a browser/GUI agent that can perceive and operate a user's screen for task automation, while performing the *visual perception and sensitive-data handling* on-device, so that private/sensitive on-screen information is not indiscriminately exposed to a remote reasoning service.

The problem statement is fundamentally about **on-device visual perception + privacy**, not about building a brand-new foundation model or a brand-new agent framework from scratch.

### 2.2 Why the problem is real (not invented for this pitch)

- GUI/CUA systems (e.g. OSWorld) use screenshots and accessibility trees as their primary observation channel — this is the standard architecture across the field. **[VERIFIED]**
- GUIGuard-Bench, a January 2026 paper, documents that GUI screenshots carry rich, directly actionable private information and that privacy risk is trajectory-dependent (it depends on the sequence of screens, not just one image). **[VERIFIED]**
- AgentDAM (Meta FAIR, NeurIPS 2025) shows that agents built on GPT-4, Llama-3, and Claude are prone to using more private information than a task actually requires ("data minimization" failures). **[VERIFIED]**

### 2.3 The core tension you are solving

```
Naive redaction (blackout everything)
        privacy ↑        task success ↓
                    vs.
No redaction (send raw screen)
        task success ↑   privacy ↓
```

GUIGuard's own evaluation demonstrates this trade-off empirically — static/naive protection measurably degrades a cloud planner's semantic understanding of the page. **[VERIFIED — the existence of this trade-off in their evaluation. Do not quote a specific score without re-checking §14.]**

Your system's job is to move the operating point up and to the right: **low leakage AND high task success**, via *semantic* redaction rather than *visual* redaction.

### 2.4 ISRO relevance

ISRO's public portals — Bhuvan (geospatial), MOSDAC (meteorological/oceanographic, built with the Indian Navy), VEDAS, OpenSAFE — are open-registration but used by scientists, defense-adjacent researchers, and analysts whose **behavior** (what they searched, downloaded, and when) is sensitive even though the portal itself is public. If an analyst automates a workflow with a cloud-hosted agent, the raw screenshot pipeline leaks: session identity, department, search intent, and geographic areas of interest — a profiling risk, not just a PII risk. This reframes "PII protection" as **operational-behavior protection**, which is a stronger and more ISRO-specific framing than generic PII masking.

---

## 3. Goals, Non-Goals, and Scope

### 3.1 Goals (in priority order)

| # | Goal | Why it's prioritized here |
|---|------|---------------------------|
| G1 | Working end-to-end demo: task in → sanitized context out → cloud plan → local policy check → local click executed | This is what wins a live SIH round. A partial pipeline that runs end-to-end beats a "more complete" pipeline that only works in slides. |
| G2 | Local, on-device sensitive-data detection across **both** DOM and screenshot, kept in sync | This is your strongest, most technically defensible differentiator (see §14, USP validity ranking). |
| G3 | Task-aware semantic redaction (placeholders, not blackout) | Directly answers the rubric's "visual-context accuracy" and "redaction precision" criteria. |
| G4 | Deterministic local policy gate before any action executes | This is the security story judges will probe hardest — "what stops the cloud from doing something bad?" |
| G5 | An evaluation harness that produces your own numbers | Turns your submission from "claims" into "evidence." This is what separates a winning SIH team from an average one. |
| G6 (stretch) | Canvas/WebGL-aware redaction for Bhuvan/MOSDAC-style map widgets | Real, hard, ISRO-specific problem — high value if time allows, but do not let it block G1–G5. |
| G7 (stretch) | Parallel exploratory latency hiding (PELH) | Genuinely interesting, but it is a performance optimization, not your core thesis. Build only after G1–G5 work. |

### 3.2 Non-Goals (explicitly out of scope — say this out loud to judges)

- **Not** building a new foundation VLM. You use an existing commercial/API model (Claude, GPT-4o, or an open VLM) as the "brain," unmodified.
- **Not** claiming zero possible privacy leakage. You claim "no raw screenshot/DOM leaves the trust boundary by design," which is an architectural property you can demonstrate — not a formal proof of zero leakage.
- **Not** solving prompt injection completely. You add a defense layer (task-relevance filtering + policy gate); you do not claim full immunity.
- **Not** shipping a production Chrome Web Store extension with enterprise policy management, though the architecture should not preclude it later.
- **Not** re-implementing GoClick, GUIGuard, or MobileExplorer from scratch as research contributions — you are integrating/adapting existing, cited techniques.

### 3.3 Scope boundary for the SIH submission

In scope: 1 browser extension, 2–3 demo portals (a real public ISRO-style portal such as Bhuvan/MOSDAC plus one local mock/staging site you fully control for repeatable demos), 1 cloud planner integration, 1 local grounding method, 1 policy engine, 1 evaluation harness with your own dataset of ≥50–100 annotated screenshots.

---

## 4. Users, Personas, and Core Use Cases

**Persona: ISRO/portal analyst ("Dr. Sharma, Oceanography Division")** — needs to run repetitive lookup/download tasks on MOSDAC/Bhuvan and wants an AI assistant to do the clicking, but must not have their identity, department, or search behavior transmitted to a third-party cloud AI.

**Persona: SIH judge/evaluator** — needs to see, within a 5–8 minute demo, (a) the privacy problem happening live in an unprotected baseline, (b) your system preventing it, (c) the task still succeeding, (d) your own measured numbers, not just claims.

**Core use cases (also your demo scenarios, detailed in §18):**
1. Search + download a specific dataset/imagery from a map-based portal (WebGL/Canvas heavy).
2. Check a dashboard/chart while the user's logged-in identity and history stay hidden from the cloud.
3. Resist a fine-print prompt-injection instruction embedded in the page.

---

## 5. Success Criteria (Mapped to Official SIH Rubric)

The five official evaluation dimensions and what "done" looks like for each:

| Rubric Metric | Weight | What "done" means for your MVP | Where it's specified in this PRD |
|---|---|---|---|
| Visual-context accuracy | 25% | After sanitization, the cloud planner still correctly identifies and clicks the right task-relevant element ≥ your target success rate on your own test set | §12.1 |
| Sensitive/PII detection precision & recall | 20% | Your DMPR pipeline is benchmarked against your own labeled dataset with reported P/R, not assumed | §12.2 |
| Redaction precision | 20% | Bounding boxes tightly cover the sensitive region without over-masking neighboring content | §12.3 |
| Client resource utilization | 20% | Measured RAM/CPU footprint of the extension + local models on a real laptop, reported honestly | §12.4 |
| End-to-end latency | 15% | Measured wall-clock time from user command to completed action, broken into stages | §12.5 |

**Rule for your slides:** every number under these five headings must come from §12's protocol, run by your own team, on your own machine. If you haven't run it, write "target" next to it, not a bare number.

---

## 6. One-Sentence Thesis and Mental Model

> **The cloud can reason, but it must never see raw private state, and it must never directly control the browser.**

Mental model — Brain vs. Body:

```
CLOUD  = BRAIN   → "What should happen next?"                 (untrusted, replaceable, stateless)
LOCAL  = BODY    → "What is on screen? What's sensitive?      (trusted, has all context,
                     Is this action allowed? Where exactly     final say on every action)
                     is the target? Execute."
```

Trust zones:

```
ZONE 1 — TRUSTED LOCAL           ZONE 2 — SANITIZED (crosses boundary)      ZONE 3 — UNTRUSTED CLOUD
raw screenshot                   redacted screenshot                       VLM reasoning
raw DOM                          placeholder tokens                        planning
credentials, PII                 safe structural metadata                  abstract action output only
token↔real-value map             task-sufficient layout
final click execution
```

---

## 7. System Architecture

### 7.1 End-to-end data flow

```
                         [ USER TYPES A TASK ]
                                  │
                                  ▼
                 ┌───────────────────────────────┐
                 │   CHROMIUM MV3 EXTENSION       │
                 │  (content script + bg worker)  │
                 └───────────────┬────────────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              ▼ capture screenshot                     ▼ read DOM / a11y tree
   chrome.tabs.captureVisibleTab()          content-script XPath/A11y extractor
              │                                        │
              └───────────────────┬────────────────────┘
                                  ▼
                 ┌───────────────────────────────┐
                 │  DMPR: DUAL-MODAL PRIVACY      │
                 │  RECOGNITION ENGINE            │
                 │  - regex/rule PII detector     │
                 │  - local NER / classifier      │
                 │  - visual detector (optional)  │
                 └───────────────┬────────────────┘
                                  ▼
                 ┌───────────────────────────────┐
                 │  DOM–VISUAL LOCKSTEP SYNC      │
                 │  getBoundingClientRect() maps  │
                 │  DOM node ↔ screen coordinates │
                 └───────────────┬────────────────┘
                                  ▼
                 ┌───────────────────────────────┐
                 │  TASK-AWARE ABI REDACTION      │
                 │  cosine similarity(task, node) │
                 │  → keep plaintext OR replace   │
                 │    with typed placeholder      │
                 └───────────────┬────────────────┘
                                  ▼
                    SANITIZED SCREENSHOT + SANITIZED
                    STRUCTURAL CONTEXT (JSON)
                                  │
                                  ▼
                 ┌───────────────────────────────┐
                 │   CLOUD PLANNER (VLM API)      │
                 │   returns ABSTRACT ACTION      │
                 │   e.g. {"action":"click",      │
                 │   "target":"[USER_ID#c4]"}     │
                 └───────────────┬────────────────┘
                                  ▼
                 ┌───────────────────────────────┐
                 │   LOCAL POLICY ENGINE (gate)   │
                 │   allow / block / ask-user     │
                 └───────────────┬────────────────┘
                        allowed  │  blocked → stop, log, notify user
                                  ▼
                 ┌───────────────────────────────┐
                 │   LOCAL GROUNDING              │
                 │   placeholder/text → real      │
                 │   on-screen coordinate         │
                 └───────────────┬────────────────┘
                                  ▼
                        REAL BROWSER ACTION
                     (click/type/scroll executed
                      on the user's actual tab)
                                  │
                                  └──────── loop back to capture ────────
```

### 7.2 Components (map to code modules — see §17)

| Component | Responsibility | Runs where |
|---|---|---|
| Capture Agent | Screenshot + DOM/a11y snapshot on each step | Content script |
| DMPR Engine | Detect sensitive spans/regions in text + DOM attributes | Background worker (local model) |
| Lockstep Sync | Map DOM node bounds ↔ pixel regions | Content script |
| ABI Redactor | Decide keep-plaintext vs. placeholder per task relevance; render placeholder into both DOM copy and screenshot copy | Background worker |
| Cloud Planner Client | Send sanitized bundle to VLM API, parse abstract action | Background worker (network call) |
| Policy Engine | Deterministic allow/block decision on the abstract action | Background worker (no network) |
| Grounding Actuator | Resolve target placeholder/description → concrete (x,y) | Content script (has live DOM) |
| Executor | Dispatch real click/type/scroll events | Content script |
| Telemetry/Eval Logger | Record every step's timing, detections, decisions to local storage for later benchmarking | Background worker |
| (Stretch) PELH Explorer | Background parallel probing during cloud "thinking" window | Hidden iframe / background worker |

---

## 8. Functional Requirements

Each requirement has an ID, a plain description, and an acceptance test. Build in this numeric order for MVP (FR-1 → FR-8 are MVP-critical; FR-9–FR-11 are enhancements).

### FR-1 — Extension Shell & Capture
The extension must capture, on demand or on a fixed cadence, (a) a screenshot of the visible tab and (b) a structural snapshot of the DOM/accessibility tree, timestamped and correlated by a shared step ID.
**Acceptance test:** Trigger one capture; verify a PNG/JPEG and a JSON DOM snapshot exist with matching step IDs within 500ms of each other.

### FR-2 — Sensitive Data Detection (DMPR)
The system must detect, locally, at minimum these categories: person name, email, phone number, physical address, government ID pattern, credential/password fields, session/auth tokens, free-text search history fields.
Detection must run against **both** the DOM text/attributes and (optionally, if time allows) OCR'd screenshot text, using: (a) regex/pattern rules for structured PII (email, phone, ID formats), (b) a compact local NER/classifier model for unstructured PII (names, addresses), (c) DOM signal heuristics (`type="password"`, `autocomplete="email"`, ARIA labels containing "name"/"phone"/etc.).
**Acceptance test:** Run against your labeled test set (§12.2); report precision/recall per category.

### FR-3 — DOM–Visual Lockstep Sync
For every DOM node flagged sensitive, compute its on-screen bounding box via `getBoundingClientRect()` and store a mapping `{node_id, bbox, sensitivity_label}`. For every visually-detected sensitive region (if a visual detector is used), attempt to reverse-map it to the underlying DOM node using bbox overlap.
**Acceptance test:** For a test page with 10 known sensitive fields, verify ≥90% of DOM-flagged fields have a correctly associated bounding box (manual/automated overlay check).

### FR-4 — Task-Aware Semantic Redaction (ABI)
For each sensitive node, compute a task-relevance score (cosine similarity between the task embedding and the node's nearby label/context embedding, per FR-4a below). If relevance is above threshold *and* the value is not itself a raw secret needed only for internal navigation, redact to a **typed placeholder** (`[EMAIL_REDACTED#<hash4>]`, `[USER_ID#<hash4>]`, etc.) rather than a blank/blackout, in **both** the DOM copy sent as structural context and the pixel region on the screenshot (inpainted with matching font/box).
**FR-4a:** Use a local embedding model (e.g., a compact `bge`-family or similar small sentence-embedding model runnable via ONNX Runtime Web) to embed (i) the user's task string and (ii) a short text description of each candidate UI element (label + nearby text). Rank by cosine similarity.
**Acceptance test:** On a labeled test set with "task-relevant" vs "irrelevant" sensitive fields, verify the redaction decision matches the label ≥ your target accuracy (§12.3), and verify placeholders appear at the correct coordinates in the outgoing screenshot.

### FR-5 — Sanitized Context Assembly
Assemble the outgoing payload to the cloud planner: sanitized screenshot (image) + a compact structural JSON (see §10.1) containing only placeholder tokens, element types, and layout — never raw values.
**Acceptance test:** Automated check (regex scan) confirms zero matches of any value present in the "known secrets" list of the test fixture, in either the outgoing image OR the outgoing JSON, before the request leaves the device.

### FR-6 — Cloud Planner Integration
Send the sanitized bundle + task to a cloud VLM (Claude/GPT-4o/etc.) with a system prompt constraining it to respond with a single structured "next action" (JSON: action type, target description/placeholder, optional value-to-type that must itself be a placeholder or literal task text — never a request to "reveal" or "output" a redacted value).
**Acceptance test:** For a set of test tasks, verify the model's response always parses into the expected schema (§10.2) and never contains a request for a real secret value.

### FR-7 — Local Policy Engine (Gate)
Before any action executes, evaluate it against a local, deterministic rule set (JSON/YAML rules is acceptable for MVP; a full RDF/Turtle BDI engine is a stretch — see §16). Minimum rules for MVP:
- Block any `type` action whose target or value maps to a credential/session field being sent toward a domain different from the current page's origin.
- Block any action targeting a placeholder that was marked `high_risk` during redaction, unless explicitly confirmed by the user.
- Allow all other actions whose target placeholder exists in the current lockstep map.
**Acceptance test:** Feed the policy engine synthetic "malicious" abstract actions (e.g., "type session_token into external-site.com form") and verify 100% block rate on your test suite of ≥20 adversarial cases.

### FR-8 — Local Grounding & Execution
Translate the cloud's target description/placeholder back into a real coordinate using the lockstep map (exact match case) or a local grounding model/heuristic (fuzzy case — e.g., cloud says "the search button" without an exact placeholder match). Dispatch a synthetic click/input event at that coordinate/element.
**Acceptance test:** For 20 test instructions, verify the resolved coordinate lands within the correct element's bounding box ≥ your target grounding accuracy (§12.1), and that the click actually registers in the live page.

### FR-9 (Stretch) — Canvas/WebGL Interception
For canvas-rendered widgets (maps/charts), intercept `fillText`/`drawElements`/`drawArrays` or periodically OCR the rendered canvas region to detect sensitive text that has no DOM representation, and overlay a redaction box directly on the captured bitmap before it is sent out.
**Acceptance test:** On a test page with a canvas element rendering a known sensitive string, verify the string is not present (via OCR check) in the outgoing sanitized screenshot.

### FR-10 (Stretch) — Parallel Exploratory Latency Hiding (PELH)
While waiting for the cloud planner's response, rank candidate next-actions by task-relevance and speculatively probe the top 1–2 in a hidden/cloned context, then roll back using a perceptual-hash (pHash) state check (and a replay-trace fallback), appending any discovered hints to the next cloud prompt.
**Acceptance test:** Verify state is bit-for-visual-purposes identical (pHash Hamming distance under your chosen, *experimentally validated*, threshold — do not hardcode "12" without testing it on your own pages) after rollback, on ≥10 trial explorations.

### FR-11 — Evaluation & Telemetry Logging
Every run must log, locally: per-step latency breakdown (capture / detect / redact / network / plan / policy / ground / execute), every detection decision (label, confidence, coordinates), every policy decision (allow/block + rule fired), and task outcome (success/fail). This log is your evaluation dataset and your proof-of-work artifact — build it before you build the demo polish.

---

## 9. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Privacy | No raw screenshot or raw DOM text is ever included in any outbound network request. Enforce this with an automated pre-send check (FR-5), not just architectural intent. |
| Security | All PII↔placeholder mappings live only in-memory inside the isolated MV3 extension context; cleared on tab close; never written to disk unencrypted; never sent to the cloud. |
| Performance (resource) | Target combined extension + local model footprint under a stated, *measured* RAM ceiling on a mid-range laptop (report the real number — see §12.4; do not assert a number you have not measured). |
| Performance (latency) | Target combined local-side processing (capture→sanitize→ground→execute, excluding cloud network+inference time) under a stated, *measured* millisecond budget (§12.5). |
| Reliability | If the local model or policy engine fails/throws, default to **fail-closed**: block the action and surface an error to the user, never fail-open into an unreviewed action. |
| Portability | MV3 extension should run on any Chromium-based browser (Chrome, Edge, Brave) without portal-specific code paths hardcoded outside a small adapter layer. |
| Explainability | Every block/redaction decision must be inspectable by the user (a small side panel or console log showing "why" — this doubles as your judge-facing debugging tool). |

---

## 10. Data Contracts & Schemas

### 10.1 Sanitized Structural Context (sent to cloud)

```json
{
  "step_id": "s-0007",
  "task": "Find the seasonal vegetation index tile for Grid-Zone 12",
  "viewport": { "width": 1440, "height": 900 },
  "elements": [
    {
      "placeholder_id": null,
      "type": "button",
      "text": "Download",
      "bbox": [812, 430, 96, 32]
    },
    {
      "placeholder_id": "USER_ID#c4",
      "type": "text",
      "text": "[USER_ID#c4]",
      "bbox": [40, 12, 140, 20],
      "sensitivity": "identity"
    },
    {
      "placeholder_id": "SESSION_REDACTED#41",
      "type": "hidden_metadata",
      "text": "[SESSION_REDACTED#41]",
      "bbox": null,
      "sensitivity": "session"
    }
  ],
  "screenshot_ref": "sanitized_s-0007.png"
}
```

Rules for this object: no field may ever contain a real PII value; `placeholder_id` is present only on redacted nodes; `bbox` is omitted for elements with no visual footprint (pure metadata).

### 10.2 Cloud Planner Response (abstract action)

```json
{
  "step_id": "s-0007",
  "reasoning_summary": "Grid-Zone 12 is visible on the map; click it, then click Download.",
  "actions": [
    { "type": "click", "target_text": "Grid-Zone 12" },
    { "type": "click", "target_placeholder": null, "target_text": "Download" }
  ]
}
```

Contract: `target_placeholder` must be either `null` (meaning: ground by visible text/description) or an exact placeholder token that appeared in the outgoing context. The cloud must **never** be asked to, and must never attempt to, output an unredacted value — enforce this with a response-schema validator that rejects/flags any response containing a string not present in your placeholder vocabulary or the original task text.

### 10.3 Local Policy Rule (MVP format)

```json
{
  "rule_id": "block-cross-origin-credential-type",
  "condition": {
    "action_type": "type",
    "target_sensitivity_in": ["credential", "session"],
    "destination_origin_not_equal": "page_origin"
  },
  "effect": "block",
  "message": "Blocked: attempted to send credential/session data to a different origin."
}
```

(This is the pragmatic MVP substitute for the full BDI/Turtle/PKG design described in the original concept doc — see §16.3 for why, and how to upgrade later.)

### 10.4 Evaluation Log Entry

```json
{
  "step_id": "s-0007",
  "timings_ms": { "capture": 42, "detect": 180, "redact": 65, "network": 4200, "policy": 3, "ground": 22, "execute": 15 },
  "detections": [ { "label": "email", "bbox": [40,12,140,20], "confidence": 0.94, "redacted": true, "task_relevant": false } ],
  "policy_decision": { "action": "click", "result": "allow", "rule_fired": null },
  "outcome": "success"
}
```

---

## 11. Security & Trust Model

### 11.1 Trust boundary (restated as a testable property)

**Property to test, not just assert:** *For every network request the extension makes to the cloud planner, an automated scanner confirms zero substring matches against a fixture list of "known secret values" injected into the test page.* This is your FR-5 acceptance test and it is also your strongest jury-facing proof (§18 demo, §20 checklist).

### 11.2 Threat model

| Threat | Mitigation | Status |
|---|---|---|
| Cloud planner receives raw PII via screenshot | DMPR + ABI redaction before any network call | FR-2, FR-4, FR-5 |
| Cloud planner receives raw PII via DOM/HTML | DOM–Visual lockstep sync prunes DOM text alongside screenshot | FR-3 |
| Cloud planner instructs an unsafe/exfiltrating action | Local deterministic policy gate, fail-closed | FR-7 |
| Malicious/compromised webpage embeds hidden instructions ("prompt injection") aimed at the agent | Task-relevance filtering flags low-similarity imperative text; policy engine still gates the resulting action regardless | §13, FR-4a, FR-7 |
| Local token↔PII map exfiltrated by a compromised local process | Map lives only in extension's isolated in-memory context, garbage-collected on tab close, never persisted unencrypted | NFR — Security |
| Canvas/WebGL content bypasses DOM-based redaction entirely | FR-9 canvas interception (stretch); until built, treat canvas regions as "unknown — mask by default" rather than "assume safe" | FR-9 |
| Local grounding model misfires / picks wrong element | Confidence threshold + human-in-the-loop confirmation dialog below threshold | §16.4, Risk Register |

### 11.3 What you can honestly claim vs. what you cannot

| Claim | Honest version |
|---|---|
| "0% raw sensitive pixels transmitted" | "By architecture, no raw screenshot or DOM buffer is ever included in an outbound request — verified by an automated pre-send scanner in our test suite." (Architectural guarantee you can test, not a claim of zero missed detections.) |
| "0% privacy leakage" | Do not claim this. Recall on your detector will not be 100%; say instead: "Measured PII recall of **[MEASURE]**% on our N=`[X]`-sample labeled test set." |
| "Solves prompt injection" | "Adds a task-relevance-based defense layer against fine-print/hidden-instruction injection; this is a mitigation, not a formal guarantee." |

---

## 12. Evaluation Protocol

You need your own numbers. Here is exactly how to produce each rubric metric.

### 12.1 Visual-Context Accuracy / Task Success Rate

**Method:** Build a fixed test set of N (target ≥20) task instructions against your demo portal(s) plus at least one real ISRO-style public portal capture. For each task, run (a) baseline (raw screenshot to cloud, no redaction) and (b) your system. Record binary success (did the correct element get clicked / correct data retrieved) for both.
**Report:** `Task Success Rate = successes / N` for both conditions, side by side. This dual-condition reporting is your single strongest evidence of the privacy/utility trade-off claim in §2.3 — build it early.

### 12.2 PII Detection Precision & Recall

**Method:** Manually label a test corpus (screenshots + DOM snapshots) with ground-truth sensitive spans/regions per category (name, email, phone, session, credential, etc.). Run FR-2's detector; compare predicted spans to ground truth using IoU ≥ 0.5 (bounding-box) or exact-span match (text) as your "hit" criterion.
**Report:** Per-category and overall Precision = TP/(TP+FP), Recall = TP/(TP+FN). Recall is your headline number for the rubric weight; report both.

### 12.3 Redaction Precision

**Method:** For every true-positive detection, measure how tightly the rendered placeholder box matches the ground-truth bounding box (IoU) and whether any non-sensitive neighboring text was accidentally covered (manual spot-check on a sample, e.g. 30 detections).
**Report:** Mean IoU of redaction boxes vs. ground truth; count of "over-redaction" incidents per 100 detections.

### 12.4 Client Resource Utilization

**Method:** Using Chrome DevTools Performance/Memory panel (or `chrome://extensions` background page memory view), measure peak and steady-state RAM and CPU while the extension is actively processing a step, on a specified real machine (state the CPU/RAM spec in your report — this matters for credibility).
**Report:** Peak RAM (MB), average CPU (%) during a 10-step task run.

### 12.5 End-to-End Latency

**Method:** Use the FR-11 telemetry log. Break every step into: capture, detect, redact, network+cloud-inference, policy, ground, execute. Run ≥10 full tasks; report mean and p90 for total time and for the "local-only" subtotal (everything except the network+cloud-inference stage, since that is bounded by the third-party API and not your engineering).
**Report:** A stacked bar chart (mean ms per stage) — this single chart answers both "how fast is it" and "where is the ISRO-Guard specific overhead" (i.e., is your privacy layer adding meaningful latency, and how much).

> **Presentation tip:** Judges will trust a table with 4 columns — *Metric, Your Measured Value, Sample Size, Test Conditions* — far more than a single impressive-looking percentage with no methodology attached.

---

## 13. Prompt-Injection & Adversarial Robustness Requirements

- **AR-1:** The system must compute task-relevance similarity (FR-4a) for *all* text blocks on a page, not only ones that look like form fields — including hidden/low-opacity/tiny-font text nodes — since these are exactly where fine-print injection attacks hide.
- **AR-2:** Any text block with high imperative-language density (regex/heuristic: presence of "ignore previous", "system update", "upload", "send to", etc. combined with low task-relevance score) should be flagged and excluded from the sanitized context sent to the cloud, logged as a suspected injection attempt.
- **AR-3:** Regardless of AR-1/AR-2, the policy engine (FR-7) remains the final backstop — even if an injected instruction reaches the cloud and the cloud "obeys" it, the resulting action still must pass the local policy gate before executing.
- **AR-4:** Do not present AR-1–AR-3 as "prompt injection solved." Present it as layered defense-in-depth, and say so explicitly to judges — this is a more credible and more senior framing than an absolute claim.

---

## 14. Citation & Claims Integrity Ledger

This section exists because the earlier draft mixed real, verifiable research with specific numbers that could not be confirmed and, in at least one case, appear to be misattributed. Before your final submission, go through this table and replace every **[UNVERIFIED]** row with either a number you personally pulled from the primary source, or your own **[MEASURE]**d value.

### 14.1 Confirmed to exist (safe to cite as related work)

| Work | What it actually is | Status |
|---|---|---|
| **OSWorld** — "Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments" | Established GUI-agent benchmark using screenshots + accessibility trees as observation; widely cited baseline in the field. | **[VERIFIED]** |
| **GoClick** — "Lightweight Element Grounding Model for Autonomous GUI Interaction" | Real paper (2026). Confirmed: 230M-parameter encoder-decoder (Florence-2-based) GUI element grounding model, explicitly designed for resource-constrained/on-device use and for device-cloud collaboration frameworks. | **[VERIFIED]** — parameter count and design intent confirmed directly from the abstract. |
| **GUIGuard / GUIGuard-Bench** — "Toward a General Framework for Privacy-Preserving GUI Agents" | Real paper (Jan 2026). Confirmed: three-stage framework (privacy recognition → privacy protection → task execution under protection); benchmark of 630 trajectories, 13,830 screenshots, region-level privacy annotations. Confirmed headline result: state-of-the-art models achieve only **13.3% strict-match accuracy on Android** and **1.4% on PC** on their privacy-recognition task. | **[VERIFIED]** — these two specific numbers (13.3%, 1.4%) match the paper's own abstract. Per-model breakdowns beyond this (e.g. specific numbers attributed to "Claude 4.5", "Qwen-3.5", "Gemini-3") are **[UNVERIFIED]** — re-check against the actual results table before quoting. |
| **MobileExplorer** — "Accelerating On-Device Inference for Mobile GUI Agents via Online Exploration" | Real paper (2026). Confirmed: parallel/speculative exploration during VLM reasoning time, two-level rollback mechanism, evaluated on AndroidWorld. Confirmed headline result: **23% reduction in reasoning steps/latency**, **task success maintained or improved by up to 5%**. | **[VERIFIED]** for the 23% / "up to 5%" headline figures. The specific **39.7% (M3A baseline) / 50.9% (MobileExplorer)** absolute success-rate figures used in the earlier draft's table were **not found in the abstract** and must be independently re-confirmed against the paper's results table before use — mark as **[UNVERIFIED]** until then. |
| **AgentDAM** — "Privacy Leakage Evaluation for Autonomous Web Agents" | Real paper, Meta FAIR, NeurIPS 2025. Confirmed: benchmark for the "data minimization" principle in web agents; evaluates GPT-4, Llama-3, and Claude-based agents; shows agents are prone to using unnecessary sensitive information. | **[VERIFIED]** |

### 14.2 Needs correction before you present it

| Claim in the earlier draft | What was actually found | Action required |
|---|---|---|
| "CORE (NeurIPS 2025, Datasets and Benchmarks Track)... AndroidLab, GPT-4o + Gemma-2-9B: 37.76% task success, 34.96% UI exposure reduction" | A real, closely-related paper exists — *"CORE: Reducing UI Exposure in Mobile Agents via Collaboration Between Cloud and Local LLMs"* — but its actual reported AndroidLab number is **GPT-4o + Qwen2.5-7B: 29.97% UI-exposure reduction with a 3.06-point task-success drop**. The **Gemma2-9B** pairing and **55.6%** exposure-reduction figure in that paper is reported on a *different* dataset (DroidTask), not AndroidLab. The venue tag ("NeurIPS 2025, Datasets and Benchmarks Track") could not be confirmed either. | **Do not use the 37.76%/34.96% figures.** Either cite the paper's real, verified numbers correctly (29.97% / 3.06-pt drop on AndroidLab; 55.6% / 4.9-pt drop on DroidTask, with the correct model pairings), or drop the CORE comparison entirely if you can't personally verify the paper before submission. |
| "[43] On-Device LLM Deployment and Overhead Analysis... 141.04 seconds per step, 4.22× latency degradation, 6.9 GB RAM (also elsewhere quoted as 7.8 GB)" | Could not be located in, or confirmed against, any primary source during this review. | **Treat as [UNVERIFIED / DO NOT QUOTE].** If your team wants a "local 7B model is too slow/heavy" comparison, run it yourselves — download a quantized 7B model, run one inference step on a representative device, and report your own measured latency/RAM. A number you measured yourself is more defensible than a number you can't source. |
| "AgentDAM... baseline agents leak raw sensitive elements in 64.6% of multi-modal execution steps" | Not confirmed against the AgentDAM abstract or found in initial verification. | **[UNVERIFIED]** — locate this exact figure in the AgentDAM paper's results tables before using it, or replace with your own measured leakage rate from your baseline-vs-protected comparison (§12.1). |
| The "[TARGET]" rows in the SOTA-vs-ISRO-Guard comparison table (92.5% visual accuracy, 98.2% PII recall, 96.5% redaction precision, <450MB RAM, 22.8s latency) | These are correctly labeled as targets in the source draft. | **No correction needed to the label** — just make sure your slides keep the "[TARGET]" tag visible and replace with **[MEASURE]**d values as soon as your evaluation harness (§12) produces real numbers. Never let a "[TARGET]" silently become a bare number on a slide. |

### 14.3 Important novelty correction — "ABI" is not a term you coined

A real, separate paper already exists using almost exactly this idea and name: **"Anonymization-Enhanced Privacy Protection for Mobile GUI Agents: Available but Invisible"** (2026). **[VERIFIED — confirmed to exist as a distinct published work.]**

**What this means for your pitch:** Do not present "Available-But-Invisible (ABI)" as a concept your team invented. Instead:
- Cite it explicitly as prior/related work: "task-aware semantic redaction, sometimes called 'available but invisible' redaction in recent mobile-agent privacy literature, keeps a placeholder visible so the agent knows an element exists without exposing its value."
- Reframe your actual contribution more precisely and more defensibly as: **applying this style of redaction inside a browser (not mobile) environment, synchronized bidirectionally across DOM and screenshot channels (the "lockstep" mechanism), and extended to canvas/WebGL-rendered map/chart widgets** — which genuinely does appear to be a less-covered niche than mobile-app ABI redaction.
- This correction actually **strengthens** your pitch's intellectual honesty, which matters a great deal to an academic/ISRO jury: claiming a narrower, correctly-scoped novelty is more credible than claiming a broader one that a judge can disprove with one search.

### 14.4 Standing instruction for the rest of your bibliography

The remaining citations in the original concept doc (Chrome MV3 architecture docs, Transformers.js/ONNX Runtime Web guides, the AAMAS BDI framework reference, the SOUPS fine-print-injection reference, the CUPA/PKG references) were **not individually re-verified** in this pass — spot-check them the same way before your final submission: open the actual source, confirm the number/claim you intend to quote appears there, and only then put it on a slide. As a general policy: **any number that ends up on a judge-facing slide should be traceable, by your own team, to either a page number in a real paper or a row in your own evaluation log.**

---

## 15. Build Plan: MVP → Full System (Phased, De-risked)

Do not start with the full architecture. Build the thinnest possible vertical slice first, prove it works end-to-end, then layer in privacy, then security, then optimization.

| Stage | What you build | Exit criterion |
|---|---|---|
| **Stage 0 — Scaffold** | MV3 extension skeleton: manifest, background worker, content script, basic popup UI. Screenshot capture works. Manual click dispatch works. | You can capture a screenshot and programmatically click a hardcoded element. |
| **Stage 1 — Naive agent** | Send raw screenshot + task to cloud VLM; parse a simple "click X" response; ground by matching visible text; execute click. No privacy yet. | A 3–5 step task completes end-to-end on your test portal. |
| **Stage 2 — Privacy (FR-2, FR-5)** | Add DMPR regex/rule detection on DOM text; redact matched values before sending; add the automated "zero-secret-leak" pre-send scanner (§11.1). | Task from Stage 1 still succeeds, and the scanner confirms zero known-secret substrings left the device. |
| **Stage 3 — Cross-modal sync (FR-3)** | Add `getBoundingClientRect()` mapping; redact the corresponding screenshot region for every DOM-flagged field. | Visual placeholder boxes appear at correct coordinates over redacted DOM fields. |
| **Stage 4 — Task-aware redaction (FR-4)** | Add local embedding model + cosine similarity; task-relevant sensitive fields stay plaintext, irrelevant ones get placeholders. | Task success rate recovers to at least Stage-1 baseline while privacy holds from Stage 2. |
| **Stage 5 — Policy engine (FR-7)** | Add the JSON rule-based gate; write ≥20 adversarial test cases; verify 100% block rate. | Adversarial test suite passes; a legitimate action suite (≥20 cases) has 0 false blocks. |
| **Stage 6 — Grounding robustness (FR-8)** | Add fuzzy grounding (text-similarity fallback) for when the cloud doesn't return an exact placeholder; add confidence threshold + human-confirmation fallback. | Grounding succeeds on both exact-placeholder and free-text-description test cases. |
| **Stage 7 — Evaluation harness (FR-11)** | Build the telemetry logger; run the full §12 protocol; produce your first honest numbers. | You have a filled-in version of the §5 table with real numbers, not targets. |
| **Stage 8 (stretch) — Canvas/WebGL (FR-9)** | Only attempt after Stage 7 is solid. | OCR-based canvas redaction demonstrated on one map widget. |
| **Stage 9 (stretch) — PELH (FR-10)** | Only attempt if Stages 0–7 are demo-stable with time to spare. | Measured latency reduction on your own task set, with rollback correctness verified. |

**Rule of thumb for a hackathon timeline:** if you are more than 60% through your available build time and still on Stage 3 or earlier, cut Stage 8/9 entirely and put all remaining time into Stage 7 (evaluation) and demo polish. A working, measured Stage-6 system beats an unmeasured, half-working Stage-9 system in every SIH round.

---

## 16. Technology Stack & Justified Substitutions

| Layer | Original concept | Recommendation for a buildable hackathon MVP | Why |
|---|---|---|---|
| Extension shell | Chromium Manifest V3 | **Keep as-is.** | Correct choice; MV3 isolated worlds give you the sandboxing story for free. |
| DOM/a11y extraction | Custom XPath extractor | **Keep as-is**, using `document.evaluate` / `Element.getBoundingClientRect()` / ARIA attribute reads. | Standard, no external dependency needed. |
| Local grounding model | GoClick-B (230M, INT8, WebGPU) | **Two-tier plan:** (1) MVP — a deterministic text/label-matching grounder (fuzzy string match between cloud's target description and DOM element text/ARIA labels) requiring no ML model at all; (2) Enhancement — integrate a small open grounding model via Transformers.js/ONNX Runtime Web **only if** you've validated it actually loads and runs at acceptable latency in a real browser tab on your target laptop. | A 230M-parameter model in-browser is achievable but is real engineering risk (WebGPU availability, model conversion, cold-load time). Don't let it block your MVP demo — the fuzzy-match grounder is honest, works today, and you can *upgrade* to a model-based grounder as a visible "improvement" story if time allows. |
| Local embedding model | bge-micro-v1.5 via ONNX Runtime Web | **Keep the approach**, but validate load time and bundle size on your actual target browser before committing; have a pure-JS cosine-similarity-over-TF-IDF fallback ready as a zero-dependency backup. | Same risk-management logic as above. |
| Policy engine | Full BDI + Turtle/RDF Personal Knowledge Graph | **MVP: plain JSON/YAML rule list evaluated by a small hand-written matcher** (see §10.3). Keep the *BDI framing* in your slides (Belief = current page state, Desire = user's task, Intention = the action about to run) since it's a good explanatory model — but don't build a full RDF reasoner under time pressure. | A hand-rolled deterministic rule evaluator gives you the same security property (deterministic, local, auditable) with a fraction of the implementation risk. Upgrade to a real RDF store (e.g., `rdflib.js`, `Comunica`, `N3.js`) only as a post-hackathon roadmap item. |
| Cloud planner | Claude / GPT-4o via API | **Keep as-is.** Use whichever API key you have access to; abstract the client behind one interface so you can swap models. | No reason to change; this is exactly the "untrusted cloud brain" the architecture calls for. |
| Canvas/WebGL interception | `fillText`/`drawElements` prototype override + visual OCR | **Stretch only** (Stage 8). If attempted, use a well-tested browser OCR library (e.g., Tesseract.js) rather than building custom OCR. | High implementation risk, ISRO-relevant but not required for a working MVP demo — a live map-portal demo with DOM-based redaction on the surrounding controls (search bar, session info) already tells a strong story even without canvas-level redaction. |
| Latency hiding (PELH) | Parallel iframe probing + pHash rollback | **Stretch only** (Stage 9). | Genuinely valuable engineering, genuinely high risk of introducing state-corruption bugs during a demo. Only attempt with time to spare and thorough testing. |
| Evaluation | — | **Build first, not last.** A local JSON log + a small Python/Node script that computes P/R/IoU/latency stats from that log. | This is the single highest-leverage piece of engineering for your rubric score, and it is also the cheapest to build. |

---

## 17. Repository Structure

```
isro-guard-cua/
├── extension/
│   ├── manifest.json                # MV3 manifest
│   ├── background/
│   │   ├── service-worker.js        # orchestration, cloud client, policy engine
│   │   ├── dmpr/                    # sensitive-data detection
│   │   │   ├── regex-rules.js
│   │   │   ├── ner-model.js         # optional local NER wrapper
│   │   │   └── index.js
│   │   ├── redaction/
│   │   │   ├── task-relevance.js    # embeddings + cosine similarity
│   │   │   └── placeholder-map.js   # in-memory token<->value store
│   │   ├── policy/
│   │   │   ├── rules.json
│   │   │   └── engine.js
│   │   └── cloud-client.js          # VLM API wrapper
│   ├── content-scripts/
│   │   ├── capture.js               # screenshot + DOM snapshot
│   │   ├── lockstep-sync.js         # bbox <-> DOM mapping
│   │   ├── grounding.js             # placeholder/text -> coordinate
│   │   └── executor.js              # dispatch click/type/scroll
│   ├── popup/
│   │   ├── popup.html
│   │   └── popup.js                 # task input, live decision log
│   └── assets/
├── eval/
│   ├── dataset/                     # labeled screenshots + DOM snapshots
│   ├── run_eval.py                  # computes P/R/IoU/latency from logs
│   └── report_template.md
├── fixtures/
│   └── mock-portal/                 # your own controllable demo site
│       ├── index.html               # Bhuvan/MOSDAC-style mock with seeded fake PII
│       └── canvas-map-demo.html
├── docs/
│   ├── ISRO-Guard_CUA_Master_PRD.md # this document
│   └── demo-script.md
└── README.md
```

---

## 18. Demo Script & Judge Q&A Prep

### 18.1 Recommended demo flow (5–8 minutes)

1. **(30s) Frame the problem live.** Open your mock portal (or a real public ISRO portal page) logged in as a fake analyst with visible name/email/session info. State the task: *"Find and download the latest chart for Grid-Zone 12."*
2. **(60s) Show the baseline failure mode.** Run an *unprotected* agent (raw screenshot straight to cloud). Show — in your own network inspector or a side panel — that the analyst's name, email, and session ID were sent to the cloud API. This is your "the problem is real" beat.
3. **(90s) Turn on ISRO-Guard.** Re-run the same task. Show the sanitized screenshot (placeholders visible) side-by-side with the original. Show your side-panel decision log: *"Redacted: name, email, session (not task-relevant). Kept: Grid-Zone 12, Download button (task-relevant)."*
4. **(60s) Show the cloud plan + policy gate.** Display the abstract action the cloud returned, then show the local policy engine's allow decision (or, better, script one adversarial step where the "cloud" — simulate this if needed — tries something unsafe, and show the local gate blocking it live).
5. **(60s) Show task success.** The click executes; the correct file/chart is retrieved; task completes.
6. **(60–90s) Show your numbers.** One slide: the §5 table, filled in with your own measured values and honest **[TARGET]**/**[MEASURE]** labels, plus the stacked latency bar chart from §12.5.
7. **(30s) Close on the thesis.** *"The cloud can reason, but it never sees raw private state and never directly controls the browser — and we can prove both of those properties, live, on our own test suite."*

### 18.2 Likely judge questions and how to answer them honestly

| Question | Suggested honest answer |
|---|---|
| "Isn't this just PII masking?" | "No — naive masking blacks out the region and the agent loses context. We keep the region visible as a typed placeholder and decide keep-vs-redact based on whether it's relevant to the *current task*, so the agent still understands the page layout." |
| "Did you invent GoClick / this ABI idea?" | "No — GoClick is an existing lightweight grounding model we integrate, and 'available-but-invisible' redaction is an existing technique in recent mobile-agent privacy literature. Our contribution is applying and extending this specifically to browser DOM+screenshot lockstep synchronization and, for ISRO's map-heavy portals, to canvas/WebGL content that DOM-only or mobile-only approaches don't cover." |
| "How do you know your PII detector actually works?" | Show the §12.2 table: your own precision/recall on your own labeled test set, with sample size stated. |
| "What if the cloud model tries to do something malicious?" | Demo the FR-7 policy gate blocking a scripted malicious action live. |
| "What's your resource footprint?" | Show the §12.4 measured RAM/CPU numbers with the test machine spec stated. |
| "Can this scale to production?" | Be honest: "This is a hackathon MVP proving the architecture. Production would need a full RDF-based policy engine, a Chrome Web Store review process, and expanded canvas/WebGL coverage — all of which are on our roadmap, not built yet." |

---

## 19. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Local grounding/embedding model fails to load or is too slow in-browser | Medium | High (blocks demo) | Build the zero-ML fuzzy-match fallback first (§16); treat ML models as an upgrade, not a dependency. |
| Cloud API rate limits / outage during live demo | Medium | High | Pre-record a backup video of a full successful run; test your API key/quota the morning of the demo. |
| PELH/canvas stretch features introduce state-corruption bugs that break the *core* demo | Medium | High | Keep stretch features on a separate branch; only merge into the demo build after dedicated regression testing; never demo an unmerged branch live. |
| Judges ask for a number you haven't actually measured | High if you skip §12 | Medium–High (credibility) | Build the evaluation harness (Stage 7) before demo polish, not after. |
| Portal (Bhuvan/MOSDAC) changes layout or is unreachable on demo day (network/venue issues) | Medium | High | Always have the self-hosted `fixtures/mock-portal` as your primary demo target; treat the real portal as a bonus "look, it works on the real thing too" moment. |
| Over-claiming a citation that a judge happens to know is wrong | Low–Medium | High (credibility) | Use §14 before finalizing any slide with a number or a "we invented X" claim. |

---

## 20. Proof-of-Work Deliverables Checklist

Prepare all of these — this is what turns a live demo into a *submission* a jury can evaluate after the fact:

- [ ] Public/shared code repository matching the structure in §17, with a clear README (setup + run instructions).
- [ ] `eval/dataset/` — your labeled test set (screenshots + DOM snapshots + ground-truth sensitive-region annotations).
- [ ] `eval/run_eval.py` output — a generated report with the §5 table filled in with real numbers.
- [ ] A short (2–4 min) screen-recorded video of the full demo flow (§18.1), as a fallback for live-demo failure.
- [ ] The 5-slide SIH submission deck (see §21-style mapping below), each slide's numbers traceable to §12 or §14.
- [ ] A one-page "What we did NOT build / limitations" slide or appendix — judges consistently reward teams that are precise about scope.
- [ ] This PRD itself, included in the repo as your design record.

**5-slide mapping (for the official SIH template):**
1. Team + Problem Statement → §2
2. Proposed Solution & Architecture → §6, §7
3. Technical Stack & Pipeline → §8, §16
4. Genuinely Different USPs (correctly scoped per §14.3) → §14.3, plus FR-3/FR-4/FR-7 as your three defensible pillars
5. Feasibility, Roadmap & Benchmarks → §12, §15, §19

---

## 21. Team Roles (RACI) — adapt names/count to your team size

| Workstream | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| Extension shell + capture (Stage 0–1) | Dev A | Team Lead | — | Whole team |
| DMPR + redaction (Stage 2–4) | Dev B | Team Lead | Dev A (for DOM access) | Whole team |
| Policy engine + grounding (Stage 5–6) | Dev C | Team Lead | Dev B (for placeholder schema) | Whole team |
| Evaluation harness + numbers (Stage 7) | Dev D | Team Lead | All devs (for log format) | Whole team, esp. before deck finalization |
| Slides + citation integrity (§14) | Non-coding member / whole team | Team Lead | All devs | Whole team |
| Demo rehearsal + backup video | Whole team | Team Lead | — | — |

---

## 22. Appendix A: Glossary

| Term | Meaning |
|---|---|
| CUA | Computer-Using Agent — an AI that perceives and operates a computer/browser UI |
| VLM | Vision-Language Model — reasons over image + text jointly |
| PII | Personally Identifiable Information |
| DOM | Document Object Model — the structural tree representation of a webpage |
| DMPR | Dual-Modal Privacy Recognition — this project's term for detecting sensitive data in both DOM and visual channels |
| ABI | "Available-But-Invisible" redaction — placeholder-based redaction that preserves layout awareness (term from existing published research — see §14.3, not coined by this project) |
| BDI | Belief-Desire-Intention — a symbolic agent-reasoning framework used here as a conceptual model for the policy engine |
| Lockstep sync | This project's mechanism for keeping DOM-based and screenshot-based redaction consistent via `getBoundingClientRect()` |
| Grounding | Mapping a natural-language instruction/description to an exact UI element or coordinate |
| pHash | Perceptual Hash — a compact image fingerprint used to check whether two screenshots represent visually "the same" state |
| PELH | Parallel Exploratory Latency Hiding — using cloud "thinking time" to speculatively explore likely next actions locally |
| MV3 | Chrome Extension Manifest V3 — the current Chromium extension architecture with isolated worlds/service workers |

---

## 23. Appendix B: Reference List (with integrity flags)

Use this instead of the earlier bibliography. Flags: **V** = Verified in this review, **U** = Unverified/needs your own check, **C** = Confirmed incorrect as previously cited, requiring correction.

1. **[V]** OSWorld — "Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments" (2024).
2. **[V]** GoClick — "Lightweight Element Grounding Model for Autonomous GUI Interaction" (2026) — 230M params, encoder-decoder, on-device/device-cloud collaboration design confirmed.
3. **[V]** GUIGuard / GUIGuard-Bench — "Toward a General Framework for Privacy-Preserving GUI Agents" (Jan 2026) — three-stage framework, 630 trajectories / 13,830 screenshots, 13.3% (Android) / 1.4% (PC) SOTA strict-match figures confirmed.
4. **[V]** MobileExplorer — "Accelerating On-Device Inference for Mobile GUI Agents via Online Exploration" (2026) — 23% latency reduction, up to 5% success-rate improvement confirmed; specific 39.7%/50.9% figures **[U]**.
5. **[V]** AgentDAM — "Privacy Leakage Evaluation for Autonomous Web Agents" (Meta FAIR, NeurIPS 2025) — data-minimization benchmark confirmed; specific "64.6% leakage rate" figure **[U]**.
6. **[V]** "Anonymization-Enhanced Privacy Protection for Mobile GUI Agents: Available but Invisible" (2026) — confirms "ABI" is existing prior art, not a novel team contribution.
7. **[C]** CORE — a real paper exists ("Reducing UI Exposure in Mobile Agents via Collaboration Between Cloud and Local LLMs"), but the previously cited AndroidLab figures (37.76% / 34.96%, Gemma-2-9B) do not match the paper's actual reported figures (29.97% reduction / 3.06-pt drop with Qwen2.5-7B on AndroidLab; 55.6% reduction / 4.9-pt drop with Gemma2-9B on the *different* DroidTask dataset). Correct before use.
8. **[U]** "On-Device LLM Deployment and Overhead Analysis" (previously cited as a CORE technical appendix; 141.04s/step, 6.9–7.8GB RAM) — not located; recommend measuring your own local-7B-model baseline instead of citing this.
9. **[U]** All remaining original citations (Chromium MV3 architecture docs, Transformers.js/ONNX Runtime Web guides, AAMAS BDI proceedings reference, SOUPS fine-print-injection reference, CUPA/PKG references, ISRO portal citations) — not individually re-verified in this pass; spot-check each before it appears on a judge-facing slide.

---

*End of Master PRD. Treat §14 as a living checklist — update it the moment your team independently verifies or measures a number, and keep every "[TARGET]" honestly labeled until your own §12 evaluation replaces it with a "[MEASURE]"d result.*