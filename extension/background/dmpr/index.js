/**
 * DMPR — Dual-Modal Privacy Recognition Engine
 * FR-2: unified entry point combining:
 *   (a) DOM signal heuristics
 *   (b) Regex/pattern rules on DOM text
 *   (c) OCR-based visual detection on the screenshot (MANDATORY — SIH26171 requirement)
 *   (d) NER (stub, future upgrade path)
 *
 * Stage 2: OCR visual detection added — this is the on-device visual perception
 * channel required by the PS title "On-device Visual Perception for Lightweight
 * Browser Agents".  DOM detection remains as a supporting channel.
 */

import { runRegexRules }       from './regex-rules.js';
import { runNER }               from './ner-model.js';
import { detectPIIInScreenshot } from './ocr-visual.js';

/**
 * DOM signal heuristics — FR-2 (c).
 * Examines a DOM element's attributes for known sensitive-field markers.
 *
 * @param {{ nodeId: string, tag: string, type: string|null, autocomplete: string|null, ariaLabel: string|null, name: string|null, id: string|null }} el
 * @returns {{ label: string, risk: 'high'|'medium', source: 'dom_signal', confidence: number }|null}
 */
function domSignalCheck(el) {
  const { type, autocomplete, ariaLabel, name, id } = el;

  // Password / credential fields
  if (type === 'password') {
    return { label: 'credential', risk: 'high', source: 'dom_signal', confidence: 1.0 };
  }

  // Autocomplete hints
  const ac = (autocomplete ?? '').toLowerCase();
  const credentialAC = ['email', 'username', 'current-password', 'new-password', 'tel', 'given-name', 'family-name', 'name', 'address-line1'];
  for (const hint of credentialAC) {
    if (ac.includes(hint)) {
      const labelMap = {
        'email': 'email', 'tel': 'phone',
        'given-name': 'person_name', 'family-name': 'person_name', 'name': 'person_name',
        'address-line1': 'address',
        'username': 'credential',
        'current-password': 'credential', 'new-password': 'credential'
      };
      return {
        label: labelMap[hint] ?? 'credential',
        risk: 'high',
        source: 'dom_signal',
        confidence: 1.0
      };
    }
  }

  // ARIA label / name / id keywords
  const keywords = [ariaLabel, name, id].filter(Boolean).join(' ').toLowerCase();
  if (/\bpassword\b/.test(keywords)) return { label: 'credential', risk: 'high', source: 'dom_signal', confidence: 0.95 };
  if (/\b(email|e-mail)\b/.test(keywords)) return { label: 'email', risk: 'high', source: 'dom_signal', confidence: 0.95 };
  if (/\b(phone|mobile|tel)\b/.test(keywords)) return { label: 'phone', risk: 'high', source: 'dom_signal', confidence: 0.9 };
  if (/\b(username|userid|user.?id)\b/.test(keywords)) return { label: 'credential', risk: 'high', source: 'dom_signal', confidence: 0.9 };
  if (/\b(session|token|api.?key|auth)\b/.test(keywords)) return { label: 'session', risk: 'high', source: 'dom_signal', confidence: 0.9 };
  if (/\b(name)\b/.test(keywords)) return { label: 'person_name', risk: 'medium', source: 'dom_signal', confidence: 0.7 };
  if (/\b(address|location)\b/.test(keywords)) return { label: 'address', risk: 'medium', source: 'dom_signal', confidence: 0.7 };

  return null;
}

/**
 * Main detection function — dual-modal (DOM + visual screenshot OCR).
 *
 * @param {{ elements: Array<{...}> }} domSnapshot
 * @param {string|null} screenshotDataUrl  — PNG data URL from captureVisibleTab
 * @param {{ width: number, height: number }|null} viewport
 * @returns {Promise<Array>}  — unified detection array (DOM + OCR hits merged)
 */
export async function detectSensitiveData(domSnapshot, screenshotDataUrl, viewport = null) {
  const detections = [];

  // ── Channel 1: DOM-based detection (regex + signals + NER) ────────────────
  for (const el of (domSnapshot?.elements ?? [])) {
    // DOM signal heuristic
    const domHit = domSignalCheck(el);
    if (domHit) {
      detections.push({
        nodeId: el.nodeId,
        label: domHit.label,
        risk: domHit.risk,
        match: el.value ?? el.textContent ?? '',
        start: 0,
        end: (el.value ?? el.textContent ?? '').length,
        confidence: domHit.confidence,
        source: domHit.source,
        bbox: null,
        redacted: false,
        taskRelevant: null
      });
    }

    // Regex rules on text content + value
    const textToScan = [el.textContent, el.value].filter(Boolean).join(' ');
    if (textToScan.trim()) {
      const regexHits = runRegexRules(textToScan, el.nodeId);
      for (const hit of regexHits) {
        const alreadyFlagged = detections.some(
          d => d.nodeId === el.nodeId && d.label === hit.label && d.source === 'dom_signal'
        );
        if (!alreadyFlagged) {
          detections.push({
            nodeId: el.nodeId,
            label: hit.label,
            risk: hit.risk,
            match: hit.match,
            start: hit.start,
            end: hit.end,
            confidence: 1.0,
            source: 'regex',
            bbox: null,
            redacted: false,
            taskRelevant: null
          });
        }
      }
    }

    // NER (stub — future upgrade path)
    const nerHits = await runNER(textToScan, el.nodeId);
    for (const hit of nerHits) {
      detections.push({
        nodeId: el.nodeId,
        label: hit.label,
        risk: 'medium',
        match: hit.match,
        start: hit.start,
        end: hit.end,
        confidence: hit.confidence,
        source: 'ner',
        bbox: null,
        redacted: false,
        taskRelevant: null
      });
    }
  }

  // ── Channel 2: Visual OCR detection on screenshot (MANDATORY) ─────────────
  // This is the "on-device visual perception" required by SIH26171.
  // It catches PII rendered in pixels with no DOM representation.
  if (screenshotDataUrl) {
    const ocrResult = await detectPIIInScreenshot(screenshotDataUrl, viewport);

    if (ocrResult === null) {
      // Fail-closed: OCR worker failed to initialise. Surface this as a thrown
      // error so the pipeline does NOT silently proceed without visual detection.
      throw new Error(
        'OCR visual detection unavailable — Tesseract worker failed to initialise. ' +
        'Check that extension/assets/tesseract/eng.traineddata is present (22MB). ' +
        'Pipeline halted to prevent undetected PII leakage.'
      );
    }

    for (const hit of ocrResult) {
      const duplicate = detections.some(
        d => d.label === hit.label && d.match === hit.match && d.source !== 'ocr'
      );
      if (!duplicate) {
        detections.push(hit);
      } else {
        // DOM already caught this value — attach the OCR bbox as a secondary
        // visual coordinate for the lockstep painter.
        const existing = detections.find(
          d => d.label === hit.label && d.match === hit.match
        );
        if (existing && !existing.ocrBbox && hit.bbox) {
          existing.ocrBbox = hit.bbox;
        }
      }
    }
  }

  return detections;
}
