import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRuntimePackage,
  BROWSER_SESSION_DEFAULT_LEASE_MS,
  BROWSER_SESSION_MAX_LEASE_MS,
  PACKAGE_FORMAT,
  validateBrowserSessionDefinition,
  validateConnectionDefinition,
  validatePackagePath,
} from "./build-runtime-package.mjs";

const writeFixture = (root, overrides = {}) => {
  const skillDirectory = path.join(root, "fixture-skill");
  fs.mkdirSync(path.join(skillDirectory, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDirectory, "scripts", "runtime.mjs"),
    "#!/usr/bin/env node\nconsole.log('ok');\n",
  );
  fs.writeFileSync(
    path.join(skillDirectory, "release.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      release: {
        skillId: "fixture-skill",
        version: "1.2.3",
        summary: "Test fixture",
      },
      connection: null,
      runtime: {
        version: "2.3.4",
        minimumHostVersion: "1.4.0",
        entrypoint: { path: "runtime.mjs", interpreter: "node" },
        capabilities: ["network"],
        files: [{
          source: "scripts/runtime.mjs",
          path: "runtime.mjs",
          mode: 493,
        }],
      },
      ...overrides,
    }, null, 2)}\n`,
  );
  return skillDirectory;
};

test("runtime package build is deterministic and content-addressed", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-runtime-build-"));
  try {
    const skillDirectory = writeFixture(temporaryRoot);
    const first = buildRuntimePackage(skillDirectory);
    const second = buildRuntimePackage(skillDirectory);
    const parsed = JSON.parse(first.packageBytes.toString("utf8"));

    assert.equal(first.packageSha256, second.packageSha256);
    assert.deepEqual(first.packageBytes, second.packageBytes);
    assert.equal(parsed.format, PACKAGE_FORMAT);
    assert.deepEqual(parsed.skill, {
      id: "fixture-skill",
      runtimeVersion: "2.3.4",
    });
    assert.equal(parsed.files[0].path, "runtime.mjs");
    assert.match(parsed.files[0].sha256, /^[0-9a-f]{64}$/u);
    assert.equal(first.manifest.files[0].contentBase64, undefined);
    assert.equal(first.manifest.files[0].sizeBytes, 39);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("browser-session definition is normalized into the signed package", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-browser-session-build-"));
  try {
    const skillDirectory = writeFixture(temporaryRoot);
    const definitionPath = path.join(skillDirectory, "release.json");
    const definition = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
    definition.runtime.capabilities = ["browser", "local-session", "network"];
    definition.runtime.browserSession = {
      apiVersion: 1,
      sessionClass: "messenger-profile",
      manualAssist: true,
    };
    fs.writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);

    const result = buildRuntimePackage(skillDirectory);
    const parsed = JSON.parse(result.packageBytes.toString("utf8"));
    assert.deepEqual(parsed.browserSession, {
      apiVersion: 1,
      sessionClass: "messenger-profile",
      leaseMs: BROWSER_SESSION_DEFAULT_LEASE_MS,
      manualAssist: true,
    });
    assert.deepEqual(result.manifest.browserSession, parsed.browserSession);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("browser-session definition rejects unsafe combinations and leases over six hours", () => {
  assert.throws(
    () => validateBrowserSessionDefinition({
      apiVersion: 1,
      sessionClass: "protected-snapshot",
    }, ["network"]),
    /requires browser and local-session/u,
  );
  assert.throws(
    () => validateBrowserSessionDefinition({
      apiVersion: 1,
      sessionClass: "delegated-ephemeral",
      leaseMs: BROWSER_SESSION_MAX_LEASE_MS + 1,
    }, ["browser", "local-session"]),
    /leaseMs/u,
  );
});

test("release-only environment input is embedded without entering source metadata", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-runtime-input-"));
  try {
    const skillDirectory = writeFixture(temporaryRoot);
    const definitionPath = path.join(skillDirectory, "release.json");
    const definition = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
    definition.runtime.files.push({
      sourceEnvironment: "FIXTURE_DISTRIBUTABLE_INPUT",
      releaseInputExposure: "package-recipient",
      path: "release-input.json",
      mode: 420,
    });
    fs.writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);

    const distributableInput = '{"client_id":"fixture","client_key":"synthetic"}';
    const result = buildRuntimePackage(skillDirectory, {
      environment: { FIXTURE_DISTRIBUTABLE_INPUT: distributableInput },
    });
    const parsed = JSON.parse(result.packageBytes.toString("utf8"));
    const embeddedFile = parsed.files.find((file) => file.path === "release-input.json");

    assert.equal(
      Buffer.from(embeddedFile.contentBase64, "base64").toString("utf8"),
      distributableInput,
    );
    assert.equal(result.manifest.files[1].contentBase64, undefined);
    assert.doesNotMatch(JSON.stringify(result.manifest), /synthetic/u);
    assert.doesNotMatch(fs.readFileSync(definitionPath, "utf8"), /synthetic/u);
    assert.throws(
      () => buildRuntimePackage(skillDirectory, { environment: {} }),
      /FIXTURE_DISTRIBUTABLE_INPUT is missing or empty/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime file cannot combine repository and release-only sources", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-runtime-source-"));
  try {
    const skillDirectory = writeFixture(temporaryRoot);
    const definitionPath = path.join(skillDirectory, "release.json");
    const definition = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
    definition.runtime.files[0].sourceEnvironment = "FIXTURE_DISTRIBUTABLE_INPUT";
    definition.runtime.files[0].releaseInputExposure = "package-recipient";
    fs.writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);

    assert.throws(
      () => buildRuntimePackage(skillDirectory, {
        environment: { FIXTURE_DISTRIBUTABLE_INPUT: "fixture" },
      }),
      /exactly one of source or sourceEnvironment/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("release-only input requires an explicit extractability declaration", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-runtime-exposure-"));
  try {
    const skillDirectory = writeFixture(temporaryRoot);
    const definitionPath = path.join(skillDirectory, "release.json");
    const definition = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
    definition.runtime.files.push({
      sourceEnvironment: "FIXTURE_DISTRIBUTABLE_INPUT",
      path: "release-input.json",
      mode: 420,
    });
    fs.writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);

    assert.throws(
      () => buildRuntimePackage(skillDirectory, {
        environment: { FIXTURE_DISTRIBUTABLE_INPUT: "fixture" },
      }),
      /releaseInputExposure.*package-recipient/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("company-private package keeps tenant identity in a catalog-slug directory", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-private-runtime-"));
  try {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const skillDirectory = writeFixture(temporaryRoot, {
      release: {
        skillId: `company-${companyId}-fixture-skill`,
        catalogSlug: "fixture-skill",
        version: "1.2.3",
        summary: "Company-private fixture",
      },
    });
    const result = buildRuntimePackage(skillDirectory);
    const parsed = JSON.parse(result.packageBytes.toString("utf8"));

    assert.equal(result.catalogSlug, "fixture-skill");
    assert.equal(parsed.skill.id, `company-${companyId}-fixture-skill`);

    fs.writeFileSync(
      path.join(skillDirectory, "release.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        release: {
          skillId: `company-${companyId}-another-skill`,
          catalogSlug: "fixture-skill",
          version: "1.2.3",
          summary: "Mismatched private fixture",
        },
        connection: null,
        runtime: {
          version: "2.3.4",
          minimumHostVersion: "1.4.0",
          entrypoint: { path: "runtime.mjs", interpreter: "node" },
          capabilities: ["network"],
          files: [{
            source: "scripts/runtime.mjs",
            path: "runtime.mjs",
            mode: 493,
          }],
        },
      }, null, 2)}\n`,
    );
    assert.throws(
      () => buildRuntimePackage(skillDirectory),
      /exact tenant-namespaced company skill id/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("portable package paths fail closed", () => {
  for (const unsafePath of ["../runtime.mjs", "runtime\\main.mjs", "CON", "a/../b"]) {
    assert.throws(() => validatePackagePath(unsafePath), /safe|normalized|portable/u);
  }
});

test("connection definition allows bounded generic fields without provider code", () => {
  assert.deepEqual(validateConnectionDefinition({
    schemaVersion: 1,
    intro: ["Настройте общее подключение."],
    configFields: [
      {
        key: "apiId",
        kind: "integer",
        label: "API id",
        required: true,
        minimum: 1,
        maximum: 100,
      },
    ],
    secretFields: [
      {
        requestKey: "apiHash",
        bindingKey: "api_hash",
        label: "API hash",
        requiredOnCreate: true,
        validation: "hex32",
        name: "API hash",
        publicDescription: "Общий секрет подключения.",
      },
    ],
  }).configFields.map((field) => field.key), ["apiId"]);

  assert.deepEqual(validateConnectionDefinition({
    schemaVersion: 1,
    intro: ["Credentials are managed by the installation."],
    configFields: [{
      key: "allowAutonomous",
      kind: "boolean",
      label: "Allow autonomous",
      default: true,
    }],
    deprecatedConfigKeys: ["apiId"],
    secretFields: [],
  }).deprecatedConfigKeys, ["apiId"]);

  assert.throws(
    () => validateConnectionDefinition({
      schemaVersion: 1,
      intro: [],
      configFields: [{
        key: "apiId",
        kind: "integer",
        label: "API id",
        minimum: 1,
        maximum: 100,
      }],
      deprecatedConfigKeys: ["apiId"],
      secretFields: [],
    }),
    /still active/u,
  );

  assert.throws(
    () => validateConnectionDefinition({
      schemaVersion: 1,
      intro: [],
      configFields: [],
      secretFields: [{
        requestKey: "token",
        bindingKey: "token",
        label: "Token",
        requiredOnCreate: true,
        validation: "provider-regex",
        name: "Token",
        publicDescription: "Token",
      }],
    }),
    /unsupported validator/u,
  );

  assert.throws(
    () => validateConnectionDefinition({
      schemaVersion: 1,
      intro: [],
      configFields: [{
        key: "endpoint",
        kind: "url",
        label: "Endpoint",
        urlPolicy: "https",
        default: "https://example.com/",
      }],
      secretFields: [],
    }),
    /unsupported fields/u,
  );
});

test("Git release state cannot become a second production pointer", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-runtime-state-"));
  try {
    const skillDirectory = writeFixture(temporaryRoot, {
      release: {
        skillId: "fixture-skill",
        version: "1.2.3",
        state: "current",
        summary: "Invalid state fixture",
      },
    });
    assert.throws(() => buildRuntimePackage(skillDirectory), /state is forbidden/u);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime sources cannot be symlinks", (context) => {
  if (process.platform === "win32") {
    context.skip("A non-elevated Windows runner cannot create this symlink fixture.");
    return;
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-runtime-link-"));
  try {
    const skillDirectory = writeFixture(temporaryRoot);
    const runtimePath = path.join(skillDirectory, "scripts", "runtime.mjs");
    fs.unlinkSync(runtimePath);
    fs.symlinkSync(path.join(temporaryRoot, "outside.mjs"), runtimePath);
    assert.throws(
      () => buildRuntimePackage(skillDirectory),
      /regular non-symlink file/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});


test("personal accounts need an enforcing host and cannot bind company secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-account-capability-"));
  try {
    const directory = writeFixture(root), file = path.join(directory, "release.json");
    const definition = JSON.parse(fs.readFileSync(file, "utf8"));
    definition.runtime.capabilities = ["local-session", "local-accounts-v1"];
    fs.writeFileSync(file, JSON.stringify(definition));
    assert.throws(() => buildRuntimePackage(directory), /host 3.7.0/);
    definition.runtime.minimumHostVersion = "3.7.0";
    fs.writeFileSync(file, JSON.stringify(definition));
    assert.ok(buildRuntimePackage(directory).manifest.capabilities.includes("local-accounts-v1"));
    definition.runtime.capabilities.push("secret-checkout");
    fs.writeFileSync(file, JSON.stringify(definition));
    assert.throws(() => buildRuntimePackage(directory));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
