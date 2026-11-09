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
    // Owner-bound calls buffer only one bounded native JSON result below.
    const captured = { stdout: [], stderr: [] };
    let capturedBytes = 0, captureFailed = false;
    if (dependencies.captureOutput) {
      // Only the trusted owner adapter consumes complete bounded JSON. Native
      // output never becomes an Error/log or an unbounded retained stream.
      for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => {
        capturedBytes += bytes.length;
        if (capturedBytes > 1024 * 1024) { captureFailed = true; child.kill('SIGTERM'); return; }
        captured[name].push(Buffer.from(bytes));
      });
    } else {
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }

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
      if (captureFailed) {
        reject(new IphoneMirroringRuntimeError('IPHONE_MIRRORING_OUTPUT_UNAVAILABLE', 'Результат операции не получен полностью. Проверьте экран; ввод не повторяйте.'));
        return;
      }
      if (signal) {
        reject(new IphoneMirroringRuntimeError(
          "IPHONE_MIRRORING_RUNTIME_SIGNAL",
          `Runtime Видеоповтора iPhone завершён сигналом ${signal}.`,
        ));
        return;
      }
      try { resolve(dependencies.captureOutput ? { code: code ?? 1,
        stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(captured.stdout)),
        stderr: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(captured.stderr)) } : code ?? 1);
      } catch { reject(new IphoneMirroringRuntimeError('IPHONE_MIRRORING_OUTPUT_UNAVAILABLE', 'Результат операции не получен полностью. Проверьте экран; ввод не повторяйте.')); }
    });
  });
};

/** Several workflows can share one physical iPhone display, but never an
 * implicit supervisor lease or stale coordinate frame. The generic host owns
 * logical leases, one-attempt stop fencing and the screen-generation queue;
 * this adapter only describes native command/observation semantics. */
export async function runSkillRuntime(runtimeArguments = process.argv.slice(2), dependencies = {}) {
  if (!process.env.TRELIO_SKILL_RUNTIME_SESSION_ID) return runRuntime(runtimeArguments, dependencies);
  const isSession = runtimeArguments[0] === 'session';
  const command = isSession ? runtimeArguments[1] : runtimeArguments[0];
  const sessionIndex = runtimeArguments.indexOf('--session');
  if (!isSession && sessionIndex < 0) return runRuntime(runtimeArguments, dependencies);
  const moduleUrl = process.env.TRELIO_EXECUTION_SESSION_MODULE_URL;
  if (!moduleUrl?.startsWith('file:')) throw new IphoneMirroringRuntimeError('IPHONE_MIRRORING_HOST_REQUIRED', 'Нужен runtime с поддержкой параллельных сессий.');
  const host = await import(moduleUrl);
  if (host.BROWSER_EXECUTION_SESSIONS_API !== 'trelio.browser-execution-sessions/v1') throw new IphoneMirroringRuntimeError('IPHONE_MIRRORING_HOST_REQUIRED', 'Обновите runtime для параллельной работы.');
  let lastNative;
  const invoke = async args => {
    lastNative = await runRuntime(args, { ...dependencies, captureOutput: true });
    if (lastNative.code !== 0) throw new IphoneMirroringRuntimeError('IPHONE_MIRRORING_NATIVE_FAILED', 'Нативная операция завершилась с ошибкой.');
    const value = JSON.parse(lastNative.stdout);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('native_result_invalid');
    return value;
  };
  const hasImage = value => value && !value.observation_error
    && (typeof value.output === 'string' || hasImage(value.observation));
  const normalized = value => ({ phase: value.active === false ? 'closed' : 'ready',
    ...(typeof value.reused === 'boolean' ? { reused: value.reused } : {}),
    sessionId: value.sessionID || value.session_id || value.action_result?.sessionID,
    expiresAt: Math.floor(Date.now() + Number(value.hard_remaining ?? value.status?.hard_remaining) * 1000), native: value });
  const operation = isSession && ['start', 'status', 'stop'].includes(command) ? command : 'request';
  const input = !isSession && ['click', 'tap', 'double-click', 'long-press', 'scroll', 'type-text', 'key', 'home', 'app-switcher', 'spotlight'].includes(command);
  try {
    const result = await host.withSharedAccountService({
      accountDirectory: path.join(host.browserConfigHome(), 'integrations', 'iphone-mirroring', 'device-service'),
      operation, sessionId: sessionIndex < 0 ? undefined : runtimeArguments[sessionIndex + 1],
      changesState: input || ['retry', 'focus', 'center'].includes(command), requiresFreshObservation: input,
      observesResult: result => hasImage(result.native),
      start: async () => normalized(await invoke(runtimeArguments)),
      dispatch: async (op, physical) => normalized(await invoke(op === 'request'
        ? runtimeArguments.map((value, index) => index === sessionIndex + 1 ? physical : value)
        : ['session', op, '--session', physical, '--compact'])),
    });
    const logical = result.sessionId;
    const project = value => Array.isArray(value) ? value.map(project) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        ['sessionID', 'session_id'].includes(key) ? logical : project(item)])) : value;
    const value = result.native ? project(result.native) : { ok: true, action: `session_${operation}`,
      sessionID: logical, active: result.phase !== 'closed', ...(result.phase === 'closed' ? { exitReason: 'explicit_stop' } : {}),
      ...(result.sharedServiceActive ? { sharedServiceActive: true } : {}) };
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return 0;
  } catch (error) {
    // Preserve the reviewed native refusal exactly, without putting its body
    // in an exception or a durable service record. Host refusals are static.
    if (lastNative?.code) { process.stdout.write(lastNative.stdout); process.stderr.write(lastNative.stderr); return lastNative.code; }
    if (error?.code === 'BROWSER_SESSION_OBSERVATION_STALE') throw new IphoneMirroringRuntimeError(error.code, 'Другой чат изменил экран iPhone. Получите свежий screenshot перед вводом.');
    if (error?.code === 'BROWSER_SESSION_UNREGISTERED_SERVICE') throw new IphoneMirroringRuntimeError(error.code,
      'Открыта сессия прежнего runtime или без привязки к чату. Завершите её в исходном чате, затем запустите новую сессию.');
    throw error instanceof IphoneMirroringRuntimeError ? error : new IphoneMirroringRuntimeError('IPHONE_MIRRORING_SESSION_UNAVAILABLE', 'Сессия этого чата недоступна. Проверьте её status; ввод не повторяйте.');
  }
}

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
    process.exitCode = await runSkillRuntime();
  } catch (error) {
    process.exitCode = emitWrapperError(error);
  }
}
