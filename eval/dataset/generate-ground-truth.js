#!/usr/bin/env node
/**
 * Generate ground-truth annotations for the evaluation dataset (Stage 7 / FR-11).
 *
 * Uses Puppeteer to:
 *   1. Open the mock portal in multiple states (search page, profile page, canvas page)
 *   2. Walk every element with data-pii attribute to get real bboxes
 *   3. Run the same regex rules as dmpr/regex-rules.js against DOM text
 *   4. Write ground-truth.jsonl — one line per annotated step
 *
 * Output: eval/dataset/ground-truth.jsonl (≥50 entries across all portal states)
 *
 * Run: node eval/dataset/generate-ground-truth.js
 */

'use strict';

const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORTAL_BASE = path.resolve(__dirname, '../../fixtures/mock-portal');
const OUT_JSONL   = path.resolve(__dirname, 'ground-truth.jsonl');
const SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// PII regex rules mirrored from dmpr/regex-rules.js (Node-compatible version)
const REGEX_RULES = [
  { id: 'email',       label: 'email',       risk: 'high',   pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  { id: 'phone_intl',  label: 'phone',       risk: 'high',   pattern: /(?:\+?91[-.\s]?)?[6-9]\d{9}\b/g },
  { id: 'phone_intl2', label: 'phone',       risk: 'high',   pattern: /\+91-\d{4}-\d{6}\b/g },
  { id: 'aadhaar',     label: 'gov_id',      risk: 'high',   pattern: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g },
  { id: 'pan',         label: 'gov_id',      risk: 'high',   pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  { id: 'ipv4',        label: 'network_id',  risk: 'medium', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  { id: 'jwt',         label: 'session',     risk: 'high',   pattern: /\bey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g },
  { id: 'hex_token',   label: 'session',     risk: 'high',   pattern: /\b[0-9a-fA-F]{32,}\b/g },
  { id: 'name_prefix', label: 'person_name', risk: 'medium', pattern: /\b(?:Dr|Mr|Mrs|Ms|Prof|Shri|Smt)\.?\s+[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?\b/g },
];

function runRegex(text) {
  const hits = [];
  for (const rule of REGEX_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ ruleId: rule.id, label: rule.label, risk: rule.risk,
                  match: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  return hits;
}

// DOM signal check (mirrors dmpr/index.js domSignalCheck)
function domSignalLabel(type, autocomplete, ariaLabel, name, id) {
  if (type === 'password') return 'credential';
  const ac = (autocomplete ?? '').toLowerCase();
  if (ac.includes('email')) return 'email';
  if (ac.includes('tel')) return 'phone';
  if (ac.includes('name')) return 'person_name';
  if (ac.includes('password')) return 'credential';
  if (ac.includes('username')) return 'credential';
  const kw = [ariaLabel, name, id].filter(Boolean).join(' ').toLowerCase();
  if (/password/.test(kw)) return 'credential';
  if (/email/.test(kw)) return 'email';
  if (/phone|mobile|tel/.test(kw)) return 'phone';
  if (/session|token/.test(kw)) return 'session';
  return null;
}

// ─── Annotation generator ─────────────────────────────────────────────────────

async function annotatePortalPage(page, section, stepId, screenshotFile) {
  const sensitiveSpans = [];

  // 1. Walk data-pii elements (ground-truth from fixture markup)
  const piiEls = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-pii]')).map(el => {
      const r = el.getBoundingClientRect();
      return {
        id:    el.id || null,
        tag:   el.tagName.toLowerCase(),
        label: el.getAttribute('data-pii'),
        text:  el.textContent?.trim() || el.value || '',
        bbox:  r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
      };
    })
  );

  for (const el of piiEls) {
    if (!el.text || !el.bbox) continue;
    sensitiveSpans.push({
      nodeId:    el.id ? `#${el.id}` : null,
      label:     el.label,
      match:     el.text.slice(0, 100),
      bbox:      el.bbox,
      source:    'ground_truth_markup'
    });
  }

  // 2. Walk form inputs and detect via DOM signals + regex
  const formEls = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input,textarea,select,span,p,div')).map(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return null;
      return {
        id:          el.id || null,
        tag:         el.tagName.toLowerCase(),
        type:        el.getAttribute('type'),
        autocomplete: el.getAttribute('autocomplete'),
        ariaLabel:   el.getAttribute('aria-label'),
        name:        el.getAttribute('name'),
        value:       el.value || null,
        textContent: el.textContent?.trim().slice(0, 200) || null,
        bbox:        { x: r.x, y: r.y, width: r.width, height: r.height }
      };
    }).filter(Boolean)
  );

  for (const el of formEls) {
    // DOM signal
    const dsLabel = domSignalLabel(el.type, el.autocomplete, el.ariaLabel, el.name, el.id);
    const text    = el.value || el.textContent || '';
    if (dsLabel && text) {
      const alreadyAnnotated = sensitiveSpans.some(
        s => s.nodeId === (el.id ? `#${el.id}` : null) && s.label === dsLabel
      );
      if (!alreadyAnnotated) {
        sensitiveSpans.push({
          nodeId: el.id ? `#${el.id}` : null,
          label:  dsLabel,
          match:  text.slice(0, 100),
          bbox:   el.bbox,
          source: 'dom_signal'
        });
      }
    }

    // Regex scan
    const scanText = [el.value, el.textContent].filter(Boolean).join(' ');
    const regexHits = runRegex(scanText);
    for (const hit of regexHits) {
      const dup = sensitiveSpans.some(
        s => s.match === hit.match && s.label === hit.label
      );
      if (!dup) {
        sensitiveSpans.push({
          nodeId: el.id ? `#${el.id}` : null,
          label:  hit.label,
          match:  hit.match,
          bbox:   el.bbox,
          source: 'regex'
        });
      }
    }
  }

  return {
    step_id:          stepId,
    section,
    url:              page.url(),
    screenshot_ref:   screenshotFile ? path.basename(screenshotFile) : null,
    sensitive_spans:  sensitiveSpans.filter(s => s.match && s.match.trim().length >= 3)
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[GT] Generating ground-truth annotations…');

  const CHROME_PATHS = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser', '/usr/bin/chromium'
  ];
  const exe = CHROME_PATHS.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    ...(exe ? { executablePath: exe } : {})
  });

  const entries = [];
  let stepNum = 0;

  async function capture(page, section, label) {
    stepNum++;
    const stepId = `gt-${String(stepNum).padStart(3, '0')}`;
    const shotPath = path.join(SCREENSHOTS_DIR, `${stepId}.png`);
    await page.screenshot({ path: shotPath, type: 'png', fullPage: false });
    const entry = await annotatePortalPage(page, section, stepId, shotPath);
    entry.label = label;
    entries.push(entry);
    console.log(`  [${stepId}] ${label}: ${entry.sensitive_spans.length} spans`);
    return entry;
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // ── Section 1: Search page (10 snapshots — different scroll/state) ────────
    for (let i = 0; i < 10; i++) {
      await page.goto(`file://${PORTAL_BASE}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__isroGuardTestReady === true, { timeout: 5000 });
      if (i > 0) {
        await page.click('#search-btn').catch(() => {});
        await new Promise(r => setTimeout(r, 400));
      }
      await capture(page, 'search', `search-page-${i === 0 ? 'initial' : 'with-results'}-${i}`);
    }

    // ── Section 2: Profile page (20 snapshots — dense PII) ───────────────────
    for (let i = 0; i < 20; i++) {
      await page.goto(`file://${PORTAL_BASE}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__isroGuardTestReady === true, { timeout: 5000 });
      // Navigate to profile
      await page.evaluate(() => {
        document.querySelector('[data-section="profile"]')?.click();
      });
      await new Promise(r => setTimeout(r, 200));
      await capture(page, 'profile', `profile-page-${i}`);
    }

    // ── Section 3: Nav bar visible on all pages (15 snapshots) ───────────────
    for (let i = 0; i < 15; i++) {
      await page.goto(`file://${PORTAL_BASE}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__isroGuardTestReady === true, { timeout: 5000 });
      // Scroll to different positions to test different view states
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), i * 50);
      await capture(page, 'navbar', `navbar-pii-${i}`);
    }

    // ── Section 4: Canvas map page (5 snapshots) ─────────────────────────────
    for (let i = 0; i < 5; i++) {
      await page.goto(`file://${PORTAL_BASE}/canvas-map-demo.html`, { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 500)); // wait for canvas render
      await capture(page, 'canvas', `canvas-${i}`);
    }

  } finally {
    await browser.close();
  }

  // Write JSONL
  const lines = entries.map(e => JSON.stringify(e));
  fs.writeFileSync(OUT_JSONL, lines.join('\n') + '\n');

  const totalSpans  = entries.reduce((s, e) => s + e.sensitive_spans.length, 0);
  console.log(`\n[GT] Done: ${entries.length} entries, ${totalSpans} total sensitive spans`);
  console.log(`[GT] Written → ${OUT_JSONL}`);

  // Summary by section
  const bySec = {};
  for (const e of entries) bySec[e.section] = (bySec[e.section] ?? 0) + 1;
  console.log('[GT] Entries by section:', bySec);
}

main().catch(err => { console.error('[GT] Error:', err); process.exit(1); });
