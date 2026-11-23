// Tests for the Logs screen's live start lines.
// Run: node --experimental-test-module-mocks --test panel/worker/api/log.test.js
import test, { mock } from "node:test";
import assert from "node:assert/strict";

// log.js imports ./server.js only for getState; stub it so this test does not load
// the Hetzner client and its YAML import.
mock.module("./server.js", { exports: { getState: async () => ({ state: "none" }) } });

const log = await import("./log.js");

const STARTED = "2026-11-21T10:00:00Z";
const AGENT_STARTED = "2026-11-21T10:07:00Z";
const STOP_STARTED = "2026-11-21T11:00:00Z";
const STOP_FINISHED = "2026-11-21T11:01:00Z";

function storedSession() {
    return {
        sessions: [
            {
                kind: "start",
                at: STARTED,
                fields: [
                    ["Host", "cpx12"],
                    ["Region", "Helsinki"],
                    ["Save", "-"],
                ],
                lines: [{ time: STARTED, text: "Creating server cpx12 in Helsinki ...", kind: "done" }],
                serverId: "42",
                closed: false,
            },
        ],
    };
}

function env() {
    return {
        MC_HOSTNAME: "mc.example",
        AGENT_URL: "http://agent.test",
        WORLD: { get: async () => ({ json: async () => storedSession() }) },
    };
}

const server = { id: "42", created: STARTED, status: "running" };

function lineOf(session, text) {
    return session.lines.find((l) => l.text === text);
}

function agentLog(overrides = {}) {
    return {
        agentStarted: AGENT_STARTED,
        jobs: {
            start: { status: "running", lines: [], started: AGENT_STARTED, finished: null, reason: null },
            stop: { status: "idle", lines: [] },
        },
        onlineAt: null,
        ...overrides,
    };
}

test("Hetzner: server is running keeps its first timestamp when the agent connects", async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = realFetch;
    });

    // While the agent is down the line is already shown at the server's start time
    const booting = await log.build(env(), server, "booting");
    const first = lineOf(booting.sessions[0], "Hetzner: server is running");
    assert.equal(first.time, STARTED);

    // When the agent connects, the same line must not jump to agentStarted
    globalThis.fetch = async () => ({ status: 200, json: async () => agentLog() });

    const restoring = await log.build(env(), server, "restoring");
    const later = lineOf(restoring.sessions[0], "Hetzner: server is running");
    assert.equal(later.time, STARTED);
    assert.equal(lineOf(restoring.sessions[0], "Agent connected").time, AGENT_STARTED);
});

test("live start lines do not go back before the stored creation lines", async () => {
    // Hetzner's created time is a moment before the lines written after createServer returned
    const createdAt = "2026-11-21T09:59:59Z";
    const createdLine = "2026-11-21T10:00:00Z";
    const dnsLine = "2026-11-21T10:00:01Z";
    const stored = {
        sessions: [
            {
                kind: "start",
                at: createdAt,
                fields: [],
                lines: [
                    { time: createdAt, text: "Creating server cpx12 in Helsinki ...", kind: "done" },
                    { time: createdLine, text: "Server created, id 42", kind: "done" },
                    { time: dnsLine, text: "DNS record updated: mc.example -> 203.0.113.1", kind: "done" },
                ],
                serverId: "42",
                closed: false,
            },
        ],
    };
    const built = await log.build({ ...env(), WORLD: { get: async () => ({ json: async () => stored }) } }, server, "booting");

    assert.equal(lineOf(built.sessions[0], "Hetzner: server is running").time, dnsLine);
});

test("stop session and its delete line use the job's stable start and finish times", async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = realFetch;
    });

    globalThis.fetch = async () => ({
        status: 200,
        json: async () => ({
            ...agentLog(),
            jobs: {
                start: { status: "done", lines: [], started: AGENT_STARTED, finished: AGENT_STARTED, reason: null },
                stop: {
                    status: "done",
                    lines: [{ time: STOP_STARTED, text: "Stopping Minecraft ..." }],
                    started: STOP_STARTED,
                    finished: STOP_FINISHED,
                    reason: "shut down now",
                },
            },
        }),
    });

    const built = await log.build(env(), server, "deleting");
    const stop = built.sessions.find((s) => s.kind === "stop");
    assert.equal(stop.at, STOP_STARTED);
    assert.equal(stop.fields.find(([key]) => key === "Uptime")[1], "1h 0m");
    assert.equal(lineOf(stop, "Deleting server 42 ...").time, STOP_FINISHED);
});

test("creationLines timestamps the start action at the operation start", () => {
    const operationStart = "2020-01-01T00:00:00Z";
    const lines = log.creationLines({ id: "42" }, "cpx12", "hel1", "mc.example", "203.0.113.1", operationStart);

    assert.equal(lines[0].text, "Creating server cpx12 in Helsinki ...");
    assert.equal(lines[0].time, operationStart);
    // Completed steps keep their own, later timestamps
    for (const line of lines.slice(1)) {
        assert.notEqual(line.time, operationStart);
        assert.ok(Date.parse(line.time) >= Date.parse(operationStart));
    }
});
