/**
 * Redaction — Placeholder Map & Sanitized Payload Builder
 * FR-4 / FR-5: replaces detected PII with typed placeholders in both the DOM
 * structural copy and the screenshot bitmap.
 *
 * Security invariant: this module is the ONLY place that holds the
 * real_value ↔ placeholder mapping. The map lives purely in memory, is
 * scoped to a single tab session, and is never serialised to disk or
 * included in any outbound payload.
 *
 * Stage 0/1: passthrough stub — no redaction applied yet.
 * Stage 2: regex/DOM-signal detections → placeholders in DOM JSON.
 * Stage 3: bboxes → placeholder boxes drawn onto screenshot bitmap.
 * Stage 4: task-relevance scoring filters keep-plaintext vs. redact.
 */

/**
 * In-memory store: placeholder token → real value.
 * Cleared on tab close (the service worker itself is ephemeral).
 * Key:   e.g. "EMAIL_REDACTED#b8c3"
 * Value: the original string (never leaves this module)
 *
 * @type {Map<string, string>}
 */
const _tokenMap = new Map();

/**
 * Resolve a placeholder token back to its real value.
 * Used by the Grounding Actuator (Stage 6) when the action target IS a
 * placeholder that needs to be typed into a form — only executed locally.
 *
 * @param {string} token
 * @returns {string|undefined}
 */
export function resolveToken(token) {
  return _tokenMap.get(token);
}

/**
 * Return a read-only copy of the full placeholder map.
 * Used by the policy engine to check whether an action references a known token.
 *
 * @returns {Object.<string, string>}
 */
export function getPlaceholderMap() {
  return Object.fromEntries(_tokenMap);
}

/** Clear the map (call on tab close or new task). */
export function clearPlaceholderMap() {
  _tokenMap.clear();
}

// ─── Token generation ─────────────────────────────────────────────────────────

const LABEL_PREFIX = {
  email:       'EMAIL_REDACTED',
  phone:       'PHONE_REDACTED',
  gov_id:      'GOVID_REDACTED',
  credential:  'CRED_REDACTED',
  session:     'SESSION_REDACTED',
  person_name: 'NAME_REDACTED',
  address:     'ADDR_REDACTED',
  geolocation: 'GEO_REDACTED',
  network_id:  'NETID_REDACTED',
  unknown:     'PII_REDACTED'
};

/**
 * Generate a deterministic 4-char hex hash from a string.
 * Short enough to be readable in a screenshot; not cryptographically meaningful.
 */
function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).slice(-4);
}

/**
 * Obtain (or create) a placeholder token for a real value.
 * Idempotent: the same real value always yields the same token.
 *
 * @param {string} realValue
 * @param {string} label     — PII category
 * @returns {string}  e.g. "[EMAIL_REDACTED#b8c3]"
 */
export function getOrCreateToken(realValue, label) {
  // Check if we already have a token for this value
  for (const [tok, val] of _tokenMap.entries()) {
    if (val === realValue) return tok;
  }
  const prefix = LABEL_PREFIX[label] ?? LABEL_PREFIX.unknown;
  const hash = shortHash(realValue);
  const token = `[${prefix}#${hash}]`;
  _tokenMap.set(token, realValue);
  return token;
}

// ─── Payload builder ──────────────────────────────────────────────────────────

/**
 * Build the sanitized outbound payload from a DOM snapshot + detections.
 *
 * Stage 0/1 stub: passes through unmodified (privacy not yet applied).
 * Stage 2 will replace the stub body.
 *
 * @param {object} domSnapshot
 * @param {string} screenshotDataUrl
 * @param {Array}  detections        — from DMPR engine
 * @param {string} task              — user task string (for task-relevance in Stage 4)
 * @returns {{ sanitizedDom: object, sanitizedScreenshot: string, placeholderMap: object }}
 */
export async function buildSanitizedPayload(domSnapshot, screenshotDataUrl, detections, task) {
  // Stage 0/1 stub — no redaction, passthrough.
  // WARNING: This intentionally sends raw data — Stage 2 will fix this.
  // The zero-secret-leak scanner (FR-5) will fail on raw data, which is expected
  // behaviour for Stage 0/1 and is the motivator for building Stage 2.

  return {
    sanitizedDom: domSnapshot,
    sanitizedScreenshot: screenshotDataUrl,
    placeholderMap: getPlaceholderMap()
  };
}

/**
 * Apply redaction to a DOM snapshot given a list of detections.
 * Replaces the `textContent` / `value` of flagged nodes with placeholder tokens,
 * and marks each detection as `redacted: true`.
 *
 * Called by buildSanitizedPayload once Stage 2 is implemented.
 *
 * @param {object} domSnapshot
 * @param {Array}  detections
 * @returns {{ sanitizedDom: object, updatedDetections: Array }}
 */
export function applyDOMRedaction(domSnapshot, detections) {
  // Deep clone so the original snapshot (held locally) is not mutated
  const sanitized = JSON.parse(JSON.stringify(domSnapshot));
  const updated = JSON.parse(JSON.stringify(detections));

  for (const det of updated) {
    const el = sanitized.elements?.find(e => e.nodeId === det.nodeId);
    if (!el) continue;

    const token = getOrCreateToken(det.match, det.label);

    // Replace in textContent
    if (el.textContent && el.textContent.includes(det.match)) {
      el.textContent = el.textContent.replaceAll(det.match, token);
    }
    // Replace in value (input fields)
    if (el.value && el.value.includes(det.match)) {
      el.value = el.value.replaceAll(det.match, token);
    }

    det.redacted = true;
    det.token = token;
  }

  return { sanitizedDom: sanitized, updatedDetections: updated };
}
