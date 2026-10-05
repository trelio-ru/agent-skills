#!/usr/bin/env node

/**
 * Build the content-addressed JSON package accepted by Trelio's signed runtime
 * publisher. This tool deliberately lives outside the plugin subtree: a
 * provider release must not depend on, mutate or rebuild the generic host.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PACKAGE_FORMAT = "trelio-agent-skill-package/v1";
const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const COMPANY_PRIVATE_SKILL_ID = /^(company-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const ALLOWED_CAPABILITIES = new Set([
  "browser",
  "local-session",
  "network",
  "secret-checkout",
]);
const ALLOWED_INTERPRETERS = new Set(["node", "python", "executable"]);
const ALLOWED_CONNECTION_FIELD_KINDS = new Set([
  "boolean",
  "integer",
  "literal",
  "text",
  "url",
]);
const ALLOWED_SECRET_VALIDATIONS = new Set(["hex32", "single-line-16-1024"]);
const ALLOWED_URL_POLICIES = new Set(["https", "public-https-base"]);
const CONNECTION_CONFIG_KEY = /^[a-z][A-Za-z0-9]{0,63}$/u;
const CONNECTION_SECRET_KEY = /^[a-z][a-z0-9_]{0,63}$/u;
const RELEASE_INPUT_ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{0,127}$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_RELEASE_INPUT_BYTES = 64 * 1024;
export const BROWSER_SESSION_DEFAULT_LEASE_MS = 30 * 60 * 1000;
export const BROWSER_SESSION_MAX_LEASE_MS = 6 * 60 * 60 * 1000;
const BROWSER_SESSION_CLASSES = new Set([
  "messenger-profile",
  "protected-snapshot",
  "delegated-ephemeral",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const assertObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
};

const assertExactKeys = (value, allowedKeys, label) => {
  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpectedKeys.join(", ")}.`);
  }
};

const assertSafeCopy = (value, label, maximumLength = 500) => {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || value.length > maximumLength
    || /[\0\r]/u.test(value)
  ) {
    throw new Error(`${label} must contain 1-${maximumLength} safe characters.`);
  }
  return value;
};

const assertOptionalSafeCopy = (value, label, maximumLength = 500) => {
  if (value === undefined) return;
  assertSafeCopy(value, label, maximumLength);
};

export const validateBrowserSessionDefinition = (rawDefinition, capabilities) => {
  if (rawDefinition === undefined || rawDefinition === null) return null;
  const definition = assertObject(rawDefinition, "runtime.browserSession");
  assertExactKeys(
    definition,
    new Set(["apiVersion", "sessionClass", "leaseMs", "manualAssist"]),
    "runtime.browserSession",
  );
  if (definition.apiVersion !== 1) {
    throw new Error("runtime.browserSession.apiVersion must equal 1.");
  }
  if (!BROWSER_SESSION_CLASSES.has(definition.sessionClass)) {
    throw new Error("runtime.browserSession.sessionClass is unsupported.");
  }
  const leaseMs = definition.leaseMs === undefined
    ? BROWSER_SESSION_DEFAULT_LEASE_MS
    : definition.leaseMs;
  if (
    !Number.isInteger(leaseMs)
    || leaseMs < 60_000
    || leaseMs > BROWSER_SESSION_MAX_LEASE_MS
  ) {
    throw new Error(
      `runtime.browserSession.leaseMs must be from 60000 to ${BROWSER_SESSION_MAX_LEASE_MS}.`,
    );
  }
  if (definition.manualAssist !== undefined && typeof definition.manualAssist !== "boolean") {
    throw new Error("runtime.browserSession.manualAssist must be boolean.");
  }
  if (!capabilities.includes("browser") || !capabilities.includes("local-session")) {
    throw new Error(
      "runtime.browserSession requires browser and local-session capabilities.",
    );
  }
  return {
    apiVersion: 1,
    sessionClass: definition.sessionClass,
    leaseMs,
    manualAssist: definition.manualAssist === true,
  };
};

/**
 * Validate only generic connection primitives understood by Trelio. Provider
 * manifests cannot inject executable validators or arbitrary regular
 * expressions into the control plane.
 */
