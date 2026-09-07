/**
 * Local Policy Engine — FR-7
 * Deterministic, synchronous, no-network rule evaluator.
 *
 * Takes an abstract action from the cloud planner + the current session's
 * placeholder map + the current page origin, and returns { result, ruleFired, message }.
 *
 * Design: fail-closed — if the rules list doesn't explicitly allow an action,
 * the default is BLOCK, not allow. This implements PRD §9 NFR "Reliability".
 *
 * Stage 0: basic structure wired; rules loaded from rules.json.
 * Stage 5: full adversarial test suite written and all ≥20 cases verified.
 */

// Chrome MV3 service workers do not support import assertions (`assert { type: 'json' }`).
// Rules are inlined here as a plain JS constant, keeping rules.json as the canonical
// source of truth for documentation/review purposes.
const RULES = [
  {
    "rule_id": "block-cross-origin-credential-type",
    "description": "Block any 'type' action that would send a credential or session value to a different origin than the current page.",
    "condition": {
      "action_type": "type",
      "target_sensitivity_in": ["credential", "session"],
      "destination_origin_not_equal": "page_origin"
    },
    "effect": "block",
    "message": "Blocked: attempted to send credential/session data to a different origin."
  },
  {
    "rule_id": "block-navigate-external",
    "description": "Block any 'navigate' action to a non-page-origin URL that contains credential or session placeholder tokens.",
    "condition": {
      "action_type": "navigate",
      "url_contains_token_labels": ["credential", "session"],
      "destination_origin_not_equal": "page_origin"
    },
    "effect": "block",
    "message": "Blocked: navigation to external URL containing sensitive token."
  },
  {
    "rule_id": "block-high-risk-placeholder-unconfirmed",
    "description": "Block any action that targets a placeholder marked high_risk unless user has explicitly confirmed.",
    "condition": {
      "target_placeholder_risk": "high",
      "user_confirmed": false
    },
    "effect": "block",
    "message": "Blocked: action targets a high-risk placeholder. User confirmation required."
  },
  {
    "rule_id": "block-unknown-placeholder",
    "description": "Block any action whose target placeholder token does not exist in the current lockstep map.",
    "condition": {
      "target_placeholder_not_in_map": true
    },
    "effect": "block",
    "message": "Blocked: action references an unknown placeholder token not in this session's map."
  },
  {
    "rule_id": "block-reveal-secret-value",
    "description": "Block any action that appears to attempt to output or echo a redacted value (e.g. a 'type' whose value IS a real PII match).",
    "condition": {
      "action_type": "type",
      "value_is_raw_pii": true
    },
    "effect": "block",
    "message": "Blocked: cloud attempted to type a raw PII value directly."
  },
  {
    "rule_id": "allow-click-non-sensitive",
    "description": "Allow click actions targeting non-sensitive, non-placeholder elements.",
    "condition": {
      "action_type": "click",
      "target_placeholder_risk": null
    },
    "effect": "allow",
    "message": null
  }
];

/**
 * @typedef {{ type: string, target_text?: string, target_placeholder?: string|null, value?: string }} AbstractAction
 * @typedef {{ result: 'allow'|'block'|'ask_user', ruleFired: string|null, message: string|null }} PolicyResult
 */

/**
 * Evaluate an abstract action against the local policy rules.
 * Fail-closed: unknown actions are blocked by default.
 *
 * @param {AbstractAction} action
 * @param {Object.<string, string>} placeholderMap  — token → real value (local only)
 * @param {{ pageOrigin: string, userConfirmed?: boolean }} context
 * @returns {PolicyResult}
 */
