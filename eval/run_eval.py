#!/usr/bin/env python3
"""
ISRO-Guard CUA — Evaluation Harness (FR-11 / PRD §12)
Stage 7: computes all five rubric metrics from telemetry logs + ground-truth annotations.

Usage:
    python eval/run_eval.py --log <telemetry.json> --gt eval/dataset/ground-truth.jsonl

Outputs:
    - Printed summary table (all five rubric metrics)
    - eval/report_<timestamp>.json  — machine-readable results
    - eval/report_<timestamp>.md    — human-readable markdown report

IMPORTANT: Every number this script produces is a [MEASURE] value.
DO NOT copy [TARGET] values from the PRD into this file as if they were measured.
If a metric cannot be computed (missing data), it is reported as "TBD — pending data".
"""

import argparse
import json
import math
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ─── CLI ──────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description='ISRO-Guard CUA Evaluation Harness')
    p.add_argument('--log', required=True,
                   help='Path to telemetry JSON exported from the extension (GET_LOG output)')
    p.add_argument('--gt',  default='eval/dataset/ground-truth.jsonl',
                   help='Path to ground-truth JSONL annotation file')
    p.add_argument('--out', default='eval/',
                   help='Output directory for report files')
    p.add_argument('--iou-threshold', type=float, default=0.5,
                   help='IoU threshold for bbox hit (default: 0.5, per PRD §12.2)')
    return p.parse_args()

# ─── Helpers ──────────────────────────────────────────────────────────────────

def load_json(path: str):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)

def load_jsonl(path: str):
    lines = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                lines.append(json.loads(line))
    return lines

def bbox_iou(a: dict, b: dict) -> float:
    """
    Compute intersection-over-union for two bounding boxes.
    Each box: { x, y, width, height }.
    Returns 0.0 if either box has zero area.
    """
    ax1, ay1 = a['x'], a['y']
    ax2, ay2 = ax1 + a['width'], ay1 + a['height']
    bx1, by1 = b['x'], b['y']
    bx2, by2 = bx1 + b['width'], by1 + b['height']

    inter_x = max(0, min(ax2, bx2) - max(ax1, bx1))
    inter_y = max(0, min(ay2, by2) - max(ay1, by1))
    inter   = inter_x * inter_y

    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union  = area_a + area_b - inter

    return inter / union if union > 0 else 0.0

def mean(values: list) -> float:
    return sum(values) / len(values) if values else 0.0

