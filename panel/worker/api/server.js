// The Minecraft server's life: its state, start, stop, the shutdown plan, deleting it after the backup
import * as hetzner from "../services/hetzner.js";
import * as dns from "../services/dns.js";
import * as agent from "../services/agent.js";
import * as backups from "../services/backups.js";
import { HttpError } from "../http.js";

export const routes = {
    "GET /api/server": getServer,
    "POST /api/server/start": start,
    "POST /api/server/stop": stop,
    "POST /api/server/plan": setPlan,
    "GET /api/console": getConsole,
    "POST /api/console": sendCommand,
};

const STOPPABLE = ["starting", "online", "stopped", "backup_failed"];

// One state for the site, from Hetzner and the agent:
//   none -> creating -> booting -> restoring -> starting -> online -> backing_up -> deleting -> none
// Off the happy path:
//   stopped        Minecraft is not running, stop to back up and delete the server
//   backup_failed  the server is kept, stop can be retried
// Also returns the raw Hetzner server and agent status for the callers that need them.
async function getState(env) {
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
            location: server.datacenter.location.name,
            createdAt: server.created,
        };
    }
    if (status) {
        data.plan = status.plan ?? null;
        data.players = status.players ?? null;
        data.metrics = status.metrics ?? null;
    }
    if (log) data.log = log;
    return data;
}

const TYPES = ["cx23", "cpx12", "cpx22"];
const LOCATIONS = ["nbg1", "fsn1", "hel1"];

// { save, type, location } from the site; each falls back to the default
async function start(request, env) {
    const body = await request.json().catch(() => ({}));
    const type = body.type ?? env.SERVER_TYPE;
    const location = body.location ?? env.LOCATION;
    const save = body.save ?? null;
    if (!TYPES.includes(type)) throw new HttpError(400, `unknown server type ${type}`);
    if (!LOCATIONS.includes(location)) throw new HttpError(400, `unknown location ${location}`);
    if (save && !(await backups.exists(env, save))) throw new HttpError(400, `no backup ${save}`);
    if (await hetzner.findServer(env)) {
        throw new HttpError(409, "server already exists");
    }
    const server = await hetzner.createServer(env, { type, location, save });
    await dns.setMinecraftIp(env, server.public_net.ipv4.ip);
    return { state: "creating" };
}

// Only starts the backup; deleteAfterBackup() deletes the server when it is done
async function stop(request, env) {
    const { state } = await getState(env);
    if (!STOPPABLE.includes(state)) {
        throw new HttpError(409, `cannot stop in state ${state}`);
    }
    await stopNow(env);
    return { state: "backing_up" };
}

async function stopNow(env) {
    const res = await agent.stop(env);
    if (!res) throw new HttpError(502, "agent unreachable");
    if (res.status !== 202) throw new HttpError(res.status, res.data.error);
}

// { plan: "hour" | "empty" | null }; null cancels
async function setPlan(request, env) {
    const { plan = null } = await request.json().catch(() => ({}));
    const res = await agent.setPlan(env, plan);
    if (!res) throw new HttpError(502, "agent unreachable");
    if (res.status !== 200) throw new HttpError(res.status, res.data.error);
    return res.data;
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
        await hetzner.deleteServer(env, server.id);
        return;
    }

    // The shutdown plan: stop in the last 10 minutes before the next billed hour.
    // "empty" waits while anyone is online and tries again the next hour.
    const plan = status?.plan;
    if (!plan || !STOPPABLE.includes(state) || minutesToNextHour(server.created) > 10) return;
    const online = status.players?.list.length ?? 0;
    if (plan === "hour" || online === 0) {
        console.log(`Shutdown plan "${plan}": stopping, ${online} players online`);
        await stopNow(env);
    }
}
