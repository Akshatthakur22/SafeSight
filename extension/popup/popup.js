/**
 * Popup controller — ISRO-Guard CUA
 * Handles the three-tab UI: Agent (task runner), Decision Log, Settings.
 *
 * Communicates with the background service worker via chrome.runtime.sendMessage.
 * Never reads raw PII values — the placeholder map stays in the background worker.
 */

'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const taskInput          = document.getElementById('task-input');
const runBtn             = document.getElementById('run-btn');
const captureBtn         = document.getElementById('capture-btn');
const clearLogBtn        = document.getElementById('clear-log-btn');
const agentLog           = document.getElementById('agent-log');
const fullLog            = document.getElementById('full-log');
const stepCounter        = document.getElementById('step-counter');
const statusDot          = document.getElementById('status-dot');
const exportLogBtn       = document.getElementById('export-log-btn');

const privacyToggle      = document.getElementById('privacy-toggle');
const apiProvider        = document.getElementById('api-provider');
const apiKeyInput        = document.getElementById('api-key');
const apiStatus          = document.getElementById('api-status');
const saveSettingsBtn    = document.getElementById('save-settings-btn');
const clearKeyBtn        = document.getElementById('clear-key-btn');
const confidenceInput    = document.getElementById('confidence-threshold');
const openMockPortalBtn  = document.getElementById('open-mock-portal');

// ─── Tab switching ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'log') refreshFullLog();
  });
});

// ─── Log helpers ──────────────────────────────────────────────────────────────

let _stepCount = 0;

/**
 * Append an entry to the agent live log.
 * @param {'info'|'success'|'warn'|'error'|'block'|'allow'} level
 * @param {string} text
 */
function logEntry(level, text) {
  const empty = agentLog.querySelector('.empty-log');
  if (empty) empty.remove();

  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const div = document.createElement('div');
  div.className = `log-entry ${level}`;
  div.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(text)}`;
  agentLog.appendChild(div);
  agentLog.scrollTop = agentLog.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setStatus(state) {
  statusDot.className = 'status-dot' + (state === 'ok' ? '' : ` ${state}`);
  statusDot.title = { ok: 'Extension active', warn: 'Warning', error: 'Error' }[state] ?? state;
}

// ─── Run task ─────────────────────────────────────────────────────────────────

runBtn.addEventListener('click', async () => {
  const task = taskInput.value.trim();
  if (!task) { logEntry('warn', 'Please enter a task first.'); return; }

  runBtn.disabled = true;
  runBtn.textContent = '⏳ Running…';
  setStatus('warn');

  logEntry('info', `▶ Task: "${task}"`);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found.');

    logEntry('info', `Tab: ${tab.title?.slice(0, 50)} (${tab.id})`);

    const result = await chrome.runtime.sendMessage({
      type: 'CAPTURE_AND_RUN',
      payload: { task }
    });

    _stepCount++;
    stepCounter.textContent = `${_stepCount} step${_stepCount !== 1 ? 's' : ''}`;

    if (result?.outcome === 'success') {
      logEntry('success', `✓ Step ${result.stepId} succeeded`);
      logEntry('allow', `Policy: ${result.policyResult?.result ?? 'allow'}`);
    } else if (result?.outcome === 'no_action') {
      logEntry('warn', `Step ${result.stepId}: no action (cloud not configured or stub mode)`);
    } else {
      logEntry('warn', `Step ${result?.stepId}: outcome = ${result?.outcome}`);
    }

    if (result?.timings) {
      const t = result.timings;
      const parts = Object.entries(t).map(([k, v]) => `${k}:${Math.round(v)}ms`);
      logEntry('info', `Timings — ${parts.join(' | ')}`);
    }

    setStatus('ok');
  } catch (err) {
    logEntry('error', `✗ Error: ${err.message}`);
    setStatus('error');
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = '▶ Run Task';
  }
});

// ─── Capture only ─────────────────────────────────────────────────────────────

captureBtn.addEventListener('click', async () => {
  logEntry('info', '📷 Capturing screenshot + DOM…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_ONLY', payload: {} });
    if (result?.screenshotDataUrl) {
      logEntry('success', `Capture OK — step ${result.stepId}, ${Math.round(result.screenshotDataUrl.length / 1024)}KB PNG`);
    } else {
      logEntry('warn', 'Capture returned no data.');
    }
  } catch (err) {
    logEntry('error', `Capture failed: ${err.message}`);
  }
});

// ─── Clear log ────────────────────────────────────────────────────────────────

clearLogBtn.addEventListener('click', () => {
  agentLog.innerHTML = '<div class="empty-log">Log cleared.</div>';
  _stepCount = 0;
  stepCounter.textContent = '0 steps';
});

// ─── Full telemetry log ───────────────────────────────────────────────────────

async function refreshFullLog() {
  const entries = await chrome.runtime.sendMessage({ type: 'GET_LOG', payload: {} });
  const el = fullLog;
  if (!entries?.length) {
    el.innerHTML = '<div class="empty-log">No telemetry entries.</div>';
    return;
  }
  el.innerHTML = '';
  for (const entry of entries.slice(-100).reverse()) {
    const div = document.createElement('div');
    div.className = 'log-entry info';
    const ts = new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false });
    const outcome = entry.outcome ?? entry.event;
    const level = outcome === 'success' ? 'success'
                : entry.policyDecision?.result === 'block' ? 'block'
                : 'info';
    div.className = `log-entry ${level}`;
    div.innerHTML = `<span class="ts">${ts}</span>[${escapeHtml(entry.step_id)}] ${escapeHtml(outcome)}`;
    el.appendChild(div);
  }
}

// ─── Export log ───────────────────────────────────────────────────────────────

exportLogBtn.addEventListener('click', async () => {
  const entries = await chrome.runtime.sendMessage({ type: 'GET_LOG', payload: {} });
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `isroguard-telemetry-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Settings ─────────────────────────────────────────────────────────────────

