#!/usr/bin/env python3
"""HTTP agent the panel talks to through the Cloudflare Tunnel. Standard library only."""
import hmac
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AGENT_TOKEN = os.environ["AGENT_TOKEN"]
PORT = int(os.environ.get("AGENT_PORT", "8080"))
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))

# State of the last stop.sh run: idle, running, done, failed
stop_state = {"status": "idle", "log": ""}


def container_state():
    """Docker state and health of mc-server, e.g. ("running", "healthy"); ("missing", None) if absent, ("error", None) if docker fails."""
    try:
        result = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", "mc-server"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "error", None
    if result.returncode != 0:
        return "missing", None
    status, _, health = result.stdout.strip().partition(" ")
    return status, health or None


def run_stop():
    # Any exception must end in "failed", otherwise "running" sticks and blocks a retry
    try:
        result = subprocess.run(
            [os.path.join(SCRIPTS_DIR, "stop.sh")],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        stop_state.update(status="done" if result.returncode == 0 else "failed", log=result.stdout[-4000:])
    except Exception as err:
        stop_state.update(status="failed", log=f"stop.sh did not run: {err}")


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        # compare_digest: constant-time, does not leak the token through timing
        given = self.headers.get("Authorization", "")
        if hmac.compare_digest(given, f"Bearer {AGENT_TOKEN}"):
            return True
        self.send_json(401, {"error": "unauthorized"})
        return False

    def do_GET(self):
        if not self.authorized():
            return
        if self.path == "/status":
            status, health = container_state()
            self.send_json(200, {"container": status, "health": health, "stop": stop_state})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorized():
            return
        if self.path == "/stop":
            if stop_state["status"] == "running":
                self.send_json(409, {"error": "stop already running"})
                return
            # Backup takes minutes, so run it in the background; the panel polls /status.
            # "running" is set here, not in the thread, so two quick requests cannot both start it.
            stop_state.update(status="running", log="")
            threading.Thread(target=run_stop, daemon=True).start()
            self.send_json(202, {"stop": "started"})
        else:
            self.send_json(404, {"error": "not found"})


if __name__ == "__main__":
    # Localhost only: reachable from outside just through the tunnel
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
