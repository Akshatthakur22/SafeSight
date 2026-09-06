/**
 * DMPR — Regex/Pattern Rules for Structured PII Detection
 * FR-2: detects email, phone, government-ID formats, Indian-format identifiers,
 * session tokens, credential markers, and physical address fragments.
 *
 * Each rule has:
 *   id        — unique stable identifier (used in detections log)
 *   label     — PII category (matches §12.2 evaluation categories)
 *   pattern   — RegExp (global flag required for matchAll)
 *   risk      — 'high' | 'medium' (drives policy engine priority in Stage 5)
 */

export const REGEX_RULES = [
  // ── Email ──────────────────────────────────────────────────────────────────
  {
    id: 'email',
    label: 'email',
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    risk: 'high'
  },

  // ── Phone — international + Indian formats ─────────────────────────────────
  {
    id: 'phone_intl',
    label: 'phone',
    pattern: /(?:\+?91[-.\s]?)?[6-9]\d{9}\b/g,
    risk: 'high'
  },
  {
    id: 'phone_generic',
    label: 'phone',
    pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    risk: 'high'
  },

  // ── Aadhaar (12-digit, may be space/dash separated) ────────────────────────
  {
    id: 'aadhaar',
    label: 'gov_id',
    pattern: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
    risk: 'high'
  },

  // ── PAN Card (India) ───────────────────────────────────────────────────────
  {
    id: 'pan',
    label: 'gov_id',
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    risk: 'high'
  },

  // ── Passport (India: A-Z followed by 7 digits) ─────────────────────────────
  {
    id: 'passport',
    label: 'gov_id',
    pattern: /\b[A-PR-WYa-pr-wy][1-9]\d\s?\d{4}[1-9]\b/g,
    risk: 'high'
  },

  // ── IPv4 address (potential session/infra leak) ────────────────────────────
  {
    id: 'ipv4',
    label: 'network_id',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    risk: 'medium'
  },

  // ── JWT / Bearer token fragments ───────────────────────────────────────────
  {
    id: 'jwt',
    label: 'session',
    pattern: /\bey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
    risk: 'high'
  },

  // ── Generic hex session/API tokens (≥32 hex chars) ─────────────────────────
  {
    id: 'hex_token',
    label: 'session',
    pattern: /\b[0-9a-fA-F]{32,}\b/g,
    risk: 'high'
  },

  // ── Coordinate pairs (lat/lon — geospatial analyst behavior signal) ─────────
  {
    id: 'latlon',
    label: 'geolocation',
    pattern: /\b-?(?:90(?:\.0+)?|[1-8]?\d(?:\.\d+)?)\s*[,/]\s*-?(?:180(?:\.0+)?|1[0-7]\d(?:\.\d+)?|\d{1,2}(?:\.\d+)?)\b/g,
    risk: 'medium'
  },

  // ── Person name prefix heuristic (Dr./Mr./Mrs. + word) ─────────────────────
  // NOTE: This is a weak signal; the NER model in Stage 2 takes over for names.
  {
    id: 'name_prefix',
    label: 'person_name',
    pattern: /\b(?:Dr|Mr|Mrs|Ms|Prof|Shri|Smt)\.?\s+[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?\b/g,
    risk: 'medium'
  }
];

/**
 * Run all regex rules against a plain text string.
 * Returns an array of detection objects.
 *
 * @param {string} text
 * @param {string} [sourceId]  — identifies which DOM node / field this text came from
 * @returns {{ ruleId: string, label: string, risk: string, match: string, start: number, end: number, sourceId?: string }[]}
 */
export function runRegexRules(text, sourceId) {
  const results = [];
  for (const rule of REGEX_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      results.push({
        ruleId: rule.id,
        label: rule.label,
        risk: rule.risk,
        match: m[0],
        start: m.index,
        end: m.index + m[0].length,
        ...(sourceId !== undefined ? { sourceId } : {})
      });
    }
  }
  return results;
}
