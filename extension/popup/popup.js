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
// BUG-2/3 FIX: runTask() returns { taskId, finalOutcome, steps, lastStep }.
// The popup previously read result.stepId and result.outcome which are on
// lastStep, not on the top-level object.  We now handle both shapes.

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

    // result shape: { taskId, finalOutcome, steps, lastStep }
    // lastStep shape: { stepId, outcome, error?, timings }
    const lastStep = result?.lastStep ?? result;  // graceful fallback for old shape
    const outcome  = result?.finalOutcome ?? lastStep?.outcome ?? result?.outcome;
    const stepId   = lastStep?.stepId ?? result?.stepId ?? result?.taskId ?? '?';
    const errMsg   = lastStep?.error  ?? result?.error;

    _stepCount += result?.steps?.length ?? 1;
    stepCounter.textContent = `${_stepCount} step${_stepCount !== 1 ? 's' : ''}`;

    if (outcome === 'success') {
      logEntry('success', `✓ Step ${stepId} succeeded`);
    } else if (outcome === 'task_complete') {
      logEntry('success', `✓ Task complete (${stepId})`);
    } else if (outcome === 'cloud_error') {
      logEntry('error', `✗ Cloud error on ${stepId}: ${errMsg ?? '(see SW console for details)'}`);
    } else if (outcome === 'policy_block') {
      logEntry('block', `✗ Policy blocked on ${stepId}`);
    } else if (outcome === 'ground_fail' || outcome === 'ground_low_confidence') {
      logEntry('warn', `⚠ Grounding failed on ${stepId}: ${errMsg ?? outcome}`);
    } else {
      // Generic fallback — show whatever we got
      logEntry('warn', `Step ${stepId}: outcome = ${outcome ?? '(none)'}${errMsg ? ' — ' + errMsg : ''}`);
    }

    if (lastStep?.timings) {
      const parts = Object.entries(lastStep.timings).map(([k, v]) => `${k}:${Math.round(v)}ms`);
      logEntry('info', `Timings — ${parts.join(' | ')}`);
    }

    setStatus(outcome === 'success' || outcome === 'task_complete' ? 'ok' : 'error');

  } catch (err) {
    logEntry('error', `✗ Error: ${err.message}`);
    setStatus('error');
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = '▶ Run Task';
  }
});

