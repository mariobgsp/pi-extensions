#!/usr/bin/env python3
"""browser-auto daemon — persistent Python HTTP server (stdlib http.server only).

Owns ONE engine instance (one browser + one persistent context + one page).
JSON-RPC-ish over localhost HTTP:

  GET  /health          -> {"ok": true}
  POST /rpc             -> {"op": "<op>", "params": {...}} => {"ok": ...} or {"ok": false, "error": ...}

Engine interface (duck-typed; see engines/playwright_engine.py):
  launch/navigate/snapshot/inspect/fill/click/check/screenshot/wait/wait_for_login/close

Engine registry: {"playwright": PlaywrightEngine, "nodriver": NodriverEngine}.
A future worker fills in engines/nodriver_engine.py without touching the
TS client or this core.

Usage: python3.14 server.py --port <port>
Records {"port","pid"} to ~/.cache/pi-browser/daemon.json (lockfile).
"""

import argparse
import json
import os
import queue
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "engines"))

LOCKFILE = os.path.expanduser("~/.cache/pi-browser/daemon.json")

_engine = None
_engine_name = None

# ponytail: single owner thread serialises all ops; parallel ops queue.
_owner_calls = queue.Queue()
_owner_thread = None
_owner_started = False
_owner_start_lock = threading.Lock()


def _owner_loop():
    while True:
        item = _owner_calls.get()
        if item is None:
            return
        fn, out = item
        try:
            out.put((True, fn()))
        except BaseException as e:  # noqa: BLE001 — re-raised on caller thread
            out.put((False, e))


def _ensure_owner():
    global _owner_thread, _owner_started
    with _owner_start_lock:
        if not _owner_started:
            t = threading.Thread(target=_owner_loop, name="browser-auto-owner", daemon=True)
            t.start()
            _owner_thread = t
            _owner_started = True


def _run_on_owner(fn):
    _ensure_owner()
    out = queue.Queue(maxsize=1)
    _owner_calls.put((fn, out))
    ok, val = out.get()
    if not ok:
        raise val
    return val


def get_engine_class(name):
    if name == "playwright":
        from playwright_engine import PlaywrightEngine
        return PlaywrightEngine
    if name == "nodriver":
        from nodriver_engine import NodriverEngine  # stub: raises NOT-IMPLEMENTED
        return NodriverEngine
    raise ValueError(f"unknown engine {name!r} — want 'playwright' (default) | 'nodriver'")


def _dispatch_inner(op, params):
    global _engine, _engine_name
    params = params or {}
    if op == "launch":
        cls = get_engine_class(params.get("engine") or "playwright")
        old = _engine
        _engine = cls()  # NodriverEngine.__init__ raises the stub error here
        _engine_name = params.get("engine") or "playwright"
        engine = _engine
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        kw = {k: v for k, v in params.items() if k != "engine"}
        return engine.launch(**kw)
    if _engine is None:
        raise RuntimeError("browser not launched — call browser_launch first")
    if op == "close":
        engine = _engine
        _engine = None
        _engine_name = None
        return engine.close()
    engine = _engine
    handler = getattr(engine, op, None)
    if handler is None:
        # 'wait_for' RPC op maps to Engine.wait (avoids the `for` keyword).
        if op == "wait_for":
            handler = getattr(engine, "wait", None)
    if handler is None:
        raise ValueError(f"unknown op {op!r}")
    # Runs on the single owner thread, so a 300s wait_for_login blocks
    # later ops but never touches a second thread (Playwright is thread-affine).
    # /health stays live — it never enters this queue.
    return handler(**params)


def dispatch(op, params):
    # ALL engine access runs on the one owner thread that owns Playwright.
    return _run_on_owner(lambda: _dispatch_inner(op, params))


class Handler(BaseHTTPRequestHandler):
    server_version = "pi-browser-auto/0.1"

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("browser-auto: " + fmt % args + "\n")

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"ok": False, "error": "want /health or POST /rpc"})

    def do_POST(self):
        if self.path != "/rpc":
            self._send(404, {"ok": False, "error": "want POST /rpc"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 4 * 1024 * 1024:
                self._send(413, {"ok": False, "error": "request body too large (max 4MB)"})
                return
            req = json.loads(self.rfile.read(length) or b"{}")
            result = dispatch(req.get("op"), req.get("params"))
            if isinstance(result, dict):
                self._send(200, result if "ok" in result else {"ok": True, **result})
            else:
                self._send(200, {"ok": True, "result": result})
        except NotImplementedError as e:
            self._send(501, {"ok": False, "error": str(e)})
        except Exception as e:
            self._send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    if args.host not in ("127.0.0.1", "localhost"):
        ap.error("--host must be 127.0.0.1 or localhost (loopback only)")
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    os.makedirs(os.path.dirname(LOCKFILE), exist_ok=True)
    with open(LOCKFILE, "w") as f:
        json.dump({"port": srv.server_address[1], "pid": os.getpid()}, f)
    print(f"browser-auto daemon on {args.host}:{srv.server_address[1]}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
