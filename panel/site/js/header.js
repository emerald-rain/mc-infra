// Shared header: chick, status pill and the action button (DESIGN.md §2)
import { esc, duration, ago, elapsed, minutesToNextHour, elements } from "./format.js";
import { STATES, STOPPABLE, STARTING } from "./states.js";

const RING = 28.3; // circumference of the r=4.5 billing ring

export function header(root, { onShutdown, onStart }) {
  const el = elements(root);
  el.shutdown.addEventListener("click", onShutdown);
  el.start.addEventListener("click", onStart);

  function part(html, cls = "") {
    return `<span class="part ${cls}">${html}</span>`;
  }

  function onlinePill(server) {
    const s = server.server;
    const uptime = (Date.now() - new Date(s.createdAt)) / 60000;
    const left = minutesToNextHour(s.createdAt);
    const offset = (RING * (1 - left / 60)).toFixed(1);
    return (
      part(`<span class="dot green" aria-hidden="true"></span><span class="sr">Uptime</span><b>${duration(uptime)}</b>`) +
      `<span>${esc(s.type)}</span>` +
      part(
        `<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">` +
          `<circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--ring-track)" stroke-width="2"/>` +
          `<circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--ring-fill)" stroke-width="2" stroke-dasharray="${RING}" stroke-dashoffset="${offset}" transform="rotate(-90 6 6)"/>` +
          `</svg><span class="sr">Next billing in</span><b>${left}m</b><span>left</span>`,
        "ring-part",
      )
    );
  }

  // A stage of the server's life: "● Restoring world  +2:45"
  function stagePill(server) {
    const { label, dot } = STATES[server.state] ?? { label: server.state, dot: "ring" };
    let tail = "";
    if (server.state === "none") tail = server.deletedAt ? ago(server.deletedAt) : "";
    // "+4:35" while starting, uptime after that
    else if (STARTING.includes(server.state) && server.server) tail = elapsed(server.server.createdAt);
    else if (server.server) tail = duration((Date.now() - new Date(server.server.createdAt)) / 60000);
    return part(`<span class="dot ${dot}" aria-hidden="true"></span><b>${esc(label)}</b>`) + (tail ? `<span>${tail}</span>` : "");
  }

  // screen: "online" | "offline"; server: GET /api/server, null until it answers
  return function render(screen, server) {
    el.status.hidden = !server;
    el.shutdown.hidden = el.start.hidden = true;
    if (!server) return;

    const idle = server.state === "none";
    el.status.classList.toggle("idle", idle);
    if (screen === "online" && server.state === "online" && server.server) el.status.innerHTML = onlinePill(server);
    else el.status.innerHTML = stagePill(server);

    if (STOPPABLE.includes(server.state)) el.shutdown.hidden = false;
    if (screen === "offline" && idle) el.start.hidden = false;
  };
}

// The Start button's label for screen readers names the picked save
export function setStartLabel(root, when, busy) {
  const button = root.querySelector('[data-el="start"]');
  button.setAttribute("aria-label", when ? `Start server from the ${when} save` : "Start server");
  button.disabled = busy;
}
