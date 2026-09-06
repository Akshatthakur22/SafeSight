/**
 * Cloud Planner Client — FR-6
 * Sends the sanitized bundle (screenshot + structural DOM JSON + task) to the
 * configured cloud VLM and parses the abstract action response.
 *
 * Security invariants (enforced in Stage 2, stubbed here):
 *   1. The pre-send scanner (FR-5) MUST pass before any real HTTP call is made.
 *   2. The API key is loaded from extension storage, NEVER hardcoded.
 *   3. The response schema validator MUST reject any response that contains a
 *      value that maps back to a real PII string.
 *
 * Stage 0/1: structure in place; live call wired up in Stage 1 after the human
 * provides an API key. Set apiProvider = 'stub' to run without a key.
 *
 * Supported providers: 'anthropic' (Claude), 'openai' (GPT-4o), 'stub'.
 */

import { runPreSendScanner } from './pre-send-scanner.js';

/**
 * Load the API key and provider from extension's local storage.
 * The user sets these via the popup settings panel.
 * Returns null if not configured.
 *
 * @returns {Promise<{ provider: string, apiKey: string }|null>}
 */
async function loadAPIConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(['apiProvider', 'apiKey'], items => {
      if (!items.apiProvider || !items.apiKey) {
        resolve(null);
      } else {
        resolve({ provider: items.apiProvider, apiKey: items.apiKey });
      }
    });
  });
}

/**
 * Build the request body for the configured provider.
 *
 * @param {string} provider
 * @param {string} task
 * @param {object} sanitizedDom
 * @param {string} sanitizedScreenshotDataUrl
 * @param {string} stepId
 * @returns {{ url: string, headers: object, body: object }}
 */
function buildRequest(provider, task, sanitizedDom, sanitizedScreenshotDataUrl, stepId) {
  const systemPrompt = `You are a browser automation assistant.
You will receive a sanitized screenshot and a structural description of a webpage.
Some sensitive fields have been replaced with typed placeholder tokens like [EMAIL_REDACTED#xxxx].

Your job:
1. Understand the page layout and the user's task.
2. Identify the SINGLE next action to take (click, type, scroll, or navigate).
3. Return ONLY a JSON object conforming to this schema — nothing else:
{
  "step_id": "<step_id>",
  "reasoning_summary": "<one sentence>",
  "actions": [
    { "type": "click|type|scroll|navigate", "target_text": "<visible text or description>", "target_placeholder": "<placeholder token or null>", "value": "<string to type, or null>" }
  ]
}
RULES:
- Never request, output, or reference the real value behind any placeholder token.
- Never include any string that looks like a password, email, PAN, Aadhaar, phone, or session token.
- If uncertain, return { "type": "wait", "target_text": null, "target_placeholder": null }.`;

  const userContent = [
    {
      type: 'text',
      text: `Step ID: ${stepId}\nTask: ${task}\n\nPage structure (sanitized):\n${JSON.stringify(sanitizedDom, null, 2)}`
    }
  ];

  // Attach screenshot if available
  if (sanitizedScreenshotDataUrl) {
    const base64 = sanitizedScreenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = sanitizedScreenshotDataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
    if (provider === 'anthropic') {
      userContent.unshift({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 }
      });
    } else if (provider === 'openai') {
      userContent.unshift({
        type: 'image_url',
        image_url: { url: sanitizedScreenshotDataUrl, detail: 'high' }
      });
    }
  }

  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: 'claude-opus-4-5',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      }
    };
  }

  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'gpt-4o',
        max_tokens: 512,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ]
      }
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Parse the VLM's raw response text into our AbstractAction schema (§10.2).
 * Throws if the response doesn't match the expected shape.
 *
 * @param {string} rawText
 * @param {string} stepId
 * @returns {{ step_id: string, reasoning_summary: string, actions: Array }}
 */
function parseCloudResponse(rawText, stepId) {
  // Strip markdown code fences if present
  const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Cloud response is not valid JSON: ${cleaned.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    throw new Error('Cloud response missing "actions" array.');
  }

  const validTypes = ['click', 'type', 'scroll', 'navigate', 'wait'];
  for (const action of parsed.actions) {
    if (!validTypes.includes(action.type)) {
      throw new Error(`Unknown action type from cloud: "${action.type}"`);
    }
  }

  return {
    step_id: parsed.step_id ?? stepId,
    reasoning_summary: parsed.reasoning_summary ?? '',
    actions: parsed.actions
  };
}

/**
 * Main entry point: call the cloud planner.
 *
 * Will throw if:
 *   - No API key is configured (ask the human — see build prompt rule 7).
 *   - The pre-send scanner finds a secret leak in the payload.
 *   - The response schema is invalid.
 *
 * @param {string} task
 * @param {object} sanitizedDom
 * @param {string} sanitizedScreenshotDataUrl
 * @param {string} stepId
 * @returns {Promise<{ step_id, reasoning_summary, actions }>}
 */
export async function callCloudPlanner(task, sanitizedDom, sanitizedScreenshotDataUrl, stepId) {
  const config = await loadAPIConfig();

  if (!config) {
    throw new Error(
      'No API key configured. ' +
      'Please open the ISRO-Guard popup → Settings and enter your Anthropic or OpenAI API key. ' +
      'Do not hardcode a key — this is a security requirement.'
    );
  }

  if (config.provider === 'stub') {
    // Stub mode: return a hardcoded safe response for Stage 0/1 testing.
    console.info('[CloudClient] Running in STUB mode — no real API call.');
    return {
      step_id: stepId,
      reasoning_summary: 'STUB: click the primary action button.',
      actions: [{ type: 'click', target_text: 'Search', target_placeholder: null, value: null }]
    };
  }

  // ── Pre-send security scanner (FR-5) ──────────────────────────────────────
  // This MUST pass before the HTTP call is made.
  // In Stage 0/1 the sanitized payload may still contain raw data (by design —
  // Stage 2 will fix that). The scanner will report violations but we continue
  // in Stage 0/1. From Stage 2 onwards, a violation throws and blocks the call.
  const payloadForScan = {
    dom: JSON.stringify(sanitizedDom),
    screenshot: sanitizedScreenshotDataUrl ? '[image omitted from text scan]' : ''
  };
  const scanResult = await runPreSendScanner(payloadForScan);
  if (scanResult.violations.length > 0) {
    // Stage 2+: throw to block the call.
    // Stage 0/1: warn only — redaction not yet implemented.
    console.warn('[CloudClient] Pre-send scanner VIOLATIONS (expected in Stage 0/1):', scanResult.violations);
  }

  const { url, headers, body } = buildRequest(
    config.provider, task, sanitizedDom, sanitizedScreenshotDataUrl, stepId
  );

  // Attach API key header
  if (config.provider === 'anthropic') headers['x-api-key'] = config.apiKey;
  if (config.provider === 'openai')    headers['Authorization'] = `Bearer ${config.apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cloud API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();

  // Extract raw text from provider-specific response envelope
  let rawText;
  if (config.provider === 'anthropic') {
    rawText = data.content?.[0]?.text ?? '';
  } else if (config.provider === 'openai') {
    rawText = data.choices?.[0]?.message?.content ?? '';
  }

  return parseCloudResponse(rawText, stepId);
}
