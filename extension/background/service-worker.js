/**
 * ISRO-Guard CUA — Background Service Worker
 * Stage 1: Naive end-to-end agent.
 *
 * Bug fixes in this revision:
 *   BUG-1  onInstalled always overwrites ALL keys on every reload/update so
 *          stale storage values never block the Groq config from loading.
 *   BUG-2  runTask() now returns { taskId, finalOutcome, steps, lastStep } so
 *          the popup can read stepId/outcome/error/timings from lastStep.
 *   BUG-3  PIPELINE_STATUS broadcasts now carry the full step result so the
 *          popup can display per-step progress live.
 *   BUG-4  PING_CONFIG and FORCE_RELOAD_CONFIG messages added so the popup
 *          can verify and repair storage without reloading the extension.
 *   BUG-5  Every cloud_error now logs the real underlying error message into
 *          the telemetry entry so the Decision Log shows the actual cause.
 */

import { detectSensitiveData }       from './dmpr/index.js';
import { buildSanitizedPayload }     from './redaction/placeholder-map.js';
import { scoreTaskRelevance }        from './redaction/task-relevance.js';
import { paintRedactionBoxes }       from './redaction/screenshot-painter.js';
import { evaluatePolicy }            from './policy/engine.js';
import { callCloudPlanner }          from './cloud-client.js';
import { TelemetryLogger }           from './telemetry-logger.js';
import { DEFAULT_CONFIG }            from './default-config.js';
import { resolveToken }              from './redaction/placeholder-map.js';

// ─── Config seeding ───────────────────────────────────────────────────────────
// BUG-1 FIX: Always overwrite every key on install OR update.
// Development reloads fire reason='update'. If we only seed on install,
// a single bad/stale storage state persists forever across dev reloads.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  chrome.storage.local.set(DEFAULT_CONFIG, () => {
    console.info('[SW] Config seeded from default-config.js:', Object.keys(DEFAULT_CONFIG).join(', '));
  });
});

// Also seed on SW startup (handles the case where onInstalled already fired
// before this version of the SW was loaded).
chrome.storage.local.get(['apiProvider'], items => {
  if (!items.apiProvider) {
    chrome.storage.local.set(DEFAULT_CONFIG, () =>
      console.info('[SW] Config seeded on startup (was missing)')
    );
  }
});

const MAX_STEPS = 10;

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => {
      console.error('[SW] Unhandled error in handleMessage:', err);
      sendResponse({ ok: false, error: err.message });
    });
  return true; // keep async sendResponse channel open
});

async function handleMessage(message, sender) {
  const { type, payload } = message;

  // Resolve the active tab ID (popup sends no sender.tab)
  let tabId = sender.tab?.id ?? null;
  if (tabId == null && type !== 'GET_LOG' && type !== 'CLEAR_LOG'
      && type !== 'PING_CONFIG' && type !== 'FORCE_RELOAD_CONFIG') {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) throw new Error('No active tab found.');
    tabId = active.id;
  }

  switch (type) {
    case 'CAPTURE_AND_RUN':
      return runTask(payload.task, tabId);

    case 'CAPTURE_ONLY':
      return captureTab(tabId);

    case 'HARDCODED_CLICK':
      return dispatchHardcodedClick(tabId, payload.selector);

    case 'GET_LOG':
      return TelemetryLogger.getAll();

    case 'CLEAR_LOG':
      return TelemetryLogger.clear();

    // BUG-4 FIX: Let the popup verify what is actually in storage.
    // Returns the config without the API key value (key presence is boolean).
    case 'PING_CONFIG': {
      return new Promise(resolve => {
        chrome.storage.local.get(['apiProvider', 'apiModel', 'apiKey'], items => {
          resolve({
            apiProvider: items.apiProvider ?? null,
            apiModel:    items.apiModel    ?? null,
            hasApiKey:   !!items.apiKey,
            // Prefix of key for debugging — NEVER the full key
            apiKeyPrefix: items.apiKey ? items.apiKey.slice(0, 8) + '…' : null
          });
        });
      });
    }

    // BUG-4 FIX: Force-overwrite storage from DEFAULT_CONFIG on demand.
    case 'FORCE_RELOAD_CONFIG': {
      return new Promise(resolve => {
        chrome.storage.local.set(DEFAULT_CONFIG, () => {
          console.info('[SW] Config force-reloaded from default-config.js');
          resolve({ ok: true, keys: Object.keys(DEFAULT_CONFIG) });
        });
      });
    }

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

// ─── Primitives ───────────────────────────────────────────────────────────────

async function captureTab(tabId) {
  const stepId    = generateStepId();
  const timestamp = Date.now();
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  TelemetryLogger.record(stepId, 'capture', { tabId, timestamp, ok: true });
  return { stepId, screenshotDataUrl, timestamp };
}

async function dispatchHardcodedClick(tabId, selector) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: sel => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `Element not found: ${sel}` };
      el.click();
      const { x, y, width, height } = el.getBoundingClientRect();
      return { ok: true, selector: sel, bbox: { x, y, width, height } };
    },
    args: [selector]
  });
  const result = results[0]?.result ?? { ok: false, error: 'No scripting result' };
  TelemetryLogger.record('s-click', 'hardcoded_click', result);
  return result;
}

