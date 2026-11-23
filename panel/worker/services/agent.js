// The agent on the server (server/agent/agent.py), reached through the Cloudflare Tunnel

// { status, data } with the agent's HTTP status and JSON, or null if the agent is unreachable
async function call(env, method, path, body) {
    try {
        const res = await fetch(`${env.AGENT_URL}${path}`, {
            method,
            headers: { Authorization: `Bearer ${env.AGENT_TOKEN}`, "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(10000),
        });
        // While the tunnel has no connector Cloudflare answers with its own 5xx page
        if (res.status >= 500) return null;
        return { status: res.status, data: await res.json() };
    } catch {
        return null;
    }
}

// { container, health, jobs: { stop: { status, log } }, players, metrics, emptySince }, or null if unreachable
export async function status(env) {
    const res = await call(env, "GET", "/status");
    return res?.status === 200 ? res.data : null;
}

// Starts stop.sh (stop Minecraft, back up the world).
export async function stop(env) {
    return await call(env, "POST", "/stop");
}

// { lines: [{ time, text, command }] }, or null
export async function console(env) {
    const res = await call(env, "GET", "/console");
    return res?.status === 200 ? res.data : null;
}

// Runs a server command through RCON
export async function command(env, text) {
    return await call(env, "POST", "/console", { command: text });
}
