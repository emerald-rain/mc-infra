// The agent on the server (server/agent.py), reached through the Cloudflare Tunnel

// Response, or null if the agent is unreachable
async function agent(env, method, path) {
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

// { container, health, stop: { status, log } }, or null if unreachable
export async function agentStatus(env) {
    const res = await agent(env, "GET", "/status");
    return res?.ok ? await res.json() : null;
}

// Starts the backup; returns the agent's Response, or null if unreachable
export async function agentStop(env) {
    return await agent(env, "POST", "/stop");
}
