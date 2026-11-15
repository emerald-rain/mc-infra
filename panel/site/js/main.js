// Entry point: picks the screen, polls the API and hands the data to the screens.
//   #logs        Logs (the chick in the header)
//   otherwise    No server until a started server is online, Online from then until it is deleted
import { api } from "./api.js";
import { header, setStartLabel } from "./header.js";
import { onlineScreen } from "./online.js";
import { offlineScreen } from "./offline.js";
import { logsScreen } from "./logs.js";
import { STATES, STARTING } from "./states.js";

const POLL_MS = 5000;
const OFFLINE_POLL_MS = 60000;

const roots = {
  online: document.getElementById("online"),
  offline: document.getElementById("offline"),
  logs: document.getElementById("logs"),
};

let server = null;   // GET /api/server
let offline = null;  // GET /api/offline
let offlineAt = 0;
let starting = false;
let screen = null;

const renderHeader = header(document.getElementById("top"), {
  onShutdown: () => online.openSheet(),
  onStart: start,
});
const online = onlineScreen(roots.online, { sheet: document.getElementById("sheet"), refresh, report: showError });
const offlineView = offlineScreen(roots.offline, {
  onPick: (when) => setStartLabel(document.getElementById("top"), when, starting),
});
const logs = logsScreen(roots.logs);

function currentScreen() {
  if (location.hash === "#logs") return "logs";
  // A start keeps the No server screen up until the server is online
  if (server?.state === "none" || STARTING.includes(server?.state)) return "offline";
  return "online";
}

function render() {
  const next = currentScreen();
  if (next !== screen) {
    screen = next;
    for (const [name, root] of Object.entries(roots)) root.hidden = name !== screen;
    if (screen === "logs") {
      logs.shown();
      loadLog();
    }
    if (screen === "offline") loadOffline(true);
  }
  if (!server) return renderHeader(screen, null);
  renderHeader(screen, { ...server, deletedAt: offline?.deletedAt });
}

function showError(text) {
  online.showError(text);
  offlineView.showError(text);
}

async function refresh() {
  try {
    server = await api("GET", "/server");
    const errors = {
      backup_failed: "Backup failed. The server is kept: open the log, then shut down to retry.",
      start_failed: "Start failed, see the log. Shut down deletes the server, the backups stay in R2.",
    };
    showError(errors[server.state] ?? "");
  } catch (err) {
    showError(`No connection to the panel: ${err.message}`);
  }
  render();
  if (!server) return;
  offlineView.lock(server.state !== "none");
  if (server.state === "none") loadOffline(false);
  else online.update(server);
  if (screen === "logs") loadLog();
}

async function loadOffline(force) {
  if (!force && Date.now() - offlineAt < OFFLINE_POLL_MS) return;
  offlineAt = Date.now();
  try {
    offline = await api("GET", "/offline");
    offlineView.update(offline);
    render();
  } catch (err) {
    offlineView.showError(err.message);
  }
}

async function loadLog() {
  try {
    const log = await api("GET", "/log");
    const dot = STATES[server?.state]?.dot;
    logs.update(log, dot === "amber");
  } catch {
    // the next poll retries
  }
}

// Start creates the server and opens the log, where the start runs
async function start() {
  if (starting) return;
  starting = true;
  setStartLabel(document.getElementById("top"), null, true);
  try {
    await api("POST", "/server/start", offlineView.startRequest());
    showError("");
    location.hash = "#logs";
  } catch (err) {
    offlineView.showError(err.message);
  }
  starting = false;
  setStartLabel(document.getElementById("top"), null, false);
  refresh();
}

window.addEventListener("hashchange", render);
render();
refresh();
setInterval(refresh, POLL_MS);
