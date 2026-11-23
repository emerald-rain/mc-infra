// No server screen (DESIGN.md §4): R2 usage, the save to start from, past servers
import { esc, ago, gb, gbTotal, elements } from "./format.js";
import { PAST_SERVERS } from "./past-servers.js";

const DONE_MS = 1600;

const ICON_DOWN = `<svg class="icon-down" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10"/></svg>`;
const ICON_CHECK = `<svg class="icon-check" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>`;
const ICON_CLOUD = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.1 2.75 2.75 0 0 0 4.5 12.5z"/><path d="M8 7.5v3.5M6.5 9.5L8 11l1.5-1.5"/></svg>`;

export function offlineScreen(root, { onPick }) {
  const el = elements(root);
  let data = null;
  let picked = null;    // backup key
  let downloaded = null;
  let pastOpen = false;
  let timer;

  function renderR2() {
    const r2 = data.r2;
    el.r2.hidden = !r2;
    if (!r2) return;
    el.r2Fill.style.width = `${Math.min(100, (r2.used / r2.limit) * 100).toFixed(1)}%`;
    el.r2Text.innerHTML = `<span class="strong">${gb(r2.used)}</span>/${gbTotal(r2.limit)} GB`;
    el.r2.setAttribute("aria-label", `Cloudflare R2: ${gb(r2.used)} of ${gbTotal(r2.limit)} GB free tier used`);
  }

  function renderSaves() {
    const saves = data.backups ?? [];
    el.saves.hidden = saves.length === 0;
    if (!saves.some((s) => s.key === picked)) picked = saves[0]?.key ?? null;
    el.savesCount.textContent = saves.length === 1 ? "1 save" : `${saves.length} saves`;
    el.savesList.innerHTML = saves
      .map((s) => {
        const on = s.key === picked;
        return (
          `<div class="save${on ? " on" : ""}">` +
          `<button type="button" class="save-pick" role="radio" aria-checked="${on}" data-save="${esc(s.key)}">` +
          `<span class="radio" aria-hidden="true"></span>` +
          `<span class="save-text"><span class="save-name">${esc(s.key)}</span><span class="save-when">${ago(s.uploaded)}</span></span>` +
          `<span class="save-size">${gb(s.size)} GB</span></button>` +
          `<button type="button" class="icon-btn${downloaded === s.key ? " done" : ""}" data-download="${esc(s.key)}" aria-label="Download ${esc(s.key)}">` +
          ICON_DOWN + ICON_CHECK +
          (downloaded === s.key ? `<span class="sr" role="status">Download started</span>` : "") +
          `</button></div>`
        );
      })
      .join("");
    const save = saves.find((s) => s.key === picked);
    onPick(save ? ago(save.uploaded) : null);
  }

  function renderPast() {
    el.past.hidden = PAST_SERVERS.length === 0;
    el.pastCount.textContent = `${PAST_SERVERS.length} saves`;
    el.pastList.innerHTML = PAST_SERVERS.map((w) =>
      `<li><span class="past-version">${esc(w.version)}</span><span class="past-name">${esc(w.name)}</span>` +
      `<span class="past-size">${esc(w.size)}</span>` +
      `<a class="past-link" href="${esc(w.url)}" target="_blank" rel="noopener" aria-label="Open ${esc(w.version)} ${esc(w.name)} in Google Drive">${ICON_CLOUD}</a></li>`,
    ).join("");
  }

  // Past servers are collapsed by default; the count stays visible in the header
  function setPastOpen(open) {
    pastOpen = open;
    el.past.classList.toggle("open", open);
    el.pastToggle.setAttribute("aria-expanded", open);
    el.pastList.hidden = !open;
  }

  el.pastToggle.addEventListener("click", () => setPastOpen(!pastOpen));

  let locked = false; // a server is being started: the choices stay on screen, frozen

  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-save],[data-download]");
    if (!t) return;
    const d = t.dataset;
    if (locked && !d.download) return;
    if (d.save) {
      picked = d.save;
      renderSaves();
    } else if (d.download) {
      // The Worker answers with Content-Disposition: attachment, so the page stays
      window.location.href = `/api/backup?key=${encodeURIComponent(d.download)}`;
      downloaded = d.download;
      renderSaves();
      clearTimeout(timer);
      timer = setTimeout(() => {
        downloaded = null;
        renderSaves();
      }, DONE_MS);
    }
  });

  renderPast();
  setPastOpen(false);

  return {
    // Body for POST /api/server/start
    startRequest() {
      return { save: picked };
    },
    lock(on) {
      locked = on;
      root.classList.toggle("locked", on);
    },
    showError(text) {
      el.error.textContent = text;
      el.error.hidden = !text;
    },
    update(offline) {
      data = offline;
      renderR2();
      renderSaves();
    },
  };
}
