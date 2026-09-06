/**
 * Redaction — Task-Aware ABI Relevance Scorer
 * FR-4 / FR-4a: decide whether a sensitive node is relevant to the current task.
 *
 * Relevant  → keep plaintext in the outgoing payload (the cloud needs this value
 *             to understand the page context, but it is task-linked, not a raw secret).
 * Irrelevant → replace with a typed placeholder.
 *
 * Stage 0/1: stub returns 0 for everything (treat all sensitive nodes as irrelevant).
 * Stage 4: will replace with a real embedding model (bge-micro or TF-IDF fallback).
 *
 * Threshold: configurable; defaults to 0.35 (cosine similarity).
 * A node whose similarity to the task exceeds this threshold is "task-relevant".
 */

import { embedText } from '../dmpr/ner-model.js';

/** Cosine similarity threshold — nodes above this keep their plaintext value. */
export const RELEVANCE_THRESHOLD = 0.35;

/**
 * Compute cosine similarity between two float32 vectors.
 * Returns 0 if either vector has zero magnitude (stub vectors).
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}  0..1
 */
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Build a short textual description of a DOM element for embedding.
 * Combines ARIA label, name, placeholder, nearby label text, and tag type.
 *
 * @param {{ ariaLabel, name, placeholder, textContent, tag }} el
 * @returns {string}
 */
function elementDescription(el) {
  return [el.ariaLabel, el.name, el.placeholder, el.textContent, el.tag]
    .filter(Boolean)
    .join(' ')
    .slice(0, 200); // cap to avoid large token counts
}

/**
 * Score task-relevance for every detection in the list.
 * Mutates each detection in-place, setting `taskRelevant: boolean`.
 *
 * @param {string} task
 * @param {Array}  detections
 * @param {Array}  domElements  — full elements array from DOM snapshot
 * @returns {Promise<Array>}    — same array with taskRelevant filled in
 */
export async function scoreTaskRelevance(task, detections, domElements) {
  if (!detections.length) return detections;

  // Embed the task string once
  const taskVec = await embedText(task);

  for (const det of detections) {
    const el = domElements?.find(e => e.nodeId === det.nodeId);
    const description = el ? elementDescription(el) : det.match;

    const elVec = await embedText(description);
    const sim = cosineSimilarity(taskVec, elVec);

    det.taskRelevant = sim >= RELEVANCE_THRESHOLD;
    det.relevanceScore = sim;
  }

  return detections;
}
