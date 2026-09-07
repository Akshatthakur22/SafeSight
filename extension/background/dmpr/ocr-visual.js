/**
 * OCR Visual Detection — Stage 2
 * SIH26171 mandatory requirement: "On-device Visual Perception"
 *
 * Uses Tesseract.js (WASM-based) to OCR the screenshot PNG and detect PII
 * in the rendered pixels — catching sensitive text with NO DOM representation
 * (canvas-rendered text, CSS ::before/after content, WebGL overlays, etc.).
 *
 * ALL processing is on-device:
 *   - WASM binary:    bundled at assets/tesseract/tesseract-core-lstm.wasm
 *   - Language data:  bundled at assets/tesseract/eng.traineddata (22MB, offline)
 *   - Worker script:  bundled at assets/tesseract/worker.min.js
 *
 * No CDN requests are made. The extension works fully offline after installation.
 *
 * Fail-closed: if the Tesseract worker fails to initialise, detectPIIInScreenshot
 * returns null (not []), and the pipeline surface this as a hard error rather than
 * silently proceeding without visual detection.
 */

import { runRegexRules } from './regex-rules.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TESSERACT_ESM_PATH = chrome.runtime.getURL('assets/tesseract/tesseract.esm.min.js');
const WORKER_PATH        = chrome.runtime.getURL('assets/tesseract/worker.min.js');
const WASM_PATH          = chrome.runtime.getURL('assets/tesseract/tesseract-core-lstm.wasm');
const LANG_DATA_PATH     = chrome.runtime.getURL('assets/tesseract/eng.traineddata');

/** Minimum OCR word confidence to accept (0–100). */
const MIN_WORD_CONFIDENCE = 55;

// ─── Worker singleton ─────────────────────────────────────────────────────────

let _worker        = null;
let _workerPromise = null;
let _workerFailed  = false;  // latched: if init fails once, stay failed

/**
 * Return the ready Tesseract worker, creating it on first call.
 * Returns null ONLY if init genuinely failed (caller must treat as error).
 */
async function getWorker() {
  if (_workerFailed) return null;
  if (_worker)       return _worker;
  if (_workerPromise) return _workerPromise;

  _workerPromise = (async () => {
    try {
      const { createWorker } = await import(TESSERACT_ESM_PATH);

      const w = await createWorker('eng', 1, {
        workerPath:  WORKER_PATH,
        corePath:    WASM_PATH,
        langPath:    LANG_DATA_PATH,
        cacheMethod: 'none',  // data is already at LANG_DATA_PATH; no caching needed
        logger:      () => {},
        errorHandler: (err) => {
          console.error('[OCR] Worker runtime error:', err);
          _worker = null;
          _workerPromise = null;
          _workerFailed  = true;
        }
      });

      _worker = w;
      _workerPromise = null;
      console.info('[OCR] Tesseract worker ready (fully offline, bundled lang data).');
      return w;

    } catch (err) {
      _workerFailed  = true;
      _workerPromise = null;
      console.error('[OCR] Worker initialisation failed:', err.message);
      return null;
    }
  })();

  return _workerPromise;
}

/** Terminate the worker (called on extension suspend / tab close). */
export async function terminateOCRWorker() {
  if (_worker) { await _worker.terminate(); _worker = null; }
  _workerFailed = false;  // allow re-init after an explicit terminate
}

// ─── Main detection function ──────────────────────────────────────────────────

/**
 * Run OCR on a screenshot and detect PII in the rendered pixels.
 *
 * This is the PRIMARY on-device visual perception channel (SIH26171 PS title).
 *
 * @param {string} screenshotDataUrl  — PNG/JPEG data URL from captureVisibleTab
 * @param {{ width: number, height: number } | null} viewport
 * @returns {Promise<Array | null>}
 *   Array of detection objects on success.
 *   null if the OCR worker failed to initialise — caller must treat this as an
 *   error (fail-closed), not silently fall back to DOM-only detection.
 */
export async function detectPIIInScreenshot(screenshotDataUrl, viewport) {
  if (!screenshotDataUrl) return [];

  const worker = await getWorker();

  // Fail-closed: null means the visual perception layer is broken.
  // The caller (dmpr/index.js) decides how to surface this.
  if (!worker) return null;

  let ocrResult;
  try {
    ocrResult = await worker.recognize(screenshotDataUrl);
  } catch (err) {
    console.error('[OCR] recognize() failed:', err.message);
    _worker       = null;
    _workerFailed = true;
    return null;  // fail-closed — not []
  }

  const detections = [];
  const words      = ocrResult?.data?.words ?? [];

  // Per-word PII scan
  for (const word of words) {
    if (word.confidence < MIN_WORD_CONFIDENCE) continue;
    const text = word.text?.trim();
    if (!text || text.length < 3) continue;

    const hits = runRegexRules(text, 'ocr-word');
    for (const hit of hits) {
      const tb = word.bbox;
      detections.push({
        label:        hit.label,
        risk:         hit.risk,
        match:        hit.match,
        confidence:   Math.round(word.confidence) / 100,
        bbox:         { x: tb.x0, y: tb.y0, width: tb.x1 - tb.x0, height: tb.y1 - tb.y0 },
        source:       'ocr',
        nodeId:       null,
        start:        hit.start,
        end:          hit.end,
        redacted:     false,
        taskRelevant: null
      });
    }
  }

  // Multi-word PII scan (e.g. "Dr. Test Analyst" spans two words)
  const fullText = words
    .filter(w => w.confidence >= MIN_WORD_CONFIDENCE)
    .map(w => w.text)
    .join(' ');

  const fullHits = runRegexRules(fullText, 'ocr-full');
  for (const hit of fullHits) {
    const dup = detections.some(
      d => d.source === 'ocr' && d.label === hit.label && d.match === hit.match
    );
    if (!dup) {
      // Multi-word span: no precise bbox at this stage — lockstep painter will skip
      detections.push({
        label:        hit.label,
        risk:         hit.risk,
        match:        hit.match,
        confidence:   0.8,
        bbox:         null,
        source:       'ocr',
        nodeId:       null,
        start:        hit.start,
        end:          hit.end,
        redacted:     false,
        taskRelevant: null
      });
    }
  }

  console.info(`[OCR] Visual detection complete: ${detections.length} PII hit(s) in screenshot.`);
  return detections;
}
