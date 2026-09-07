/**
 * Cloud Planner Client — FR-6
 * Stage 2+: Live VLM call with pre-send scanner hard-block.
 *
 * Security invariants:
 *   1. Pre-send scanner MUST pass before any HTTP call — now a hard block.
 *   2. API key loaded from chrome.storage.local only — never hardcoded.
 *   3. Response schema validator rejects unknown action types and secret patterns.
 *
 * What the cloud receives (Groq / qwen3.6-27b):
 *   - A compact plain-text summary of visible interactive elements (≤500 chars).
 *   - The user's task string.
 *   - NO screenshot (Groq vision not available on this account tier — tested).
 *   - NO raw DOM values — only sanitized element labels from buildCompactUserMessage().
 *
 * Supported providers: 'anthropic', 'openai', 'groq', 'stub'.
 */

import { runPreSendScanner } from './pre-send-scanner.js';

// ─── API config ───────────────────────────────────────────────────────────────

/**
 * Load provider + key from extension storage.
 * Returns null when neither is set (user hasn't configured the popup yet).
 * @returns {Promise<{provider: string, apiKey: string} | null>}
 */
async function loadAPIConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(['apiProvider', 'apiKey', 'apiModel'], items => {
      const provider = items.apiProvider ?? null;
      const hasKey   = !!items.apiKey;

      // Always log what was found so SW DevTools console shows the actual state.
      // Never log the key value itself.
      console.info(
        `[CloudClient] loadAPIConfig → provider="${provider}" ` +
        `hasKey=${hasKey} model="${items.apiModel ?? '(default)'}"`
      );

      if (!provider) {
        resolve(null);
      } else if (provider === 'stub') {
        resolve({ provider: 'stub', apiKey: '', model: null });
      } else if (!hasKey) {
        console.warn('[CloudClient] Provider set but no API key in storage — falling back to stub.');
        resolve(null);
      } else {
        resolve({ provider, apiKey: items.apiKey, model: items.apiModel ?? null });
      }
    });
  });
}

// ─── Stub planner ─────────────────────────────────────────────────────────────

/**
 * Stateful stub that returns a realistic 5-step action sequence for the mock
 * portal task "Find and download the seasonal vegetation index for Grid-Zone 12".
 *
 * Each call to getStubResponse() advances an internal per-stepId counter so that
 * successive pipeline steps get the correct next action.
 *
 * Step sequence:
 *   1. select Grid-Zone 12 in the dropdown
 *   2. select "Seasonal Vegetation Index" dataset type
 *   3. click the Search button
 *   4. click the first Download button in the results
 *   5. signal task_complete
 */
const _stubState = new Map(); // taskPrefix → stepIndex

function getStubResponse(stepId) {
  // Extract the task prefix (e.g. "s-0001" from "s-0001-03")
  const prefix = stepId.replace(/-\d+$/, '');
  const idx    = (_stubState.get(prefix) ?? 0);
  _stubState.set(prefix, idx + 1);

  const SEQUENCE = [
    // Step 0: select Grid-Zone 12
    {
      reasoning_summary: 'I can see a Grid Zone dropdown. Selecting Grid-Zone 12 first.',
      actions: [{
        type: 'click',
        target_text: 'Grid-Zone 12',
        target_placeholder: null,
        value: null
      }]
    },
    // Step 1: select dataset type
    {
      reasoning_summary: 'Grid-Zone 12 is selected. Now selecting Seasonal Vegetation Index.',
      actions: [{
        type: 'click',
        target_text: 'Seasonal Vegetation Index',
        target_placeholder: null,
        value: null
      }]
    },
    // Step 2: click Search
    {
      reasoning_summary: 'Parameters set. Clicking Search to retrieve available datasets.',
      actions: [{
        type: 'click',
        target_text: 'Search',
        target_placeholder: null,
        value: null
      }]
    },
    // Step 3: click the first Download button in results
    {
      reasoning_summary: 'Results are visible. Clicking Download for the first available dataset.',
      actions: [{
        type: 'click',
        target_text: 'Download',
        target_placeholder: null,
        value: null
      }]
    },
    // Step 4: task complete
    {
      reasoning_summary: 'Download initiated successfully. Task complete.',
      actions: [{ type: 'task_complete', target_text: null, target_placeholder: null, value: null }]
    }
  ];

  const entry = SEQUENCE[Math.min(idx, SEQUENCE.length - 1)];
  return {
    step_id: stepId,
    reasoning_summary: entry.reasoning_summary,
    actions: entry.actions
  };
}