// BUG-3 FIX: Listen for per-step live updates from the service worker.
// This fires for each step as it completes, giving real-time feedback.
chrome.runtime.onMessage.addListener((message) => {
  // ── Per-step live status updates ─────────────────────────────────────────
  if (message.type === 'PIPELINE_STATUS' && message.result) {
    const { stepId, outcome, error: stepErr } = message.result;
    if (!stepId) return;
    if (outcome === 'success') {
      logEntry('success', `  → ${stepId}: success`);
    } else if (outcome === 'cloud_error') {
      logEntry('error', `  → ${stepId}: cloud_error — ${stepErr ?? '(check SW console)'}`);
    } else if (outcome && outcome !== 'no_action') {
      logEntry('warn', `  → ${stepId}: ${outcome}${stepErr ? ' — ' + stepErr : ''}`);
    }
  }

  // ── Stage 6: Policy gate asks user to confirm a high-risk action ──────────
  if (message.type === 'ASK_USER_CONFIRM') {
    const target = message.action?.target_text ?? message.action?.target_placeholder ?? '(unknown)';
    logEntry('warn',
      `⚠ Policy: confirmation required for "${target.slice(0, 40)}" — ` +
      `${message.message ?? 'high-risk placeholder'}`
    );
    // Surface a small in-popup confirm strip (non-blocking — user can dismiss)
    const strip = document.createElement('div');
    strip.style.cssText =
      'background:#1e293b;border:1px solid #f59e0b;border-radius:5px;padding:8px 10px;' +
      'margin:6px 0;font-size:11px;color:#fbbf24;display:flex;gap:8px;align-items:center;';
    strip.innerHTML =
      `<span style="flex:1">Confirm: click <b>${escapeHtml(target.slice(0,35))}</b>?</span>` +
      `<button id="confirm-yes-${message.stepId}" style="padding:3px 10px;background:#2563eb;` +
      `color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">Allow</button>` +
      `<button id="confirm-no-${message.stepId}" style="padding:3px 10px;background:#374151;` +
      `color:#94a3b8;border:none;border-radius:4px;cursor:pointer;font-size:11px;">Block</button>`;
    agentLog.appendChild(strip);
    agentLog.scrollTop = agentLog.scrollHeight;

    strip.querySelector(`#confirm-yes-${message.stepId}`)?.addEventListener('click', () => {
      strip.remove();
      chrome.runtime.sendMessage({ type: 'USER_CONFIRMED', stepId: message.stepId, confirmed: true });
      logEntry('allow', `  User confirmed action on ${message.stepId}`);
    });
    strip.querySelector(`#confirm-no-${message.stepId}`)?.addEventListener('click', () => {
      strip.remove();
      chrome.runtime.sendMessage({ type: 'USER_CONFIRMED', stepId: message.stepId, confirmed: false });
      logEntry('block', `  User rejected action on ${message.stepId}`);
    });
  }

  // ── Stage 6: Low-confidence grounding warning ─────────────────────────────
  if (message.type === 'GROUND_LOW_CONFIDENCE') {
    const target = message.action?.target_text ?? message.action?.target_placeholder ?? '(unknown)';
    const pct    = Math.round((message.confidence ?? 0) * 100);
    logEntry('warn',
      `⚠ Grounding: low confidence ${pct}% for "${target.slice(0, 35)}" — ` +
      `step ${message.stepId} paused for review`
    );
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

const apiModelInput = document.getElementById('api-model');

// Default model IDs shown per provider
const PROVIDER_DEFAULTS = {
  groq:      'qwen/qwen3.6-27b',
  anthropic: 'claude-opus-4-5',
  openai:    'gpt-4o',
  stub:      ''
};

// Load saved settings on open
chrome.storage.local.get(['apiProvider', 'apiModel', 'privacyEnabled', 'confidenceThreshold'], items => {
  if (items.apiProvider) {
    apiProvider.value = items.apiProvider;
    updateProviderUI(items.apiProvider);
  }
  if (items.apiModel && apiModelInput) apiModelInput.value = items.apiModel;
  privacyToggle.checked = items.privacyEnabled !== false;
  if (items.confidenceThreshold !== undefined) {
    confidenceInput.value = String(items.confidenceThreshold);
  }
  chrome.storage.local.get(['apiKey'], k => {
    if (k.apiKey) {
      apiStatus.textContent = '✓ API key stored';
      apiStatus.className = 'api-status ok';
    }
  });
});

// BUG-4 FIX: Ping the SW for the current config state when the popup opens.
// This surfaces misconfigurations (missing key, wrong provider) immediately.
chrome.runtime.sendMessage({ type: 'PING_CONFIG' }).then(cfg => {
  if (!cfg) return;
  const line = `Config: provider=${cfg.apiProvider ?? 'none'} key=${cfg.hasApiKey ? cfg.apiKeyPrefix : 'MISSING'}`;
  console.info('[Popup]', line);
  if (!cfg.hasApiKey && cfg.apiProvider !== 'stub') {
    logEntry('warn', `⚠ No API key in storage — will use stub. Open Settings and save your key.`);
  }
}).catch(() => {});

function updateProviderUI(provider) {
  const isStub = provider === 'stub';
  document.getElementById('api-key-field').style.display   = isStub ? 'none' : '';
  const modelField = document.getElementById('api-model-field');
  if (modelField) modelField.style.display = isStub ? 'none' : '';
  // Pre-fill the model placeholder with the provider default
  if (apiModelInput && !apiModelInput.value) {
    apiModelInput.placeholder = PROVIDER_DEFAULTS[provider] ?? '';
  }
}

// Show/hide key + model fields based on provider
apiProvider.addEventListener('change', () => {
  updateProviderUI(apiProvider.value);
});

saveSettingsBtn.addEventListener('click', () => {
  const provider   = apiProvider.value;
  const key        = apiKeyInput.value.trim();
  const modelId    = apiModelInput?.value.trim() || PROVIDER_DEFAULTS[provider] || '';
  const privacy    = privacyToggle.checked;
  const threshold  = parseFloat(confidenceInput.value);

  if (isNaN(threshold) || threshold < 0 || threshold > 1) {
    apiStatus.textContent = 'Confidence threshold must be 0.00–1.00';
    apiStatus.className   = 'api-status error';
    return;
  }

  const toStore = {
    apiProvider:         provider,
    apiModel:            modelId,
    privacyEnabled:      privacy,
    confidenceThreshold: threshold
  };
  if (key) toStore.apiKey = key;

  chrome.storage.local.set(toStore, () => {
    apiStatus.textContent = `✓ Saved (${provider}${modelId ? ' · ' + modelId : ''})`;
    apiStatus.className   = 'api-status ok';
    apiKeyInput.value     = ''; // clear the field after saving
    setTimeout(() => { apiStatus.textContent = ''; }, 4000);
  });
});

clearKeyBtn.addEventListener('click', () => {
  chrome.storage.local.remove(['apiKey'], () => {
    apiStatus.textContent = 'API key cleared.';
    apiStatus.className   = 'api-status error';
    apiKeyInput.value     = '';
  });
});

// Force-reload config from default-config.js without reloading the extension.
document.getElementById('reload-config-btn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'FORCE_RELOAD_CONFIG' }).then(r => {
    apiStatus.textContent = r?.ok
      ? `✓ Config reloaded (${(r.keys ?? []).join(', ')})`
      : '✗ Reload failed';
    apiStatus.className = r?.ok ? 'api-status ok' : 'api-status error';
    // Refresh the UI to show new values
    chrome.storage.local.get(['apiProvider', 'apiModel'], items => {
      if (items.apiProvider) { apiProvider.value = items.apiProvider; updateProviderUI(items.apiProvider); }
      if (items.apiModel && apiModelInput) apiModelInput.value = items.apiModel;
    });
    setTimeout(() => { apiStatus.textContent = ''; }, 4000);
  }).catch(err => {
    apiStatus.textContent = `✗ ${err.message}`;
    apiStatus.className   = 'api-status error';
  });
});

// ─── Open mock portal ─────────────────────────────────────────────────────────

openMockPortalBtn.addEventListener('click', () => {
  // Opens the bundled mock portal fixture in a new tab.
  const url = chrome.runtime.getURL('../../fixtures/mock-portal/index.html');
  // Fallback: the fixture is served as a file:// URL during local testing.
  chrome.tabs.create({ url });
});
