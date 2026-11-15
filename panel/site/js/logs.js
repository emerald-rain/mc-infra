// Logs screen (DESIGN.md §5): every start and stop as a neofetch-style terminal
import { esc, hms, fullUtc, elements } from "./format.js";
import { renderWord } from "./pixel-font.js";

const ICONS = {
  done: `<svg width="11" height="11" viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>`,
  ok: `<svg width="11" height="11" viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>`,
  err: `<svg width="11" height="11" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  spin: `<svg class="spinner" width="11" height="11" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 6 6"/></svg>`,
};
const WORDS = { start: renderWord("START", { cell: 3 }), stop: renderWord("STOP", { cell: 3 }) };

// "Host" -> "Host:   " so the values line up at 8 characters
const field = ([k, v]) =>
  `<div class="field"><span class="k">${esc(k)}</span><span class="p">${":".padEnd(8 - k.length)}</span><span class="v">${esc(v)}</span></div>`;

function line(l) {
  if (l.console) return ""; // Minecraft's boot output, kept in older logs, is not shown
  const kind = ICONS[l.kind] ? l.kind : "done";
  const hint = l.hint ? `<span class="ev-hint">${esc(l.hint)}</span>` : "";
  return (
    `<div class="ev ${kind}"><span class="ev-t">${hms(l.time)}</span>` +
    `<span class="ev-i" aria-hidden="true">${ICONS[kind]}</span>` +
    `<span class="ev-x">${esc(l.text)}${hint}</span></div>`
  );
}

function session(s) {
  return (
    `<div class="session-head">${WORDS[s.kind] ?? ""}` +
    `<div class="session-at">${fullUtc(s.at)}</div>` +
    `<div class="session-rule">${"-".repeat(29)}</div>` +
    s.fields.map(field).join("") +
    `</div>` +
    s.lines.map(line).join("")
  );
}

export function logsScreen(root) {
  const el = elements(root);
  let stick = true;
  let key = "";

  el.wordmark.innerHTML = renderWord("KLADNASH", { cell: 5 });

  // Stays at the bottom while the user is there; scrolled up, the log stands still
  el.scroll.addEventListener("scroll", () => {
    const s = el.scroll;
    stick = s.scrollHeight - s.scrollTop - s.clientHeight < 24;
  });

  const scrollDown = () => stick && (el.scroll.scrollTop = el.scroll.scrollHeight);

  return {
    shown() {
      stick = true;
      scrollDown();
    },
    // log: GET /api/log
    update(log) {
      const next = JSON.stringify(log.sessions);
      if (next !== key) {
        key = next;
        el.sessions.innerHTML = log.sessions.map(session).join("");
      }
      scrollDown();
    },
  };
}
