/**
 * ISRO-Guard CUA — Background Service Worker
 * Orchestrates the full pipeline: capture → detect → redact → plan → policy → ground → execute
 * Stage 0: skeleton with capture + hardcoded click dispatch wired up.
 * Stages 1–7 will progressively fill in each pipeline stage.
 */

import { detectSensitiveData } from './dmpr/index.js';
import { buildSanitizedPayload } from './redaction/placeholder-map.js';
import { evaluatePolicy } from './policy/engine.js';
import { callCloudPlanner } from './cloud-client.js';
import { TelemetryLogger } from './telemetry-logger.js';

// ─── Message router ───────────────────────────────────────────────────────────
// Content scripts and popup communicate with the SW via chrome.runtime.sendMessage.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => {
      console.error('[SW] Unhandled error in message handler:', err);
      sendResponse({ ok: false, error: err.message });
    });
  return true; // keep channel open for async sendResponse
});

/**
 * Central dispatcher.
 * @param {{ type: string, payload: any }} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<any>}
 */
async function handleMessage(message, sender) {
  const { type, payload } = message;

  switch (type) {
    case 'CAPTURE_AND_RUN':
      return runPipeline(payload.task, sender.tab.id);

    case 'CAPTURE_ONLY':
      return captureTab(sender.tab.id);

    case 'HARDCODED_CLICK':
      // Stage-0 exit test: click a known element by selector on the active tab.
      return dispatchHardcodedClick(sender.tab.id, payload.selector);

    case 'GET_LOG':
      return TelemetryLogger.getAll();

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

// ─── Stage-0 primitives ───────────────────────────────────────────────────────

/**
 * Capture a screenshot of the visible tab.
 * Returns { stepId, screenshotDataUrl, timestamp }.
 */
async function captureTab(tabId) {
  const stepId = generateStepId();
  const timestamp = Date.now();

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(
    null, // current window
    { format: 'png', quality: 100 }
  );

  TelemetryLogger.record(stepId, 'capture', { tabId, timestamp, ok: true });
  return { stepId, screenshotDataUrl, timestamp };
}

/**
 * Dispatch a click on a known CSS selector in the tab.
 * Stage-0 only — used by the exit-test harness.
 */
async function dispatchHardcodedClick(tabId, selector) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `Element not found: ${sel}` };
      el.click();
      const { x, y, width, height } = el.getBoundingClientRect();
      return { ok: true, selector: sel, bbox: { x, y, width, height } };
    },
    args: [selector]
  });

  const result = results[0]?.result ?? { ok: false, error: 'No result from scripting' };
  TelemetryLogger.record('s-click', 'hardcoded_click', result);
  return result;
}

// ─── Full pipeline (stages 1–7 will flesh this out) ──────────────────────────

/**
 * Full agent pipeline. Called when the user submits a task from the popup.
 * At Stage 0 this is a stub; each stage will replace the stub sections.
 *
 * @param {string} task   Natural-language task from the user.
 * @param {number} tabId  Chrome tab ID.
 */
async function runPipeline(task, tabId) {
  const stepId = generateStepId();
  const timings = {};

  // ── 1. Capture ──────────────────────────────────────────────────────────────
  let t = now();
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  timings.capture = now() - t;

  // Request DOM snapshot from content script
  const domSnapshot = await sendToContentScript(tabId, { type: 'GET_DOM_SNAPSHOT', stepId });

  // ── 2. Detect (DMPR) ────────────────────────────────────────────────────────
  t = now();
  // Stage 2 will implement this; stub returns empty detections.
  const detections = await detectSensitiveData(domSnapshot, null /* imageData — Stage 3 */);
  timings.detect = now() - t;

  // ── 3. Redact ───────────────────────────────────────────────────────────────
  t = now();
  // Stage 2–4 will implement this; stub passes through unchanged.
  const { sanitizedDom, sanitizedScreenshot, placeholderMap } =
    await buildSanitizedPayload(domSnapshot, screenshotDataUrl, detections, task);
  timings.redact = now() - t;

  // ── 4. Cloud plan ────────────────────────────────────────────────────────────
  t = now();
  // Stage 1 will wire this up properly; stub returns null.
  let cloudResponse = null;
  try {
    cloudResponse = await callCloudPlanner(task, sanitizedDom, sanitizedScreenshot, stepId);
  } catch (err) {
    console.warn('[SW] Cloud planner unavailable (Stage 0 stub):', err.message);
  }
  timings.network = now() - t;

  // ── 5. Policy gate ───────────────────────────────────────────────────────────
  t = now();
  let policyResult = { result: 'allow', ruleFired: null }; // default allow until Stage 5
  if (cloudResponse?.actions?.length) {
    policyResult = evaluatePolicy(cloudResponse.actions[0], placeholderMap);
  }
  timings.policy = now() - t;

  // ── 6. Ground + Execute ──────────────────────────────────────────────────────
  let outcome = 'no_action';
  if (policyResult.result === 'allow' && cloudResponse?.actions?.length) {
    t = now();
    const groundResult = await sendToContentScript(tabId, {
      type: 'GROUND_AND_EXECUTE',
      action: cloudResponse.actions[0],
      placeholderMap,
      stepId
    });
    timings.ground = groundResult.groundMs ?? 0;
    timings.execute = groundResult.executeMs ?? 0;
    outcome = groundResult.ok ? 'success' : 'ground_fail';
  }

  // ── 7. Log ───────────────────────────────────────────────────────────────────
  TelemetryLogger.record(stepId, 'full_step', {
    task, timings, detections,
    policyDecision: policyResult,
    outcome
  });

  return { stepId, timings, policyResult, outcome };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _stepCounter = 0;
function generateStepId() {
  _stepCounter += 1;
  return `s-${String(_stepCounter).padStart(4, '0')}`;
}

function now() { return performance.now(); }

/**
 * Send a message to the content script running in a specific tab
 * and wait for the response.
 */
function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}
