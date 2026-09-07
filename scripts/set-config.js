#!/usr/bin/env node
/**
 * Regenerate extension/background/default-config.js from environment variables
 * or CLI arguments.
 *
 * Usage:
 *   GROQ_API_KEY=gsk_xxx node scripts/set-config.js
 *   node scripts/set-config.js --provider groq --key gsk_xxx --model qwen/qwen3.6-27b
 *
 * The file is gitignored and loaded by the service worker on first install
 * to pre-populate chrome.storage.local without requiring the user to open
 * the popup Settings tab.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const args    = process.argv.slice(2);
const getArg  = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : null; };

const provider = getArg('--provider') ?? 'groq';
const key      = getArg('--key')      ?? process.env.GROQ_API_KEY  ?? process.env.API_KEY ?? '';
const model    = getArg('--model')    ?? 'qwen/qwen3.6-27b';

if (!key) {
  console.error('ERROR: No API key provided.');
  console.error('  Set GROQ_API_KEY env var, or pass --key <value>.');
  process.exit(1);
}

const outPath = path.resolve(__dirname, '../extension/background/default-config.js');
const content = `/**
 * Default configuration — loaded by the service worker on first install.
 * THIS FILE IS GITIGNORED — never commit it to source control.
 *
 * Regenerated: ${new Date().toISOString()}
 * Run:  node scripts/set-config.js [--provider <p>] [--key <k>] [--model <m>]
 */
export const DEFAULT_CONFIG = {
  apiProvider:         '${provider}',
  apiKey:              '${key}',
  apiModel:            '${model}',
  privacyEnabled:      true,
  confidenceThreshold: 0.45
};
`;

fs.writeFileSync(outPath, content, 'utf-8');
console.log(`✓ Wrote ${outPath}`);
console.log(`  provider: ${provider}  model: ${model}  key: ${key.slice(0,8)}…`);
