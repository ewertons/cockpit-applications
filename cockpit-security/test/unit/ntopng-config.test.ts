import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
    configureListeners,
    httpLoopbackAddressFromConfig,
    httpPortFromConfig,
    listenersAreLoopbackOnly,
    redisConnectionFromConfig,
    redisEnvironment,
    SET_ADMIN_PASSWORD_SCRIPT,
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

    test("keeps a disabled HTTP listener disabled (HTTPS-only setups are refused)", () => {
        const result = configureListeners("-w=0\n-W=3001\n", false);
        assert.equal(result, "-w=0\n-W=127.0.0.1:3001\n");
        assert.equal(httpPortFromConfig(result), 0);
    });
});

describe("listenersAreLoopbackOnly", () => {
    test("missing or unbound listeners are not loopback-only", () => {
        assert.equal(listenersAreLoopbackOnly(""), false);
        assert.equal(listenersAreLoopbackOnly("-w=3000"), false);
        assert.equal(listenersAreLoopbackOnly("-w=127.0.0.1:3000\n-W=3001"), false);
        assert.equal(listenersAreLoopbackOnly("-w=192.0.2.10:3000"), false);
    });

    test("loopback addresses", () => {
        assert.equal(listenersAreLoopbackOnly("-w=127.0.0.1:3000"), true);
        assert.equal(listenersAreLoopbackOnly("-w=[::1]:3000\n-W=0"), true);
        assert.equal(listenersAreLoopbackOnly("-w=:3000\n-W=:3001"), true);
    });
});

describe("httpLoopbackAddressFromConfig", () => {
    test("keeps the configured loopback address for the tunnel destination", () => {
        assert.equal(httpLoopbackAddressFromConfig("-w=[::1]:3000"), "[::1]");
        assert.equal(httpLoopbackAddressFromConfig("-w=127.0.0.1:3000"), "127.0.0.1");
        assert.equal(httpLoopbackAddressFromConfig("-w=:3000"), "127.0.0.1");
        assert.equal(httpLoopbackAddressFromConfig(""), "127.0.0.1");
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

describe("redisConnectionFromConfig", () => {
    test("defaults to localhost database 0", () => {
        assert.deepEqual(redisConnectionFromConfig("-w=3000\n"), { host: "127.0.0.1", port: 6379, database: 0 });
    });

    test("reads host, port, password, database and socket path", () => {
        assert.deepEqual(redisConnectionFromConfig("-r=127.0.0.1:6379@1\n"), { host: "127.0.0.1", port: 6379, database: 1 });
        assert.deepEqual(redisConnectionFromConfig("--redis redis.lan:6380:pa:ss@2"),
                         { host: "redis.lan", port: 6380, password: "pa:ss", database: 2 });
        assert.deepEqual(redisConnectionFromConfig("-r=@3"), { host: "127.0.0.1", port: 6379, database: 3 });
        assert.deepEqual(redisConnectionFromConfig("-r=/run/redis/redis.sock@4"),
                         { host: "127.0.0.1", port: 6379, socketPath: "/run/redis/redis.sock", database: 4 });
    });

    test("rejects values that cannot be passed on safely", () => {
        for (const value of ["-r=-h:1", "-r=host:port", "-r=host:0", "-r=host@x", "-r=/run/redis sock", "-r=host:6379:pa`ss"])
            assert.throws(() => redisConnectionFromConfig(value), value);
    });
});

describe("SET_ADMIN_PASSWORD_SCRIPT", () => {
    const FAKE_REDIS_CLI = `#!/bin/sh
echo "$*" >> "$FAKE_REDIS_DIRECTORY/log"
case "$*" in
    *EXISTS*) echo 1 ;;
    *"-x SET"*) cat > "$FAKE_REDIS_DIRECTORY/hash"; echo "\${FAKE_SET_REPLY:-OK}" ;;
    *GET*) cat "$FAKE_REDIS_DIRECTORY/hash" ;;
    *SET*) echo OK ;;
esac
`;

    function runScript(setReply?: string) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fake-redis-"));
        fs.writeFileSync(path.join(directory, "redis-cli"), FAKE_REDIS_CLI, { mode: 0o755 });
        const connection = redisConnectionFromConfig("-r=127.0.0.1:6379@2");
        const environment: Record<string, string> = {
            PATH: `${directory}:${process.env.PATH}`,
            FAKE_REDIS_DIRECTORY: directory,
            ...(setReply ? { FAKE_SET_REPLY: setReply } : {}),
        };
        for (const entry of redisEnvironment(connection)) {
            const separator = entry.indexOf("=");
            environment[entry.slice(0, separator)] = entry.slice(separator + 1);
        }
        const result = spawnSync("sh", ["-c", SET_ADMIN_PASSWORD_SCRIPT], { input: "new password", env: environment, encoding: "utf8" });
        const log = fs.readFileSync(path.join(directory, "log"), "utf8");
        const hash = fs.existsSync(path.join(directory, "hash")) ? fs.readFileSync(path.join(directory, "hash"), "utf8") : "";
        fs.rmSync(directory, { recursive: true, force: true });
        return { status: result.status, log, hash };
    }

    test("stores the MD5 hash in the configured database", () => {
        const result = runScript();
        assert.equal(result.status, 0);
        assert.equal(result.hash, createHash("md5").update("new password").digest("hex"));
        assert.ok(result.log.split("\n").filter(Boolean).every(line => line.startsWith("-h 127.0.0.1 -p 6379 -n 2 ")));
    });

    test("fails when Redis rejects the write", () => {
        assert.notEqual(runScript("MISCONF Redis is configured to save RDB snapshots").status, 0);
    });
});
