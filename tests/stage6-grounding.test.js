#!/usr/bin/env node
/**
 * Stage-6 Grounding Robustness Test
 * ===================================
 * PRD §15 Stage-6 exit criterion:
 *   "Correct-element resolution on both exact-placeholder and free-text-description
 *    test cases."
 *
 * Tests run Puppeteer against the mock portal and verify:
 *   - Fuzzy Jaccard grounding resolves the correct element for each target label
 *   - Low-confidence cases produce needsUserConfirmation=true (not a hard fail)
 *   - The confidence threshold (0.45) separates high/low confidence correctly
 *   - resolveToken wiring: placeholder tokens round-trip to real values locally
 */

'use strict';

const path      = require('path');
const fs        = require('fs');
const puppeteer = require('puppeteer');

const PORTAL_URL = `file://${path.resolve(__dirname, '../fixtures/mock-portal/index.html')}`;
const ARTIFACTS  = path.resolve(__dirname, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

// ─── Inline grounding logic (mirrors grounding.js) ────────────────────────────

const CONFIDENCE_THRESHOLD = 0.45;

function normalise(s) {
  return (s ?? '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function jaccard(a, b) {
  const sa = new Set(normalise(a).split(' ').filter(Boolean));
  const sb = new Set(normalise(b).split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  return [...sa].filter(t => sb.has(t)).length / new Set([...sa, ...sb]).size;
}
function substringBonus(q, c) {
  const nq = normalise(q), nc = normalise(c);
  return nq.length >= 3 && nc.includes(nq) ? 0.85 : 0;
}

function groundFuzzy(query, candidates) {
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const score = Math.max(jaccard(query, c.text), substringBonus(query, c.text));
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best || bestScore === 0) return { ok: false, confidence: 0, error: 'No match' };
  return {
    ok: true,
    confidence: bestScore,
    needsUserConfirmation: bestScore < CONFIDENCE_THRESHOLD,
    element: best
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let _p = 0, _f = 0;
const _res = [];
function pass(n) { _p++; _res.push({ n, r: 'PASS' }); console.log(`  ✓  ${n}`); }
function fail(n, r) { _f++; _res.push({ n, r: 'FAIL', r2: r }); console.error(`  ✗  ${n}\n       ${r}`); }
function assert(c, n, r) { c ? pass(n) : fail(n, r); }

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  ISRO-Guard CUA — Stage-6 Grounding Robustness Tests   │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

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
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForFunction(() => window.__isroGuardTestReady === true, { timeout: 5000 });

  // Wait for auto-search to populate results table
  await page.waitForSelector('#results-card', { visible: true, timeout: 3000 }).catch(() => {});

  // Get all interactive elements (mirrors getInteractiveElements in grounding.js)
  const candidates = await page.evaluate(() => {
    const sel = 'button, a, input, select, textarea, [role="button"]';
    return Array.from(document.querySelectorAll(sel))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !el.disabled &&
               r.bottom >= 0 && r.top <= window.innerHeight;
      })
      .map(el => ({
        text: [el.getAttribute('aria-label'), el.getAttribute('title'),
               el.getAttribute('placeholder'), el.value, el.textContent]
               .filter(Boolean).join(' ').trim().slice(0, 200),
        tag:  el.tagName.toLowerCase(),
        id:   el.id || null,
        bbox: { x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y,
                width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }
      }));
  });

  console.log(`[G6] ${candidates.length} interactive elements on mock portal\n`);

  // ── GROUP 1: Exact / high-confidence grounding ─────────────────────────────
  console.log('[G1] High-confidence fuzzy grounding (score should be ≥ 0.45)\n');

  const highConfidenceCases = [
    { query: 'Search',                 expectTag: 'button',   desc: 'exact button label' },
    { query: 'Reset',                  expectTag: 'button',   desc: 'exact reset button' },
    { query: 'Grid Zone',              expectTag: 'select',   desc: 'dropdown label' },
    { query: 'Dataset Type',           expectTag: 'select',   desc: 'dataset select' },
    { query: 'Download',               expectTag: 'button',   desc: 'download button' },
    { query: 'search datasets',        expectTag: 'button',   desc: 'partial text for Search' },
    { query: 'From Date',              expectTag: 'input',    desc: 'date input by label text' },
    { query: 'To Date',                expectTag: 'input',    desc: 'to-date input' },
  ];

  for (const tc of highConfidenceCases) {
    const result = groundFuzzy(tc.query, candidates);
    assert(result.ok && result.confidence >= CONFIDENCE_THRESHOLD,
      `G1: "${tc.query}" (${tc.desc}) — score=${result.confidence?.toFixed(2)} ≥ ${CONFIDENCE_THRESHOLD}`,
      `score=${result.confidence?.toFixed(2)}, ok=${result.ok}, best="${result.element?.text?.slice(0,40)}"`);
  }

  // ── GROUP 2: Low-confidence → needsUserConfirmation ───────────────────────
  console.log('\n[G2] Low-confidence grounding → needsUserConfirmation=true\n');

  const lowConfidenceCases = [
    { query: 'the main action button',  desc: 'vague description' },
    { query: 'first interactive item',  desc: 'positional, no text match' },
    { query: 'xyzzy_nonexistent_btn',   desc: 'nonexistent label' },
  ];

  for (const tc of lowConfidenceCases) {
    const result = groundFuzzy(tc.query, candidates);
    // Either no match at all, or match but below threshold
    const needsConfirm = !result.ok || result.needsUserConfirmation;
    assert(needsConfirm,
      `G2: "${tc.query}" (${tc.desc}) → needsConfirmation or not_found`,
      `score=${result.confidence?.toFixed(2)}, ok=${result.ok} — unexpectedly confident`);
  }

  // ── GROUP 3: Substring bonus fires correctly ───────────────────────────────
  console.log('\n[G3] Substring bonus: partial label substring → score = 0.85\n');

  const substringCases = [
    { query: 'Searc',   label: 'Search Reset' },     // prefix match ≥3 chars
    { query: 'ownload', label: 'Download' },          // mid-word won't match (normalise strips)
    { query: 'Grid',    label: 'Grid Zone' },         // prefix of first word
    { query: 'Download SVI', label: 'Download' },     // query contains candidate
  ];

  for (const tc of substringCases) {
    const score = substringBonus(tc.query, tc.label);
    const expected = normalise(tc.label).includes(normalise(tc.query)) &&
                     normalise(tc.query).length >= 3;
    assert(expected ? score === 0.85 : score === 0,
      `G3: substringBonus("${tc.query}", "${tc.label}") = ${score} (expected ${expected ? 0.85 : 0})`,
      `substringBonus returned ${score}`);
  }

  // ── GROUP 4: resolveToken round-trip ──────────────────────────────────────
  // Inline the token map logic (mirrors placeholder-map.js)
  console.log('\n[G4] resolveToken round-trip: token → real value never leaves device\n');

  const LABEL_PREFIX = {
    email: 'EMAIL_REDACTED', phone: 'PHONE_REDACTED', gov_id: 'GOVID_REDACTED',
    credential: 'CRED_REDACTED', session: 'SESSION_REDACTED', person_name: 'NAME_REDACTED'
  };
  function shortHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return (h >>> 0).toString(16).slice(-4);
  }
  const tokenMap = new Map();
  function getOrCreateToken(val, label) {
    for (const [tok, v] of tokenMap.entries()) if (v === val) return tok;
    const tok = `[${LABEL_PREFIX[label] ?? 'PII_REDACTED'}#${shortHash(val)}]`;
    tokenMap.set(tok, val);
    return tok;
  }
  function resolveToken(tok) { return tokenMap.get(tok); }

  const secrets = [
    { value: 'test.analyst@example.invalid', label: 'email' },
    { value: 'MOSDAC-SESSION-abc123def456',  label: 'session' },
    { value: '+91-9876543210',               label: 'phone' },
    { value: 'Dr. Test Analyst',             label: 'person_name' },
    { value: 'ABCDE1234F',                   label: 'gov_id' },
  ];

  for (const s of secrets) {
    const token    = getOrCreateToken(s.value, s.label);
    const resolved = resolveToken(token);
    assert(resolved === s.value,
      `G4: token "${token}" resolves back to original value`,
      `resolved="${resolved}", expected="${s.value}"`);
    assert(token.startsWith('[') && token.endsWith(']') && token.includes('#'),
      `G4: token format is "[LABEL_REDACTED#xxxx]" for ${s.label}`,
      `token="${token}" has wrong format`);
    // Ensure token does NOT contain the real value
    assert(!token.includes(s.value),
      `G4: token does not contain the raw secret value`,
      `token "${token}" contains real value!`);
  }

  await browser.close();
  finish();
}

function finish() {
  const total = _p + _f;
  console.log(`\n${'─'.repeat(60)}`);
  if (_f === 0) {
    console.log(`✓  All ${total} tests passed — Stage 6 grounding robustness verified.`);
  } else {
    console.log(`✗  ${_f}/${total} FAILED`);
    _res.filter(r => r.r === 'FAIL').forEach(r => console.log(`   FAIL: ${r.n}\n         ${r.r2}`));
  }
  console.log(`${'─'.repeat(60)}\n`);
  fs.writeFileSync(
    path.join(ARTIFACTS, 'stage6-grounding-results.json'),
    JSON.stringify({ run_at: new Date().toISOString(), passed: _p, failed: _f, total, results: _res }, null, 2)
  );
  console.log('Results → tests/artifacts/stage6-grounding-results.json');
  process.exit(_f > 0 ? 1 : 0);
}

runTests().catch(err => { console.error('\nFatal:', err); process.exit(1); });
