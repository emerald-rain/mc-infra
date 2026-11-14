// The server card: shows the state from GET /api/server, starts and stops the server
import { api } from "./api.js";

// state: [label, dot color, hint, button action]
const STATES = {
  none:          ["Offline",         "gray",   "No server, the world is safe in R2.",                              "start"],
  creating:      ["Creating",        "yellow", "Hetzner is creating the server.",                                  null],
  booting:       ["Booting",         "yellow", "Installing packages, a few minutes.",                              null],
  restoring:     ["Restoring world", "yellow", "Downloading the latest backup from R2.",                           null],
  starting:      ["Starting",        "yellow", "Minecraft is loading the world.",                                  "stop"],
  online:        ["Online",          "green",  "Join and have fun.",                                               "stop"],
  stopped:       ["Stopped",         "red",    "Minecraft is not running. Stop to back up and delete the server.", "stop"],
  backing_up:    ["Backing up",      "yellow", "Saving the world to R2. You can close the tab.",                   null],
  deleting:      ["Deleting",        "yellow", "Backup done, the server is being deleted.",                        null],
  backup_failed: ["Backup failed",   "red",    "The server is kept. Check the log and retry.",                     "stop"],
};

const BUTTON_TEXT = { start: "Start server", stop: "Stop server" };

export function serverCard(card) {
  // Elements of this card by their data-el name
  const el = Object.fromEntries([...card.querySelectorAll("[data-el]")].map((e) => [e.dataset.el, e]));
  let busy = false;
  let actionError = "";

  function render(data) {
    const [label, color, hint, action] = STATES[data.state] ?? [data.state, "gray", "", null];
    el.label.textContent = label;
    el.dot.className = `dot ${color}`;
    el.hint.textContent = hint;
    el.hostname.textContent = data.hostname;
    el.address.hidden = !["starting", "online"].includes(data.state);
    el.log.textContent = data.log ?? "";
    el.log.hidden = !data.log;
    el.action.hidden = !action;
    el.action.textContent = data.state === "backup_failed" ? "Retry backup" : BUTTON_TEXT[action];
    el.action.dataset.action = action ?? "";
    el.action.disabled = busy;
  }

  function showError(text) {
    el.error.textContent = text;
    el.error.hidden = !text;
  }

  async function refresh() {
    try {
      render(await api("GET", "/server"));
      showError(actionError);
    } catch (err) {
      showError(`No connection to the panel: ${err.message}`);
    }
  }

  el.action.addEventListener("click", async () => {
    const action = el.action.dataset.action;
    if (action === "stop" && !confirm("Stop the server? Players will be kicked.")) return;
    busy = true;
    el.action.disabled = true;
    try {
      await api("POST", `/server/${action}`);
      actionError = "";
    } catch (err) {
      actionError = err.message;
    }
    busy = false;
    await refresh();
  });

  el.copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(el.hostname.textContent);
    el.copy.textContent = "Copied";
    setTimeout(() => (el.copy.textContent = "Copy"), 1500);
  });

  refresh();
  setInterval(refresh, 5000);
}
