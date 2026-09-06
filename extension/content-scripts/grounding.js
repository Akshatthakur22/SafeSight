/**
 * Content Script — Grounding Actuator (FR-8)
 * Translates the cloud planner's abstract target (placeholder token or
 * plain-text description) into a concrete DOM element + coordinate.
 *
 * Strategy (two-tier, per PRD §16):
 *   Tier 1 — EXACT MATCH: if the action carries a `target_placeholder` token,
 *             look it up in the current session's lockstep map and return the
 *             stored bbox directly.
 *   Tier 2 — FUZZY MATCH: if no exact placeholder match, score all visible
 *             interactive elements by text/label similarity against the cloud's
 *             `target_text` and pick the highest-scoring one above a confidence
 *             threshold. Below threshold → surface a human-confirmation dialog.
 *
 * No ML model is required for grounding in Stages 0–6 (PRD §16, MVP grounder).
 * The GoClick model integration is a post-MVP enhancement.
 *
 * Stage 0: structure in place; fuzzy match uses a simple normalised-overlap score.
 * Stage 6: confidence threshold + human-confirmation dialog fully wired.
 */

'use strict';

/** Minimum similarity score to auto-execute without user confirmation. */
const CONFIDENCE_THRESHOLD = 0.45;

// ─── Fuzzy text similarity ────────────────────────────────────────────────────

/**
 * Normalise a string for comparison: lowercase, strip punctuation, collapse
 * whitespace.
 * @param {string} s
 * @returns {string}
 */
function normalise(s) {
  return (s ?? '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Token-overlap Jaccard similarity between two strings.
 * Fast, zero-dependency, good enough for label matching.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}  0..1
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(normalise(a).split(' ').filter(Boolean));
  const setB = new Set(normalise(b).split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

/**
 * Exact substring match bonus: if query appears verbatim in candidate text,
 * boost score to at least 0.8.
 */
function substringBonus(query, candidate) {
  const q = normalise(query);
  const c = normalise(candidate);
  return (q.length >= 3 && c.includes(q)) ? 0.85 : 0;
}

// ─── Interactive element index ────────────────────────────────────────────────

const GROUNDING_TAGS = ['button', 'a', 'input', 'select', 'textarea', '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]'];

/**
 * Return all currently-visible, non-disabled interactive elements with their
 * text labels and bboxes.
 *
 * @returns {Array<{ el: Element, text: string, bbox: DOMRect }>}
 */
function getInteractiveElements() {
  const selector = GROUNDING_TAGS.join(', ');
  return Array.from(document.querySelectorAll(selector))
    .map(el => {
      const bbox = el.getBoundingClientRect();
      if (bbox.width === 0 || bbox.height === 0) return null;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
      // Must be at least partially in viewport
      if (bbox.bottom < 0 || bbox.top > window.innerHeight) return null;

      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('placeholder'),
        el.value,
        el.textContent
      ].filter(Boolean).join(' ').trim().slice(0, 200);

      return { el, text: label, bbox };
    })
    .filter(Boolean);
}

// ─── Grounding logic ──────────────────────────────────────────────────────────

/**
 * Attempt to ground an abstract action to a DOM element.
 *
 * @param {{ type: string, target_text: string|null, target_placeholder: string|null }} action
 * @param {Object.<string, string>} placeholderMap  — token → nodeId mapping
 *        (in Stage 3+ this comes from the lockstep map; Stage 0 it's empty)
 * @returns {{
 *   ok: boolean,
 *   method: 'exact_placeholder'|'fuzzy_text'|'not_found',
 *   element: Element|null,
 *   bbox: { x, y, width, height }|null,
 *   confidence: number,
 *   needsUserConfirmation: boolean,
 *   error: string|null
 * }}
 */
function groundAction(action, placeholderMap) {
  // ── Tier 1: exact placeholder lookup ──────────────────────────────────────
  if (action.target_placeholder) {
    const token = action.target_placeholder;
    // In Stage 3+ the lockstep map carries nodeIds; look up the element directly.
    const nodeIdOrSelector = placeholderMap?.[token];
    if (nodeIdOrSelector) {
      const el = findByNodeIdOrSelector(nodeIdOrSelector);
      if (el) {
        const r = el.getBoundingClientRect();
        return {
          ok: true,
          method: 'exact_placeholder',
          element: el,
          bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
          confidence: 1.0,
          needsUserConfirmation: false,
          error: null
        };
      }
    }
    // Placeholder not resolved — fall through to fuzzy match on target_text
  }

  // ── Tier 2: fuzzy text match ───────────────────────────────────────────────
  const query = action.target_text ?? action.target_placeholder ?? '';
  if (!query) {
    return { ok: false, method: 'not_found', element: null, bbox: null, confidence: 0,
             needsUserConfirmation: false, error: 'No target text or placeholder provided.' };
  }

  const candidates = getInteractiveElements();
  let best = null;
  let bestScore = 0;

  for (const cand of candidates) {
    const jaccard = jaccardSimilarity(query, cand.text);
    const bonus   = substringBonus(query, cand.text);
    const score   = Math.max(jaccard, bonus);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }

  if (!best || bestScore === 0) {
    return { ok: false, method: 'not_found', element: null, bbox: null, confidence: 0,
             needsUserConfirmation: false, error: `No element found matching "${query}"` };
  }

  const needsConfirmation = bestScore < CONFIDENCE_THRESHOLD;

  return {
    ok: true,
    method: 'fuzzy_text',
    element: best.el,
    bbox: { x: best.bbox.x, y: best.bbox.y, width: best.bbox.width, height: best.bbox.height },
    confidence: bestScore,
    needsUserConfirmation: needsConfirmation,
    error: null
  };
}

/**
 * Helper: find a DOM element by nodeId string (from capture.js) or CSS selector.
 */
function findByNodeIdOrSelector(idOrSel) {
  if (idOrSel.startsWith('#')) return document.getElementById(idOrSel.slice(1));
  if (idOrSel.startsWith('.') || idOrSel.includes('[') || idOrSel.includes('>')) {
    try { return document.querySelector(idOrSel); } catch { return null; }
  }
  // XPath-style path
  const parts = idOrSel.split('/');
  let current = document.body;
  for (const part of parts) {
    const match = part.match(/^(\w+)\[(\d+)\]$/);
    if (!match) return null;
    const [, tag, idxStr] = match;
    const idx = parseInt(idxStr, 10) - 1;
    const children = Array.from(current.children).filter(c => c.tagName.toLowerCase() === tag);
    if (!children[idx]) return null;
    current = children[idx];
  }
  return current instanceof Element ? current : null;
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GROUND_ACTION') {
    try {
      const result = groundAction(message.action, message.placeholderMap ?? {});
      // Don't serialise the DOM Element — just return the metadata.
      sendResponse({
        ok: result.ok,
        method: result.method,
        bbox: result.bbox,
        confidence: result.confidence,
        needsUserConfirmation: result.needsUserConfirmation,
        error: result.error
      });
    } catch (err) {
      sendResponse({ ok: false, method: 'error', bbox: null, confidence: 0,
                     needsUserConfirmation: false, error: err.message });
    }
    return true;
  }
});

// Export for executor.js (same-page context — both scripts share the page scope
// but as separate files they communicate through the message passing above).
// The executor calls GROUND_ACTION via the service worker, not directly.
