"""Synthetic native child; no real mailbox, Keychain or provider network."""
import json
import os
from pathlib import Path
import sys
import threading
import time

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
config = json.loads(sys.stdin.readline())
Path(config["pidFile"]).write_text(str(os.getpid()))

if config["mode"] == "crash":
    os._exit(3)
if config["mode"] == "healthy":
    # Real worker also exits on owner pipe EOF independently of its main task.
    def monitor():
        while sys.stdin.readline():
            pass
        os._exit(2)
    threading.Thread(target=monitor, daemon=True).start()
elif config["mode"] == "result":
    print(json.dumps({"op": "permit", "id": 1}), flush=True)
    assert json.loads(sys.stdin.readline()) == {"id": 1, "ok": True}
    print(json.dumps({"op": "result", "id": 2, "code": 0,
                      "value": json.dumps({"ok": True, "synthetic": "пароль не нужен"}, ensure_ascii=False)}), flush=True)
elif config["mode"] == "open":
    print(json.dumps({"op": "open", "id": 1, "url": "http://127.0.0.1:12345/" + "a" * 43}), flush=True)
    assert json.loads(sys.stdin.readline()) == {"id": 1, "ok": True}
    print(json.dumps({"op": "result", "id": 2, "code": 0, "value": '{"ok":true}'}), flush=True)

# A native timer must also terminate a worker that never requests another
# permit. POSIX tests additionally SIGSTOP this process after startup.
while True:
    time.sleep(60)
