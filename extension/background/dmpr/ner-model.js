/**
 * DMPR — Local NER / Classifier wrapper
 * FR-2 (b): compact local NER for unstructured PII (person names, addresses, org names).
 *
 * Stage 0/1: STUB — returns empty detections and logs that the model is not yet loaded.
 * Stage 2: will integrate a real ONNX Runtime Web model (e.g. a quantized NER model).
 * Stage 4: will add the sentence-embedding model for task-relevance scoring (FR-4a).
 *
 * The interface is intentionally stable so callers never need to change when the
 * stub is replaced with the real model.
 */

let _modelLoaded = false;

/**
 * Load the local NER model into memory.
 * In Stage 2 this will fetch and instantiate an ONNX Runtime Web session.
 * Until then it is a no-op.
 *
 * @returns {Promise<void>}
 */
export async function loadNERModel() {
  if (_modelLoaded) return;
  // TODO Stage 2: load ONNX model from extension/assets/ner-model.onnx
  console.info('[NER] Model not yet loaded — stub active (Stage 0)');
  _modelLoaded = false; // stays false until the real model is wired up
}

/**
 * Run NER inference over a text span.
 *
 * @param {string} text
 * @param {string} [sourceId]
 * @returns {Promise<{ label: string, match: string, start: number, end: number, confidence: number, sourceId?: string }[]>}
 */
export async function runNER(text, sourceId) {
  if (!_modelLoaded) {
    // Stub: no detections until real model is loaded.
    return [];
  }
  // TODO Stage 2: pass `text` through ONNX session and decode BIO tags
  return [];
}

/**
 * Run the sentence-embedding model for task-relevance scoring.
 * FR-4a: embed the task string and each UI element's label+context, then
 * compute cosine similarity.
 *
 * @param {string} text   — text to embed
 * @returns {Promise<number[]>}  — float32 embedding vector
 */
export async function embedText(text) {
  // TODO Stage 4: load bge-micro-v1.5 or TF-IDF fallback and return real vector.
  // Stub: return a zero vector (cosine similarity will be 0 → treat as irrelevant).
  return new Array(384).fill(0);
}
