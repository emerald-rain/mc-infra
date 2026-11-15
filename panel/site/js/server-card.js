// The server view: shows the state from GET /api/server, starts and stops the server
import { api } from "./api.js";

// state: [label, dot color, hint, button action]
const STATES = {
  none:          ["No server",       "gray",   "No server, the world is safe in R2.",                              "start"],
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

const BUTTON_TEXT = { start: "Start", stop: "Shut down" };

export function serverCard(root) {
  // Elements of this view by their data-el name
  const el = Object.fromEntries([...root.querySelectorAll("[data-el]")].map((e) => [e.dataset.el, e]));
  let state = "none";
  let busy = false;
  let actionError = "";

  function render(data) {
    state = data.state;
    const [label, color, hint, action] = STATES[state] ?? [state, "gray", "", null];
    el.label.textContent = label;
    el.dot.className = `dot ${color}`;
    el.pill.classList.toggle("idle", state === "none");
    el.hint.textContent = hint;
    setCopyValue(el.copyHostname, el.hostname, data.hostname);
    setCopyValue(el.copyIp, el.ip, data.ip ?? "");
    el.address.hidden = !["starting", "online"].includes(state) || !data.ip;
    el.log.textContent = data.log ?? "";
    el.log.hidden = !data.log;
    el.action.hidden = !action;
    el.action.className = `btn ${action ?? ""}`;
    el.action.textContent = state === "backup_failed" ? "Retry backup" : BUTTON_TEXT[action];
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

  async function run(action) {
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
  }

  // Stopping kicks the players, so it asks first. Retrying a failed backup does not.
  el.action.addEventListener("click", () => {
    const action = el.action.dataset.action;
    if (action === "stop" && state !== "backup_failed") el.sheet.hidden = false;
    else run(action);
  });

  const closeSheet = () => (el.sheet.hidden = true);
  el.close.addEventListener("click", closeSheet);
  el.cancel.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());
  el.confirm.addEventListener("click", () => {
    closeSheet();
    run("stop");
  });

  // Copy pill: the value is kept on the button, the text shows "Copied" for a moment after a tap
  function setCopyValue(button, label, value) {
    button.dataset.value = value;
    if (!button.classList.contains("copied")) label.textContent = value;
  }

  function copyPill(button, label) {
    let timer;
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(button.dataset.value);
      clearTimeout(timer);
      label.textContent = "Copied";
      button.classList.add("copied");
      timer = setTimeout(() => {
        button.classList.remove("copied");
        label.textContent = button.dataset.value;
      }, 1600);
    });
  }
  copyPill(el.copyHostname, el.hostname);
  copyPill(el.copyIp, el.ip);

  refresh();
  setInterval(refresh, 5000);
}
