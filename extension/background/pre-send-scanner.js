/**
 * Pre-Send Zero-Secret-Leak Scanner — FR-5 / PRD §11.1
 *
 * Ground rule 4 from the build prompt: this scanner MUST be built and pass
 * before any real network call to a cloud model is made.
 *
 * How it works:
 *   - Maintains a "known secrets" fixture list (loaded from storage or injected
 *     by the test harness).
 *   - Before every outbound request, scans EVERY string in the payload for
 *     substring matches against that list.
 *   - If any match is found: reports a violation.
 *   - From Stage 2 onwards, the cloud-client treats a violation as a hard block.
 *
 * The fixture list for tests lives in tests/fixtures/known-secrets.json.
 * In a live session it's populated from the placeholder map's real values.
 */

/** @type {Set<string>} — populated at runtime */
const _knownSecrets = new Set();

/**
 * Register a known secret value (called by the redaction layer when it stores
 * a real value in the placeholder map).
 *
 * @param {string} value
 */
export function registerSecret(value) {
  if (value && value.trim()) _knownSecrets.add(value.trim());
}

/**
 * Replace the known-secrets set entirely (used by the test harness to inject
 * a fixture list before each test run).
 *
 * @param {string[]} secrets
 */
export function setKnownSecrets(secrets) {
  _knownSecrets.clear();
  for (const s of secrets) {
    if (s && s.trim()) _knownSecrets.add(s.trim());
  }
}

/** Return a copy of the current known-secrets set (for test assertions). */
export function getKnownSecrets() {
  return new Set(_knownSecrets);
}

/**
 * Scan a payload object (all string values, recursively) for known-secret substrings.
 *
 * @param {object|string} payload — the object or string to scan
 * @returns {{ ok: boolean, violations: Array<{ secret: string, field: string, context: string }> }}
 */
export async function runPreSendScanner(payload) {
  if (_knownSecrets.size === 0) {
    // No secrets registered yet — nothing to check (normal in Stage 0 before
    // the placeholder map has been populated).
    return { ok: true, violations: [] };
  }

  const violations = [];

  function scanValue(value, fieldPath) {
    if (typeof value !== 'string') return;
    for (const secret of _knownSecrets) {
      if (secret.length >= 4 && value.includes(secret)) {
        violations.push({
          secret: `[REDACTED — ${secret.length} chars]`, // never log the secret itself
          field: fieldPath,
          context: value.slice(Math.max(0, value.indexOf(secret) - 20), value.indexOf(secret) + secret.length + 20)
            .replace(secret, '[SECRET_HERE]')
        });
      }
    }
  }

  function recurse(obj, path) {
    if (typeof obj === 'string') {
      scanValue(obj, path);
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => recurse(item, `${path}[${i}]`));
    } else if (obj && typeof obj === 'object') {
      for (const [key, val] of Object.entries(obj)) {
        recurse(val, path ? `${path}.${key}` : key);
      }
    }
  }

  recurse(payload, '');

  return {
    ok: violations.length === 0,
    violations
  };
}