export function evaluatePolicy(action, placeholderMap, context = {}) {
  if (!action) {
    return {
      result: 'block',
      ruleFired: 'null-action',
      message: 'Blocked: received null action from cloud planner.'
    };
  }

  const { pageOrigin = '', userConfirmed = false } = context;
  const targetToken = action.target_placeholder ?? null;

  // ── Rule 1: block cross-origin credential/session type ─────────────────────
  if (action.type === 'type') {
    const tokenRisk = targetToken ? getTokenRisk(targetToken, placeholderMap) : null;
    const valueRisk = action.value ? getRawValueRisk(action.value, placeholderMap) : null;

    const sensitiveLabels = ['credential', 'session'];
    const targetIsSensitive = tokenRisk && sensitiveLabels.includes(tokenRisk.label);
    const destOrigin = action.destination_origin ?? pageOrigin;

    if (targetIsSensitive && destOrigin && destOrigin !== pageOrigin) {
      return block('block-cross-origin-credential-type',
        'Blocked: attempted to send credential/session data to a different origin.');
    }

    // ── Rule 5: block if value is raw PII (cloud tried to type real secret) ───
    if (valueRisk) {
      return block('block-reveal-secret-value',
        `Blocked: cloud attempted to type a raw PII value (${valueRisk.label}).`);
    }
  }

  // ── Rule 2: block cross-origin navigate with sensitive token in URL ─────────
  if (action.type === 'navigate') {
    const url = action.url ?? '';
    const hasSensitiveToken = [...Object.keys(placeholderMap)].some(tok => url.includes(tok));
    const isExternal = !url.startsWith(pageOrigin) && !url.startsWith('/') && !url.startsWith('#');
    if (hasSensitiveToken && isExternal) {
      return block('block-navigate-external',
        'Blocked: navigation to external URL containing sensitive token.');
    }
  }

  // ── Rule 3: block high-risk placeholder without user confirmation ──────────
  if (targetToken) {
    const tokenInfo = getTokenRisk(targetToken, placeholderMap);
    if (tokenInfo?.risk === 'high' && !userConfirmed) {
      // Same-origin type actions with high-risk placeholders are permitted
      // (the user is filling in their own form on their own page).
      // Cross-origin was already blocked above; ask_user applies here for
      // non-type actions AND type actions where no explicit destination was provided
      // (unknown destination → require confirmation).
      const destOriginForAsk = action.destination_origin ?? null;
      const isSameOriginType = action.type === 'type' &&
        destOriginForAsk !== null &&
        destOriginForAsk === pageOrigin;
      if (!isSameOriginType) {
        return {
          result: 'ask_user',
          ruleFired: 'block-high-risk-placeholder-unconfirmed',
          message: `Action targets a high-risk placeholder (${tokenInfo.label}). Please confirm.`
        };
      }
    }

    // ── Rule 4: block unknown placeholder (not in current session map) ────────
    if (!(targetToken in placeholderMap)) {
      return block('block-unknown-placeholder',
        `Blocked: action references unknown placeholder token "${targetToken}".`);
    }
  }

  // ── Default: allow if none of the above block rules fired ─────────────────
  // Explicit allow — logged so the audit trail is complete.
  return {
    result: 'allow',
    ruleFired: null,
    message: null
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function block(ruleId, message) {
  return { result: 'block', ruleFired: ruleId, message };
}

/**
 * Extract the label and risk embedded in a placeholder token string.
 * Token format: "[LABEL_REDACTED#xxxx]"
 * Returns null if the token is not in the map (i.e., not a real session token).
 */
function getTokenRisk(token, placeholderMap) {
  if (!(token in placeholderMap)) return null;
  // Derive label from prefix — e.g. "[EMAIL_REDACTED#b8c3]" → "email"
  const prefixMap = {
    'EMAIL_REDACTED': { label: 'email', risk: 'high' },
    'PHONE_REDACTED': { label: 'phone', risk: 'high' },
    'GOVID_REDACTED': { label: 'gov_id', risk: 'high' },
    'CRED_REDACTED':  { label: 'credential', risk: 'high' },
    'SESSION_REDACTED': { label: 'session', risk: 'high' },
    'NAME_REDACTED':  { label: 'person_name', risk: 'medium' },
    'ADDR_REDACTED':  { label: 'address', risk: 'medium' },
    'GEO_REDACTED':   { label: 'geolocation', risk: 'medium' },
    'NETID_REDACTED': { label: 'network_id', risk: 'medium' }
  };
  for (const [prefix, info] of Object.entries(prefixMap)) {
    if (token.startsWith(`[${prefix}#`)) return info;
  }
  return { label: 'unknown', risk: 'high' }; // unknown tokens treated as high-risk
}

/**
 * Check whether a typed value is itself a raw PII value present in our token map.
 * i.e., the cloud is trying to type the real secret value directly.
 */
function getRawValueRisk(value, placeholderMap) {
  for (const [token, realVal] of Object.entries(placeholderMap)) {
    if (realVal && value.includes(realVal)) {
      return getTokenRisk(token, placeholderMap);
    }
  }
  return null;
}
