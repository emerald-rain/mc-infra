// The Minecraft server's life: its state, start, stop, and deleting it after the backup
import * as hetzner from "../services/hetzner.js";
import * as dns from "../services/dns.js";
import * as agent from "../services/agent.js";
import { HttpError } from "../http.js";

export const routes = {
    "GET /api/server": getServer,
    "POST /api/server/start": start,
    "POST /api/server/stop": stop,
};

// One state for the site, from Hetzner and the agent:
//   none -> creating -> booting -> restoring -> starting -> online -> backing_up -> deleting -> none
// Off the happy path:
//   stopped        Minecraft is not running, stop to back up and delete the server
//   backup_failed  the server is kept, stop can be retried
async function getState(env) {
    const server = await hetzner.findServer(env);
    if (!server) return { state: "none" };

    const ip = server.public_net.ipv4?.ip ?? null;
    if (server.status === "deleting") return { state: "deleting", ip };
    if (server.status !== "running") return { state: "creating", ip };

    // The agent is down while cloud-init installs packages and clones the repo
    const status = await agent.status(env);
    if (!status) return { state: "booting", ip };

    const { container, health, jobs } = status;
    if (jobs.stop.status === "running") return { state: "backing_up", ip };
    if (jobs.stop.status === "done") return { state: "deleting", ip };
    if (jobs.stop.status === "failed") return { state: "backup_failed", ip, log: jobs.stop.log };
    // start.sh creates the container only after the world is restored
    if (container === "missing") return { state: "restoring", ip };
    if (container === "running") return { state: health === "healthy" ? "online" : "starting", ip };
    return { state: "stopped", ip };
}

async function getServer(request, env) {
    return { ...(await getState(env)), hostname: env.MC_HOSTNAME };
}

async function start(request, env) {
    if (await hetzner.findServer(env)) {
        throw new HttpError(409, "server already exists");
    }
    const server = await hetzner.createServer(env);
    await dns.setMinecraftIp(env, server.public_net.ipv4.ip);
    return { state: "creating" };
}

// Only starts the backup; deleteAfterBackup() deletes the server when it is done
async function stop(request, env) {
    const { state } = await getState(env);
    if (!["starting", "online", "stopped", "backup_failed"].includes(state)) {
        throw new HttpError(409, `cannot stop in state ${state}`);
    }
    const res = await agent.stop(env);
    if (!res) throw new HttpError(502, "agent unreachable");
    if (res.status !== 202) throw new HttpError(res.status, res.data.error);
    return { state: "backing_up" };
}

// Runs from the cron: delete the server once the agent says its world is in R2
export async function deleteAfterBackup(env) {
    const server = await hetzner.findServer(env);
    if (server?.status !== "running") return;

    const status = await agent.status(env);
    if (status?.jobs.stop.status === "done") {
        console.log(`Backup done, deleting server ${server.id}`);
        await hetzner.deleteServer(env, server.id);
    }
}