// ─── Request builder ──────────────────────────────────────────────────────────

/**
 * Minimal action schema sent to and expected from the cloud planner.
 * Reasoning summary is REMOVED — it was never used by the extension and
 * added tokens to the response, eating into the OTPM budget.
 *
 * {
 *   "step_id": "s-0001-01",
 *   "actions": [
 *     { "type": "click|type|scroll|task_complete", "target_text": "Search" }
 *   ]
 * }
 */

/**
 * System prompt — minimal, format-only.
 * Shows exactly two output examples. No schema explanation, no pipe-separated
 * alternatives, no prose. The model's only job is to pick a label and format it.
 *
 * Observed think block with this prompt: 200–800 tokens (within 1000 OTPM limit).
 * JSON output: ~15 tokens.
 */
const SYSTEM_PROMPT =
`Output JSON only: {"actions":[{"type":"click","target_text":"LABEL"}]}
Replace LABEL with the element to click.
For task complete: {"actions":[{"type":"task_complete","target_text":null}]}
No other text. No explanation.`;

/**
 * Build a compact, state-descriptive user message.
 *
 * The user message tells the model the task and lists the interactive elements
 * by their visible labels only. The model picks one label — grounding resolves
 * the rest locally.
 *
 * Key constraint: keep the message under ~200 chars so the model's think block
 * stays under the 1000-token OTPM ceiling.
 */
function buildCompactUserMessage(stepId, task, domSnapshot) {
  const ACTIONABLE  = new Set(['button', 'a', 'input', 'select', 'textarea']);
  const SKIP_TYPES  = new Set(['date', 'time', 'datetime-local', 'month', 'week',
                                'hidden', 'submit', 'reset', 'color', 'range']);
  const elements = (domSnapshot?.elements ?? [])
    .filter(el => {
      if (el.hidden || el.visible === false) return false;
      if (!ACTIONABLE.has(el.tag)) return false;
      if (el.tag === 'input' && SKIP_TYPES.has(el.type ?? '')) return false;
      return true;
    })
    .slice(0, 5)   // 5 elements max — fewer = shorter think block
    .map(el => {
      const rawLabel = el.tag === 'select'
        ? (el.value?.trim() || el.ariaLabel || el.name || el.id || '')
        : (el.textContent?.trim() || el.value?.trim() || el.ariaLabel || el.placeholder || el.name || el.id || '');
      const label = rawLabel.slice(0, 20);  // 20 chars max per label
      return label ? label : null;
    })
    .filter(Boolean);

  const pageTitle = (domSnapshot?.title ?? 'page').slice(0, 30);
  const shortTask = task.slice(0, 80);

  // Format: "Task. Page: X. Click one of: A, B, C"
  return `Task: ${shortTask} Page: ${pageTitle} Elements: ${elements.join(', ')}`.slice(0, 300);
}

/**
 * Build the HTTP request for the configured provider.
 * NOTE: _screenshotDataUrl is accepted but intentionally NOT sent for Groq
 * (vision not available on this account tier — confirmed by live API testing).
 * The cloud receives only the compact text summary from buildCompactUserMessage.
 * For Anthropic/OpenAI providers the screenshot is also not sent in the current
 * implementation (text-only planner for all providers at this stage).
 */
function buildRequest(config, task, sanitizedDom, _screenshotDataUrl, stepId) {
  const { provider, model } = config;

  const userText = buildCompactUserMessage(stepId, task, sanitizedDom);

  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: {
        model: model ?? 'claude-opus-4-5',
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userText }]
      }
    };
  }

  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: model ?? 'gpt-4o',
        max_tokens: 512,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userText }
        ]
      }
    };
  }

  // ── Groq — qwen/qwen3.6-27b ───────────────────────────────────────────────
  // OTPM limit: 1000 tokens/minute (confirmed from x-ratelimit-limit-tokens header
  // and from 429 error messages: "Limit 1000, Requested N").
  // Qwen3's <think> block uses 100–500 tokens; JSON output is ~40 tokens.
  // Setting max_tokens to the OTPM limit (1000) ensures the model can always
  // finish its think block and emit the JSON.  The 429 retry handler manages
  // the rare case where a previous call in the same minute used the budget.
  // Empirically verified: single calls use 119–491 tokens (finish=stop) when
  // OTPM window has budget. Never set below 500 — the think block can reach 490t.
  if (provider === 'groq') {
    return {
      url:     'https://api.groq.com/openai/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model:      model ?? 'qwen/qwen3.6-27b',
        max_tokens: 1000,  // = OTPM limit; retry handler covers 429 on exhaustion
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userText }
        ]
      }
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

