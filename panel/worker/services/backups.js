// World backups in R2 (bucket mc-world, binding WORLD). Names are UTC times: 2026-11-15T06:50:07Z.tar.zst
export const PREFIX = "backups/";

// Every object under a prefix, following R2's pages
async function listAll(env, prefix) {
    const objects = [];
    let cursor;
    do {
        const page = await env.WORLD.list({ prefix, cursor });
        objects.push(...page.objects);
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return objects;
}

// [{ key, size, uploaded }], newest first; key without the "backups/" prefix
export async function list(env) {
    const objects = await listAll(env, PREFIX);
    return objects
        .filter((o) => o.key.endsWith(".tar.zst"))
        .map((o) => ({ key: o.key.slice(PREFIX.length), size: o.size, uploaded: o.uploaded.toISOString() }))
        .sort((a, b) => b.key.localeCompare(a.key));
}

// Bytes in the whole bucket (the R2 free tier counts all of it)
export async function used(env) {
    const objects = await listAll(env, "");
    return objects.reduce((sum, o) => sum + o.size, 0);
}

// Only plain backup names, so a key can never point outside backups/
export function validName(name) {
    return typeof name === "string" && /^[\w:.-]+\.tar\.zst$/.test(name) && !name.includes("..");
}

export async function exists(env, name) {
    return validName(name) && (await env.WORLD.head(PREFIX + name)) !== null;
}

export async function get(env, name) {
    return validName(name) ? await env.WORLD.get(PREFIX + name) : null;
}
