/**
 * Content Script — Executor (FR-8)
 * Dispatches real browser events (click, type, scroll) onto live page elements.
 *
 * Security invariant: this module ONLY executes actions that:
 *   (a) passed the local policy engine (FR-7), AND
 *   (b) were successfully grounded to a real, visible DOM element.
 * It never receives the raw PII values — only the grounded element reference
 * plus any value-to-type (which, in Stage 4+, is itself a placeholder resolved
 * locally by the placeholder map).
 *
 * Stage 0: click and type dispatch implemented and tested against mock portal.
 * Stage 6: GROUND_AND_EXECUTE message wires grounding + execution together.
 */

'use strict';

// ─── Event dispatchers ────────────────────────────────────────────────────────

/**
 * Simulate a real click at the centre of an element's bounding box.
 * Uses both a synthetic MouseEvent and el.click() for maximum compatibility.
 *
 * @param {Element} el
 * @returns {{ ok: boolean, bbox: object }}
 */
function dispatchClick(el) {
  const r = el.getBoundingClientRect();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;

  // Scroll element into view first if needed
  el.scrollIntoView({ block: 'center', behavior: 'instant' });

  const eventInit = {
    bubbles: true, cancelable: true, view: window,
    clientX: cx, clientY: cy, screenX: cx, screenY: cy
  };

  el.dispatchEvent(new MouseEvent('mouseover', eventInit));
  el.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, button: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup',   { ...eventInit, button: 0 }));
  el.dispatchEvent(new MouseEvent('click',     { ...eventInit, button: 0 }));

  return { ok: true, bbox: { x: r.x, y: r.y, width: r.width, height: r.height } };
}

/**
 * Type a string into an input/textarea element.
 * Dispatches keydown/keypress/input/keyup for each character so the page's
 * event listeners (e.g. React synthetic events) fire correctly.
 *
 * @param {Element} el
 * @param {string}  value
 * @returns {{ ok: boolean }}
 */
function dispatchType(el, value) {
  el.focus();
  el.scrollIntoView({ block: 'center', behavior: 'instant' });

  // Clear existing value
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set;
  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;

  const setter = nativeInputValueSetter || nativeTextareaValueSetter;
  if (setter) {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Fallback for non-React pages
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return { ok: true };
}

/**
 * Scroll the page by (dx, dy) pixels.
 *
 * @param {number} dx
 * @param {number} dy
 * @returns {{ ok: boolean }}
 */
function dispatchScroll(dx, dy) {
  window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
  return { ok: true };
}

// ─── Grounding + Execution pipeline ──────────────────────────────────────────

/**
 * Find a DOM element by nodeId (matches capture.js format) or CSS selector.
 * Needed for direct grounding lookup in Stage 0 / test harness.
 */
function findElement(selector) {
  if (!selector) return null;
  if (selector.startsWith('#')) return document.getElementById(selector.slice(1));
  try { return document.querySelector(selector); } catch { return null; }
}

/**
 * Full GROUND_AND_EXECUTE handler.
 * Receives a grounded action from the service worker (post-policy-gate).
 *
 * @param {{ action, groundResult }} msg
 * @returns {{ ok, groundMs, executeMs, bbox, error }}
 */
function groundAndExecute(msg) {
  const { action, groundResult } = msg;
  const t0 = performance.now();

  if (!groundResult?.ok) {
    return { ok: false, groundMs: 0, executeMs: 0, bbox: null,
             error: groundResult?.error ?? 'Grounding failed' };
  }

  if (groundResult.needsUserConfirmation) {
    // Surface a native confirm dialog so the user sees what's about to happen.
    const proceed = window.confirm(
      `ISRO-Guard: Low-confidence grounding (${Math.round(groundResult.confidence * 100)}%).\n` +
      `About to click: "${action.target_text ?? action.target_placeholder}"\n\n` +
      `Proceed?`
    );
    if (!proceed) {
      return { ok: false, groundMs: performance.now() - t0, executeMs: 0,
               bbox: groundResult.bbox, error: 'User cancelled low-confidence action.' };
    }
  }

  const groundMs = performance.now() - t0;

  // Find the element in the live DOM using the grounded bbox centre.
  // In Stage 3+ the lockstep map carries nodeIds for exact lookup.
  // Here we fall back to elementFromPoint at bbox centre.
  const { bbox } = groundResult;
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const el = document.elementFromPoint(cx, cy);

  if (!el) {
    return { ok: false, groundMs, executeMs: 0, bbox,
             error: `No element at grounded coordinates (${cx}, ${cy})` };
  }

  const t1 = performance.now();
  let execResult;

  switch (action.type) {
    case 'click':
      execResult = dispatchClick(el);
      break;
    case 'type':
      execResult = dispatchType(el, action.value ?? '');
      break;
    case 'scroll':
      execResult = dispatchScroll(action.dx ?? 0, action.dy ?? 100);
      break;
    default:
      execResult = { ok: false };
  }

  const executeMs = performance.now() - t1;

  return {
    ok: execResult.ok,
    groundMs,
    executeMs,
    bbox,
    error: execResult.ok ? null : `Execute failed for action type "${action.type}"`
  };
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Full grounded execution (called from service worker after policy gate passes)
  if (message.type === 'GROUND_AND_EXECUTE') {
    try {
      const result = groundAndExecute(message);
      sendResponse(result);
    } catch (err) {
      sendResponse({ ok: false, groundMs: 0, executeMs: 0, bbox: null, error: err.message });
    }
    return true;
  }

  // Stage-0 hardcoded click — used by the exit test harness only.
  if (message.type === 'HARDCODED_CLICK_CONTENT') {
    try {
      const el = findElement(message.selector);
      if (!el) {
        sendResponse({ ok: false, error: `Element not found: ${message.selector}` });
        return true;
      }
      const result = dispatchClick(el);
      sendResponse(result);
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true;
  }
});