export const validateConnectionDefinition = (rawDefinition) => {
  if (rawDefinition === null) return null;
  const definition = assertObject(rawDefinition, "connection");
  assertExactKeys(
    definition,
    new Set([
      "schemaVersion",
      "intro",
      "configFields",
      "deprecatedConfigKeys",
      "secretFields",
    ]),
    "connection",
  );
  if (definition.schemaVersion !== 1) {
    throw new Error("connection.schemaVersion must equal 1.");
  }
  if (!Array.isArray(definition.intro) || definition.intro.length > 6) {
    throw new Error("connection.intro must contain no more than 6 paragraphs.");
  }
  definition.intro.forEach((paragraph, index) => {
    assertSafeCopy(paragraph, `connection.intro[${index}]`, 1_000);
  });
  if (
    !Array.isArray(definition.configFields)
    || definition.configFields.length > 32
    || !Array.isArray(definition.secretFields)
    || definition.secretFields.length > 8
  ) {
    throw new Error("connection fields exceed their bounded limits.");
  }

  const configKeys = new Set();
  for (const [index, rawField] of definition.configFields.entries()) {
    const field = assertObject(rawField, `connection.configFields[${index}]`);
    if (!CONNECTION_CONFIG_KEY.test(String(field.key || ""))) {
      throw new Error(`connection.configFields[${index}].key is invalid.`);
    }
    if (configKeys.has(field.key)) {
      throw new Error(`Duplicate connection config key: ${field.key}.`);
    }
    configKeys.add(field.key);
    if (!ALLOWED_CONNECTION_FIELD_KINDS.has(field.kind)) {
      throw new Error(`Unsupported connection field kind: ${field.kind}.`);
    }
    const visibleKeys = ["key", "kind", "label", "required", "placeholder", "help"];
    const keysByKind = {
      boolean: [...visibleKeys, "default"],
      integer: [
        ...visibleKeys,
        "default",
        "minimum",
        "maximum",
        "displayMultiplier",
      ],
      literal: ["key", "kind", "value"],
      text: [...visibleKeys, "maximumLength", "multiline", "nullable"],
      url: [...visibleKeys, "urlPolicy", "nullable"],
    };
    assertExactKeys(
      field,
      new Set(keysByKind[field.kind]),
      `connection.configFields[${index}]`,
    );
    if (field.kind === "literal") {
      if (
        (typeof field.value === "string" && field.value.length > 500)
        || (
          typeof field.value === "number"
          && (!Number.isFinite(field.value) || Math.abs(field.value) > Number.MAX_SAFE_INTEGER)
        )
        || !["string", "number", "boolean"].includes(typeof field.value)
      ) {
        throw new Error(`Literal connection field ${field.key} requires a scalar value.`);
      }
      continue;
    }

    assertSafeCopy(field.label, `connection.configFields[${index}].label`, 160);
    assertOptionalSafeCopy(field.placeholder, `connection.configFields[${index}].placeholder`, 300);
    assertOptionalSafeCopy(field.help, `connection.configFields[${index}].help`, 1_000);
    if (field.required !== undefined && typeof field.required !== "boolean") {
      throw new Error(`connection field ${field.key} required must be boolean.`);
    }
    if (field.kind === "boolean") {
      if (typeof field.default !== "boolean") {
        throw new Error(`Boolean connection field ${field.key} requires a boolean default.`);
      }
    } else if (field.kind === "integer") {
      if (
        !Number.isSafeInteger(field.minimum)
        || !Number.isSafeInteger(field.maximum)
        || field.minimum > field.maximum
      ) {
        throw new Error(`Integer connection field ${field.key} has invalid bounds.`);
      }
      if (
        field.default !== undefined
        && (!Number.isSafeInteger(field.default)
          || field.default < field.minimum
          || field.default > field.maximum)
      ) {
        throw new Error(`Integer connection field ${field.key} has an invalid default.`);
      }
      if (
        field.displayMultiplier !== undefined
        && (!Number.isSafeInteger(field.displayMultiplier)
          || field.displayMultiplier < 1
          || field.displayMultiplier > 1_000_000_000)
      ) {
        throw new Error(`Integer connection field ${field.key} has an invalid displayMultiplier.`);
      }
    } else if (field.kind === "text") {
      if (!Number.isSafeInteger(field.maximumLength) || field.maximumLength < 1 || field.maximumLength > 10_000) {
        throw new Error(`Text connection field ${field.key} has an invalid maximumLength.`);
      }
      for (const flag of ["multiline", "nullable"]) {
        if (field[flag] !== undefined && typeof field[flag] !== "boolean") {
          throw new Error(`Text connection field ${field.key} ${flag} must be boolean.`);
        }
      }
    } else if (field.kind === "url") {
      if (!ALLOWED_URL_POLICIES.has(field.urlPolicy)) {
        throw new Error(`URL connection field ${field.key} has an unsupported policy.`);
      }
      if (field.nullable !== undefined && typeof field.nullable !== "boolean") {
        throw new Error(`URL connection field ${field.key} nullable must be boolean.`);
      }
    }
  }

  const deprecatedConfigKeys = definition.deprecatedConfigKeys ?? [];
  if (!Array.isArray(deprecatedConfigKeys) || deprecatedConfigKeys.length > 32) {
    throw new Error("connection.deprecatedConfigKeys must contain no more than 32 keys.");
  }
  const seenDeprecatedConfigKeys = new Set();
  for (const [index, key] of deprecatedConfigKeys.entries()) {
    if (!CONNECTION_CONFIG_KEY.test(String(key || ""))) {
      throw new Error(`connection.deprecatedConfigKeys[${index}] is invalid.`);
    }
    if (configKeys.has(key)) {
      throw new Error(`Deprecated connection config key ${key} is still active.`);
    }
    if (seenDeprecatedConfigKeys.has(key)) {
      throw new Error(`Duplicate deprecated connection config key: ${key}.`);
    }
    seenDeprecatedConfigKeys.add(key);
  }

  const requestKeys = new Set();
  const bindingKeys = new Set();
  for (const [index, rawField] of definition.secretFields.entries()) {
    const field = assertObject(rawField, `connection.secretFields[${index}]`);
    assertExactKeys(
      field,
      new Set([
        "requestKey",
        "bindingKey",
        "label",
        "requiredOnCreate",
        "validation",
        "name",
        "publicDescription",
        "placeholderNew",
        "placeholderExisting",
        "help",
      ]),
      `connection.secretFields[${index}]`,
    );
    if (!CONNECTION_CONFIG_KEY.test(String(field.requestKey || ""))) {
      throw new Error(`connection.secretFields[${index}].requestKey is invalid.`);
    }
    if (!CONNECTION_SECRET_KEY.test(String(field.bindingKey || ""))) {
      throw new Error(`connection.secretFields[${index}].bindingKey is invalid.`);
    }
    if (requestKeys.has(field.requestKey) || bindingKeys.has(field.bindingKey)) {
      throw new Error("Connection secret request and binding keys must be unique.");
    }
    requestKeys.add(field.requestKey);
    bindingKeys.add(field.bindingKey);
    if (field.requiredOnCreate !== true) {
      throw new Error(`Connection secret ${field.requestKey} must be required on first setup.`);
    }
    if (!ALLOWED_SECRET_VALIDATIONS.has(field.validation)) {
      throw new Error(`Connection secret ${field.requestKey} has an unsupported validator.`);
    }
    assertSafeCopy(field.label, `connection.secretFields[${index}].label`, 160);
    assertSafeCopy(field.name, `connection.secretFields[${index}].name`, 160);
    assertSafeCopy(
      field.publicDescription,
      `connection.secretFields[${index}].publicDescription`,
      500,
    );
    assertOptionalSafeCopy(field.placeholderNew, `connection.secretFields[${index}].placeholderNew`, 300);
    assertOptionalSafeCopy(
      field.placeholderExisting,
      `connection.secretFields[${index}].placeholderExisting`,
      300,
    );
    assertOptionalSafeCopy(field.help, `connection.secretFields[${index}].help`, 1_000);
  }
  return definition;
};

