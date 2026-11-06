/**
 * Public card requirements belong to each provider's catalog-requirements.json,
 * independently of executable packages and instruction versions. Keep this
 * protocol closed: it is intentional public copy, never company config, a
 * credential, browser state or a runtime capability/authorization declaration.
 * Backend and publisher consume a generated exact copy of this pure validator.
 * No provider IDs, versions, source paths or connection values are inferred.
 *
 * @typedef {{schemaVersion: 1, companySetup: boolean,
 * personalAccount: "required" | "optional" | "not_required",
 * authorization: "browser" | "token" | null, connectionLabel: string}} CatalogRequirements
 */

/** @param {unknown} value @returns {CatalogRequirements} */
export const normalizeCatalogRequirements = (value) => {
  const keys = ["schemaVersion", "companySetup", "personalAccount", "authorization", "connectionLabel"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error("Catalog requirements must contain exactly the five declared public fields.");
  }
  const input = /** @type {Record<string, unknown>} */ (value);
  if (input.schemaVersion !== 1 || typeof input.companySetup !== "boolean"
    || typeof input.personalAccount !== "string"
    || !["required", "optional", "not_required"].includes(input.personalAccount)
    || ![null, "browser", "token"].includes(/** @type {null | string} */ (input.authorization))
    || typeof input.connectionLabel !== "string" || !input.connectionLabel.trim()
    || input.connectionLabel.trim().length > 240 || /[\r\n\u0000-\u001f]/u.test(input.connectionLabel)
    || /~e1:|TRELIOE1/u.test(input.connectionLabel)) {
    throw new Error("Catalog requirements contain an unsupported version or invalid public value.");
  }
  // Return fresh closed data. Extra object properties/prototypes and raw source
  // JSON cannot accidentally escape into the public SQL DTO or release plan.
  return /** @type {CatalogRequirements} */ ({ schemaVersion: 1,
    companySetup: input.companySetup, personalAccount: input.personalAccount,
    authorization: input.authorization, connectionLabel: input.connectionLabel.trim() });
};
