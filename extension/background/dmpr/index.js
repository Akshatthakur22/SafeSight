/**
 * DMPR — Dual-Modal Privacy Recognition Engine
 * FR-2: unified entry point that combines regex rules + DOM-signal heuristics + NER.
 *
 * Stage 0/1: regex + DOM signals only (NER stub returns empty).
 * Stage 2: full implementation wired up; this file's interface stays stable.
 *
 * Output shape per detection (mirrors §10.4 log schema):
 * {
 *   nodeId     : string    — unique DOM node identifier assigned during snapshot
 *   label      : string    — PII category (email / phone / gov_id / session / credential / person_name / geolocation / network_id)
 *   risk       : 'high'|'medium'
 *   match      : string    — the matched text value (kept LOCAL — never sent out)
 *   start      : number    — char offset within the node's text content
 *   end        : number
 *   confidence : number    — 0..1 (regex rules emit 1.0; NER emits model score)
 *   source     : 'regex'|'dom_signal'|'ner'
 *   bbox       : null      — filled in by lockstep-sync.js in Stage 3
 *   redacted   : false     — filled in by ABI redactor in Stage 4
 *   taskRelevant: null     — filled in by task-relevance scorer in Stage 4
 * }
 */

import { runRegexRules } from './regex-rules.js';
import { runNER } from './ner-model.js';

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
 * Main detection function.
 *
 * @param {{ elements: Array<{ nodeId, tag, type, autocomplete, ariaLabel, name, id, textContent, value }> }} domSnapshot
 * @param {ImageData|null} _imageData  — reserved for visual OCR (Stage 3+)
 * @returns {Promise<Array>}  — array of detection objects
 */
export async function detectSensitiveData(domSnapshot, _imageData) {
  if (!domSnapshot?.elements) return [];

  const detections = [];

  for (const el of domSnapshot.elements) {
    // 1. DOM signal heuristic
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

    // 2. Regex rules on text content + value
    const textToScan = [el.textContent, el.value].filter(Boolean).join(' ');
    if (textToScan.trim()) {
      const regexHits = runRegexRules(textToScan, el.nodeId);
      for (const hit of regexHits) {
        // Avoid duplicate if dom_signal already flagged this node at same label
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

    // 3. NER (stub in Stage 0; real model in Stage 2)
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

  return detections;
}
