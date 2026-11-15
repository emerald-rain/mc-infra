// The Logs screen: stored sessions from R2 plus the live part of the current server
import * as log from "../services/log.js";
import * as agent from "../services/agent.js";
import { getState } from "./server.js";

export const routes = {
    "GET /api/log": getLog,
};

export const REGIONS = { nbg1: "Nuremberg", fsn1: "Falkenstein", hel1: "Helsinki" };

const { line } = log;
const now = () => new Date().toISOString();

// 226 -> "3h 46m", like the site
function duration(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

// A script's output: "ERROR: ..." lines are errors; the last line spins while it runs
function jobLines(job) {
    const lines = job.lines.map((l) => line(l.time, l.text, l.text.startsWith("ERROR") ? "err" : "done"));
    const last = lines[lines.length - 1];
    if (last && job.status === "running") last.kind = "spin";
    if (last && job.status === "failed") last.kind = "err";
    return lines;
}

// The lines worker writes when it creates the server (api/server.js start)
export function creationLines(server, type, location, hostname, ip) {
    const t = now();
    return [
        line(t, `Creating server ${type} in ${REGIONS[location] ?? location} ...`),
        line(t, `Server created, id ${server.id}`),
        line(t, `IP assigned: ${ip}`),
        line(t, `DNS record updated: ${hostname} -> ${ip}`),
    ];
}

// The start session of a running server: stored creation lines, then Hetzner, the agent and Minecraft
function startLines(stored, server, agentLog, hostname) {
    const lines = stored.lines.filter((l) => !l.live);
    const live = (l) => ({ ...l, live: true });
    const add = (...more) => lines.push(...more.map(live));

    if (server.status !== "running") {
        add(line(server.created, `Hetzner: server is ${server.status} ...`, "spin"));
        return lines;
    }
    if (!agentLog) {
        add(
            line(server.created, "Hetzner: server is running"),
            line(server.created, "Waiting for the server agent ...", "spin", { hint: "Installing packages, a few minutes." }),
        );
        return lines;
    }
    add(line(agentLog.agentStarted ?? server.created, "Hetzner: server is running"));
    add(line(agentLog.agentStarted ?? server.created, "Agent connected"));
    const start = agentLog.jobs.start;
    if (start && start.status !== "idle") add(...jobLines(start));
    if (start?.status !== "done") return lines;

    add(line(start.finished, "Container mc-server: running", agentLog.onlineAt ? "done" : "spin"));
    if (agentLog.onlineAt) add(line(agentLog.onlineAt, `Server is online, join at ${hostname}`, "ok"));
    return lines;
}

// The stop session while the agent backs up the world
function stopSession(server, agentLog) {
    const stop = agentLog?.jobs.stop;
    if (!stop || stop.status === "idle") return null;
    const upload = stop.lines.map((l) => l.text.match(/^Uploading \S+\/(\S+\.tar\.zst)/)).find(Boolean);
    const lines = jobLines(stop);
    if (stop.status === "done") lines.push(line(stop.finished, `Deleting server ${server.id} ...`, "spin"));
    return {
        kind: "stop",
        at: stop.started,
        fields: [
            ["Reason", stop.reason ?? "shut down now"],
            ["Uptime", duration(new Date(stop.started) - new Date(server.created))],
            ["Save", upload?.[1] ?? "-"],
        ],
        lines,
        serverId: server.id,
    };
}

// Stored sessions with the live ones of this server put in place
export async function build(env, server, state) {
    const stored = await log.load(env);
    if (!server) return stored;
    const index = stored.sessions.findIndex((s) => s.kind === "start" && s.serverId === server.id && !s.closed);
    if (index < 0) return stored;

    const agentLog = ["creating", "booting"].includes(state) ? null : await agent.log(env);
    const sessions = [...stored.sessions];
    sessions[index] = { ...sessions[index], lines: startLines(sessions[index], server, agentLog, env.MC_HOSTNAME) };
    const stop = stopSession(server, agentLog);
    if (stop) sessions.splice(index + 1, 0, stop);
    return { sessions };
}

// Right before the server is deleted: the live part becomes history
export async function close(env, server, state) {
    const built = await build(env, server, state);
    const finish = (l) => (l.kind === "spin" ? { ...l, kind: "done" } : l);
    const sessions = built.sessions.map((s) =>
        s.serverId === server.id ? { ...s, closed: true, lines: s.lines.map(finish).map(({ live, ...l }) => l) } : s,
    );
    let stop = sessions.find((s) => s.kind === "stop" && s.serverId === server.id);
    if (!stop) {
        // Deleted without a backup (the start failed)
        stop = { kind: "stop", at: now(), fields: [["Reason", "start failed"], ["Uptime", duration(Date.now() - new Date(server.created))], ["Save", "-"]], lines: [], serverId: server.id, closed: true };
        sessions.push(stop);
    }
    if (!stop.lines.some((l) => l.text.startsWith("Deleting server"))) stop.lines.push(line(now(), `Deleting server ${server.id} ...`));
    stop.lines.push(line(now(), "Server deleted", "ok"));
    await log.save(env, { sessions });
}

// A new start session, written when the server is created
export async function opened(env, session) {
    const stored = await log.load(env);
    stored.sessions.push(session);
    await log.save(env, stored);
}

async function getLog(request, env) {
    const { server, state } = await getState(env);
    const built = log.trim(await build(env, server, state));
    return { sessions: built.sessions.map(({ kind, at, fields, lines }) => ({ kind, at, fields, lines })) };
}
