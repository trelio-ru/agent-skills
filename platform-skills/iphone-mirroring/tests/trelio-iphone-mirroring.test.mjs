import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  IphoneMirroringRuntimeError,
  buildHelperInvocation,
  runRuntime,
} from "../scripts/trelio-iphone-mirroring.mjs";
import { buildRuntimePackage } from "../../tools/build-runtime-package.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "..");
test("runtime rejects every non-macOS surface before touching a local helper", () => {
  for (const platform of ["linux", "win32", "freebsd"]) {
    assert.throws(
      () => buildHelperInvocation(["status"], { platform }),
      (error) => {
        assert.ok(error instanceof IphoneMirroringRuntimeError);
        assert.equal(error.code, "IPHONE_MIRRORING_UNSUPPORTED_PLATFORM");
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
  }
});

test("macOS invocation uses fixed zsh and the helper from the same package", () => {
  const syntheticEntrypoint = path.join(
    skillDirectory,
    "trelio-iphone-mirroring.mjs",
  );
  const invocation = buildHelperInvocation(
    ["screenshot", "--output", "/tmp/example.png"],
    {
      platform: "darwin",
      moduleUrl: pathToFileURL(syntheticEntrypoint).href,
    },
  );

  assert.equal(invocation.executable, "/bin/zsh");
  assert.equal(invocation.cwd, skillDirectory);
  assert.deepEqual(invocation.args, [
    path.join(skillDirectory, "scripts", "mirrorctl"),
    "screenshot",
    "--output",
    "/tmp/example.png",
  ]);
});

test("release packages the cross-platform gate and every native source", async () => {
  const release = JSON.parse(await readFile(
    path.join(skillDirectory, "release.json"),
    "utf8",
  ));
  const packagePaths = release.runtime.files.map((file) => file.path).sort();

  assert.equal(release.release.skillId, "iphone-mirroring");
  assert.equal(release.release.version, "2.1.1");
  assert.equal(release.connection, null);
  assert.equal(release.runtime.version, "2.1.0");
  assert.equal(release.runtime.entrypoint.interpreter, "node");
  assert.equal(release.runtime.entrypoint.path, "trelio-iphone-mirroring.mjs");
  assert.deepEqual(release.runtime.capabilities, ["local-session"]);
  assert.deepEqual(packagePaths, [
    "scripts/input-guardian.swift",
    "scripts/input-safety.swift",
    "scripts/mirror-session-supervisor.swift",
    "scripts/mirrorctl",
    "scripts/mirrorctl.swift",
    "scripts/runtime-output.swift",
    "scripts/virtual-display-bridge.h",
    "scripts/virtual-display-bridge.m",
    "trelio-iphone-mirroring.mjs",
  ]);
});

test("instructions preserve hidden-session ownership and prove cleanup", async () => {
  const instructions = await readFile(path.join(skillDirectory, "SKILL.md"), "utf8");
  const hiddenLaunchBranch = instructions.indexOf("При исходном `app_not_running`");
  const foregroundBranch = instructions.indexOf("`focus --visible` и `center --visible`");

  assert.ok(hiddenLaunchBranch >= 0);
  assert.ok(foregroundBranch > hiddenLaunchBranch);
  const hiddenLaunchContract = instructions.slice(
    hiddenLaunchBranch,
    foregroundBranch,
  );

  assert.match(instructions, /exact `runtimeExecution\.localAction`/u);
  assert.match(instructions, /`parameters\.arguments`/u);
  assert.match(hiddenLaunchContract, /`session start`\s+напрямую/u);
  assert.match(hiddenLaunchContract, /не вызывай перед ним `focus` или `center`/u);
  assert.match(instructions, /mirrorWasRunning=false/u);
  assert.match(instructions, /mirrorLaunchedBySupervisor=true/u);
  assert.match(instructions, /session stop --session SESSION_ID/u);
  assert.match(instructions, /active=false/u);
  assert.match(instructions, /exitReason=explicit_stop/u);
  assert.match(instructions, /`status --compact --no-ocr`\s+и проверь `app_running=false`/u);
  assert.match(instructions, /IPHONE_MIRRORING_UNSUPPORTED_PLATFORM/u);
  for (const command of ["home", "app-switcher", "spotlight", "retry"]) {
    assert.ok(instructions.includes(`${command} --session SESSION_ID`));
  }
  assert.match(instructions, /events_posted/u);
  assert.match(instructions, /verification_required/u);
  assert.match(instructions, /input_target_changed/u);
  assert.doesNotMatch(instructions, /scripts\/mirrorctl\s+(?:status|session|click)/u);
});

test("locked-phone recovery explicitly reconnects before waiting", async () => {
  const instructions = await readFile(path.join(skillDirectory, "SKILL.md"), "utf8");
  const inUseBranchStart = instructions.indexOf("- `iphone_in_use`");
  const unlockBranchStart = instructions.indexOf("- `physical_unlock_required`");
  const connectedBranchStart = instructions.indexOf("- `connected_or_unknown`");

  assert.ok(inUseBranchStart >= 0);
  assert.ok(unlockBranchStart > inUseBranchStart);
  assert.ok(connectedBranchStart > unlockBranchStart);

  const inUseBranch = instructions.slice(inUseBranchStart, unlockBranchStart);
  const unlockBranch = instructions.slice(unlockBranchStart, connectedBranchStart);
  assert.match(inUseBranch, /один раз выполни `retry --session ID`/u);
  assert.match(inUseBranch, /только затем запусти\s+`wait-connected/u);
  assert.match(inUseBranch, /пассивное\s+ожидание.*оставит старое состояние/ius);
  assert.match(unlockBranch, /выполни один `retry --session ID`/u);
  assert.match(unlockBranch, /переходи к `wait-connected`/u);
});

test("native retry recognizes Apple's terminal Connect action", async () => {
  const helper = await readFile(
    path.join(skillDirectory, "scripts", "mirrorctl.swift"),
    "utf8",
  );
  const reconnectFinder = helper.indexOf("private func findReconnectButton");
  const retryAction = helper.indexOf("private func pressRetry");
  const reconnectContract = helper.slice(reconnectFinder, retryAction);

  assert.ok(reconnectFinder >= 0);
  assert.ok(retryAction > reconnectFinder);
  assert.match(reconnectContract, /\$0 == "подключиться"/u);
  assert.match(reconnectContract, /\$0 == "connect"/u);
  assert.match(reconnectContract, /\$0\.contains\("повторить попытку"\)/u);
  assert.match(helper.slice(retryAction), /findReconnectButton\(in: window\)/u);
});

test("native supervisor marks and terminates only its own mirror launch", async () => {
  const supervisor = await readFile(
    path.join(skillDirectory, "scripts", "mirror-session-supervisor.swift"),
    "utf8",
  );
  const launchGuard = supervisor.indexOf("if runningMirrorPID() == nil {");
  const ownershipMark = supervisor.indexOf(
    "state.mirrorLaunchedBySupervisor = true",
    launchGuard,
  );
  const cleanupGuard = supervisor.indexOf(
    "if state.mirrorLaunchedBySupervisor,",
  );
  const terminateOwnedProcess = supervisor.indexOf(
    "_ = application.terminate()",
    cleanupGuard,
  );

  assert.ok(launchGuard >= 0);
  assert.ok(ownershipMark > launchGuard);
  assert.ok(cleanupGuard >= 0);
  assert.ok(terminateOwnedProcess > cleanupGuard);
});

test("native input paths use uncached foreground observations", async () => {
  for (const filename of ["mirrorctl.swift", "mirror-session-supervisor.swift", "input-guardian.swift"]) {
    const source = await readFile(path.join(skillDirectory, "scripts", filename), "utf8");
    assert.doesNotMatch(source, /NSWorkspace\.shared\.frontmostApplication/u);
    assert.match(source, /freshFrontmostPID\(\)/u);
  }
});

test("wrapper cancellation ends its real waiting helper and removes signal listeners", {
  skip: process.platform !== "darwin",
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trelio-iphone-cancel-"));
  let child;
  try {
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "scripts", "mirrorctl"), "exec /bin/sleep 30\n");
    const signalTarget = new EventEmitter();
    const running = runRuntime([], {
      moduleUrl: pathToFileURL(path.join(root, "runtime.mjs")).href,
      signalTarget,
      spawnProcess: (...args) => {
        child = spawn(...args);
        child.once("spawn", () => signalTarget.emit("SIGTERM"));
        return child;
      },
    });
    await assert.rejects(running, { code: "IPHONE_MIRRORING_RUNTIME_SIGNAL" });
    assert.equal(child.signalCode, "SIGTERM");
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(signalTarget.listenerCount(signal), 0);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("a killed host cannot leave its wrapper and delayed helper alive", {
  skip: process.platform !== "darwin",
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trelio-iphone-orphan-"));
  const descendantPIDs = [];
  let host;
  let timer;
  try {
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "scripts", "mirrorctl"), "print '{\"helper\":'$$'}'\nexec /bin/sleep 30\n");
    const runtimePath = path.join(root, "runtime.mjs");
    const productionModule = pathToFileURL(path.join(skillDirectory, "scripts", "trelio-iphone-mirroring.mjs")).href;
    await writeFile(runtimePath, `import { runRuntime } from ${JSON.stringify(productionModule)};
try { await runRuntime([], { moduleUrl: import.meta.url }); } catch { process.exitCode = 1; }
`);
    const hostPath = path.join(root, "host.mjs");
    await writeFile(hostPath, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(runtimePath)}], { stdio: 'inherit' });
process.stdout.write(JSON.stringify({ wrapper: child.pid }) + '\\n');
setInterval(() => {}, 1000);
`);
    host = spawn(process.execPath, [hostPath], { stdio: ["ignore", "pipe", "pipe"] });
    // SIGKILL cannot be forwarded by the host. Its inherited stdout stays open
    // until both descendants exit, so close proves cleanup of the entire chain.
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Orphaned input process survived host cancellation")), 3000);
      let pending = "";
      host.stdout.on("data", (chunk) => {
        pending += chunk.toString();
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n");
          const row = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          descendantPIDs.push(row.wrapper ?? row.helper);
          if (descendantPIDs.length === 2) host.kill("SIGKILL");
        }
      });
      host.once("error", reject);
      host.once("close", resolve);
    });
    assert.equal(descendantPIDs.length, 2);
    for (const pid of descendantPIDs) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(timer);
    if (host?.exitCode === null && host?.signalCode === null) host.kill("SIGKILL");
    for (const pid of descendantPIDs) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS helper sources compile and expose their bounded command surface", {
  skip: process.platform !== "darwin",
  timeout: 180_000,
}, async () => {
  // Materialize the deterministic package exactly as the trusted host does.
  // This catches a mismatch between source paths and package paths before a
  // signed release reaches production.
  const built = buildRuntimePackage(skillDirectory);
  const runtimePackage = JSON.parse(built.packageBytes.toString("utf8"));
  const materializedRoot = await mkdtemp(path.join(
    tmpdir(),
    "trelio-iphone-mirroring-test-",
  ));

  try {
    for (const file of runtimePackage.files) {
      const destination = path.join(
        materializedRoot,
        ...file.path.split("/"),
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.contentBase64, "base64"));
      await chmod(destination, file.mode);
    }

    // `--help` performs the same first-run Swift/Objective-C build as a live
    // command, but it neither launches iPhone Mirroring nor requests TCC.
    const entrypoint = path.join(
      materializedRoot,
      ...runtimePackage.entrypoint.path.split("/"),
    );
    // The zsh launcher derives both its compiled cache and session path from
    // TMPDIR. Supplying only IPHONE_MIRRORING_SESSION_DIR is ineffective: the
    // launcher intentionally replaces that value with its own scoped path.
    const nativeTemp = path.join(materializedRoot, "private-native-temp");
    await mkdir(nativeTemp, { mode: 0o700 });
    const isolatedEnvironment = { ...process.env, TMPDIR: nativeTemp };
    const result = spawnSync(process.execPath, [entrypoint, "--help"], {
      cwd: materializedRoot,
      env: isolatedEnvironment,
      encoding: "utf8",
      timeout: 170_000,
    });

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mirrorctl session start/u);
    assert.match(result.stdout, /mirrorctl screenshot --output PATH/u);
    assert.match(result.stdout, /--compact/u);
    assert.match(result.stdout, /--observe/u);

    const sessionReads = [[], ["--compact"]].map((flags) => spawnSync(
      process.execPath, [entrypoint, "session", "status", ...flags],
      { cwd: materializedRoot, env: isolatedEnvironment, encoding: "utf8", timeout: 10_000 },
    ));
    for (const read of sessionReads) assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(sessionReads[1].stdout), JSON.parse(sessionReads[0].stdout));
    assert.equal(JSON.parse(sessionReads[1].stdout).active, false);
    assert.equal(sessionReads[1].stdout.trim().split("\n").length, 1);
    assert.ok(sessionReads[1].stdout.length < sessionReads[0].stdout.length);

    // A private, empty lease directory keeps these executable checks entirely
    // separate from any live session on the developer's Mac. Every command
    // must fail before touching Accessibility, an app window, or HID input.
    const guardedCases = [
      { args: ["click", "--x", "0.5", "--y", "0.5"], code: "hidden_session_required" },
      { args: ["scroll", "--direction", "down"], code: "hidden_session_required" },
      ...["home", "app-switcher", "spotlight", "retry", "focus", "center", "type-text"].map((command) => ({
        args: [command], code: "hidden_session_required",
      })),
      { args: ["click", "--x", "0.5", "--y", "0.5", "--session", "ended"], code: "session_not_active" },
      { args: ["home", "--session", "ended"], code: "session_not_active" },
      { args: ["type-text", "--session", "ended", "--text", "проверка"], code: "session_not_active" },
      { args: ["click", "--x", "0.5", "--y", "0.5", "--session", "ended", "--visible"], code: "input_mode_conflict" },
    ];
    const compactCases = guardedCases.map(({ args, code }) => ({ args: [...args, "--compact"], code }));
    const observedCases = guardedCases.filter(({ args }) => ["click", "scroll", "type-text"].includes(args[0]))
      .map(({ args, code }) => ({ args: [...args, "--compact", "--observe"], code }));
    for (const { args, code } of [...guardedCases, ...compactCases, ...observedCases]) {
      const denied = spawnSync(process.execPath, [entrypoint, ...args], {
        cwd: materializedRoot,
        env: isolatedEnvironment,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(denied.signal, null, denied.stderr);
      assert.equal(denied.status, 5, denied.stderr);
      const failure = JSON.parse(denied.stderr);
      assert.equal(failure.error_code, code);
      assert.equal(failure.observation, undefined);
      assert.equal(failure.observation_error, undefined);
      assert.equal(denied.stdout, "");
    }
    const invalidObserve = spawnSync(process.execPath, [entrypoint, "session", "status", "--compact", "--observe"], {
      cwd: materializedRoot, env: isolatedEnvironment, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(invalidObserve.status, 2, invalidObserve.stderr);
    assert.equal(invalidObserve.stdout, "");
    const invalidStart = spawnSync(process.execPath, [entrypoint, "session", "start", "--idle-timeout", "1", "--compact", "--observe"], {
      cwd: materializedRoot, env: isolatedEnvironment, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(invalidStart.status, 2, invalidStart.stderr);
    assert.equal(JSON.parse(invalidStart.stderr).observation, undefined);
    assert.equal(JSON.parse(invalidStart.stderr).observation_error, undefined);
  } finally {
    await rm(materializedRoot, { recursive: true, force: true });
  }
});

test("native input contract rejects stale targets, held input and events after cancellation", {
  skip: process.platform !== "darwin",
  timeout: 60_000,
}, async () => {
  const buildDirectory = await mkdtemp(path.join(tmpdir(), "trelio-input-safety-test-"));
  try {
    const binary = path.join(buildDirectory, "input-safety-tests");
    // Compile the production functions themselves with injected observations
    // and a deterministic clock. No virtual display or user input is needed.
    const compile = spawnSync("/usr/bin/xcrun", [
      "swiftc", "-parse-as-library", "-warnings-as-errors",
      "-framework", "CoreGraphics",
      path.join(skillDirectory, "scripts", "input-safety.swift"),
      path.join(testDirectory, "input-safety-tests.swift"),
      "-o", binary,
    ], { encoding: "utf8", timeout: 50_000 });
    assert.equal(compile.status, 0, compile.stderr);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Input safety regressions passed/u);
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }
});

test("compact output and one-shot observation preserve input evidence and private artifacts", {
  skip: process.platform !== "darwin",
  timeout: 60_000,
}, async () => {
  const buildDirectory = await mkdtemp(path.join(tmpdir(), "trelio-runtime-output-test-"));
  try {
    const binary = path.join(buildDirectory, "runtime-output-tests");
    const compile = spawnSync("/usr/bin/xcrun", [
      "swiftc", "-parse-as-library", "-warnings-as-errors",
      path.join(skillDirectory, "scripts", "runtime-output.swift"),
      path.join(testDirectory, "runtime-output-tests.swift"),
      "-o", binary,
    ], { encoding: "utf8", timeout: 50_000 });
    assert.equal(compile.status, 0, compile.stderr);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Runtime output regressions passed/u);
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }
});
