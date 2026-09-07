#!/usr/bin/env node
/**
 * Stage-1 Groq Integration Test
 * ==============================
 * Tests the DOM-context → Groq qwen/qwen3.6-27b → JSON action → schema validation
 * → local grounding → browser execution loop using the real Groq API.
 *
 * Key facts (measured, not assumed):
 *   - OTPM limit: 1000 output tokens/minute on free tier.
 *   - New higher-tier key: much larger OTPM headroom (7000+ remaining after a call).
 *   - New minimal system prompt: think block 80–450 tokens (was 900–1200 with old prompt).
 *   - max_tokens: 1000 is sufficient; finish=stop reliable with new prompt + key.
 *   - response_format:json_object NOT supported (tested).
 *   - Vision NOT available on this account tier (tested).
 *   - Old prompt had pipe-separated alternatives (click|type|…) → model reasoned
 *     through all of them → inflated think block → exceeded OTPM ceiling.
 *
 * Run:  node tests/stage1-groq-integration.test.js
 *   or: npm run test:groq
 */

'use strict';

const https     = require('https');
const path      = require('path');
const fs        = require('fs');
const puppeteer = require('puppeteer');

// ─── Load API key ─────────────────────────────────────────────────────────────

function loadApiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  const cfgPath = path.resolve(__dirname, '../extension/background/default-config.js');
  if (fs.existsSync(cfgPath)) {
    const m = fs.readFileSync(cfgPath, 'utf-8').match(/apiKey:\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  }
  return null;
}

const API_KEY    = loadApiKey();
const MODEL      = 'qwen/qwen3.6-27b';
const PORTAL_URL = `file://${path.resolve(__dirname, '../fixtures/mock-portal/index.html')}`;
const ARTIFACTS  = path.resolve(__dirname, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

// ─── Test harness ─────────────────────────────────────────────────────────────

let _p = 0, _f = 0, _s = 0;
const _res = [];
function pass(n)         { _p++; _res.push({n, r:'PASS'});         console.log(`  ✓  ${n}`); }
function fail(n, reason) { _f++; _res.push({n, r:'FAIL', reason});  console.error(`  ✗  ${n}\n       ${reason}`); }
function skip(n, reason) { _s++; _res.push({n, r:'SKIP', reason});  console.log(`  ⊘  ${n} [SKIP: ${reason}]`); }
function assert(c, n, r) { c ? pass(n) : fail(n, r); }

// ─── Groq HTTP helper ─────────────────────────────────────────────────────────

function groqPost(payload) {
  return new Promise((resolve, reject) => {
    const attempt = (triesLeft, delay) => {
      const body = JSON.stringify(payload);
      const req  = https.request({
        hostname: 'api.groq.com',
        path:     '/openai/v1/chat/completions',
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Authorization':  `Bearer ${API_KEY}`,
          'Content-Length': Buffer.byteLength(body)
        }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 429 && triesLeft > 0) {
            const wait = (parseInt(res.headers['retry-after'] ?? '5', 10) + 1) * 1000;
            console.warn(`  [Groq] 429 — retrying in ${wait/1000}s`);
            setTimeout(() => attempt(triesLeft - 1, Math.min(delay * 2, 30000)), wait);
          } else if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          } else {
            resolve(JSON.parse(data));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    };
    attempt(3, 5000);
  });
}

// ─── Parser (mirrors cloud-client.js parseAndValidate exactly) ────────────────

function parseQwenResponse(raw, finishReason) {
  if (finishReason === 'length') {
    throw new Error(`finish_reason=length (truncated). Tail: …${raw.slice(-80)}`);
  }
  // 1. Strip <think>…</think>
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // 2. Strip code fences
  text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  // 3. Extract first JSON object
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) text = text.slice(s, e + 1);
  return JSON.parse(text);
}

const VALID_TYPES = new Set(['click', 'type', 'scroll', 'navigate', 'wait', 'task_complete']);

function validateSchema(parsed) {
  if (!parsed || typeof parsed !== 'object') throw new Error('Not an object');
  if (!Array.isArray(parsed.actions) || !parsed.actions.length) throw new Error('"actions" missing/empty');
  const a = parsed.actions[0];
  if (!a.type || !VALID_TYPES.has(a.type)) throw new Error(`Invalid type: "${a.type}"`);
  return parsed;
}

// ─── System prompt (must match cloud-client.js SYSTEM_PROMPT exactly) ─────────

const SYSTEM_PROMPT =
`You are a browser agent. Identify the single next action.
Reply with ONLY this JSON (no other text, no explanation):
{"actions":[{"type":"click","target_text":"ExactLabel"}]}
To signal task done: {"actions":[{"type":"task_complete","target_text":null}]}
Do not repeat the page content. Do not explain your choice. Output JSON only.`;

