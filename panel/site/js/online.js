// Online screen (DESIGN.md §3): players, metrics, address, RCON console, shutdown sheet
import { api } from "./api.js";
import { esc, gb, gbTotal, hms, minutesToNextHour, elements } from "./format.js";
import { PLANS, STOPPABLE, STOPPING, minutesToPlannedStop } from "./states.js";

const COPIED_MS = 1600;

// Player face from the skin, with the hat layer; 8x8, scaled up without smoothing
const headUrl = (name) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/8`;
const head = (name) => `<img class="head" src="${headUrl(name)}" width="16" height="16" alt="" loading="lazy">`;

// sheet: the shutdown sheet, outside root so it opens on the No server screen too.
// report: shows an error on whichever screen is up.
export function onlineScreen(root, { sheet, refresh, report }) {
  const el = { ...elements(root), ...elements(sheet), sheet };
  let server = null;
  let playersOpen = false;
  let sheetChoice = "empty";
  let busy = false;
  let consoleKey = "";

  // --- Players -------------------------------------------------------------

  el.playersToggle.addEventListener("click", () => setPlayersOpen(!playersOpen));

  function setPlayersOpen(open) {
    playersOpen = open;
    el.players.classList.toggle("open", open);
    el.playersToggle.setAttribute("aria-expanded", open);
    el.playersList.hidden = !open;
  }

  function renderPlayers(players) {
    el.players.hidden = !players;
    if (!players) return;
    const list = players.list;
    el.players.setAttribute("aria-label", `Players online: ${list.length} of ${players.max}`);
    el.heads.innerHTML = list.slice(0, 5).map((p) => head(p.name)).join("");
    el.heads.hidden = list.length === 0;
    el.names.textContent = list.map((p) => p.name).join(", ");
    el.count.innerHTML = `<span class="strong">${list.length}</span>/${players.max}`;
    el.playersList.innerHTML = list
      .map((p) => `<li>${head(p.name)}<span class="name">${esc(p.name)}</span><span class="time">${p.minutes} min</span></li>`)
      .join("");
    el.playersToggle.disabled = list.length === 0;
    if (list.length === 0) setPlayersOpen(false);
  }

  // --- Metrics ---------------------------------------------------------------

  const metric = (key, value, unit = "", cls = "") =>
    `<span class="metric"><span class="k">${key}</span><span class="v ${cls}">${value}</span>` +
    (unit ? `<span class="u">${unit}</span>` : "") + `</span>`;
  const sep = `<span class="metric-sep" aria-hidden="true"></span>`;

  function renderMetrics(m) {
    el.metrics.hidden = !m;
    if (!m) return;
    el.metricRow.innerHTML = [
      metric("RAM", gb(m.ram.used), `/${gbTotal(m.ram.total)} GB`),
      metric("TPS", m.tps == null ? "–" : m.tps.toFixed(1), "", m.tps >= 19 ? "good" : ""),
      metric("DISK", gb(m.disk.used), `/${gbTotal(m.disk.total)} GB`),
    ].join(sep);
    drawCpu(m.cpu ?? []);
  }

  // 10 minutes, a point every 10 s (61 points); 100% at y 4, 0% at y 86
  const POINTS = 61, H = 88, TOP = 4, BOTTOM = 86;
  const yOf = (v) => BOTTOM - (Math.min(100, Math.max(0, v)) / 100) * (BOTTOM - TOP);

  function drawCpu(cpu) {
    const svg = el.cpuSvg;
    const w = el.cpu.clientWidth || 329;
    if (cpu.length === 0) {
      svg.innerHTML = "";
      el.cpuNow.hidden = el.cpuAvg.hidden = true;
      return;
    }
    const step = w / (POINTS - 1);
    const pts = cpu.slice(-POINTS).map((v, i, a) => [w - (a.length - 1 - i) * step, yOf(v)]);
    const now = Math.round(cpu[cpu.length - 1]);
    const avg = Math.round(cpu.reduce((s, v) => s + v, 0) / cpu.length);
    const avgY = yOf(avg);
    const [lx, ly] = pts[pts.length - 1];

    svg.setAttribute("viewBox", `0 0 ${w} ${H}`);
    svg.setAttribute("width", w);
    svg.setAttribute("aria-label", `CPU usage, last 10 minutes: now ${now}%, average ${avg}%`);
    svg.innerHTML =
      `<line class="avg-line" x1="0" y1="${avgY.toFixed(1)}" x2="${w}" y2="${avgY.toFixed(1)}"/>` +
      `<polyline class="line" points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}"/>` +
      `<circle class="last" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4"/>`;

    // "avg 54%" sits right above its line
    el.cpuAvg.textContent = `avg ${avg}%`;
    el.cpuAvg.style.top = `${Math.min(H - 15, Math.max(0, avgY - 15.7))}px`;
    el.cpuAvg.hidden = false;

    // "CPU 71%" goes to the corner the line crosses least (and away from the avg label).
    // The line is sampled every pixel of its length, so steep jumps count too.
    el.cpuValue.textContent = `${now}%`;
    el.cpuNow.hidden = false;
    const samples = [];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
      const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
      for (let k = 0; k < n; k++) samples.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
    }
    const bw = 64, bh = 22; // the glyphs of "CPU 71%"
    const corners = { br: [w - bw, H - bh], bl: [0, H - bh], tr: [w - bw, 0], tl: [0, 0] };
    const avgTop = avgY - 15.7;
    let best = "br", bestScore = Infinity;
    for (const [name, [x0, y0]] of Object.entries(corners)) {
      let score = samples.filter(([x, y]) => x >= x0 && x <= x0 + bw && y >= y0 && y <= y0 + bh).length;
      // The avg label lives at the right edge: keep the right corners clear of it
      if (name[1] === "r" && avgTop < y0 + bh && avgTop + 15 > y0) score += 1000;
      if (score < bestScore) [best, bestScore] = [name, score];
    }
    el.cpuNow.className = `cpu-now ${best}`;
  }

  new ResizeObserver(() => server?.metrics && drawCpu(server.metrics.cpu ?? [])).observe(el.cpu);

  // --- Address -----------------------------------------------------------------

  function copyButton(button, label, name) {
    let timer;
    button.addEventListener("click", async () => {
      const value = button.dataset.value;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        return;
      }
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
      clearTimeout(timer);
      button.classList.add("copied");
      label.textContent = "Copied";
      button.querySelector('[role="status"]').textContent = "Copied";
      timer = setTimeout(() => {
        button.classList.remove("copied");
        label.textContent = button.dataset.value;
        button.querySelector('[role="status"]').textContent = "";
      }, COPIED_MS);
    });
    return (value) => {
      button.dataset.value = value;
      button.setAttribute("aria-label", `Copy server ${name} ${value}`);
      if (!button.classList.contains("copied")) label.textContent = value;
    };
  }
  const setDomain = copyButton(el.copyDomain, el.domainText, "domain");
  const setIp = copyButton(el.copyIp, el.ipText, "IP");

  // --- Console -------------------------------------------------------------------

  function renderConsole(lines) {
    const key = JSON.stringify(lines);
    if (key === consoleKey) return;
    consoleKey = key;
    const out = el.consoleOut;
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 24;
    out.innerHTML = lines
      .map((l) => `<div><span class="t">${hms(l.time)}</span> ${l.command ? `<span class="cmd">&gt; ${esc(l.text)}</span>` : esc(l.text)}</div>`)
      .join("");
    if (atBottom) out.scrollTop = out.scrollHeight;
  }

  async function loadConsole() {
    if (server?.state !== "online" && !STOPPING.includes(server?.state)) return;
    try {
      renderConsole((await api("GET", "/console")).lines);
    } catch {
      // the next poll retries
    }
  }

  el.consoleForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const command = el.consoleInput.value.trim();
    if (!command) return;
    el.consoleInput.value = "";
    try {
      await api("POST", "/console", { command });
      showError("");
    } catch (err) {
      showError(err.message);
    }
    loadConsole();
  });

  // Typing mode: metrics and address hide, players fold, the console takes the height
  el.consoleInput.addEventListener("focus", () => {
    root.classList.add("typing");
    setPlayersOpen(false);
  });
  el.consoleInput.addEventListener("blur", () => root.classList.remove("typing"));

  // --- Shutdown sheet ------------------------------------------------------------

  function minutesLeft() {
    return server?.server ? minutesToNextHour(server.server.createdAt) : 60;
  }

  function renderSheet() {
    const left = minutesLeft();
    const inMin = minutesToPlannedStop(left);
    const count = server?.players?.list.length ?? 0;
    el.sheetMeta.innerHTML =
      `next hour billed in <b>${left}m</b> · <b>${count}</b> ${count === 1 ? "player" : "players"} online`;
    const side = { now: "now", hour: inMin ? `in ${inMin}m` : "now", empty: `${count} online` };
    el.sheetOptions.innerHTML = Object.entries(PLANS)
      .map(([id, p]) =>
        `<button type="button" class="option" role="radio" aria-checked="${id === sheetChoice}" data-plan="${id}">` +
        `<span class="radio" aria-hidden="true"></span>` +
        `<span class="option-text"><span class="option-title">${p.title}</span><span class="option-desc">${p.desc}</span></span>` +
        `<span class="option-side">${side[id]}</span></button>`)
      .join("");
    el.sheetConfirm.textContent = {
      now: "Shut down now",
      hour: inMin ? `Shut down in ${inMin}m` : "Shut down now",
      empty: "Shut down when empty",
    }[sheetChoice];
    el.sheetSecondary.textContent = server?.plan ? "Keep running" : "Cancel";
    el.sheetConfirm.disabled = el.sheetSecondary.disabled = busy;
  }

  function openSheet() {
    sheetChoice = server?.plan ?? "empty";
    renderSheet();
    el.sheet.hidden = false;
  }
  const closeSheet = () => (el.sheet.hidden = true);

  el.sheetOptions.addEventListener("click", (e) => {
    const option = e.target.closest("[data-plan]");
    if (!option) return;
    sheetChoice = option.dataset.plan;
    renderSheet();
  });
  el.sheetClose.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());

  async function act(method, path, body) {
    busy = true;
    renderSheet();
    try {
      await api(method, path, body);
      report("");
      closeSheet();
    } catch (err) {
      report(err.message);
    }
    busy = false;
    renderSheet();
    refresh();
  }

  // "Keep running" cancels the plan, "Cancel" just closes
  el.sheetSecondary.addEventListener("click", () => {
    if (server?.plan) act("POST", "/server/plan", { plan: null });
    else closeSheet();
  });
  el.sheetConfirm.addEventListener("click", () => {
    if (sheetChoice === "now") act("POST", "/server/stop");
    else act("POST", "/server/plan", { plan: sheetChoice });
  });

  function showError(text) {
    el.error.textContent = text;
    el.error.hidden = !text;
  }

  setInterval(loadConsole, 3000);

  return {
    openSheet,
    showError,
    update(data) {
      const first = server?.state !== "online" && data.state === "online";
      // While it stops, the screen keeps the last players and metrics until the server is gone
      const stopping = STOPPING.includes(data.state);
      server = data;
      const online = data.state === "online";
      if (online || !stopping) {
        renderPlayers(online ? data.players : null);
        renderMetrics(online ? data.metrics : null);
      } else if (data.metrics) {
        renderMetrics(data.metrics); // the agent keeps measuring during the backup
      }
      el.address.hidden = !data.ip;
      setDomain(data.hostname);
      if (data.ip) setIp(data.ip);
      // The console stays readable while stopping; only an online server takes commands
      el.console.hidden = !online && !(stopping && consoleKey);
      el.consoleInput.disabled = !online;
      el.console.querySelector('button[type="submit"]').disabled = !online;
      if (!online) root.classList.remove("typing");
      if (!el.sheet.hidden) {
        if (STOPPABLE.includes(data.state)) renderSheet();
        else closeSheet();
      }
      if (first) loadConsole();
    },
  };
}