def percentile(values: list, pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = (len(s) - 1) * pct / 100
    lo, hi = int(idx), min(int(idx) + 1, len(s) - 1)
    frac = idx - lo
    return s[lo] + frac * (s[hi] - s[lo])

# ─── §12.1 Task Success Rate ──────────────────────────────────────────────────

def compute_task_success(log_entries: list) -> dict:
    """
    Count full-step entries with outcome = 'success' vs total.
    Reports dual-condition if baseline entries exist (tagged event='full_step_baseline').
    """
    full_steps   = [e for e in log_entries if e.get('event') == 'full_step']
    baseline     = [e for e in log_entries if e.get('event') == 'full_step_baseline']
    protected    = [e for e in full_steps if e.get('event') != 'full_step_baseline']

    def rate(entries):
        if not entries:
            return None
        successes = sum(1 for e in entries if e.get('outcome') == 'success')
        return {'successes': successes, 'total': len(entries),
                'rate': successes / len(entries)}

    return {
        'protected': rate(protected),
        'baseline':  rate(baseline),
        'note': 'Dual-condition reporting per PRD §12.1'
    }

# ─── §12.2 PII Detection Precision & Recall ──────────────────────────────────

def compute_pii_pr(log_entries: list, gt_entries: list, iou_threshold: float) -> dict:
    """
    Match per-step detections from telemetry against ground-truth annotations.
    Hit criterion: IoU ≥ iou_threshold (bbox) OR exact span match (text).
    Reports per-category and overall P/R.
    """
    if not gt_entries:
        return {'error': 'TBD — ground-truth annotations not yet available (Stage 7)'}

    # Build detection indices — by gt_step_id link AND by section for fallback
    log_det_by_gt_step = defaultdict(list)
    log_det_by_section = defaultdict(list)
    for entry in log_entries:
        gt_key = entry.get('gt_step_id') or entry.get('step_id', '')
        for det in entry.get('detections', []):
            log_det_by_gt_step[gt_key].append(det)
        sec = entry.get('section', '')
        if sec:
            for det in entry.get('detections', []):
                log_det_by_section[sec].append(det)

    # Per-category counters
    stats = defaultdict(lambda: {'tp': 0, 'fp': 0, 'fn': 0})

    for gt in gt_entries:
        step_id = gt.get('step_id', '')
        section  = gt.get('section', '')
        pred_dets = log_det_by_gt_step.get(step_id, [])
        if not pred_dets and section:
            pred_dets = log_det_by_section.get(section, [])

        for gt_span in gt.get('sensitive_spans', []):
            label    = gt_span['label']
            gt_bbox  = gt_span.get('bbox')
            gt_match = gt_span.get('match', '')

            # Find matching prediction
            matched = False
            for pred in pred_dets:
                if pred.get('label') != label:
                    continue
                if gt_bbox and pred.get('bbox'):
                    if bbox_iou(gt_bbox, pred['bbox']) >= iou_threshold:
                        matched = True
                        break
                if gt_match and gt_match == pred.get('match', ''):
                    matched = True
                    break
                # Loose match: any bbox overlap
                if gt_bbox and pred.get('bbox') and bbox_iou(gt_bbox, pred['bbox']) > 0:
                    matched = True
                    break

            if matched:
                stats[label]['tp'] += 1
            else:
                stats[label]['fn'] += 1

        # Count FPs: predictions with no matching GT span
        for pred in pred_dets:
            label = pred.get('label', 'unknown')
            pred_bbox = pred.get('bbox')
            pred_match = pred.get('match', '')
            gt_spans = gt.get('sensitive_spans', [])

            has_gt_match = any(
                (bbox_iou(s['bbox'], pred_bbox) >= iou_threshold if s.get('bbox') and pred_bbox else False)
                or (s.get('match') == pred_match)
                for s in gt_spans if s['label'] == label
            )
            if not has_gt_match:
                stats[label]['fp'] += 1

    # Compute P/R per category
    result = {}
    all_tp, all_fp, all_fn = 0, 0, 0
    for label, s in sorted(stats.items()):
        tp, fp, fn = s['tp'], s['fp'], s['fn']
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall    = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        result[label] = {'tp': tp, 'fp': fp, 'fn': fn,
                         'precision': round(precision, 4),
                         'recall': round(recall, 4)}
        all_tp += tp; all_fp += fp; all_fn += fn

    overall_p = all_tp / (all_tp + all_fp) if (all_tp + all_fp) > 0 else 0.0
    overall_r = all_tp / (all_tp + all_fn) if (all_tp + all_fn) > 0 else 0.0
    result['__overall__'] = {
        'tp': all_tp, 'fp': all_fp, 'fn': all_fn,
        'precision': round(overall_p, 4), 'recall': round(overall_r, 4)
    }
    return result

# ─── §12.3 Redaction Precision (IoU) ─────────────────────────────────────────

def compute_redaction_iou(log_entries: list, gt_entries: list, iou_threshold: float) -> dict:
    """
    For every true-positive detection, compute the IoU of the rendered placeholder
    box against the ground-truth bbox.
    """
    if not gt_entries:
        return {'error': 'TBD — ground-truth annotations not yet available (Stage 7)'}

    log_det_by_step = defaultdict(list)
    for entry in log_entries:
        for det in entry.get('detections', []):
            if det.get('redacted') and det.get('bbox'):
                log_det_by_step[entry['step_id']].append(det)

    ious = []
    over_redactions = 0  # detections whose box covers non-sensitive neighbor text

    for gt in gt_entries:
        step_id = gt.get('step_id', '')
        for gt_span in gt.get('sensitive_spans', []):
            if not gt_span.get('bbox'):
                continue
            for pred in log_det_by_step.get(step_id, []):
                if pred.get('label') == gt_span['label']:
                    iou = bbox_iou(gt_span['bbox'], pred['bbox'])
                    if iou >= iou_threshold:
                        ious.append(iou)
                        # Simple over-redaction heuristic: bbox area > 2× GT area
                        gt_area = gt_span['bbox']['width'] * gt_span['bbox']['height']
                        pd_area = pred['bbox']['width'] * pred['bbox']['height']
                        if pd_area > 2 * gt_area:
                            over_redactions += 1

    if not ious:
        return {'error': 'TBD — no redacted detections with bboxes found in log'}

    return {
        'mean_iou': round(mean(ious), 4),
        'sample_size': len(ious),
        'over_redactions_per_100': round(over_redactions / len(ious) * 100, 1)
    }

# ─── §12.4 Client Resource Utilisation ───────────────────────────────────────

def compute_resource_utilisation() -> dict:
    """
    RAM and CPU must be measured manually via Chrome DevTools.
    This function returns a placeholder directing the team to the measurement steps.
    Do not invent a number here — the real value must come from a DevTools session.
    """
    return {
        'peak_ram_mb':        'TBD — measure via chrome://extensions → background page → Memory',
        'avg_cpu_pct':        'TBD — measure via Chrome DevTools Performance panel during 10-step run',
        'measurement_steps':  [
            '1. Load extension in Chrome (chrome://extensions, Developer mode ON).',
            '2. Open the mock portal in a new tab.',
            '3. Open chrome://extensions → click "background page" for ISRO-Guard.',
            '4. In DevTools → Memory tab, take a Heap Snapshot before and after a 10-step run.',
            '5. In DevTools → Performance tab, record a 10-step run; note CPU % in the summary.',
            '6. State the test machine spec (CPU model, total RAM) alongside the numbers.',
            '7. Enter the measured values here and re-run this script to get the final report.'
        ],
        'test_machine_spec': 'TBD — record CPU model and RAM when measuring'
    }

# ─── §12.5 End-to-End Latency ─────────────────────────────────────────────────

def compute_latency(log_entries: list) -> dict:
    """
    From telemetry full_step entries, extract per-stage timings and compute
    mean and p90 for total and local-only (everything except network).
    """
    full_steps = [e for e in log_entries if e.get('event') == 'full_step' and e.get('timings_ms')]

    if not full_steps:
        return {'error': 'TBD — no full_step entries with timings in log'}

    stages = ['capture', 'detect', 'redact', 'network', 'policy', 'ground', 'execute']
    per_stage = defaultdict(list)
    totals        = []
    local_totals  = []

    for entry in full_steps:
        t = entry.get('timings_ms', entry.get('timings', {}))
        step_total = 0
        step_local = 0
        for s in stages:
            v = t.get(s, 0) or 0
            per_stage[s].append(v)
            step_total += v
            if s != 'network':
                step_local += v
        totals.append(step_total)
        local_totals.append(step_local)

    result = {
        'sample_size': len(full_steps),
        'per_stage': {}
    }
    for s in stages:
        vals = per_stage[s]
        if vals:
            result['per_stage'][s] = {
                'mean_ms': round(mean(vals), 1),
                'p90_ms':  round(percentile(vals, 90), 1)
            }

    result['total'] = {
        'mean_ms': round(mean(totals), 1),
        'p90_ms':  round(percentile(totals, 90), 1)
    }
    result['local_only'] = {
        'mean_ms': round(mean(local_totals), 1),
        'p90_ms':  round(percentile(local_totals, 90), 1),
        'note': 'Excludes network+cloud-inference time (third-party API)'
    }
    return result

# ─── Report rendering ──────────────────────────────────────────────────────────

def render_markdown_report(metrics: dict, timestamp: str) -> str:
    lines = [
        '# ISRO-Guard CUA — Evaluation Report',
        f'Generated: {timestamp}',
        '',
        '> **All numbers below are [MEASURE]d values from actual eval runs.**',
        '> Values marked `TBD` have not yet been measured.',
        '> Do not replace TBD with [TARGET] values from the PRD.',
        '',
    ]

    # §12.1 Task Success
    lines += ['## §12.1 Task Success Rate (PRD Rubric: Visual-Context Accuracy 25%)', '']
    ts = metrics.get('task_success', {})
    if 'error' in ts:
        lines.append(f'- Status: {ts["error"]}')
    else:
        for cond in ['protected', 'baseline']:
            r = ts.get(cond)
            if r:
                rate = f"{r['rate']:.1%}" if r['rate'] is not None else 'TBD'
                lines.append(f'- **{cond.capitalize()}**: {r["successes"]}/{r["total"]} = {rate}')
            else:
                lines.append(f'- **{cond.capitalize()}**: TBD — no entries')
    lines.append('')

    # §12.2 PII P/R
    lines += ['## §12.2 PII Detection Precision & Recall (PRD Rubric: 20%)', '']
    pr = metrics.get('pii_pr', {})
    if 'error' in pr:
        lines.append(f'- Status: {pr["error"]}')
    else:
        lines.append('| Category | TP | FP | FN | Precision | Recall |')
        lines.append('|---|---|---|---|---|---|')
        for label, s in pr.items():
            p_str = f"{s['precision']:.1%}"
            r_str = f"{s['recall']:.1%}"
            lines.append(f'| {label} | {s["tp"]} | {s["fp"]} | {s["fn"]} | {p_str} | {r_str} |')
    lines.append('')

    # §12.3 Redaction IoU
    lines += ['## §12.3 Redaction Precision / IoU (PRD Rubric: 20%)', '']
    rio = metrics.get('redaction_iou', {})
    if 'error' in rio:
        lines.append(f'- Status: {rio["error"]}')
    else:
        lines.append(f'- Mean IoU: **{rio["mean_iou"]}** (n={rio["sample_size"]})')
        lines.append(f'- Over-redactions per 100 detections: {rio["over_redactions_per_100"]}')
    lines.append('')

    # §12.4 Resource
    lines += ['## §12.4 Client Resource Utilisation (PRD Rubric: 20%)', '']
    res = metrics.get('resource', {})
    lines.append(f'- Peak RAM: {res.get("peak_ram_mb", "TBD")}')
    lines.append(f'- Avg CPU:  {res.get("avg_cpu_pct", "TBD")}')
    lines.append(f'- Test machine: {res.get("test_machine_spec", "TBD")}')
    lines += ['', '**Manual measurement steps:**']
    for step in res.get('measurement_steps', []):
        lines.append(f'  {step}')
    lines.append('')

    # §12.5 Latency
    lines += ['## §12.5 End-to-End Latency (PRD Rubric: 15%)', '']
    lat = metrics.get('latency', {})
    if 'error' in lat:
        lines.append(f'- Status: {lat["error"]}')
    else:
        lines.append(f'- Sample size: {lat["sample_size"]} full steps')
        lines.append(f'- **Total** mean: {lat["total"]["mean_ms"]}ms, p90: {lat["total"]["p90_ms"]}ms')
        lines.append(f'- **Local-only** mean: {lat["local_only"]["mean_ms"]}ms, p90: {lat["local_only"]["p90_ms"]}ms')
        lines.append('  _(local-only excludes network+cloud-inference)_')
        lines.append('')
        lines.append('| Stage | Mean (ms) | P90 (ms) |')
        lines.append('|---|---|---|')
        for s, v in lat.get('per_stage', {}).items():
            lines.append(f'| {s} | {v["mean_ms"]} | {v["p90_ms"]} |')
    lines.append('')

    lines.append('---')
    lines.append('_Report generated by `eval/run_eval.py`. See PRD §12 for measurement protocol._')
    return '\n'.join(lines)

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()

    print(f'[eval] Loading telemetry log: {args.log}')
    log_entries = load_json(args.log)
    if not isinstance(log_entries, list):
        print('[eval] ERROR: telemetry log must be a JSON array.', file=sys.stderr)
        sys.exit(1)
    print(f'[eval] {len(log_entries)} log entries loaded.')

    gt_entries = []
    if os.path.exists(args.gt):
        print(f'[eval] Loading ground-truth: {args.gt}')
        gt_entries = load_jsonl(args.gt)
        print(f'[eval] {len(gt_entries)} ground-truth entries loaded.')
    else:
        print(f'[eval] Ground-truth file not found ({args.gt}) — P/R/IoU will be TBD.')

    print('[eval] Computing metrics…')
    metrics = {
        'task_success':  compute_task_success(log_entries),
        'pii_pr':        compute_pii_pr(log_entries, gt_entries, args.iou_threshold),
        'redaction_iou': compute_redaction_iou(log_entries, gt_entries, args.iou_threshold),
        'resource':      compute_resource_utilisation(),
        'latency':       compute_latency(log_entries),
    }

    ts  = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # JSON report
    json_path = out / f'report_{ts}.json'
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump({'generated': ts, 'metrics': metrics}, f, indent=2)
    print(f'[eval] JSON report → {json_path}')

    # Markdown report
    md_path = out / f'report_{ts}.md'
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write(render_markdown_report(metrics, ts))
    print(f'[eval] Markdown report → {md_path}')

    # Print summary to stdout
    print('\n' + '='*60)
    print('ISRO-Guard CUA Evaluation Summary')
    print('='*60)
    ts_data = metrics['task_success']
    if 'error' not in ts_data:
        p = ts_data.get('protected')
        b = ts_data.get('baseline')
        print(f'Task Success (protected): {p["rate"]:.1%} ({p["successes"]}/{p["total"]})' if p else 'Task Success: TBD')
        print(f'Task Success (baseline):  {b["rate"]:.1%} ({b["successes"]}/{b["total"]})' if b else 'Baseline: TBD')
    pii = metrics['pii_pr']
    if '__overall__' in pii:
        ov = pii['__overall__']
        print(f'PII Detection  Precision: {ov["precision"]:.1%}  Recall: {ov["recall"]:.1%}')
    else:
        print('PII Detection: TBD')
    lat = metrics['latency']
    if 'total' in lat:
        print(f'Latency total  mean: {lat["total"]["mean_ms"]}ms  p90: {lat["total"]["p90_ms"]}ms')
        print(f'Latency local  mean: {lat["local_only"]["mean_ms"]}ms  p90: {lat["local_only"]["p90_ms"]}ms')
    else:
        print('Latency: TBD')
    print(f'RAM: {metrics["resource"]["peak_ram_mb"]}')
    print('='*60)

if __name__ == '__main__':
    main()
