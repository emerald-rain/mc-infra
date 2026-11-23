// The Minecraft server's life: its state, start, stop, the shutdown plan, deleting it after the backup
import * as hetzner from "../services/hetzner.js";
import * as dns from "../services/dns.js";
import * as agent from "../services/agent.js";
import * as backups from "../services/backups.js";
import * as log from "./log.js";
import { HttpError } from "../http.js";

export const routes = {
    "GET /api/server": getServer,
    "POST /api/server/start": start,
    "POST /api/server/stop": stop,
    "GET /api/console": getConsole,
    "POST /api/console": sendCommand,
};

const STOPPABLE = ["starting", "online", "stopped", "backup_failed", "start_failed"];
// States the cron may stop on its own: the server is online or already idle, never in the middle of a start
const AUTO_STOP = ["online", "stopped", "backup_failed", "start_failed"];
const EMPTY_MINUTES = 10;
const HOUR_END_MINUTES = 10;

// One state for the site, from Hetzner and the agent:
//   none -> creating -> booting -> restoring -> starting -> online -> backing_up -> deleting -> none
// Off the happy path:
//   stopped        Minecraft is not running, stop to back up and delete the server
//   backup_failed  the server is kept, stop can be retried
//   start_failed   the world was not restored; stop deletes the server (there is nothing to save)
// Also returns the raw Hetzner server and agent status for the callers that need them.
export async function getState(env) {
    const server = await hetzner.findServer(env);
    if (!server) return { state: "none" };

    const ip = server.public_net.ipv4?.ip ?? null;
    const base = { server, ip };
    if (server.status === "deleting") return { ...base, state: "deleting" };
    if (server.status !== "running") return { ...base, state: "creating" };

    // The agent is down while cloud-init installs packages and clones the repo
    const status = await agent.status(env);
    if (!status) return { ...base, state: "booting" };

    const { container, health, jobs } = status;
    const withAgent = { ...base, status };
    if (jobs.stop.status === "running") return { ...withAgent, state: "backing_up" };
    if (jobs.stop.status === "done") return { ...withAgent, state: "deleting" };
    if (jobs.stop.status === "failed") return { ...withAgent, state: "backup_failed", log: jobs.stop.log };
    // start.sh creates the container only after the world is restored
    if (container === "missing" && jobs.start?.status === "failed") return { ...withAgent, state: "start_failed" };
    if (container === "missing") return { ...withAgent, state: "restoring" };
    if (container === "running") return { ...withAgent, state: health === "healthy" ? "online" : "starting" };
    return { ...withAgent, state: "stopped" };
}

// What the site shows, see panel/site/js/main.js
async function getServer(request, env) {
    const { state, server, ip, status, log } = await getState(env);
    const data = { state, hostname: env.MC_HOSTNAME, ip: ip ?? null };
    if (server) {
        data.server = {
            id: server.id,
            type: server.server_type.name,
            // Hetzner dropped "datacenter" from servers; "location" is the current field
            location: (server.location ?? server.datacenter?.location)?.name ?? null,
            createdAt: server.created,
        };
    }
    if (status) {
        data.players = status.players ?? null;
        data.metrics = status.metrics ?? null;
    }
    if (log) data.log = log;
    return data;
}

// { save } from the site; the type and location are picked automatically
async function start(request, env) {
    const body = await request.json().catch(() => ({}));
    const save = body.save ?? null;
    if (save && !(await backups.exists(env, save))) throw new HttpError(400, `no backup ${save}`);
    if (await hetzner.findServer(env)) {
        throw new HttpError(409, "server already exists");
    }
    const choice = await hetzner.pickServer(env);
    if (!choice) throw new HttpError(503, "no server type available");
    // The log names the save even when start.sh will pick the latest itself
    const saveName = save ?? (await backups.list(env))[0]?.key ?? "-";
    const at = new Date().toISOString();
    const server = await hetzner.createServer(env, { ...choice, save });
    const ip = server.public_net.ipv4.ip;
    await dns.setMinecraftIp(env, ip);
    await log.opened(env, {
        kind: "start",
        at,
        fields: [["Host", choice.type], ["Region", log.REGIONS[choice.location] ?? choice.location], ["Save", saveName]],
        lines: log.creationLines(server, choice.type, choice.location, env.MC_HOSTNAME, ip, at),
        serverId: server.id,
    });
    return { state: "creating" };
}

// Only starts the backup; deleteAfterBackup() deletes the server when it is done
async function stop(request, env) {
    const { state, server } = await getState(env);
    if (!STOPPABLE.includes(state)) {
        throw new HttpError(409, `cannot stop in state ${state}`);
    }
    if (state === "start_failed") {
        await deleteServer(env, server, state);
        return { state: "deleting" };
    }
    await stopNow(env);
    return { state: "backing_up" };
}

async function stopNow(env) {
    const res = await agent.stop(env);
    if (!res) throw new HttpError(502, "agent unreachable");
    if (res.status !== 202) throw new HttpError(res.status, res.data.error);
}

async function getConsole(request, env) {
    const data = await agent.console(env);
    if (!data) throw new HttpError(502, "agent unreachable");
    return data;
}

async function sendCommand(request, env) {
    const { command } = await request.json().catch(() => ({}));
    const res = await agent.command(env, command ?? "");
    if (!res) throw new HttpError(502, "agent unreachable");
    if (res.status !== 200) throw new HttpError(res.status, res.data.error);
    return res.data;
}

// Hetzner bills every started hour from creation: minutes until the next one starts
function minutesToNextHour(createdAt) {
    const min = Math.floor((Date.now() - new Date(createdAt)) / 60000);
    return 60 - (min % 60);
}

// Runs from the cron, every minute
export async function tick(env) {
    const { state, server, status } = await getState(env);
    if (!server) return;

    // Delete the server once the agent says its world is in R2
    if (server.status === "running" && status?.jobs.stop.status === "done") {
        console.log(`Backup done, deleting server ${server.id}`);
        await deleteServer(env, server, state);
        return;
    }

    // Stop an empty server in the last 10 minutes before the next billed hour.
    // Someone online means it keeps running until the next hour; a start in progress is left alone.
    if (!AUTO_STOP.includes(state) || minutesToNextHour(server.created) > HOUR_END_MINUTES) return;
    const emptySince = status?.emptySince;
    if (!emptySince || Date.now() - new Date(emptySince) < EMPTY_MINUTES * 60000) return;
    console.log(`Auto stop: no players for ${EMPTY_MINUTES}m, stopping server ${server.id}`);
    await stopNow(env);
}

// The log keeps this server's sessions, then it goes. A log failure must not keep a paid server.
async function deleteServer(env, server, state) {
    await log.close(env, server, state).catch((err) => console.log(`Log not saved: ${err.message}`));
    await hetzner.deleteServer(env, server.id);
}
