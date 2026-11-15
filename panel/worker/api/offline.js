// The "No server" screen: backups to start from, R2 usage, server types per location, downloads
import * as backups from "../services/backups.js";
import * as hetzner from "../services/hetzner.js";
import { HttpError } from "../http.js";

export const routes = {
    "GET /api/offline": getOffline,
    "GET /api/backup": download,
};

const R2_FREE_BYTES = 10e9; // Cloudflare R2 free tier

async function getOffline(request, env) {
    const [list, used, availability] = await Promise.all([
        backups.list(env),
        backups.used(env),
        hetzner.availability(env).catch(() => null), // the screen still works without it
    ]);
    return {
        // The last server was deleted right after its backup
        deletedAt: list[0]?.uploaded ?? null,
        r2: { used, limit: R2_FREE_BYTES },
        backups: list,
        availability,
    };
}

// GET /api/backup?key=2026-11-15T06:50:07Z.tar.zst
async function download(request, env) {
    const key = new URL(request.url).searchParams.get("key");
    const object = await backups.get(env, key);
    if (!object) throw new HttpError(404, "no such backup");
    return new Response(object.body, {
        headers: {
            "Content-Type": "application/zstd",
            "Content-Length": String(object.size),
            "Content-Disposition": `attachment; filename="${key}"`,
        },
    });
}
