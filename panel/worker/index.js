// Panel Worker: checks the password, then serves the API (/api/*) or the site (panel/site)
//
//   index.js     this file: routing and the cron
//   auth.js      password check
//   api/         API handlers, one file per feature
//   services/    clients for Hetzner, Cloudflare DNS and the agent on the server
import { passwordOk, askForPassword } from "./auth.js";
import { HttpError } from "./http.js";
import * as server from "./api/server.js";

// "METHOD /path" -> async handler(request, env) that returns JSON data.
// A new feature: a file in api/ with its own routes, spread in here.
const routes = {
    ...server.routes,
};

export default {
    async fetch(request, env) {
        if (!(await passwordOk(request, env))) return askForPassword();

        const url = new URL(request.url);
        if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

        const handler = routes[`${request.method} ${url.pathname}`];
        if (!handler) return Response.json({ error: "not found" }, { status: 404 });
        try {
            return Response.json(await handler(request, env));
        } catch (err) {
            const status = err instanceof HttpError ? err.status : 500;
            return Response.json({ error: err.message }, { status });
        }
    },

    // Every minute, see wrangler.toml
    async scheduled(controller, env) {
        await server.deleteAfterBackup(env);
    },
};
