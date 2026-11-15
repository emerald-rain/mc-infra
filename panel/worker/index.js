// Panel Worker: checks the password, then serves the API (/api/*) or the site (panel/site)
//
//   index.js     this file: routing and the cron
//   auth.js      password check
//   api/         API handlers, one file per feature
//   services/    clients for Hetzner, Cloudflare DNS and the agent on the server
import { passwordOk, askForPassword } from "./auth.js";
import { HttpError } from "./http.js";
import * as server from "./api/server.js";
import * as offline from "./api/offline.js";
import * as log from "./api/log.js";

// "METHOD /path" -> async handler(request, env) that returns JSON data (or a Response).
// A new feature: a file in api/ with its own routes, spread in here.
const routes = {
    ...server.routes,
    ...offline.routes,
    ...log.routes,
};

export default {
    async fetch(request, env) {
        if (!(await passwordOk(request, env))) return askForPassword();

        const url = new URL(request.url);
        if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

        const handler = routes[`${request.method} ${url.pathname}`];
        if (!handler) return Response.json({ error: "not found" }, { status: 404 });
        try {
            const result = await handler(request, env);
            return result instanceof Response ? result : Response.json(result);
        } catch (err) {
            const status = err instanceof HttpError ? err.status : 500;
            return Response.json({ error: err.message }, { status });
        }
    },

    // Every minute, see wrangler.toml: shutdown plans, deleting the server after its backup
    async scheduled(controller, env) {
        await server.tick(env);
    },
};
