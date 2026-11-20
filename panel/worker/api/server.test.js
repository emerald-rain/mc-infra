// Tests for the start route's log timestamps.
// Run: node --experimental-test-module-mocks --test panel/worker/api/server.test.js
import test, { mock } from "node:test";
import assert from "node:assert/strict";

let opened = null;
let creationArgs = null;

mock.module("../services/hetzner.js", {
    exports: {
        findServer: async () => null,
        createServer: async () => ({
            id: "42",
            created: "2026-11-21T10:00:05Z",
            public_net: { ipv4: { ip: "203.0.113.1" } },
        }),
    },
});
mock.module("../services/dns.js", { exports: { setMinecraftIp: async () => {} } });
mock.module("../services/backups.js", {
    exports: { exists: async () => true, list: async () => [] },
});
mock.module("./log.js", {
    exports: {
        REGIONS: { hel1: "Helsinki" },
        creationLines: (...args) => {
            creationArgs = args;
            return [{ time: args[5], text: "Creating server ...", kind: "done" }];
        },
        opened: async (env, session) => {
            opened = session;
        },
        close: async () => {},
    },
});

const server = await import("./server.js");

test("start passes the operation start to creationLines", async () => {
    const env = { SERVER_TYPE: "cpx12", LOCATION: "nbg1", MC_HOSTNAME: "mc.example" };
    const request = { json: async () => ({ type: "cpx12", location: "hel1" }) };

    await server.routes["POST /api/server/start"](request, env);

    assert.ok(opened, "start opened a log session");
    assert.match(opened.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // creationLines(server, type, location, hostname, ip, at)
    assert.equal(creationArgs[5], opened.at);
    assert.equal(opened.lines[0].time, opened.at);
});
