// Panel Worker: password check, /api/* routes, the site from panel/site, and the cron
import { findServer, createServer, deleteServer } from "./hetzner.js";
import { setMinecraftIp } from "./dns.js";
import { agentStatus, agentStop } from "./agent.js";

// One state for the site, from Hetzner and the agent:
// none -> creating -> booting -> restoring -> starting -> online -> backing_up -> deleting -> none
// Off the happy path: stopped (container is down), backup_failed (server kept, stop can be retried)
async function serverState(env) {
    const server = await findServer(env);
    if (!server) return { state: "none" };

    const ip = server.public_net.ipv4?.ip ?? null;
    if (server.status === "deleting") return { state: "deleting", ip };
    if (server.status !== "running") return { state: "creating", ip };

    // Agent is down while cloud-init installs packages and clones the repo
    const status = await agentStatus(env);
    if (!status) return { state: "booting", ip };

    const { container, health, stop } = status;
    if (stop.status === "running") return { state: "backing_up", ip };
    if (stop.status === "done") return { state: "deleting", ip };
    if (stop.status === "failed") return { state: "backup_failed", ip, log: stop.log };
    // start.sh creates the container only after the world is restored
    if (container === "missing") return { state: "restoring", ip };
    if (container === "running") return { state: health === "healthy" ? "online" : "starting", ip };
    return { state: "stopped", ip };
}

async function api(route, env) {
    if (route === "GET /api/status") {
        return Response.json({ ...(await serverState(env)), hostname: env.MC_HOSTNAME });
    }

    if (route === "POST /api/start") {
        if (await findServer(env)) {
            return Response.json({ error: "server already exists" }, { status: 409 });
        }
        const server = await createServer(env);
        await setMinecraftIp(env, server.public_net.ipv4.ip);
        return Response.json({ state: "creating" });
    }

    // Only starts the backup; the cron deletes the server when it is done
    if (route === "POST /api/stop") {
        const { state } = await serverState(env);
        if (!["starting", "online", "stopped", "backup_failed"].includes(state)) {
            return Response.json({ error: `cannot stop in state ${state}` }, { status: 409 });
        }
        const res = await agentStop(env);
        if (!res) return Response.json({ error: "agent unreachable" }, { status: 502 });
        return Response.json(await res.json(), { status: res.status });
    }

    return Response.json({ error: "not found" }, { status: 404 });
}

// Basic auth: any username, password PANEL_PASSWORD. The browser asks once and remembers it.
async function passwordOk(request, env) {
    const header = request.headers.get("Authorization") ?? "";
    // An unset secret would match an empty password, so then nobody gets in
    if (!env.PANEL_PASSWORD || !header.startsWith("Basic ")) return false;
    let password;
    try {
        password = atob(header.slice(6)).split(":").slice(1).join(":");
    } catch {
        return false;
    }
    // Compare hashes: equal length, constant time, the password does not leak through timing
    const hash = (text) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return crypto.subtle.timingSafeEqual(await hash(password), await hash(env.PANEL_PASSWORD));
}

export default {
    async fetch(request, env) {
        if (!(await passwordOk(request, env))) {
            return new Response("unauthorized", {
                status: 401,
                headers: { "WWW-Authenticate": 'Basic realm="mc panel", charset="UTF-8"' },
            });
        }
        const url = new URL(request.url);
        if (!url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request); // files from panel/site
        }
        try {
            return await api(`${request.method} ${url.pathname}`, env);
        } catch (err) {
            return Response.json({ error: String(err) }, { status: 500 });
        }
    },

    // Every minute: delete the server once the agent says its world is in R2
    async scheduled(controller, env) {
        const server = await findServer(env);
        if (server?.status !== "running") return;
        const status = await agentStatus(env);
        if (status?.stop.status === "done") {
            console.log(`Backup done, deleting server ${server.id}`);
            await deleteServer(env, server.id);
        }
    },
};
