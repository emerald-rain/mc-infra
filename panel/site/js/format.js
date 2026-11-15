// Text formats shared by every screen (DESIGN.md §1: compact durations, UTC in the log)

// Escapes text for innerHTML
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// 226 -> "3h 46m", 14 -> "14m"
export function duration(minutes) {
  const m = Math.max(0, Math.floor(minutes));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

// Time since a date: "14m ago", "2h ago", "yesterday", "3 days ago"
export function ago(date, now = Date.now()) {
  const min = Math.max(0, Math.floor((now - new Date(date)) / 60000));
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// Bytes -> "1.2" (GB, one decimal, never 0.0 for a real file)
export function gb(bytes) {
  const value = bytes / 1e9;
  return (bytes > 0 && value < 0.1 ? 0.1 : value).toFixed(1);
}

// Totals drop a trailing ".0": 20 GB, 1.9 GB
export function gbTotal(bytes) {
  return gb(bytes).replace(/\.0$/, "");
}

const pad = (n) => String(n).padStart(2, "0");

// "08:51:04" in UTC
export function hms(date) {
  const d = new Date(date);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// "2026-11-15 08:51:04 UTC"
export function fullUtc(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${hms(d)} UTC`;
}

// Seconds since a date as "+4:35"
export function elapsed(date, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - new Date(date)) / 1000));
  return `+${Math.floor(s / 60)}:${pad(s % 60)}`;
}

// Hetzner bills every started hour from creation: minutes until the next one starts
export function minutesToNextHour(createdAt, now = Date.now()) {
  const min = Math.floor((now - new Date(createdAt)) / 60000);
  return 60 - (min % 60);
}

// Element map of a screen by data-el name
export function elements(root) {
  return Object.fromEntries([...root.querySelectorAll("[data-el]")].map((e) => [e.dataset.el, e]));
}