// ─── Response schema validator ────────────────────────────────────────────────

const VALID_ACTION_TYPES = new Set([
  'click', 'type', 'scroll', 'navigate', 'wait', 'task_complete'
]);

// Patterns that look like raw secrets — if found in a response, reject it.
// (Expanded in Stage 2 once we have the full known-secrets list.)
const SECRET_PATTERNS = [
  /\bpassword\b/i,
  /\bsession[-_]token\b/i,
  /\bapi[-_]?key\b/i,
  /eyJ[A-Za-z0-9_-]{10,}/,          // JWT prefix
  /[0-9a-fA-F]{32,}/,               // long hex token
  /\b[A-Z]{5}[0-9]{4}[A-Z]\b/,     // PAN card pattern
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/ // Aadhaar-like
];

/**
 * Parse and validate the raw text response from the VLM.
 * Handles Qwen3's <think>…</think> preamble and markdown code fences.
 * Throws on finish_reason=length (truncation) or schema violations.
 *
 * Minimal expected schema (reasoning_summary is optional):
 * { "step_id": "s-0001-01", "actions": [{ "type": "click", "target_text": "Search" }] }
 */
function parseAndValidate(rawText, stepId, finishReason) {
  // Guard: truncated response means max_tokens was too low — never try to parse it.
  if (finishReason === 'length') {
    throw new Error(
      `Groq response truncated (finish_reason=length). ` +
      `Raw tail: …${rawText.slice(-80)}`
    );
  }

  // 1. Strip Qwen3 <think>…</think> block (greedy — handles multi-paragraph thinking)
  let text = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 2. Strip markdown code fences
  text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  // 3. Extract the first {...} JSON object (handles any residual prose)
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s !== -1 && e > s) text = text.slice(s, e + 1);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Cloud response is not valid JSON after stripping <think>.\n` +
      `Raw first 400 chars: ${rawText.slice(0, 400)}`
    );
  }

  // Schema: must have actions array with at least one entry
  if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    throw new Error('Cloud response missing "actions" array or it is empty.');
  }
  if (parsed.actions.length > 1) {
    console.warn('[CloudClient] Multiple actions returned — using only the first.');
  }

  const action = parsed.actions[0];

  if (!action.type || !VALID_ACTION_TYPES.has(action.type)) {
    throw new Error(
      `Unknown action type from cloud: "${action.type}". ` +
      `Valid: ${[...VALID_ACTION_TYPES].join(', ')}`
    );
  }

  // Secret-pattern check on the action fields only (not reasoning_summary which may not exist)
  const actionText = JSON.stringify(action);
  for (const pat of SECRET_PATTERNS) {
    const match = actionText.match(pat);
    if (match && !match[0].includes('[') && !match[0].includes('#')) {
      throw new Error(
        `Cloud action contains text matching a secret pattern (${pat}). Rejected.`
      );
    }
  }

  return {
    step_id: parsed.step_id ?? stepId,
    actions: [action]
  };
}

// ─── Fetch with 429 retry ─────────────────────────────────────────────────────

/**
 * Wrap fetch with one retry on HTTP 429.
 * BUG-4 FIX: Initial delay was 15 000ms — way too long for an interactive session.
 * The Groq free tier has 8 000 TPM; a 429 is transient and clears in seconds.
 * We honour the Retry-After header if present; otherwise wait 5s.
 */
async function fetchWithRetry(url, opts, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, opts);
    if (resp.status !== 429 || attempt === maxRetries) return resp;
    const retryAfter = parseInt(resp.headers.get('retry-after') ?? '0', 10);
    const wait = retryAfter > 0 ? retryAfter * 1000 : 5000; // default 5s, not 15s
    console.warn(`[CloudClient] 429 — waiting ${wait / 1000}s then retrying (${attempt + 1}/${maxRetries})`);
    await new Promise(r => setTimeout(r, wait));
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Call the cloud planner for one pipeline step.
 *
 * Throws if:
 *   - No API key configured (and provider !== 'stub').
 *   - Pre-send scanner finds a secret violation (warn in Stage 1, throw in Stage 2+).
 *   - HTTP request fails.
 *   - Response fails schema validation.
 *
 * @param {string} task
 * @param {object} sanitizedDom
 * @param {string} sanitizedScreenshotDataUrl
 * @param {string} stepId
 * @returns {Promise<{step_id, reasoning_summary, actions}>}
 */
export async function callCloudPlanner(task, sanitizedDom, sanitizedScreenshotDataUrl, stepId) {
  const config = await loadAPIConfig();

  // ── Stub mode ──────────────────────────────────────────────────────────────
  if (!config || config.provider === 'stub') {
    if (config?.provider !== 'stub') {
      // No key set at all — default to stub so Stage 1 can be tested without a key
      console.info('[CloudClient] No API key configured — running in STUB mode.');
    }
    const stubResp = getStubResponse(stepId);
    console.info(`[CloudClient] STUB step ${stepId}: ${stubResp.reasoning_summary}`);
    return stubResp;
  }

  // ── Pre-send scanner (FR-5) — HARD BLOCK ─────────────────────────────────
  // Scans every string in the outbound payload for known secret substrings.
  // The compact user message is also scanned — task-relevant fields whose
  // real values appear in the element label summary are caught here.
  const userMessage = buildCompactUserMessage(stepId, task, sanitizedDom);
  const scanPayload = {
    task,
    dom_json:     JSON.stringify(sanitizedDom),
    user_message: userMessage   // ← added: catches task-relevant PII in prompt
    // Screenshot bytes are binary data and are NOT sent to Groq (no vision on this tier).
  };
  const scanResult = await runPreSendScanner(scanPayload);
  if (scanResult.violations.length > 0) {
    const summary = scanResult.violations
      .map(v => `${v.field}: ${v.context}`)
      .join('; ');
    throw new Error(
      `Pre-send scanner blocked request: ${scanResult.violations.length} secret(s) ` +
      `detected in outbound payload. ${summary}`
    );
  }

  // ── Build + send request ───────────────────────────────────────────────────
  const { url, headers, body } = buildRequest(
    config, task, sanitizedDom, sanitizedScreenshotDataUrl, stepId
  );

  // Attach auth header (key never serialised into body or logs)
  if (config.provider === 'anthropic') headers['x-api-key']      = config.apiKey;
  if (config.provider === 'openai')    headers['Authorization']  = `Bearer ${config.apiKey}`;
  if (config.provider === 'groq')      headers['Authorization']  = `Bearer ${config.apiKey}`;

  let response;
  try {
    response = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (netErr) {
    throw new Error(`Network error reaching cloud planner: ${netErr.message}`);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '(unreadable)');
    // Log status + Groq error body for debugging; key is never in this path.
    console.error(`[CloudClient] HTTP ${response.status} from ${url}:`, errBody.slice(0, 400));
    throw new Error(`Cloud API HTTP ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();

  // Extract raw text from provider envelope
  let rawText = '';
  let finishReason = '';
  if (config.provider === 'anthropic') {
    rawText      = data.content?.[0]?.text ?? '';
    finishReason = data.stop_reason ?? '';
  } else if (config.provider === 'openai' || config.provider === 'groq') {
    rawText      = data.choices?.[0]?.message?.content ?? '';
    finishReason = data.choices?.[0]?.finish_reason   ?? '';
  }

  // Pass finishReason into the validator — it throws clearly on finish_reason=length
  // (truncation) so we never try to parse an incomplete response.
  if (!rawText) {
    throw new Error(
      `Cloud planner returned empty content. finish_reason="${finishReason}". ` +
      `Full response keys: ${Object.keys(data).join(', ')}`
    );
  }

  return parseAndValidate(rawText, stepId, finishReason);
}