// ─── Multi-step task loop ─────────────────────────────────────────────────────

/**
 * BUG-2 FIX: Return shape now includes `lastStep` so the popup can read
 * the canonical { stepId, outcome, error, timings } it always expected.
 *
 * Return shape:
 * {
 *   taskId:       string,
 *   finalOutcome: string,
 *   steps:        StepResult[],
 *   lastStep:     StepResult   ← popup reads this
 * }
 */
async function runTask(task, tabId) {
  const taskId  = generateStepId();
  const stepLog = [];
  let   stepIdx = 0;

  broadcastStatus({ type: 'TASK_STARTED', taskId, task });

  while (stepIdx < MAX_STEPS) {
    stepIdx++;
    const stepResult = await runSingleStep(task, tabId, taskId, stepIdx);
    stepLog.push(stepResult);

    // BUG-3 FIX: Broadcast full step result so popup live-log shows real data.
    broadcastStatus({ type: 'STEP_DONE', taskId, stepIndex: stepIdx, result: stepResult });

    if (stepResult.outcome === 'task_complete')       break;
    if (stepResult.outcome === 'cloud_error')         break;
    if (stepResult.outcome === 'policy_block')        break;
    if (stepResult.outcome === 'ground_fail')         break;
    if (stepResult.outcome === 'wait')                break;
    if (stepResult.outcome === 'ground_low_confidence') break;
    // 'success' → continue to next step
  }

  const lastStep    = stepLog.at(-1) ?? { stepId: taskId, outcome: 'no_action', timings: {} };
  const finalOutcome = lastStep.outcome;

  broadcastStatus({ type: 'TASK_DONE', taskId, finalOutcome, steps: stepLog.length });

  // BUG-2 FIX: Return lastStep at the top level so popup code works without
  // needing to know about the steps array.
  return { taskId, finalOutcome, steps: stepLog, lastStep };
}

/**
 * One pipeline step: capture → visual+DOM detect → score relevance →
 * redact DOM → paint screenshot → pre-send scan → cloud → policy → ground → execute.
 * Stages 2–4 fully wired. Returns { stepId, outcome, timings }.
 */
