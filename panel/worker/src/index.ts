import userDataTemplate from "../../../infra/cloud-init/user-data.yaml";
import panelHtml from "./panel.html";

interface Env {
    SERVER_NAME: string;
    MC_HOSTNAME: string;
    SERVER_TYPE: string;
    LOCATION: string;
    FIREWALL_NAME: string;
    SSH_KEY_NAME: string;
    R2_ENDPOINT: string;
    AGENT_URL: string;
    HETZNER_TOKEN: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    MC_SEED: string;
    CF_API_TOKEN: string;
    CF_ZONE_ID: string;
    TUNNEL_TOKEN: string;
    AGENT_TOKEN: string;
    PANEL_PASSWORD: string;
}

interface Server {
    id: number;
    status: string;
    public_net: { ipv4: { ip: string } | null };
}

interface AgentStatus {
    container: string;
    health: string | null;
    stop: { status: "idle" | "running" | "done" | "failed"; log: string };
}

const HETZNER_API = "https://api.hetzner.cloud/v1";

// Request to the Hetzner Cloud API, returns parsed JSON
async function hetzner(env: Env, method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${HETZNER_API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${env.HETZNER_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        throw new Error(`Hetzner ${method} ${path}: ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? null : await res.json();
}

// Request to the Cloudflare API, returns `result` from the JSON envelope
async function cloudflare(env: Env, method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${env.CF_API_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data: any = await res.json();
    if (!res.ok || !data.success) {
        throw new Error(`Cloudflare ${method} ${path}: ${res.status} ${JSON.stringify(data.errors)}`);
    }
    return data.result;
}

// Request to the agent on the server through the tunnel; null if it is unreachable
async function agent(env: Env, method: string, path: string): Promise<Response | null> {
    try {
        const res = await fetch(`${env.AGENT_URL}${path}`, {
            method,
            headers: { Authorization: `Bearer ${env.AGENT_TOKEN}` },
            signal: AbortSignal.timeout(5000),
        });
        // While the tunnel has no connector Cloudflare answers with its own 5xx page
        return res.status >= 500 ? null : res;
    } catch {
        return null;
    }
}

async function agentStatus(env: Env): Promise<AgentStatus | null> {
    const res = await agent(env, "GET", "/status");
    return res?.ok ? await res.json() : null;
}

// Points MC_HOSTNAME at the server; not proxied, Minecraft is not HTTP
async function setMinecraftIp(env: Env, ip: string) {
    const recordsPath = `/zones/${env.CF_ZONE_ID}/dns_records`;
    const existing = await cloudflare(env, "GET", `${recordsPath}?type=A&name=${env.MC_HOSTNAME}`);
    const record = { type: "A", name: env.MC_HOSTNAME, content: ip, ttl: 60, proxied: false };
    if (existing.length > 0) {
        await cloudflare(env, "PUT", `${recordsPath}/${existing[0].id}`, record);
    } else {
        await cloudflare(env, "POST", recordsPath, record);
    }
}

// btoa() only takes Latin-1, so encode UTF-8 bytes first (MOTD has § and emoji)
function base64(text: string) {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

// cloud-init template with secrets filled in (the server clones the code itself)
function buildUserData(env: Env) {
    const rcloneConf = [
        "[r2]",
        "type = s3",
        "provider = Cloudflare",
        `access_key_id = ${env.R2_ACCESS_KEY_ID}`,
        `secret_access_key = ${env.R2_SECRET_ACCESS_KEY}`,
        `endpoint = ${env.R2_ENDPOINT}`,
        "no_check_bucket = true",
        "",
    ].join("\n");

    // minecraft/.env on the server: read by docker compose and the agent's systemd unit
    const mcEnv = [
        `MC_SEED=${env.MC_SEED}`,
        `TUNNEL_TOKEN=${env.TUNNEL_TOKEN}`,
        `AGENT_TOKEN=${env.AGENT_TOKEN}`,
        "",
    ].join("\n");

    return userDataTemplate
        .replace("__MC_ENV__", base64(mcEnv))
        .replace("__RCLONE_CONF__", base64(rcloneConf));
}

// Our server, or null if it does not exist
async function findServer(env: Env): Promise<Server | null> {
    const data = await hetzner(env, "GET", `/servers?name=${env.SERVER_NAME}`);
    return data.servers[0] ?? null;
}

async function createServer(env: Env): Promise<Server> {
    const firewalls = await hetzner(env, "GET", `/firewalls?name=${env.FIREWALL_NAME}`);
    const data = await hetzner(env, "POST", "/servers", {
        name: env.SERVER_NAME,
        server_type: env.SERVER_TYPE,
        location: env.LOCATION,
        image: "debian-13",
        // Without an SSH key Hetzner emails a root password; root login is disabled anyway
        ssh_keys: [env.SSH_KEY_NAME],
        firewalls: [{ firewall: firewalls.firewalls[0].id }],
        user_data: buildUserData(env),
    });
    return data.server;
}

// One state for the panel, combining Hetzner and the agent:
// none -> creating -> booting -> restoring -> starting -> online -> backing_up -> deleting -> none
// Off the happy path: stopped (container exited by itself), backup_failed (server kept, stop can be retried),
// docker_error (docker on the server does not respond, needs SSH)
async function panelState(env: Env) {
    const server = await findServer(env);
    if (!server) {
        return { state: "none" };
    }
    const ip = server.public_net.ipv4?.ip ?? null;
    if (server.status === "deleting") {
        return { state: "deleting", ip };
    }
    if (server.status !== "running") {
        return { state: "creating", ip };
    }

    // Agent is down while cloud-init installs packages and clones the repo
    const status = await agentStatus(env);
    if (!status) {
        return { state: "booting", ip };
    }

    const { container, health, stop } = status;
    if (stop.status === "running") return { state: "backing_up", ip };
    if (stop.status === "done") return { state: "deleting", ip };
    if (stop.status === "failed") return { state: "backup_failed", ip, log: stop.log };
    // start.sh creates the container only after the world is downloaded and extracted
    if (container === "missing") return { state: "restoring", ip };
    if (container === "error") return { state: "docker_error", ip };
    if (container === "running") return { state: health === "healthy" ? "online" : "starting", ip };
    return { state: "stopped", ip };
}

// Basic auth with any username; the browser remembers it for the API calls of the page
async function authorized(request: Request, env: Env) {
    const header = request.headers.get("Authorization") ?? "";
    // Unset secret would hash like an empty password, so refuse everything instead
    if (!env.PANEL_PASSWORD || !header.startsWith("Basic ")) {
        return false;
    }
    let password: string;
    try {
        password = atob(header.slice(6)).split(":").slice(1).join(":");
    } catch {
        return false;
    }
    // Hash both sides: timingSafeEqual needs equal lengths and is constant-time only then
    const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const [given, expected] = await Promise.all([digest(password), digest(env.PANEL_PASSWORD)]);
    return crypto.subtle.timingSafeEqual(given, expected);
}

async function handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /") {
        return new Response(panelHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (route === "GET /api/status") {
        return Response.json({ ...(await panelState(env)), hostname: env.MC_HOSTNAME });
    }

    if (route === "POST /api/start") {
        if (await findServer(env)) {
            return Response.json({ error: "server already exists" }, { status: 409 });
        }
        const server = await createServer(env);
        const ip = server.public_net.ipv4!.ip;
        await setMinecraftIp(env, ip);
        return Response.json({ state: "creating", ip });
    }

    // Starts the backup; the cron deletes the server once the agent reports it done
    if (route === "POST /api/stop") {
        const { state } = await panelState(env);
        if (!["starting", "online", "stopped", "backup_failed"].includes(state)) {
            return Response.json({ error: `cannot stop in state ${state}` }, { status: 409 });
        }
        const res = await agent(env, "POST", "/stop");
        if (!res) {
            return Response.json({ error: "agent unreachable" }, { status: 502 });
        }
        return Response.json(await res.json(), { status: res.status });
    }

    return new Response("not found", { status: 404 });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (!(await authorized(request, env))) {
            return new Response("unauthorized", {
                status: 401,
                headers: { "WWW-Authenticate": 'Basic realm="mc panel", charset="UTF-8"' },
            });
        }
        try {
            return await handle(request, env);
        } catch (err) {
            return Response.json({ error: String(err) }, { status: 500 });
        }
    },

    // Every minute: delete the server once its world is safely in R2.
    // Stateless: the agent's stop status is the only source of truth.
    async scheduled(_controller: ScheduledController, env: Env) {
        const server = await findServer(env);
        if (!server || server.status !== "running") {
            return;
        }
        const status = await agentStatus(env);
        if (status?.stop.status === "done") {
            console.log(`Backup done, deleting server ${server.id}`);
            await hetzner(env, "DELETE", `/servers/${server.id}`);
        }
    },
};
