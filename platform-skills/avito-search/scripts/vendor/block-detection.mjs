// Adapted from avito-shopping-mcp, MIT, commit 27857b9ee0609a4f2100e5d65baf4fdde506d18c.
// The adjacent avito-shopping-mcp-LICENSE.txt retains the original license.
import { object } from "./json-fields.mjs";

const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
const RATE_LIMITED_STATUS = 429;
// Qrator answers with 439 while the browser has not yet solved its JS proof-of-work.
const CHALLENGE_STATUS = 439;
const SESSION_REJECTED_STATUSES = new Set([401, 403]);
export const BLOCK_PAGE_TITLE_PREFIX = "Доступ ограничен";
const FIREWALL_PAGE_MARKER = 'class="firewall-container"';
const THROTTLE_JSON_KEY = "too-many-requests";

export function classifyResponse(response                  )                  {
  if (response.status === OK_STATUS) return "ok";
  if (response.status === CHALLENGE_STATUS) return "challenge";
  if (response.status === RATE_LIMITED_STATUS || isThrottleJson(response.text) || isFirewallPage(response.text)) {
    return "rate_limited";
  }
  if (SESSION_REJECTED_STATUSES.has(response.status)) return "session_rejected";
  if (response.status === NOT_FOUND_STATUS) return "not_found";
  return "unexpected";
}

export function isBlockPageTitle(title        )          {
  return title.trim().startsWith(BLOCK_PAGE_TITLE_PREFIX);
}

function isThrottleJson(body        )          {
  try {
    return object(JSON.parse(body))?.[THROTTLE_JSON_KEY] !== undefined;
  } catch {
    return false;
  }
}

function isFirewallPage(body        )          {
  return body.includes(FIREWALL_PAGE_MARKER);
}
