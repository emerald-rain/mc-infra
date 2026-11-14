#!/usr/bin/env python3
"""HTTP agent on the server. The panel reaches it through the Cloudflare Tunnel.

A new feature: write a handler that returns (http_status, json_data) and add it to ROUTES.
A long script (minutes): add a Job to JOBS, the panel polls its status via GET /status.
Standard library only.
"""
import hmac
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AGENT_TOKEN = os.environ["AGENT_TOKEN"]
PORT = int(os.environ.get("AGENT_PORT", "8080"))
HERE = os.path.dirname(os.path.abspath(__file__))


class Job:
    """A script that runs in the background, one copy at a time.

    status: idle -> running -> done | failed. log keeps the end of the script's output.
    """

    def __init__(self, script):
        self.script = os.path.join(HERE, script)
        self.status = "idle"
        self.log = ""
        self._lock = threading.Lock()

    def start(self):
        """Starts the script; False if it is already running."""
        # The lock makes check-and-set atomic, so two quick requests cannot both start it
        with self._lock:
            if self.status == "running":
                return False
            self.status, self.log = "running", ""
        threading.Thread(target=self._run, daemon=True).start()
        return True

    def _run(self):
        # Any exception must end in "failed", otherwise "running" sticks and blocks a retry
        try:
            result = subprocess.run([self.script], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.status = "done" if result.returncode == 0 else "failed"
            self.log = result.stdout[-4000:]
        except Exception as err:
            self.status, self.log = "failed", f"{self.script} did not run: {err}"

    def to_json(self):
        return {"status": self.status, "log": self.log}


JOBS = {
    "stop": Job("stop.sh"),  # stop Minecraft, back up the world to R2
}


def container_state():
    """Docker state and health of mc-server, e.g. ("running", "healthy").

    ("missing", None) if there is no container, ("error", None) if docker does not answer.
    """
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


# --- Handlers: each returns (http_status, json_data) ---

def get_status():
    container, health = container_state()
    jobs = {name: job.to_json() for name, job in JOBS.items()}
    return 200, {"container": container, "health": health, "jobs": jobs}


def post_stop():
    if not JOBS["stop"].start():
        return 409, {"error": "stop already running"}
    # The backup takes minutes; the panel follows it via GET /status
    return 202, {"started": "stop"}


ROUTES = {
    ("GET", "/status"): get_status,
    ("POST", "/stop"): post_stop,
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def dispatch(self):
        # compare_digest: constant time, the token does not leak through timing
        if not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {AGENT_TOKEN}"):
            return self.send_json(401, {"error": "unauthorized"})
        handler = ROUTES.get((self.command, self.path))
        if not handler:
            return self.send_json(404, {"error": "not found"})
        self.send_json(*handler())

    def send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # the panel polls every few seconds, do not flood the journal


if __name__ == "__main__":
    # Localhost only: reachable from outside just through the tunnel
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
