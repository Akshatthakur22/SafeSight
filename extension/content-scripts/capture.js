/**
 * Content Script — Capture (FR-1)
 * Runs in the page context. Responds to messages from the service worker.
 *
 * Responsibilities:
 *   GET_DOM_SNAPSHOT  → walk the live DOM and return a structured snapshot
 *                       that the background layer can run DMPR over.
 *
 * Screenshot capture (chrome.tabs.captureVisibleTab) happens in the service
 * worker because content scripts cannot call that API. This script handles
 * the DOM/a11y side of FR-1 only.
 *
 * DOM snapshot element shape (matches DMPR index.js expectations):
 * {
 *   nodeId       : string   — deterministic XPath-based ID
 *   tag          : string   — lowercase tag name
 *   type         : string|null  — input[type] attribute
 *   autocomplete : string|null
 *   ariaLabel    : string|null  — aria-label attribute
 *   role         : string|null  — role attribute
 *   name         : string|null  — name attribute
 *   id           : string|null  — id attribute
 *   placeholder  : string|null
 *   textContent  : string       — trimmed inner text (capped at 500 chars)
 *   value        : string|null  — current .value for form fields
 *   visible      : boolean      — is the element in the viewport?
 *   bbox         : { x, y, width, height }  — getBoundingClientRect result
 *   href         : string|null  — for <a> tags
 *   hidden       : boolean      — display:none / visibility:hidden / opacity:0 / tiny font
 * }
 */

'use strict';

// ─── DOM snapshot ─────────────────────────────────────────────────────────────

/** Tags we care about for task execution and PII detection. */
const RELEVANT_TAGS = new Set([
  'input', 'textarea', 'select', 'button', 'a', 'label',
  'span', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'td', 'th', 'li', 'form', 'nav', 'header', 'footer', 'main',
  'canvas', 'img', 'table'
]);

/**
 * Generate a stable, human-readable node ID from an element's position in the DOM.
 * Format: "tag[n]" where n is the 1-based index among siblings of the same tag.
 * Falls back to XPath for uniqueness.
 *
 * @param {Element} el
 * @returns {string}
 */
function nodeId(el) {
  if (el.id) return `#${el.id}`;
  // Walk up to build a short path
  const parts = [];
  let node = el;
  while (node && node !== document.body && parts.length < 5) {
    const tag = node.tagName?.toLowerCase() ?? '?';
    const siblings = node.parentElement
      ? Array.from(node.parentElement.children).filter(c => c.tagName === node.tagName)
      : [node];
    const idx = siblings.indexOf(node) + 1;
    parts.unshift(`${tag}[${idx}]`);
    node = node.parentElement;
  }
  return parts.join('/');
}

/**
 * Check whether an element is visually hidden.
 * AR-1 requires us to inspect even hidden/tiny-font elements for injection attacks.
 */
function isHidden(el) {
  const style = window.getComputedStyle(el);
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden') return true;
  if (parseFloat(style.opacity) === 0) return true;
  if (parseFloat(style.fontSize) < 3) return true; // micro-text injection
  return false;
}

/**
 * Check whether an element's bbox is within the viewport.
 */
function isVisible(bbox) {
  return (
    bbox.width > 0 && bbox.height > 0 &&
    bbox.x < window.innerWidth && bbox.y < window.innerHeight &&
    bbox.x + bbox.width > 0 && bbox.y + bbox.height > 0
  );
}

/**
 * Walk the DOM and collect relevant elements into a flat array.
 * We collect ALL elements (including hidden ones — AR-1) but flag them.
 *
 * @returns {{ stepId: string, url: string, title: string, viewport: object, elements: Array }}
 */
function buildDOMSnapshot(stepId) {
  const elements = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  let node;
  while ((node = walker.nextNode())) {
    const tag = node.tagName.toLowerCase();

    // Always capture form/interactive elements; for text elements only if they
    // have non-empty, meaningful text (avoids noise from layout divs).
    const isInteractive = ['input', 'textarea', 'select', 'button', 'a'].includes(tag);
    const textContent = (node.textContent ?? '').trim().slice(0, 500);
    if (!isInteractive && !RELEVANT_TAGS.has(tag)) continue;
    if (!isInteractive && !textContent) continue;

    const bbox = node.getBoundingClientRect();
    const hidden = isHidden(node);
    const visible = !hidden && isVisible(bbox);

    elements.push({
      nodeId: nodeId(node),
      tag,
      type:         node.getAttribute('type') ?? null,
      autocomplete: node.getAttribute('autocomplete') ?? null,
      ariaLabel:    node.getAttribute('aria-label') ?? null,
      role:         node.getAttribute('role') ?? null,
      name:         node.getAttribute('name') ?? null,
      id:           node.getAttribute('id') ?? null,
      placeholder:  node.getAttribute('placeholder') ?? null,
      textContent,
      value:        ('value' in node) ? (node.value ?? null) : null,
      visible,
      hidden,
      bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
      href: tag === 'a' ? (node.getAttribute('href') ?? null) : null
    });
  }

  return {
    stepId,
    url:   window.location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    elements
  };
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_DOM_SNAPSHOT') {
    try {
      const snapshot = buildDOMSnapshot(message.stepId ?? 's-unknown');
      sendResponse({ ok: true, snapshot });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true; // async
  }
});
