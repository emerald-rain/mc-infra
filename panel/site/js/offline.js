// No server screen (DESIGN.md §4): R2 usage, the save to start from, server type and location, past servers
import { esc, ago, gb, gbTotal, elements } from "./format.js";
import { PAST_SERVERS } from "./past-servers.js";

const DONE_MS = 1600;

const LOCATIONS = [
  { id: "nbg1", name: "Nuremberg", flag: "de" },
  { id: "fsn1", name: "Falkenstein", flag: "de" },
  { id: "hel1", name: "Helsinki", flag: "fi" },
];

// €/hour in Helsinki, used only when Hetzner did not answer; Germany costs €2/month more (DESIGN.md §4.3)
const TYPES = [
  { id: "cx23", price: 0.009, note: "older CPU" },
  { id: "cpx12", price: 0.015, note: "" },
  { id: "cpx22", price: 0.026, note: "" },
];
const GERMANY_EXTRA = 2 / 730;

const FLAGS = {
  de: `<svg width="14" height="10" viewBox="0 0 5 3" aria-hidden="true"><rect width="5" height="1" fill="#000"/><rect y="1" width="5" height="1" fill="#dd0000"/><rect y="2" width="5" height="1" fill="#ffce00"/></svg>`,
  fi: `<svg width="14" height="10" viewBox="0 0 18 11" aria-hidden="true"><rect width="18" height="11" fill="#fff"/><rect x="5" width="3" height="11" fill="#003580"/><rect y="4" width="18" height="3" fill="#003580"/></svg>`,
};
const ICON_DOWN = `<svg class="icon-down" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10"/></svg>`;
const ICON_CHECK = `<svg class="icon-check" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>`;
const ICON_CLOUD = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.1 2.75 2.75 0 0 0 4.5 12.5z"/><path d="M8 7.5v3.5M6.5 9.5L8 11l1.5-1.5"/></svg>`;

export function offlineScreen(root, { onPick }) {
  const el = elements(root);
  let data = null;
  let picked = null;    // backup key
  let type = null;      // chosen by the user, null = default
  let location = null;
  let downloaded = null;
  let timer;

  // From Hetzner: { type: { location: €/hour } } with only the locations it can be created in now.
  // Without an answer every type counts as available at the fallback price.
  const available = (typeId, loc) => {
    const all = data?.availability;
    return !all || all[typeId]?.[loc] != null;
  };
  const priceOf = (t, loc) => data?.availability?.[t.id]?.[loc] ?? t.price + (loc === "hel1" ? 0 : GERMANY_EXTRA);

  // Default: cx23 in Helsinki, else cx23 anywhere, else cpx12 in Helsinki (DESIGN.md §4.3)
  function choice() {
    const anyCx = LOCATIONS.map((l) => l.id).find((l) => available("cx23", l));
    const loc = location ?? (available("cx23", "hel1") ? "hel1" : anyCx ?? "hel1");
    const wanted = type ?? (available("cx23", loc) ? "cx23" : "cpx12");
    // An unavailable pick falls back to cpx12, then to whatever the location still has
    const fallback = ["cpx12", ...TYPES.map((t) => t.id)].find((id) => available(id, loc)) ?? wanted;
    return { location: loc, type: available(wanted, loc) ? wanted : fallback };
  }

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

  function renderConfig() {
    el.config.hidden = false;
    const c = choice();
    el.types.innerHTML = TYPES.map((t) => {
      const off = !available(t.id, c.location);
      const on = t.id === c.type;
      const price = priceOf(t, c.location);
      return (
        `<button type="button" class="type" role="radio" aria-checked="${on}" aria-disabled="${off}" data-type="${t.id}">` +
        `<span class="type-top"><span class="type-name">${t.id}</span><span class="type-note">${t.note}</span></span>` +
        `<span class="type-price">${off ? "unavailable" : `€${price.toFixed(3)}/h`}</span></button>`
      );
    }).join("");
    el.locations.innerHTML = LOCATIONS.map((l) =>
      `<button type="button" class="location" role="radio" aria-checked="${l.id === c.location}" data-location="${l.id}">` +
      `${FLAGS[l.flag]}<span>${l.name}</span></button>`).join("");
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

  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-save],[data-download],[data-type],[data-location]");
    if (!t) return;
    const d = t.dataset;
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
    } else if (d.type) {
      if (t.getAttribute("aria-disabled") === "true") return;
      type = d.type;
      renderConfig();
    } else if (d.location) {
      location = d.location;
      // A location without the wanted type falls back to cpx12 (choice() does it)
      if (type && !available(type, location)) type = null;
      renderConfig();
    }
  });

  renderPast();

  return {
    // Body for POST /api/server/start
    startRequest() {
      return { save: picked, ...choice() };
    },
    showError(text) {
      el.error.textContent = text;
      el.error.hidden = !text;
    },
    update(offline) {
      data = offline;
      renderR2();
      renderSaves();
      renderConfig();
    },
  };
}
