// Basic auth: any username, password PANEL_PASSWORD. The browser asks once and remembers it.

export async function passwordOk(request, env) {
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

// Makes the browser show its login dialog
export function askForPassword() {
    return new Response("unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="mc panel", charset="UTF-8"' },
    });
}
