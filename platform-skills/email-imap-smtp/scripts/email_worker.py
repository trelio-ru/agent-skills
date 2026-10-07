"""Private guardian child. Not a public entrypoint or a credential transport.

The worker cannot reach email code until its native owner has sent the initial
configuration. On Windows this barrier occurs after assignment to the Job.
The protocol carries only permits, CLI arguments and ordinary command results.
"""

import importlib.util
import json
import os
from pathlib import Path
import queue
import sys
import threading


def main():
    # Redirected Python streams otherwise follow the Windows legacy code page,
    # while the native protocol is explicitly UTF-8, including Unicode paths.
    sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    protocol_input, protocol_output = sys.stdin, sys.stdout
    first = protocol_input.readline(65536)
    if not first.endswith("\n"):
        os._exit(2)
    config = json.loads(first)
    replies = queue.Queue()

    def receive():
        while True:
            line = protocol_input.readline(8192)
            if not line or not line.endswith("\n"):
                # A killed native owner must not leave a healthy credential-
                # bearing Python process behind, including while waiting input.
                os._exit(2)
            try:
                replies.put(json.loads(line))
            except ValueError:
                os._exit(2)

    threading.Thread(target=receive, daemon=True).start()
    lock = threading.Lock()
    sequence = 0

    def request(operation="permit", **fields):
        nonlocal sequence
        with lock:
            sequence += 1
            protocol_output.write(json.dumps({"id": sequence, "op": operation, **fields}) + "\n")
            protocol_output.flush()
            try:
                reply = replies.get(timeout=15 if operation == "open" else 5)
            except queue.Empty:
                os._exit(2)
            if not isinstance(reply, dict) or reply.get("id") != sequence or not isinstance(reply.get("ok"), bool):
                os._exit(2)
            return reply["ok"]

    def permit():
        if not request():
            os._exit(2)

    permit()
    script = Path(__file__).with_name("trelio-email.py")
    spec = importlib.util.spec_from_file_location("trelio_email_worker_runtime", script)
    runtime = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = runtime
    spec.loader.exec_module(runtime)
    runtime.require_credential_lease = permit
    runtime.install_native_network_barriers()
    def open_browser(url):
        if not request("open", url=url):
            raise runtime.ProtectedPromptUnavailable("Не удалось открыть защищённую локальную страницу настройки почты.")
    runtime.open_browser_url = open_browser
    code = 2
    try:
        if config.get("terminal"):
            # The public entrypoint already required explicit mode + real TTY.
            # Keep terminal I/O away from the guardian's protocol descriptors.
            if os.name == "nt":
                import ctypes
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                if not kernel.AttachConsole(int(config["consoleOwner"])):
                    raise runtime.ProtectedPromptUnavailable("native_email_terminal_unavailable")
            device = config.get("terminalDevice")
            sys.stdin = open("CONIN$" if os.name == "nt" else device, "r", encoding="utf-8")
            sys.stdout = sys.stderr = open("CONOUT$" if os.name == "nt" else device, "w", encoding="utf-8")
        args = runtime.build_parser().parse_args(config["arguments"])
        result = args.handler(args)
        payload = {"ok": True, **result}
        code = 0
    except (runtime.MailboxError, OSError, UnicodeError, ValueError, runtime.imaplib.IMAP4.error) as error:
        payload = runtime.error_payload(error)
    except Exception:
        # Unexpected native/worker exceptions never expose raw private state.
        payload = {"ok": False, "error": "native_email_worker_failed"}
    permit()
    protocol_output.write(json.dumps({"id": 0, "op": "result", "code": code,
                                      "value": json.dumps(payload, ensure_ascii=False, indent=2)}, ensure_ascii=False) + "\n")
    protocol_output.flush()
    # The guardian consumes the result before terminating its owned child.
    # Exiting first would race EOF against the final ordinary CLI response.
    threading.Event().wait()


if __name__ == "__main__":
    main()
