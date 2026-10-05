#!/usr/bin/env node

import {
  constants as fsConstants,
  accessSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SUPPORTED_PLATFORM = "darwin";
const SYSTEM_ZSH = "/bin/zsh";

/**
 * Keep wrapper failures machine-readable. The Swift helper already emits its
 * own structured JSON errors, so this class is only for failures that happen
 * before the helper can start: an unsupported OS, a damaged package or a
 * process-launch error.
 */
export class IphoneMirroringRuntimeError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "IphoneMirroringRuntimeError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/**
 * Resolve only files inside the immutable materialized package and the fixed
 * macOS system shell. The Trelio host invokes this Node entrypoint with
 * shell:false; the wrapper preserves that boundary when handing arguments to
 * the reviewed zsh helper.
 */
export const buildHelperInvocation = (
  runtimeArguments,
  {
    platform = process.platform,
    moduleUrl = import.meta.url,
  } = {},
) => {
  if (platform !== SUPPORTED_PLATFORM) {
    throw new IphoneMirroringRuntimeError(
      "IPHONE_MIRRORING_UNSUPPORTED_PLATFORM",
      "Видеоповтор iPhone доступен только в локальной сессии macOS.",
      2,
    );
  }

  const runtimeDirectory = path.dirname(fileURLToPath(moduleUrl));
  return {
    executable: SYSTEM_ZSH,
    args: [path.join(runtimeDirectory, "scripts", "mirrorctl"), ...runtimeArguments],
    cwd: runtimeDirectory,
  };
};

/**
 * Verify package materialization before spawning. This produces a bounded,
 * stable error instead of leaking a platform-specific ENOENT stack trace.
 */
const assertInvocationFiles = ({ executable, args }) => {
  try {
    accessSync(executable, fsConstants.X_OK);
    accessSync(args[0], fsConstants.R_OK);
  } catch {
    throw new IphoneMirroringRuntimeError(
      "IPHONE_MIRRORING_RUNTIME_DAMAGED",
      "Подписанный runtime Видеоповтора iPhone материализован не полностью.",
    );
  }
};

const emitWrapperError = (error) => {
  const normalized = error instanceof IphoneMirroringRuntimeError
    ? error
    : new IphoneMirroringRuntimeError(
      "IPHONE_MIRRORING_RUNTIME_START_FAILED",
      "Не удалось запустить локальный runtime Видеоповтора iPhone.",
    );

  process.stderr.write(`${JSON.stringify({
    error: normalized.message,
    error_code: normalized.code,
    exit_code: normalized.exitCode,
  })}\n`);
  return normalized.exitCode;
};

/**
 * Stream stdin/stdout/stderr unchanged so screenshots and session commands
 * retain the exact helper contract. A non-zero helper exit is propagated
 * without a second wrapper error because mirrorctl has already explained it.
 */
export const runRuntime = async (
  runtimeArguments = process.argv.slice(2),
  dependencies = {},
) => {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const invocation = buildHelperInvocation(runtimeArguments, dependencies);
  assertInvocationFiles(invocation);

  return new Promise((resolve, reject) => {
    const child = spawnProcess(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: process.env,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });

    // Explicit piping keeps grandchild output visible both in an interactive
    // terminal and when the trusted host captures stdout/stderr for the agent.
    // Do not buffer JSON or screenshot diagnostics in the wrapper.
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    // A pending idle wait belongs to this invocation. Forward cancellation to
    // the exact child so a stopped host cannot leave a ten-minute delayed
    // click alive. The native CLI separately detects a killed parent, including
    // SIGKILL, which cannot be handled here.
    const signalTarget = dependencies.signalTarget ?? process;
    const signalHandlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
      signal, () => child.kill(signal),
    ]));
    // The generic skill host is another parent in the process chain. If it is
    // killed without forwarding a signal, terminate this helper as soon as
    // the wrapper is reparented; otherwise the native CLI would still see us
    // alive and could legitimately perform a delayed action.
    const originalParentPID = process.ppid;
    const parentWatch = setInterval(() => {
      if (originalParentPID <= 1 || process.ppid !== originalParentPID) child.kill("SIGTERM");
    }, 100);
    parentWatch.unref();
    const removeSignalHandlers = () => {
      clearInterval(parentWatch);
      for (const [signal, handler] of signalHandlers) signalTarget.off(signal, handler);
    };
    for (const [signal, handler] of signalHandlers) signalTarget.on(signal, handler);

    child.once("error", () => {
      removeSignalHandlers();
      reject(new IphoneMirroringRuntimeError(
        "IPHONE_MIRRORING_RUNTIME_START_FAILED",
        "Не удалось запустить локальный runtime Видеоповтора iPhone.",
      ));
    });
    // `close` fires only after the inherited helper process has exited and its
    // piped output streams have closed. Resolving on the earlier `exit` event
    // could let a short-lived wrapper finish before the final JSON was flushed.
    child.once("close", (code, signal) => {
      removeSignalHandlers();
      if (signal) {
        reject(new IphoneMirroringRuntimeError(
          "IPHONE_MIRRORING_RUNTIME_SIGNAL",
          `Runtime Видеоповтора iPhone завершён сигналом ${signal}.`,
        ));
        return;
      }
      resolve(code ?? 1);
    });
  });
};

/**
 * ESM resolves `/var` to macOS' canonical `/private/var`, while argv may keep
 * the shorter symlinked spelling. Compare real paths so a materialized runtime
 * cannot silently import-and-exit when its cache root crosses that alias.
 */
export const isMainModule = (moduleUrl, argvPath) => {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return path.resolve(fileURLToPath(moduleUrl)) === path.resolve(argvPath);
  }
};

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await runRuntime();
  } catch (error) {
    process.exitCode = emitWrapperError(error);
  }
}
