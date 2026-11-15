// The panel's log of every start and stop, kept in R2 (mc-world/panel/log.json).
//   { sessions: [{ kind: "start" | "stop", at, fields: [[key, value]], lines: [Line], serverId, closed }] }
//   Line: { time, text, kind: "done" | "spin" | "ok" | "err", hint?, console? }
// Written only when a server is created and right before it is deleted; the part in between
// is built live from Hetzner and the agent (api/log.js).
const KEY = "panel/log.json";
export const MAX_LINES = 500;

export async function load(env) {
    const object = await env.WORLD.get(KEY);
    if (!object) return { sessions: [] };
    try {
        return await object.json();
    } catch {
        return { sessions: [] };
    }
}

export async function save(env, log) {
    await env.WORLD.put(KEY, JSON.stringify(trim(log)), {
        httpMetadata: { contentType: "application/json" },
    });
}

// Keeps the last MAX_LINES lines over all sessions, dropping the oldest first
export function trim(log) {
    const sessions = log.sessions.map((s) => ({ ...s, lines: [...s.lines] }));
    let extra = sessions.reduce((n, s) => n + s.lines.length, 0) - MAX_LINES;
    while (extra > 0 && sessions.length > 0) {
        const first = sessions[0];
        const cut = Math.min(extra, first.lines.length);
        first.lines.splice(0, cut);
        extra -= cut;
        if (first.lines.length === 0) sessions.shift();
    }
    return { sessions };
}

export const line = (time, text, kind = "done", extra = {}) => ({ time, text, kind, ...extra });