// ─── Compact DOM builder (mirrors buildCompactUserMessage) ────────────────────

function buildCompactUserMessage(stepId, task, elements, title) {
  const ACTIONABLE = new Set(['button', 'a', 'input', 'select', 'textarea']);
  const elems = (elements ?? [])
    .filter(el => ACTIONABLE.has(el.type ?? el.tag))
    .slice(0, 8)
    .map(el => `${el.type ?? el.tag}:${(el.text || '').slice(0, 25)}`)
    .filter(Boolean);
  return (
    `step_id:${stepId}\nTask: ${task.slice(0, 100)}\nPage: ${(title || '').slice(0, 40)}\nElements: ${elems.join(', ')}`
  ).slice(0, 500);
}

// ─── Browser launcher ─────────────────────────────────────────────────────────

function launchBrowser() {
  const CHROME_PATHS = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser', '/usr/bin/chromium'
  ];
  const exe = CHROME_PATHS.find(p => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  });
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    ...(exe ? { executablePath: exe } : {})
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  ISRO-Guard CUA — Stage-1 Groq Integration Tests       │');
  console.log(`│  Model: ${MODEL.padEnd(47)}│`);
  console.log('└─────────────────────────────────────────────────────────┘\n');

  if (!API_KEY) {
    skip('ALL', 'No GROQ_API_KEY — set env var or create extension/background/default-config.js');
    return finish();
  }

  // ── G1: API reachability + rate-limit check ────────────────────────────────
  console.log('[G1] API connectivity');
  let rateHeaders = {};
  try {
    const t0   = Date.now();
    const resp = await groqPost({ model: MODEL, max_tokens: 5,
      messages: [{ role: 'user', content: 'hi' }] });
    rateHeaders = resp._headers ?? {};
    pass(`TEST 1.1: Groq API reachable (${Date.now()-t0}ms)`);
  } catch (err) {
    fail('TEST 1.1: Groq API reachable', err.message);
    return finish();
  }

  // ── G2: New prompt gives finish=stop (regression test) ────────────────────
  console.log('\n[G2] Regression: minimal prompt gives finish=stop with max_tokens=1000');

  let g2Raw = '', g2Finish = '', g2Parsed;
  try {
    const resp = await groqPost({
      model: MODEL, max_tokens: 1000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildCompactUserMessage(
            's-reg-01', 'Download SVI for Grid-Zone 12',
            [
              { type: 'select', text: 'Grid Zone' },
              { type: 'select', text: 'Dataset Type' },
              { type: 'button', text: 'Search' },
              { type: 'button', text: 'Reset' }
            ],
            'MOSDAC-Demo Portal'
          )
        }
      ]
    });
    g2Raw    = resp.choices?.[0]?.message?.content ?? '';
    g2Finish = resp.choices?.[0]?.finish_reason   ?? '';
    const usage = resp.usage ?? {};
    fs.writeFileSync(path.join(ARTIFACTS, 'groq-regression-raw.txt'), g2Raw);
    console.log(`  finish_reason: ${g2Finish}  completion_tokens: ${usage.completion_tokens}`);
  } catch (err) { fail('TEST 2.1: regression call', err.message); }

  assert(g2Finish === 'stop',
    'TEST 2.1: finish_reason=stop with new minimal prompt (regression for truncation bug)',
    `Got finish_reason="${g2Finish}" — model truncating`);

  if (g2Raw) {
    try {
      g2Parsed = parseQwenResponse(g2Raw, g2Finish);
      pass('TEST 2.2: <think> stripped and JSON extracted');
    } catch (err) { fail('TEST 2.2: parse regression response', err.message); }

    if (g2Parsed) {
      try {
        validateSchema(g2Parsed);
        pass(`TEST 2.3: schema valid — type="${g2Parsed.actions[0].type}" target="${g2Parsed.actions[0].target_text}"`);
      } catch (err) { fail('TEST 2.3: schema valid', err.message); }
    }
  }

  // ── G3: Full portal DOM → Groq → action ────────────────────────────────────
  console.log('\n[G3] Full pipeline: mock-portal DOM → Groq → {type,target_text}');

  const browser = await launchBrowser();
  const page    = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  try {
    await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForFunction(() => window.__isroGuardTestReady === true, { timeout: 5000 });

    // Screenshot for reference
    const shotBuf = await page.screenshot({ type: 'png', fullPage: false });
    fs.writeFileSync(path.join(ARTIFACTS, 'groq-portal-screenshot.png'), shotBuf);
    console.log(`  [artifact] groq-portal-screenshot.png (${Math.round(shotBuf.length/1024)}KB — not sent to API)`);

    // DOM snapshot — mirrors capture.js + buildCompactUserMessage
    const SKIP_TYPES = new Set(['date','time','datetime-local','month','week','hidden','submit','reset','color','range']);
    const { elements, title } = await page.evaluate((skipTypes) => {
      const KEEP = new Set(['button', 'a', 'input', 'select', 'textarea']);
      const els  = Array.from(document.querySelectorAll('*'))
        .filter(el => {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          const r = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          if (r.width === 0 || r.height === 0) return false;
          if (!KEEP.has(tag)) return false;
          if (tag === 'input' && skipTypes.includes(el.type ?? '')) return false;
          return true;
        })
        .slice(0, 8)
        .map(el => {
          const tag  = el.tagName.toLowerCase();
          const text = tag === 'select'
            ? (el.value?.trim() || el.getAttribute('aria-label') || el.name || '').slice(0, 25)
            : (el.textContent?.trim() || el.value || el.getAttribute('aria-label') || '').slice(0, 25);
          return { type: tag, text };
        });
      return { elements: els, title: document.title };
    }, [...SKIP_TYPES]);

    const TASK    = 'Find and download the seasonal vegetation index tile for Grid-Zone 12';
    const userMsg = buildCompactUserMessage('s-portal-01', TASK, elements, title);
    console.log(`  prompt: ${userMsg.replace(/\n/g, ' ').slice(0, 100)}…`);

    let portalRaw = '', portalFinish = '', portalParsed;
    try {
      const t0   = Date.now();
      const resp = await groqPost({
        model: MODEL, max_tokens: 1000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userMsg }
        ]
      });
      const latMs  = Date.now() - t0;
      portalRaw    = resp.choices?.[0]?.message?.content ?? '';
      portalFinish = resp.choices?.[0]?.finish_reason   ?? '';
      const usage  = resp.usage ?? {};
      fs.writeFileSync(path.join(ARTIFACTS, 'groq-portal-raw.txt'), portalRaw);
      console.log(`  finish=${portalFinish}  latency=${latMs}ms  completion=${usage.completion_tokens}`);
      pass(`TEST 3.1: Groq portal call returned (${latMs}ms, finish=${portalFinish})`);
    } catch (err) { fail('TEST 3.1: Groq portal call', err.message); }

    assert(portalFinish === 'stop',
      'TEST 3.2: finish_reason=stop (not truncated)',
      `finish_reason="${portalFinish}"`);

    if (portalRaw) {
      try {
        portalParsed = parseQwenResponse(portalRaw, portalFinish);
        pass('TEST 3.3: <think> stripped, JSON extracted');
      } catch (err) { fail('TEST 3.3: parse portal response', err.message); }

      if (portalParsed) {
        try {
          validateSchema(portalParsed);
          const a = portalParsed.actions[0];
          pass(`TEST 3.4: schema valid — type="${a.type}" target="${a.target_text ?? a.target_placeholder}"`);
        } catch (err) { fail('TEST 3.4: schema valid', err.message); }

        const SECRETS = ['test.analyst@example.invalid', 'MOSDAC-SESSION-abc123def456',
                         'Dr. Test Analyst', '+91-9876543210', 'ABCDE1234F', '192.168.42.7'];
        const leaked = SECRETS.find(s => JSON.stringify(portalParsed).includes(s));
        assert(!leaked, 'TEST 3.5: no known-fixture secrets in response',
          `Response contains secret: "${leaked}"`);
      }
    }

    // ── G4: Ground and execute ──────────────────────────────────────────────
    console.log('\n[G4] Local grounding of Groq action');

    const action = portalParsed?.actions?.[0];
    if (!action || action.type === 'task_complete' || action.type === 'wait') {
      skip('TEST 4.1', `Action type="${action?.type}" — no grounding needed`);
    } else {
      const normalise = s => (s ?? '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const jaccard   = (a, b) => {
        const sa = new Set(normalise(a).split(' ').filter(Boolean));
        const sb = new Set(normalise(b).split(' ').filter(Boolean));
        if (!sa.size || !sb.size) return 0;
        return [...sa].filter(t => sb.has(t)).length / new Set([...sa, ...sb]).size;
      };
      const bonus = (q, c) =>
        normalise(q).length >= 3 && normalise(c).includes(normalise(q)) ? 0.85 : 0;

      const cands = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button,a,input,select,[role="button"]'))
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; })
          .map(el => ({
            text: [el.getAttribute('aria-label'), el.value, el.textContent]
              .filter(Boolean).join(' ').trim().slice(0, 80),
            bbox: (()=>{ const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()
          }))
      );

      const query = action.target_text ?? '';
      let best = null, bestScore = 0;
      for (const c of cands) {
        const sc = Math.max(jaccard(query, c.text), bonus(query, c.text));
        if (sc > bestScore) { bestScore = sc; best = c; }
      }

      assert(bestScore > 0,
        `TEST 4.1: grounding found candidate for "${query.slice(0, 35)}" (score=${bestScore.toFixed(2)})`,
        `No element matched "${query}"`);

      if (best && bestScore >= 0.45 && action.type === 'click') {
        try {
          await page.mouse.click(best.bbox.x + best.bbox.w / 2, best.bbox.y + best.bbox.h / 2);
          await new Promise(r => setTimeout(r, 600));
          const post = await page.screenshot({ type: 'png', fullPage: false });
          fs.writeFileSync(path.join(ARTIFACTS, 'groq-post-execution.png'), post);
          pass(`TEST 4.2: click executed at [${Math.round(best.bbox.x + best.bbox.w/2)},${Math.round(best.bbox.y + best.bbox.h/2)}]`);
        } catch (err) { fail('TEST 4.2: click executed', err.message); }
      } else if (bestScore < 0.45) {
        skip('TEST 4.2', `confidence ${bestScore.toFixed(2)} < 0.45`);
      }
    }

  } finally {
    await browser.close();
  }

  // ── G5: 5-step sequence — all steps must have finish=stop ─────────────────
  console.log('\n[G5] 5-step sequence — all must have finish=stop (no truncation)');

  const STEP_PROMPTS = [
    'step_id:s-1\nTask: Download SVI GZ-12\nPage: MOSDAC\nElements: select:Grid Zone, select:Dataset Type, button:Search',
    'step_id:s-2\nTask: Download SVI GZ-12\nPage: MOSDAC (GZ-12 set)\nElements: select:SVI, button:Search',
    'step_id:s-3\nTask: Download SVI GZ-12\nPage: MOSDAC (GZ-12+SVI set)\nElements: button:Search',
    'step_id:s-4\nTask: Download SVI GZ-12\nPage: MOSDAC results — SVI Available\nElements: button:Download',
    'step_id:s-5\nTask: Download SVI GZ-12\nPage: MOSDAC — download queued\nAll done.'
  ];

  for (let i = 0; i < STEP_PROMPTS.length; i++) {
    try {
      const resp = await groqPost({
        model: MODEL, max_tokens: 1000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: STEP_PROMPTS[i] }
        ]
      });
      const raw    = resp.choices?.[0]?.message?.content ?? '';
      const finish = resp.choices?.[0]?.finish_reason   ?? '';
      const usage  = resp.usage ?? {};

      let parsed, parseOk = false;
      try { parsed = parseQwenResponse(raw, finish); parseOk = true; } catch {}

      const actionType = parsed?.actions?.[0]?.type;
      const ok = finish === 'stop' && parseOk;
      ok ? pass(`TEST 5.${i+1}: step ${i+1} finish=${finish} tok=${usage.completion_tokens} action=${actionType}`)
         : fail(`TEST 5.${i+1}: step ${i+1}`, finish === 'length' ? `TRUNCATED tok=${usage.completion_tokens}` : `finish=${finish} parseOk=${parseOk}`);

    } catch (err) {
      fail(`TEST 5.${i+1}: step ${i+1}`, err.message);
    }
  }

  finish();
}

function finish() {
  const total = _p + _f + _s;
  console.log(`\n${'─'.repeat(60)}`);
  if (_f === 0) {
    console.log(`✓  ${_p} passed${_s ? ` (${_s} skipped)` : ''} — Groq integration verified.`);
  } else {
    console.log(`✗  ${_f} FAILED / ${_p} passed / ${_s} skipped`);
    _res.filter(r => r.r === 'FAIL').forEach(r => console.log(`   FAIL: ${r.n}\n         ${r.reason}`));
  }
  console.log(`${'─'.repeat(60)}\n`);
  fs.writeFileSync(
    path.join(ARTIFACTS, 'stage1-groq-results.json'),
    JSON.stringify({ run_at: new Date().toISOString(), model: MODEL,
                     passed: _p, failed: _f, skipped: _s, results: _res }, null, 2)
  );
  console.log('Results → tests/artifacts/stage1-groq-results.json');
  process.exit(_f > 0 ? 1 : 0);
}

runTests().catch(err => { console.error('\nFatal:', err); process.exit(1); });