/**
 * Package paths have one portable meaning on macOS, Linux and Windows. Reject
 * unsafe input instead of normalizing it into a different path on one host.
 */
export const validatePackagePath = (rawPath, label = "package path") => {
  if (typeof rawPath !== "string" || !rawPath) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (
    rawPath.includes("\\")
    || rawPath.includes("\0")
    || path.posix.isAbsolute(rawPath)
    || rawPath.endsWith("/")
  ) {
    throw new Error(`${label} is not a safe relative POSIX path.`);
  }

  const normalized = path.posix.normalize(rawPath);
  const segments = normalized.split("/");
  if (
    normalized !== rawPath
    || segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || /[\u0000-\u001f\u007f:*?"<>|]/u.test(segment)
      || /[. ]$/u.test(segment)
      || WINDOWS_RESERVED_NAME.test(segment)
    ))
  ) {
    throw new Error(`${label} is not normalized or portable.`);
  }
  return normalized;
};

const readReleaseDefinition = (skillDirectory) => {
  const definitionPath = path.join(skillDirectory, "release.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${definitionPath}: ${error.message}`);
  }

  const definition = assertObject(parsed, "release.json");
  if (definition.schemaVersion !== 2) {
    throw new Error("release.json schemaVersion must equal 2.");
  }

  const release = assertObject(definition.release, "release");
  const runtime = assertObject(definition.runtime, "runtime");
  const entrypoint = assertObject(runtime.entrypoint, "runtime.entrypoint");
  if (!SKILL_ID.test(String(release.skillId || ""))) {
    throw new Error("release.skillId is invalid.");
  }
  const catalogSlug = release.catalogSlug === undefined
    ? release.skillId
    : String(release.catalogSlug);
  if (!SKILL_ID.test(catalogSlug)) {
    throw new Error("release.catalogSlug is invalid.");
  }
  if (release.catalogSlug !== undefined) {
    const privateIdentity = COMPANY_PRIVATE_SKILL_ID.exec(release.skillId);
    if (!privateIdentity || privateIdentity[2] !== catalogSlug) {
      throw new Error(
        "release.catalogSlug is allowed only for its exact tenant-namespaced company skill id.",
      );
    }
  }
  if (!STABLE_VERSION.test(String(release.version || ""))) {
    throw new Error("release.version must be stable SemVer.");
  }
  if (Object.hasOwn(release, "state")) {
    throw new Error("release.state is forbidden; live state belongs only to Trelio DB.");
  }
  if (path.basename(skillDirectory) !== catalogSlug) {
    throw new Error(
      "release skill identity must match the platform skill directory or its exact catalogSlug.",
    );
  }
  if (!STABLE_VERSION.test(String(runtime.version || ""))) {
    throw new Error("runtime.version must be stable SemVer.");
  }
  if (!STABLE_VERSION.test(String(runtime.minimumHostVersion || ""))) {
    throw new Error("runtime.minimumHostVersion must be stable SemVer.");
  }
  if (!ALLOWED_INTERPRETERS.has(entrypoint.interpreter)) {
    throw new Error("runtime.entrypoint.interpreter is unsupported.");
  }
  const entrypointPath = validatePackagePath(
    entrypoint.path,
    "runtime.entrypoint.path",
  );

  if (!Array.isArray(runtime.capabilities)) {
    throw new Error("runtime.capabilities must be an array.");
  }
  const capabilities = runtime.capabilities.map((capability) => {
    if (!ALLOWED_CAPABILITIES.has(capability)) {
      throw new Error(`Unsupported runtime capability: ${capability}.`);
    }
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("runtime.capabilities must not contain duplicates.");
  }
  const browserSession = validateBrowserSessionDefinition(
    runtime.browserSession,
    capabilities,
  );
  if (!Array.isArray(runtime.files) || runtime.files.length === 0) {
    throw new Error("runtime.files must contain at least one file.");
  }

  const connectionDefinition = validateConnectionDefinition(definition.connection);

  return {
    definitionPath,
    release,
    catalogSlug,
    runtime,
    entrypointPath,
    capabilities,
    browserSession,
    connectionDefinition,
  };
};

/**
 * Return package bytes and safe metadata without signing. Signing remains a
 * backend trust assertion; keeping private keys out of this repository is an
 * intentional boundary, not a missing build step.
 */
export const buildRuntimePackage = (
  rawSkillDirectory,
  { environment = process.env } = {},
) => {
  const skillDirectory = path.resolve(rawSkillDirectory);
  const definition = readReleaseDefinition(skillDirectory);
  const seenPackagePaths = new Set();
  const files = definition.runtime.files.map((rawFile, index) => {
    const file = assertObject(rawFile, `runtime.files[${index}]`);
    assertExactKeys(
      file,
      new Set(["source", "sourceEnvironment", "releaseInputExposure", "path", "mode"]),
      `runtime.files[${index}]`,
    );
    const hasRepositorySource = Object.hasOwn(file, "source");
    const hasEnvironmentSource = Object.hasOwn(file, "sourceEnvironment");
    if (hasRepositorySource === hasEnvironmentSource) {
      throw new Error(
        `runtime.files[${index}] must declare exactly one of source or sourceEnvironment.`,
      );
    }
    if (
      (hasEnvironmentSource && file.releaseInputExposure !== "package-recipient")
      || (hasRepositorySource && Object.hasOwn(file, "releaseInputExposure"))
    ) {
      throw new Error(
        `runtime.files[${index}].releaseInputExposure must explicitly equal package-recipient only for sourceEnvironment.`,
      );
    }
    const packagePath = validatePackagePath(
      file.path,
      `runtime.files[${index}].path`,
    );
    const portablePackagePath = packagePath.toLocaleLowerCase("en-US");
    if (seenPackagePaths.has(portablePackagePath)) {
      throw new Error(`Duplicate or case-colliding package path: ${packagePath}.`);
    }
    seenPackagePaths.add(portablePackagePath);

    if (file.mode !== 0o644 && file.mode !== 0o755) {
      throw new Error(`runtime.files[${index}].mode must be 420 or 493.`);
    }
    let bytes;
    if (hasRepositorySource) {
      const sourcePath = validatePackagePath(
        file.source,
        `runtime.files[${index}].source`,
      );
      const absoluteSourcePath = path.resolve(skillDirectory, sourcePath);
      const relativeSourcePath = path.relative(skillDirectory, absoluteSourcePath);
      if (
        relativeSourcePath.startsWith("..")
        || path.isAbsolute(relativeSourcePath)
      ) {
        throw new Error(`Runtime source escapes the skill directory: ${sourcePath}.`);
      }

      const stat = fs.lstatSync(absoluteSourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Runtime source must be a regular non-symlink file: ${sourcePath}.`);
      }
      bytes = fs.readFileSync(absoluteSourcePath);
      if (bytes.length === 0) {
        throw new Error(`Runtime source is empty: ${sourcePath}.`);
      }
    } else {
      const sourceEnvironment = String(file.sourceEnvironment || "");
      if (!RELEASE_INPUT_ENVIRONMENT_KEY.test(sourceEnvironment)) {
        throw new Error(`runtime.files[${index}].sourceEnvironment is invalid.`);
      }
      const releaseInput = environment[sourceEnvironment];
      if (typeof releaseInput !== "string" || releaseInput.length === 0) {
        throw new Error(
          `Runtime release input ${sourceEnvironment} is missing or empty.`,
        );
      }
      bytes = Buffer.from(releaseInput, "utf8");
      if (bytes.length > MAX_RELEASE_INPUT_BYTES) {
        throw new Error(
          `Runtime release input ${sourceEnvironment} exceeds ${MAX_RELEASE_INPUT_BYTES} bytes.`,
        );
      }
      // The manifest's explicit package-recipient declaration makes this
      // threat-model choice reviewable. Environment-backed bytes are
      // distributable package material, not a secret checkout: their value is
      // omitted from every diagnostic, while the final package remains
      // extractable by anyone authorized to download that immutable release.
    }
    return {
      path: packagePath,
      mode: file.mode,
      sha256: sha256(bytes),
      contentBase64: bytes.toString("base64"),
    };
  });

  if (!seenPackagePaths.has(definition.entrypointPath.toLocaleLowerCase("en-US"))) {
    throw new Error("runtime.entrypoint.path is missing from runtime.files.");
  }
  const entrypointFile = files.find((file) => file.path === definition.entrypointPath);
  if (definition.runtime.entrypoint.interpreter === "executable" && entrypointFile?.mode !== 0o755) {
    throw new Error("An executable entrypoint must use mode 0755.");
  }

  // Property order and compact JSON are fixed so identical source produces
  // identical package bytes and therefore the same package SHA-256 everywhere.
  const runtimePackage = {
    format: PACKAGE_FORMAT,
    skill: {
      id: definition.release.skillId,
      runtimeVersion: definition.runtime.version,
    },
    entrypoint: {
      path: definition.entrypointPath,
      interpreter: definition.runtime.entrypoint.interpreter,
    },
    capabilities: definition.capabilities,
    ...(definition.browserSession
      ? { browserSession: definition.browserSession }
      : {}),
    files,
  };
  // The final LF is part of the canonical package bytes. Besides keeping the
  // artifact a normal text file, it reproduces already published packages
  // byte-for-byte when their source and manifest are unchanged.
  const packageBytes = Buffer.from(`${JSON.stringify(runtimePackage)}\n`, "utf8");

  return {
    definitionPath: definition.definitionPath,
    skillId: definition.release.skillId,
    catalogSlug: definition.catalogSlug,
    skillVersion: definition.release.version,
    runtimeVersion: definition.runtime.version,
    minimumHostVersion: definition.runtime.minimumHostVersion,
    connectionDefinition: definition.connectionDefinition,
    packageBytes,
    packageSha256: sha256(packageBytes),
    packageSizeBytes: packageBytes.length,
    manifest: {
      format: runtimePackage.format,
      skill: runtimePackage.skill,
      entrypoint: runtimePackage.entrypoint,
      capabilities: runtimePackage.capabilities,
      ...(runtimePackage.browserSession
        ? { browserSession: runtimePackage.browserSession }
        : {}),
      files: files.map(({ contentBase64: _contentBase64, ...file }) => ({
        ...file,
        sizeBytes: Buffer.from(contentBase64For(file, runtimePackage), "base64").length,
      })),
    },
  };
};

/** Locate original base64 after the content-free manifest projection above. */
const contentBase64For = (manifestFile, runtimePackage) => (
  runtimePackage.files.find((file) => file.path === manifestFile.path)?.contentBase64 || ""
);

const parseArguments = (argv) => {
  const options = {
    skillDirectory: "",
    outputPath: "",
    check: false,
    expectedSkillVersion: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--skill-dir") options.skillDirectory = argv[++index] || "";
    else if (argument === "--output") options.outputPath = argv[++index] || "";
    else if (argument === "--check") options.check = true;
    else if (argument === "--expect-skill-version") {
      options.expectedSkillVersion = argv[++index] || "";
    } else {
      throw new Error(`Unknown argument: ${argument}.`);
    }
  }
  if (!options.skillDirectory) throw new Error("--skill-dir is required.");
  if (options.check === Boolean(options.outputPath)) {
    throw new Error("Choose exactly one of --check or --output.");
  }
  return options;
};

const run = () => {
  const options = parseArguments(process.argv.slice(2));
  const result = buildRuntimePackage(options.skillDirectory);
  if (
    options.expectedSkillVersion
    && result.skillVersion !== options.expectedSkillVersion
  ) {
    throw new Error(
      `Tag expects skill version ${options.expectedSkillVersion}, `
      + `but release.json declares ${result.skillVersion}.`,
    );
  }

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, result.packageBytes, { mode: 0o600 });
    fs.renameSync(temporaryPath, outputPath);
  }

  process.stdout.write(`${JSON.stringify({
    skillId: result.skillId,
    skillVersion: result.skillVersion,
    runtimeVersion: result.runtimeVersion,
    minimumHostVersion: result.minimumHostVersion,
    hasConnection: result.connectionDefinition !== null,
    packageSha256: result.packageSha256,
    packageSizeBytes: result.packageSizeBytes,
    outputPath: options.outputPath ? path.resolve(options.outputPath) : null,
  })}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
