// Cloudflare DNS: point MC_HOSTNAME at the server's IP

async function cloudflare(env, method, path, body) {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${env.CF_API_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
        throw new Error(`Cloudflare ${method} ${path}: ${res.status} ${JSON.stringify(data.errors)}`);
    }
    return data.result;
}

// Not proxied: Minecraft is not HTTP
export async function setMinecraftIp(env, ip) {
    const recordsPath = `/zones/${env.CF_ZONE_ID}/dns_records`;
    const existing = await cloudflare(env, "GET", `${recordsPath}?type=A&name=${env.MC_HOSTNAME}`);
    const record = { type: "A", name: env.MC_HOSTNAME, content: ip, ttl: 60, proxied: false };
    if (existing.length > 0) {
        await cloudflare(env, "PUT", `${recordsPath}/${existing[0].id}`, record);
    } else {
        await cloudflare(env, "POST", recordsPath, record);
    }
}
