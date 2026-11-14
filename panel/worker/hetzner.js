// Hetzner Cloud: find, create and delete our one server
import cloudInit from "../../server/cloud-init.yaml";

async function hetzner(env, method, path, body) {
    const res = await fetch(`https://api.hetzner.cloud/v1${path}`, {
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

// The server, or null if it does not exist
export async function findServer(env) {
    const data = await hetzner(env, "GET", `/servers?name=${env.SERVER_NAME}`);
    return data.servers[0] ?? null;
}

export async function createServer(env) {
    const firewalls = await hetzner(env, "GET", `/firewalls?name=${env.FIREWALL_NAME}`);
    const data = await hetzner(env, "POST", "/servers", {
        name: env.SERVER_NAME,
        server_type: env.SERVER_TYPE,
        location: env.LOCATION,
        image: "debian-13",
        // Without an SSH key Hetzner emails a root password; root login is disabled anyway
        ssh_keys: [env.SSH_KEY_NAME],
        firewalls: [{ firewall: firewalls.firewalls[0].id }],
        user_data: cloudInit.replace("__MC_ENV__", btoa(serverSecrets(env))),
    });
    return data.server;
}

export async function deleteServer(env, id) {
    await hetzner(env, "DELETE", `/servers/${id}`);
}

// Contents of /etc/mc.env on the server (ASCII only, so plain btoa() is enough)
function serverSecrets(env) {
    return [
        `TUNNEL_TOKEN=${env.TUNNEL_TOKEN}`,
        `AGENT_TOKEN=${env.AGENT_TOKEN}`,
        // rclone remote "r2:" without a config file
        "RCLONE_CONFIG=/dev/null",
        "RCLONE_CONFIG_R2_TYPE=s3",
        "RCLONE_CONFIG_R2_PROVIDER=Cloudflare",
        `RCLONE_CONFIG_R2_ACCESS_KEY_ID=${env.R2_ACCESS_KEY_ID}`,
        `RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=${env.R2_SECRET_ACCESS_KEY}`,
        `RCLONE_CONFIG_R2_ENDPOINT=${env.R2_ENDPOINT}`,
        "RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true",
        "",
    ].join("\n");
}
