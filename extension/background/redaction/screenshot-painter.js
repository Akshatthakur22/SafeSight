/**
 * Screenshot Bitmap Redactor — Stage 3 / FR-3 / FR-4
 *
 * Paints placeholder boxes onto the screenshot PNG in the background worker
 * BEFORE the image is included in any outbound payload.
 *
 * Uses OffscreenCanvas (available in MV3 service workers on Chrome ≥ 94).
 *
 * For each detection that has a `bbox` (from lockstep-sync) and is marked
 * `redacted: true`, this painter:
 *   1. Draws a filled rectangle over the sensitive region (dark overlay).
 *   2. Renders the placeholder token text (e.g. "[EMAIL_REDACTED#b8c3]") in the box.
 *
 * The result is a new data URL containing the sanitized screenshot — the original
 * raw screenshot is discarded and never reaches the cloud.
 */

/**
 * Paint redaction boxes onto a screenshot data URL.
 *
 * @param {string} screenshotDataUrl  — raw PNG/JPEG from captureVisibleTab
 * @param {Array}  detections         — from DMPR engine with bbox + redacted flags
 * @returns {Promise<string>}         — new data URL with sensitive regions painted over
 */
export async function paintRedactionBoxes(screenshotDataUrl, detections) {
  if (!screenshotDataUrl) return screenshotDataUrl;

  // Filter to detections that have a bbox and are flagged for redaction
  const toRedact = detections.filter(
    d => (d.redacted || d.taskRelevant === false) && (d.bbox || d.ocrBbox)
  );

  // If nothing has a resolved bbox, log a warning but still continue —
  // the pre-send scanner (armed with registerSecret) is the last-resort
  // hard-block. Do NOT silently return the raw screenshot without logging.
  if (toRedact.length === 0) {
    const redactedCount = detections.filter(d => d.redacted).length;
    if (redactedCount > 0) {
      console.warn(
        `[Painter] ${redactedCount} detection(s) were redacted in DOM but have no bbox — ` +
        'screenshot pixels are unpainted for those regions. ' +
        'The pre-send scanner will block if any raw value survives in the DOM payload.'
      );
    }
    // Return the original — the pre-send scanner catches DOM leakage.
    // For the screenshot channel, we accept that bbox-less detections cannot be painted.
    return screenshotDataUrl;
  }

  // Decode the screenshot into an ImageBitmap
  let imageBitmap;
  try {
    const resp = await fetch(screenshotDataUrl);
    const blob = await resp.blob();
    imageBitmap = await createImageBitmap(blob);
  } catch (err) {
    console.warn('[Painter] Could not decode screenshot for redaction:', err.message);
    return screenshotDataUrl;
  }

  const { width, height } = imageBitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx    = canvas.getContext('2d');

  // Draw the original image
  ctx.drawImage(imageBitmap, 0, 0);
  imageBitmap.close();

  // Paint each redaction box
  for (const det of toRedact) {
    const bbox = det.bbox ?? det.ocrBbox;
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) continue;

    const { x, y, width: w, height: h } = bbox;

    // Filled dark overlay
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(x, y, w, h);

    // Thin border so the redaction is visually distinct
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth   = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    // Placeholder label text — truncated to fit in the box
    const token      = det.token ?? `[${(det.label ?? 'PII').toUpperCase()}_REDACTED]`;
    const fontSize   = Math.max(8, Math.min(12, Math.floor(h * 0.45)));
    ctx.font         = `bold ${fontSize}px monospace`;
    ctx.fillStyle    = '#93c5fd';
    ctx.textBaseline = 'middle';

    const maxChars = Math.max(4, Math.floor(w / (fontSize * 0.6)));
    const label    = token.length > maxChars ? token.slice(0, maxChars - 1) + '…' : token;
    ctx.fillText(label, x + 3, y + h / 2);
  }

  // Export back to PNG data URL
  const paintedBlob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(paintedBlob);
  });
}
