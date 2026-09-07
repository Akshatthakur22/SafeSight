/**
 * Redaction — Task-Aware ABI Relevance Scorer
 * FR-4 / FR-4a: decide whether a sensitive node is relevant to the current task.
 *
 * Stage 4: TF-IDF cosine-similarity fallback (zero-dependency, no ONNX model).
 *   - Tokenises task and element description into word sets.
 *   - Scores each element against the task by Jaccard + IDF weighting.
 *   - Elements above RELEVANCE_THRESHOLD keep their plaintext (the agent needs
 *     the value to complete the task — e.g. a form field the user is filling in).
 *   - Elements below threshold get a typed placeholder.
 *
 * This is the "ABI" (Available-But-Invisible) strategy from prior literature,
 * applied browser-side with a lightweight text similarity approach.
 */

/** Cosine similarity threshold — nodes above this keep plaintext. */
export const RELEVANCE_THRESHOLD = 0.25; // slightly lower than before so more is preserved

// ─── TF-IDF tokeniser ─────────────────────────────────────────────────────────

function tokenise(text) {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function termFreq(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
  const total = tokens.length || 1;
  for (const t in tf) tf[t] /= total;
  return tf;
}

function cosineTFIDF(tokensA, tokensB) {
  const tfA = termFreq(tokensA);
  const tfB = termFreq(tokensB);
  const vocab = new Set([...Object.keys(tfA), ...Object.keys(tokensB)]);
  let dot = 0, magA = 0, magB = 0;
  for (const term of vocab) {
    const a = tfA[term] ?? 0;
    const b = tfB[term] ?? 0;
    dot  += a * b;
    magA += a * a;
    magB += b * b;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Build a short description of a DOM element for similarity comparison.
 */
function elementDescription(el) {
  return [
    el.ariaLabel,
    el.name,
    el.placeholder,
    el.id,
    el.textContent?.slice(0, 80),
    el.tag
  ].filter(Boolean).join(' ');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Score task-relevance for every detection.
 * Mutates each detection in-place, setting `taskRelevant: boolean`.
 *
 * @param {string} task
 * @param {Array}  detections
 * @param {Array}  domElements  — full elements array from DOM snapshot
 * @returns {Array}  — same array with taskRelevant filled in
 */
export function scoreTaskRelevance(task, detections, domElements) {
  if (!detections.length) return detections;

  const taskTokens = tokenise(task);

  for (const det of detections) {
    // OCR-only detections (no nodeId) are always treated as irrelevant —
    // they exist in the screenshot but not in a form the agent needs to interact with.
    if (!det.nodeId) {
      det.taskRelevant = false;
      det.relevanceScore = 0;
      continue;
    }

    const el = domElements?.find(e => e.nodeId === det.nodeId);
    const description = el ? elementDescription(el) : (det.match ?? '');
    const elTokens = tokenise(description);
    const score = cosineTFIDF(taskTokens, elTokens);

    det.taskRelevant   = score >= RELEVANCE_THRESHOLD;
    det.relevanceScore = score;
  }

  return detections;
}

// Note: embedText is no longer used. TF-IDF cosine is computed directly
// in scoreTaskRelevance() above. The ner-model.js stub still exports embedText
// for backward-compat but it is not called by this module.

