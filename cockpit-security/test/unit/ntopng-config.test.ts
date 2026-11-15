import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    configureListeners,
    httpPortFromConfig,
    listenersAreLoopbackOnly,
    validateAdminPassword,
} from "../../src/pages/ntopng-config.ts";

const PACKAGED_CONFIG = `-G=/var/run/ntopng.pid
-w=3000
`;

describe("configureListeners", () => {
    test("binds the packaged HTTP listener to loopback", () => {
        const result = configureListeners(PACKAGED_CONFIG, false);
        assert.equal(result, "-G=/var/run/ntopng.pid\n-w=127.0.0.1:3000\n");
        assert.equal(listenersAreLoopbackOnly(result), true);
    });

    test("adds a loopback listener when none is configured", () => {
        assert.equal(configureListeners("-i=eth0", false), "-i=eth0\n-w=127.0.0.1:3000\n");
        assert.equal(configureListeners("", false), "-w=127.0.0.1:3000\n");
    });

    test("keeps custom ports and rebinds HTTPS too", () => {
        const result = configureListeners("--http-port=0.0.0.0:8080\n-W 3001\n", false);
        assert.equal(result, "--http-port=127.0.0.1:8080\n-W=127.0.0.1:3001\n");
        assert.equal(httpPortFromConfig(result), 8080);
    });

    test("leaves disabled listeners alone", () => {
        assert.equal(configureListeners("-w=3000\n-W=0\n", false), "-w=127.0.0.1:3000\n-W=0\n");
    });

    test("opt-in listens on all interfaces", () => {
        const result = configureListeners("-w=127.0.0.1:3000\n", true);
        assert.equal(result, "-w=3000\n");
        assert.equal(listenersAreLoopbackOnly(result), false);
    });
});

describe("listenersAreLoopbackOnly", () => {
    test("missing or unbound listeners are not loopback-only", () => {
        assert.equal(listenersAreLoopbackOnly(""), false);
        assert.equal(listenersAreLoopbackOnly("-w=:3000"), false);
        assert.equal(listenersAreLoopbackOnly("-w=127.0.0.1:3000\n-W=3001"), false);
    });

    test("loopback addresses", () => {
        assert.equal(listenersAreLoopbackOnly("-w=127.0.0.1:3000"), true);
        assert.equal(listenersAreLoopbackOnly("-w=[::1]:3000\n-W=0"), true);
    });
});

describe("validateAdminPassword", () => {
    test("rejects short, default and mismatched passwords", () => {
        assert.notEqual(validateAdminPassword("short", "short"), null);
        assert.notEqual(validateAdminPassword("admin", "admin"), null);
        assert.notEqual(validateAdminPassword("long enough 1", "long enough 2"), null);
        assert.equal(validateAdminPassword("long enough 1", "long enough 1"), null);
    });
});