async function runSingleStep(task, tabId, taskId, stepIndex) {
  const stepId   = `${taskId}-${String(stepIndex).padStart(2, '0')}`;
  const timings  = {};
  let   outcome  = 'no_action';
  let   detections   = [];
  let   policyResult = { result: 'allow', ruleFired: null };

  try {
    // ── 1. Capture (FR-1) ──────────────────────────────────────────────────────
    let t = now();
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    const domMsg            = await sendToContentScript(tabId, { type: 'GET_DOM_SNAPSHOT', stepId });
    const domSnapshot       = domMsg?.snapshot ?? domMsg;
    timings.capture         = round(now() - t);

    if (!domSnapshot) throw new Error('DOM snapshot null — is the content script loaded on this tab?');

    // ── 2. Dual-modal detect: DOM + visual OCR (FR-2) ─────────────────────────
    // OCR is the mandatory on-device visual perception channel (SIH26171 PS title).
    t = now();
    detections = await detectSensitiveData(
      domSnapshot,
      screenshotDataUrl,
      domSnapshot.viewport ?? null
    );
    timings.detect = round(now() - t);

    // ── 2b. Lockstep sync: resolve live bboxes for DOM-flagged nodes (FR-3) ───
    if (detections.some(d => d.nodeId)) {
      const lockMsg = await sendToContentScript(tabId, {
        type: 'BUILD_LOCKSTEP_MAP',
        detections: detections.filter(d => d.nodeId)
      });
      if (lockMsg?.ok && lockMsg.detections) {
        // Merge bboxes back into the main detections array
        for (const enriched of lockMsg.detections) {
          const orig = detections.find(
            d => d.nodeId === enriched.nodeId && d.label === enriched.label
          );
          if (orig && enriched.bbox) orig.bbox = enriched.bbox;
        }
      }
    }

    // ── 3. Task-aware relevance scoring (FR-4) ─────────────────────────────────
    t = now();
    scoreTaskRelevance(task, detections, domSnapshot.elements ?? []);
    timings.relevance = round(now() - t);

    // ── 4. Redact DOM + paint screenshot (FR-4 + FR-3) ─────────────────────────
    t = now();
    const { sanitizedDom, placeholderMap } =
      await buildSanitizedPayload(domSnapshot, screenshotDataUrl, detections, task);

    // Paint redaction boxes onto the screenshot bitmap (Stage 3)
    const sanitizedScreenshot = await paintRedactionBoxes(screenshotDataUrl, detections);
    timings.redact = round(now() - t);

    // ── 5. Cloud planner (FR-6) — pre-send scanner is now hard-block ────────────
    t = now();
    let cloudResponse;
    try {
      cloudResponse = await callCloudPlanner(task, sanitizedDom, sanitizedScreenshot, stepId);
    } catch (cloudErr) {
      timings.network = round(now() - t);
      const errMsg = cloudErr.message ?? String(cloudErr);
      console.error('[SW] Cloud planner error on', stepId, '—', errMsg);
      outcome = 'cloud_error';
      await logStep(stepId, task, timings, detections, policyResult, outcome, errMsg);
      return { stepId, outcome, error: errMsg, timings };
    }
    timings.network = round(now() - t);

    // task_complete / wait signals
    const firstAction = cloudResponse.actions?.[0];
    if (!firstAction || firstAction.type === 'task_complete') {
      outcome = 'task_complete';
      await logStep(stepId, task, timings, detections, policyResult, outcome);
      return { stepId, outcome, cloudResponse, timings };
    }
    if (firstAction.type === 'wait') {
      outcome = 'wait';
      await logStep(stepId, task, timings, detections, policyResult, outcome);
      return { stepId, outcome, cloudResponse, timings };
    }

    // ── 6. Policy gate (FR-7) ──────────────────────────────────────────────────
    t = now();
    let pageOrigin = '';
    try { pageOrigin = domSnapshot?.url ? new URL(domSnapshot.url).origin : ''; } catch {}
    policyResult = evaluatePolicy(firstAction, placeholderMap, { pageOrigin });
    timings.policy = round(now() - t);

    if (policyResult.result === 'block') {
      outcome = 'policy_block';
      console.warn('[SW] Policy blocked:', policyResult.message);
      await logStep(stepId, task, timings, detections, policyResult, outcome);
      return { stepId, outcome, policyResult, cloudResponse, timings };
    }
    if (policyResult.result === 'ask_user') {
      // Stage 6: surface confirmation dialog to user via popup
      broadcastStatus({ type: 'ASK_USER_CONFIRM', stepId, action: firstAction,
                        message: policyResult.message });
      outcome = 'policy_ask_user';
      await logStep(stepId, task, timings, detections, policyResult, outcome);
      return { stepId, outcome, policyResult, cloudResponse, timings };
    }

    // ── 7. Ground (FR-8) ───────────────────────────────────────────────────────
    t = now();

    // Stage 6: if the action is a 'type' and the value is a placeholder token,
    // resolve it to the real value locally — never send raw values to the cloud.
    const actionToExecute = { ...firstAction };
    if (actionToExecute.type === 'type' && actionToExecute.value) {
      const maybeToken = actionToExecute.value;
      const realValue  = resolveToken(maybeToken);
      if (realValue) actionToExecute.value = realValue;  // swap placeholder → real value locally
    }

    const groundResult = await sendToContentScript(tabId, {
      type: 'GROUND_ACTION', action: actionToExecute, placeholderMap
    });
    timings.ground = round(now() - t);

    if (!groundResult?.ok) {
      outcome = 'ground_fail';
      await logStep(stepId, task, timings, detections, policyResult, outcome,
        groundResult?.error ?? 'Grounding returned not-ok');
      return { stepId, outcome, groundResult, cloudResponse, timings };
    }
    if (groundResult.needsUserConfirmation) {
      // Stage 6: broadcast low-confidence grounding for user review
      broadcastStatus({ type: 'GROUND_LOW_CONFIDENCE', stepId,
                        confidence: groundResult.confidence, action: actionToExecute });
      outcome = 'ground_low_confidence';
      console.warn('[SW] Low-confidence grounding, confidence:', groundResult.confidence);
      await logStep(stepId, task, timings, detections, policyResult, outcome);
      return { stepId, outcome, groundResult, cloudResponse, timings };
    }

    // ── 8. Execute (FR-8) ──────────────────────────────────────────────────────
    t = now();
    const execResult = await sendToContentScript(tabId, {
      type: 'EXECUTE_ACTION', action: actionToExecute, groundResult
    });
    timings.execute = round(now() - t);

    outcome = execResult?.ok ? 'success' : 'execute_fail';
    await logStep(stepId, task, timings, detections, policyResult, outcome,
      execResult?.ok ? null : (execResult?.error ?? 'Execute returned not-ok'));
    return { stepId, outcome, execResult, groundResult, cloudResponse, timings };

  } catch (err) {
    console.error('[SW] runSingleStep pipeline error on', stepId, '—', err.message);
    outcome = 'pipeline_error';
    await logStep(stepId, task, timings, detections, policyResult, outcome, err.message);
    return { stepId, outcome, error: err.message, timings };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;
function generateStepId() {
  return `s-${String(++_counter).padStart(4, '0')}`;
}

function now()     { return performance.now(); }
function round(ms) { return Math.round(ms * 10) / 10; }

async function logStep(stepId, task, timings, detections, policyDecision, outcome, error = null) {
  const entry = {
    step_id:    stepId,
    timings_ms: timings,
    detections: detections.map(d => ({
      label: d.label, bbox: d.bbox ?? null,
      confidence: d.confidence, redacted: d.redacted, taskRelevant: d.taskRelevant ?? null
    })),
    policy_decision: {
      result: policyDecision.result, rule_fired: policyDecision.ruleFired ?? null
    },
    outcome
  };
  // BUG-5: Always attach the real error string so Decision Log is useful.
  if (error) entry.error = error;
  await TelemetryLogger.record(stepId, 'full_step', entry);
}

function broadcastStatus(data) {
  chrome.runtime.sendMessage({ type: 'PIPELINE_STATUS', ...data }).catch(() => {});
}

function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}