// Load saved settings on open
chrome.storage.local.get(['apiProvider', 'privacyEnabled', 'confidenceThreshold'], items => {
  if (items.apiProvider) apiProvider.value = items.apiProvider;
  privacyToggle.checked = items.privacyEnabled !== false; // default true
  if (items.confidenceThreshold !== undefined) {
    confidenceInput.value = String(items.confidenceThreshold);
  }
  // Don't load the API key into the input — show only a masked placeholder.
  chrome.storage.local.get(['apiKey'], k => {
    if (k.apiKey) {
      apiStatus.textContent = '✓ API key stored';
      apiStatus.className = 'api-status ok';
    }
  });
});

// Show/hide key field based on provider
apiProvider.addEventListener('change', () => {
  document.getElementById('api-key-field').style.display =
    apiProvider.value === 'stub' ? 'none' : '';
});

saveSettingsBtn.addEventListener('click', () => {
  const provider    = apiProvider.value;
  const key         = apiKeyInput.value.trim();
  const privacy     = privacyToggle.checked;
  const threshold   = parseFloat(confidenceInput.value);

  if (isNaN(threshold) || threshold < 0 || threshold > 1) {
    apiStatus.textContent = 'Confidence threshold must be 0.00–1.00';
    apiStatus.className   = 'api-status error';
    return;
  }

  const toStore = { apiProvider: provider, privacyEnabled: privacy, confidenceThreshold: threshold };
  if (key) toStore.apiKey = key;

  chrome.storage.local.set(toStore, () => {
    apiStatus.textContent = '✓ Settings saved';
    apiStatus.className   = 'api-status ok';
    apiKeyInput.value     = ''; // clear the field after saving
    setTimeout(() => { apiStatus.textContent = ''; }, 3000);
  });
});

clearKeyBtn.addEventListener('click', () => {
  chrome.storage.local.remove(['apiKey'], () => {
    apiStatus.textContent = 'API key cleared.';
    apiStatus.className   = 'api-status error';
    apiKeyInput.value     = '';
  });
});

// ─── Open mock portal ─────────────────────────────────────────────────────────

openMockPortalBtn.addEventListener('click', () => {
  // Opens the bundled mock portal fixture in a new tab.
  const url = chrome.runtime.getURL('../../fixtures/mock-portal/index.html');
  // Fallback: the fixture is served as a file:// URL during local testing.
  chrome.tabs.create({ url });
});
