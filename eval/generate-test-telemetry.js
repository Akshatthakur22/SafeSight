#!/usr/bin/env node
/**
 * Generate a SIMULATED telemetry log for the Stage-7 evaluation harness.
 *
 * ⚠️  IMPORTANT: The numbers produced by this script are SIMULATED, not measured.
 * Detections are generated from ground-truth data (100% recall by construction).
 * Timings are random draws within observed ranges, not real per-step measurements.
 * Outcomes are random draws with hardcoded probabilities.
 *
 * ALL metrics derived from this log must be labeled [SIMULATED] in any report
 * or presentation. They CANNOT be presented as [MEASURE]d values until real
 * extension telemetry is exported from Chrome after actual task runs.
 *
 * To get real numbers:
 *   1. Load the extension in Chrome.
 *   2. Run ≥50 tasks against the mock portal with privacy ON.
 *   3. Run ≥20 tasks with privacy OFF (baseline).
 *   4. Export telemetry from the popup → Decision Log → Export.
 *   5. Run: python3 eval/run_eval.py --log <exported>.json --gt eval/dataset/ground-truth.jsonl
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const GT_FILE = path.resolve(__dirname, 'dataset/ground-truth.jsonl');
const OUT     = path.resolve(__dirname, 'test-telemetry.json');

const gt = fs.readFileSync(GT_FILE, 'utf-8')
  .split('\n').filter(Boolean).map(JSON.parse);

// Simulation parameters (derived from observed Stage 0–6 measurements)
// All timings in ms.
const TIMING_RANGES = {
  capture:  [450, 700],
  detect:   [5,   50],    // DOM regex+signals fast; OCR adds 800-3000ms in real run
  redact:   [10,  80],
  network:  [1500, 9000], // Groq OTPM variability
  policy:   [0.5, 3],
  ground:   [8,   35],
  execute:  [10,  25]
};

function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
function randInt(lo, hi) { return Math.floor(rand(lo, hi)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Simulate detections for a given GT entry (what the DMPR engine would produce)
// True positives: match ground truth; false positives: add ~10% spurious hits
function simulateDetections(gtEntry, simulateOCR = true) {
  const dets = [];
  for (const span of gtEntry.sensitive_spans) {
    if (!span.match) continue;
    // Simulate a real detection hit
    dets.push({
      label:        span.label,
      bbox:         span.bbox,
      confidence:   span.source === 'dom_signal' ? 0.95 : 1.0,
      redacted:     true,
      taskRelevant: false,
      source:       span.source === 'ground_truth_markup' ? 'dom_signal' : span.source
    });
    // OCR duplicate (visual channel also catches it)
    if (simulateOCR && span.bbox && Math.random() > 0.3) {
      dets.push({
        label:        span.label,
        bbox:         { ...span.bbox,
                        x: span.bbox.x + randInt(-3, 3),
                        y: span.bbox.y + randInt(-2, 2) },
        confidence:   0.72 + Math.random() * 0.2,
        redacted:     true,
        taskRelevant: false,
        source:       'ocr'
      });
    }
  }
  // ~10% FP rate
  if (Math.random() < 0.10) {
    dets.push({
      label:        pick(['email', 'phone', 'person_name']),
      bbox:         { x: randInt(50,800), y: randInt(50,600), width: randInt(60,180), height: 18 },
      confidence:   0.55 + Math.random() * 0.2,
      redacted:     false,
      taskRelevant: false,
      source:       pick(['regex', 'ocr'])
    });
  }
  return dets;
}

function makeTimings() {
  const t = {};
  for (const [k, [lo, hi]] of Object.entries(TIMING_RANGES)) {
    t[k] = Math.round(rand(lo, hi) * 10) / 10;
  }
  return t;
}

// Build telemetry log — one full_step entry per GT entry (search/profile sections)
// Plus a baseline run (no redaction) for dual-condition task success reporting
const entries = [];
let stepNum = 0;

// Protected runs (DMPR + redaction ON)
for (const gtEntry of gt) {
  stepNum++;
  const stepId = `s-${String(stepNum).padStart(4, '0')}`;
  const dets   = simulateDetections(gtEntry, true);
  const timings = makeTimings();

  // Outcome: success for most; occasional ground_fail
  const outcome = Math.random() < 0.88 ? 'success' :
                  Math.random() < 0.5  ? 'ground_fail' : 'cloud_error';

  entries.push({
    step_id:     stepId,
    event:       'full_step',
    timestamp:   Date.now() - (50 - stepNum) * 15000 + randInt(0, 5000),
    timings_ms:  timings,
    detections:  dets,
    policy_decision: { result: 'allow', rule_fired: null },
    outcome,
    section:     gtEntry.section,
    gt_step_id:  gtEntry.step_id  // link back to ground truth
  });
}

// Baseline runs (no redaction — for dual-condition task success §12.1)
for (let i = 0; i < 20; i++) {
  stepNum++;
  const stepId = `s-baseline-${String(i+1).padStart(3,'0')}`;
  entries.push({
    step_id:     stepId,
    event:       'full_step_baseline',
    timestamp:   Date.now() - (70 + i) * 15000,
    timings_ms:  makeTimings(),
    detections:  [],  // baseline sends raw data — no detections logged
    policy_decision: { result: 'allow', rule_fired: null },
    outcome:     Math.random() < 0.90 ? 'success' : 'ground_fail'
  });
}

fs.writeFileSync(OUT, JSON.stringify(entries, null, 2));
console.log(`\n⚠️  SIMULATED telemetry written → ${OUT}`);
console.log(`   Protected steps: ${gt.length}, Baseline steps: 20`);
console.log(`   All metrics from this log are [SIMULATED], NOT [MEASURE]d.`);
console.log(`   Replace with real Chrome extension telemetry before final reporting.`);
