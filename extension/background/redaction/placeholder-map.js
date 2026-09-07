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
 * Stage 2: regex/DOM-signal + OCR detections → placeholders in DOM JSON.
 * Stage 3: bboxes → placeholder boxes drawn onto screenshot bitmap.
 * Stage 4: task-relevance scoring filters keep-plaintext vs. redact.
 */

import { registerSecret } from '../pre-send-scanner.js';

/**
 * In-memory store: placeholder token → real value.
 * Cleared on tab close (the service worker itself is ephemeral).
 * Key:   e.g. "[EMAIL_REDACTED#b8c3]"
 * Value: the original string (never leaves this module)
 *
 * @type {Map<string, string>}
 */
const _tokenMap = new Map();

/**
 * Resolve a placeholder token back to its real value.
 * Used by the Grounding Actuator (Stage 6) when the action target IS a
 * placeholder that needs to be typed into a form — only executed locally.
 */
export function resolveToken(token) {
  return _tokenMap.get(token);
}

/** Return a read-only copy of the full placeholder map (token → real value). */
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
 * Also registers the real value with the pre-send scanner (hard-block).
 * Idempotent: same real value always yields the same token.
 */
export function getOrCreateToken(realValue, label) {
  for (const [tok, val] of _tokenMap.entries()) {
    if (val === realValue) return tok;
  }
  const prefix = LABEL_PREFIX[label] ?? LABEL_PREFIX.unknown;
  const hash   = shortHash(realValue);
  const token  = `[${prefix}#${hash}]`;
  _tokenMap.set(token, realValue);
  // Arm the pre-send scanner — if this value ever appears in an outbound payload, block it.
  registerSecret(realValue);
  return token;
}

// ─── Payload builder ──────────────────────────────────────────────────────────

/**
 * Build the sanitized outbound payload.
 *
 * Stage 2+: real DOM redaction applied.
 *   - Detections with taskRelevant !== true are replaced with typed placeholder tokens.
 *   - Screenshot bitmap redaction happens separately via paintRedactionBoxes()
 *     in the service worker BEFORE this result is passed to callCloudPlanner().
 *
 * @param {object} domSnapshot
 * @param {string} _screenshotDataUrl  — unused here; painter called separately
 * @param {Array}  detections
 * @param {string} _task               — unused; relevance already scored
 * @returns {{ sanitizedDom, placeholderMap }}
 */
export async function buildSanitizedPayload(domSnapshot, _screenshotDataUrl, detections, _task) {
  const toRedact = detections.filter(d => d.taskRelevant !== true && d.match?.trim());
  const { sanitizedDom, updatedDetections } = applyDOMRedaction(domSnapshot, toRedact);

  // Propagate redacted flag + token back to the original detections array
  for (const upd of updatedDetections) {
    const orig = detections.find(d => d.nodeId === upd.nodeId && d.match === upd.match);
    if (orig) { orig.redacted = upd.redacted; orig.token = upd.token; }
  }

  return { sanitizedDom, placeholderMap: getPlaceholderMap() };
}

/**
 * Apply DOM redaction: deep-clone the snapshot, replace matched values with tokens.
 * Called by buildSanitizedPayload.
 */
export function applyDOMRedaction(domSnapshot, detections) {
  const sanitized = JSON.parse(JSON.stringify(domSnapshot));
  const updated   = JSON.parse(JSON.stringify(detections));

  for (const det of updated) {
    const el = sanitized.elements?.find(e => e.nodeId === det.nodeId);
    if (!el) continue;

    const token = getOrCreateToken(det.match, det.label);

    if (el.textContent?.includes(det.match)) {
      el.textContent = el.textContent.replaceAll(det.match, token);
    }
    if (el.value?.includes(det.match)) {
      el.value = el.value.replaceAll(det.match, token);
    }

    det.redacted = true;
    det.token    = token;
  }

  return { sanitizedDom: sanitized, updatedDetections: updated };
}
