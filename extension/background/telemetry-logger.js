/**
 * Telemetry Logger — FR-11
 * Records every pipeline step's timing, detections, policy decisions, and outcomes
 * to chrome.storage.local for the evaluation harness (Stage 7).
 *
 * Log schema matches PRD §10.4.
 * Max entries retained in storage: 1000 (oldest entries trimmed).
 */

const STORAGE_KEY = 'isroguard_telemetry';
const MAX_ENTRIES = 1000;

/**
 * Append a log entry to local storage.
 *
 * @param {string} stepId
 * @param {string} event   — 'capture' | 'detect' | 'redact' | 'full_step' | etc.
 * @param {object} data
 */
async function record(stepId, event, data) {
  const entry = {
    step_id: stepId,
    event,
    timestamp: Date.now(),
    ...data
  };

  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY], items => {
      const log = items[STORAGE_KEY] ?? [];
      log.push(entry);
      // Trim oldest entries if over limit
      const trimmed = log.length > MAX_ENTRIES ? log.slice(log.length - MAX_ENTRIES) : log;
      chrome.storage.local.set({ [STORAGE_KEY]: trimmed }, resolve);
    });
  });
}

/**
 * Return all stored telemetry entries.
 * @returns {Promise<Array>}
 */
async function getAll() {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY], items => {
      resolve(items[STORAGE_KEY] ?? []);
    });
  });
}

/**
 * Clear all telemetry (call before a benchmarking run to start fresh).
 * @returns {Promise<void>}
 */
async function clear() {
  return new Promise(resolve => {
    chrome.storage.local.remove([STORAGE_KEY], resolve);
  });
}

export const TelemetryLogger = { record, getAll, clear };
