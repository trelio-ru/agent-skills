// Adapted from avito-shopping-mcp, MIT, commit 27857b9ee0609a4f2100e5d65baf4fdde506d18c.
// The adjacent avito-shopping-mcp-LICENSE.txt retains the original license.
import { AvitoMcpError } from "./errors.mjs";

/**
 * Unwraps a field the response cannot be used without.
 * @param value Parsed field, `null`/`undefined` when absent or malformed.
 * @param path Dotted response path named in the error.
 * @returns The present value.
 * @throws AvitoMcpError `AVITO_RESPONSE_INVALID` when the field is missing.
 */
export function required   (value                      , path        )    {
  if (value === null || value === undefined) {
    throw new AvitoMcpError("AVITO_RESPONSE_INVALID", `Avito response is missing ${path}; the site format may have changed.`);
  }
  return value;
}

export function at(value         , ...keys          )          {
  let current          = value;
  for (const key of keys) {
    current = object(current)?.[key];
  }
  return current;
}

export function list(value         )                   {
  return Array.isArray(value) ? value : null;
}

export function array(value         )            {
  return list(value) ?? [];
}

export function object(value         )                    {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value              ) : null;
}

export function text(value         )                {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function integer(value         )                {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function decimal(value         )                {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

export function boolean(value         )                 {
  return typeof value === "boolean" ? value : null;
}

export function isPresent   (value          )             {
  return value !== null;
}
