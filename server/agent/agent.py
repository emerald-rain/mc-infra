#!/usr/bin/env python3
"""HTTP agent on the server. The panel reaches it through the Cloudflare Tunnel.

A new feature: write a handler that returns (http_status, json_data) and add it to ROUTES.
A long script (minutes): add a Job to JOBS, the panel polls its status via GET /status.
Standard library only.
"""
import hmac
import json
import os
import re
import shutil
import subprocess
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AGENT_TOKEN = os.environ["AGENT_TOKEN"]
PORT = int(os.environ.get("AGENT_PORT", "8080"))
HERE = os.path.dirname(os.path.abspath(__file__))
PLAN_FILE = "/var/tmp/mc-agent-plan.json"  # survives an agent restart, dies with the server
SAMPLE_SECONDS = 10
CPU_POINTS = 61  # 10 minutes of samples for the panel's CPU chart


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


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def rcon(command):
    """Runs a server command through rcon-cli in the container; its output, or None if it failed."""
    try:
        result = subprocess.run(
            ["docker", "exec", "mc-server", "rcon-cli", command],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    # rcon-cli keeps Minecraft's colour codes
    return re.sub(r"\x1b\[[0-9;]*m|§.", "", result.stdout).strip()


class Sampler:
    """Every SAMPLE_SECONDS: CPU, players and TPS, so GET /status answers at once."""

    def __init__(self):
        self.cpu = deque(maxlen=CPU_POINTS)
        self.players = None   # {"max": 20, "list": [{"name", "minutes"}]}, None while Minecraft is down
        self.tps = None
        self._joined = {}     # player name -> time first seen online
        self._last_cpu = None

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                self._sample()
            except Exception as err:  # a bad sample must not kill the thread
                print(f"Sampler failed: {err}", flush=True)
            time.sleep(SAMPLE_SECONDS)

    def _sample(self):
        with open("/proc/stat") as f:
            fields = [int(x) for x in f.readline().split()[1:]]
        idle, total = fields[3] + fields[4], sum(fields)  # idle + iowait
        if self._last_cpu:
            d_idle, d_total = idle - self._last_cpu[0], total - self._last_cpu[1]
            if d_total > 0:
                self.cpu.append(round(100 * (1 - d_idle / d_total), 1))
        self._last_cpu = (idle, total)

        if container_state()[0] != "running":
            self.players, self.tps, self._joined = None, None, {}
            return
        self._sample_players()
        self._sample_tps()

    def _sample_players(self):
        # "There are 3 of a max of 20 players online: Steve, Alex, Kolya"
        out = rcon("list")
        match = re.search(r"(\d+) of a max of (\d+) players online:?(.*)", out or "")
        if not match:
            self.players = None
            return
        names = [n.strip() for n in match.group(3).split(",") if n.strip()]
        now = time.time()
        self._joined = {n: self._joined.get(n, now) for n in names}
        self.players = {
            "max": int(match.group(2)),
            "list": [{"name": n, "minutes": int((now - t) // 60)} for n, t in self._joined.items()],
        }

    def _sample_tps(self):
        # "Target tick rate: 20.0 per second. Average time per tick: 3.2ms (Target: 50.0ms)"
        out = rcon("tick query") or ""
        target = re.search(r"Target tick rate: ([\d.]+)", out)
        mspt = re.search(r"Average time per tick: ([\d.]+)\s*ms", out)
        if not (target and mspt):
            self.tps = None
            return
        rate = float(target.group(1))
        self.tps = round(min(rate, 1000 / max(float(mspt.group(1)), 0.001)), 1)


SAMPLER = Sampler()


def memory():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            key, value = line.split(":")
            info[key] = int(value.split()[0]) * 1024
    return {"used": info["MemTotal"] - info["MemAvailable"], "total": info["MemTotal"]}


def disk():
    usage = shutil.disk_usage("/")
    return {"used": usage.used, "total": usage.total}


def read_plan():
    try:
        with open(PLAN_FILE) as f:
            return json.load(f).get("plan")
    except (OSError, ValueError):
        return None


# Commands sent from the panel, shown in the console between the server's own lines
COMMANDS = deque(maxlen=50)
# "2026-11-15T20:14:02.123456789Z [20:14:02] [Server thread/INFO]: Steve joined the game"
LOG_LINE = re.compile(r"^(\S+)\s+(?:\[[\d:]+\]\s*)?(?:\[[^\]]*\]:?\s*)?(?:\([\w-]+\)\s*)?(.*)$")


def console_lines():
    """The end of Minecraft's output, plus the commands sent from the panel, oldest first."""
    try:
        result = subprocess.run(
            ["docker", "logs", "--timestamps", "--tail", "100", "mc-server"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    lines = []
    for raw in (result.stdout + result.stderr).splitlines():
        match = LOG_LINE.match(raw)
        if match and match.group(2).strip():
            # docker gives nanoseconds; keep whole seconds, the panel shows HH:MM:SS
            lines.append({"time": match.group(1)[:19] + "Z", "text": match.group(2), "command": False})
    lines += list(COMMANDS)
    lines.sort(key=lambda line: line["time"])
    return lines[-100:]


# --- Handlers: each returns (http_status, json_data) ---

def get_status(body):
    container, health = container_state()
    jobs = {name: job.to_json() for name, job in JOBS.items()}
    metrics = {"ram": memory(), "disk": disk(), "tps": SAMPLER.tps, "cpu": list(SAMPLER.cpu)}
    return 200, {
        "container": container, "health": health, "jobs": jobs,
        "plan": read_plan(), "players": SAMPLER.players, "metrics": metrics,
    }


def get_console(body):
    return 200, {"lines": console_lines()}


def post_console(body):
    command = str(body.get("command", "")).strip().lstrip("/")
    if not command:
        return 400, {"error": "empty command"}
    output = rcon(command)
    if output is None:
        return 502, {"error": "rcon failed, is Minecraft running?"}
    now = utc_now()
    COMMANDS.append({"time": now, "text": command, "command": True})
    # The answer goes to RCON, not to the server log, so keep it here
    for line in output.splitlines():
        if line.strip():
            COMMANDS.append({"time": now, "text": line, "command": False})
    return 200, {"output": output}


def post_plan(body):
    """Shutdown plan: "hour", "empty" or None. The panel's cron carries it out."""
    plan = body.get("plan")
    if plan not in ("hour", "empty", None):
        return 400, {"error": f"unknown plan {plan}"}
    with open(PLAN_FILE, "w") as f:
        json.dump({"plan": plan, "at": utc_now()}, f)
    return 200, {"plan": plan}


def post_stop(body):
    if not JOBS["stop"].start():
        return 409, {"error": "stop already running"}
    # The backup takes minutes; the panel follows it via GET /status
    return 202, {"started": "stop"}


ROUTES = {
    ("GET", "/status"): get_status,
    ("POST", "/stop"): post_stop,
    ("GET", "/console"): get_console,
    ("POST", "/console"): post_console,
    ("POST", "/plan"): post_plan,
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
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length)) if length else {}
        except ValueError:
            return self.send_json(400, {"error": "bad json"})
        self.send_json(*handler(body if isinstance(body, dict) else {}))

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
    SAMPLER.start()
    # Localhost only: reachable from outside just through the tunnel
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
