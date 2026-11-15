// Shared header: chick link, status pill and the action button (DESIGN.md §2)
import { esc, duration, ago, elapsed, minutesToNextHour, elements } from "./format.js";
import { STATES, STOPPABLE, minutesToPlannedStop } from "./states.js";

const RING = 28.3; // circumference of the r=4.5 billing ring

export function header(root, { onShutdown, onStart }) {
  const el = elements(root);
  el.shutdown.addEventListener("click", onShutdown);
  el.planned.addEventListener("click", onShutdown);
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
  function stagePill(server, screen) {
    const { label, dot } = STATES[server.state] ?? { label: server.state, dot: "ring" };
    // The log shows "no server" as a plain grey dot, the panel as a hollow ring
    const dotClass = dot === "ring" && screen === "logs" ? "" : dot;
    let tail = "";
    if (server.state === "none") tail = server.deletedAt ? ago(server.deletedAt) : "";
    else if (server.state === "online" && server.server) tail = duration((Date.now() - new Date(server.server.createdAt)) / 60000);
    else if (server.server) tail = elapsed(server.server.createdAt);
    return part(`<span class="dot ${dotClass}" aria-hidden="true"></span><b>${esc(label)}</b>`) + (tail ? `<span>${tail}</span>` : "");
  }

  // screen: "online" | "offline" | "logs"; server: GET /api/server, null until it answers
  return function render(screen, server) {
    root.classList.toggle("on-logs", screen === "logs");
    el.logo.href = screen === "logs" ? "#" : "#logs";
    el.logo.setAttribute("aria-label", screen === "logs" ? "Back to the panel" : "Kladnash: open server logs");

    el.status.hidden = !server;
    el.shutdown.hidden = el.planned.hidden = el.start.hidden = true;
    if (!server) return;

    const idle = server.state === "none";
    el.status.classList.toggle("idle", idle && screen !== "logs");
    if (screen === "online" && server.state === "online" && server.server) el.status.innerHTML = onlinePill(server);
    else el.status.innerHTML = stagePill(server, screen);

    if (screen === "online" && STOPPABLE.includes(server.state)) {
      const plan = server.plan;
      if (plan && server.server) {
        const text = plan === "hour" ? `Stops in ${minutesToPlannedStop(minutesToNextHour(server.server.createdAt))}m` : "Stops if empty";
        el.plannedText.textContent = text;
        el.planned.setAttribute("aria-label", `Shutdown scheduled: ${text}. Change or cancel`);
        el.planned.hidden = false;
      } else {
        el.shutdown.hidden = false;
      }
    }
    if (screen === "offline") el.start.hidden = false;
  };
}

// The Start button's label for screen readers names the picked save
export function setStartLabel(root, when, busy) {
  const button = root.querySelector('[data-el="start"]');
  button.setAttribute("aria-label", when ? `Start server from the ${when} save` : "Start server");
  button.disabled = busy;
}
