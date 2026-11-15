import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    configureReadOnlyDefaults,
    defaultsEnableReceivePack,
    removeReceivePackFromDefaults,
    repositoryConfigEnablesDaemonPush,
} from "../../src/git-daemon-config.ts";

const DEBIAN_DEFAULTS = `# Defaults for git-daemon
GIT_DAEMON_ENABLE=false
GIT_DAEMON_USER=gitdaemon
GIT_DAEMON_BASE_PATH=/var/lib
GIT_DAEMON_DIRECTORY=/var/lib/git
GIT_DAEMON_OPTIONS=""
`;

describe("defaultsEnableReceivePack", () => {
    test("detects quoted and unquoted option", () => {
        assert.equal(defaultsEnableReceivePack('GIT_DAEMON_OPTIONS="--enable=receive-pack"\n'), true);
        assert.equal(defaultsEnableReceivePack("GIT_DAEMON_OPTIONS=--enable=receive-pack\n"), true);
        assert.equal(defaultsEnableReceivePack('GIT_DAEMON_OPTIONS="--verbose --enable=receive-pack --reuseaddr"'), true);
    });

    test("ignores comments, other options and other variables", () => {
        assert.equal(defaultsEnableReceivePack(DEBIAN_DEFAULTS), false);
        assert.equal(defaultsEnableReceivePack('# GIT_DAEMON_OPTIONS="--enable=receive-pack"'), false);
        assert.equal(defaultsEnableReceivePack('GIT_DAEMON_OPTIONS="--enable=receive-pack-extra"'), false);
        assert.equal(defaultsEnableReceivePack('OTHER="--enable=receive-pack"'), false);
    });
});

describe("removeReceivePackFromDefaults", () => {
    test("keeps other options", () => {
        const result = removeReceivePackFromDefaults('A=1\nGIT_DAEMON_OPTIONS="--verbose --enable=receive-pack"\n');
        assert.equal(result, 'A=1\nGIT_DAEMON_OPTIONS="--verbose"\n');
        assert.equal(defaultsEnableReceivePack(result), false);
    });
});

describe("configureReadOnlyDefaults", () => {
    test("rewrites Debian defaults without receive-pack", () => {
        const result = configureReadOnlyDefaults(DEBIAN_DEFAULTS, "/srv/git");
        assert.equal(result, `# Defaults for git-daemon
GIT_DAEMON_ENABLE=true
GIT_DAEMON_USER=git
GIT_DAEMON_BASE_PATH=/srv/git
GIT_DAEMON_DIRECTORY=/srv/git
GIT_DAEMON_OPTIONS=""
`);
    });

    test("drops receive-pack set by earlier versions and adds missing settings", () => {
        const result = configureReadOnlyDefaults('GIT_DAEMON_OPTIONS="--enable=receive-pack"', "/srv/git");
        assert.equal(defaultsEnableReceivePack(result), false);
        assert.match(result, /^GIT_DAEMON_ENABLE=true$/m);
        assert.match(result, /^GIT_DAEMON_BASE_PATH=\/srv\/git$/m);
    });

    test("handles an empty file", () => {
        assert.equal(configureReadOnlyDefaults("", "/srv/git"),
                     "GIT_DAEMON_ENABLE=true\nGIT_DAEMON_USER=git\nGIT_DAEMON_BASE_PATH=/srv/git\nGIT_DAEMON_DIRECTORY=/srv/git\n");
    });
});

describe("repositoryConfigEnablesDaemonPush", () => {
    test("accepts git boolean true spellings", () => {
        for (const value of ["true\n", "yes", "On", "1"])
            assert.equal(repositoryConfigEnablesDaemonPush(value), true, value);
        for (const value of ["", "false\n", "0", "no"])
            assert.equal(repositoryConfigEnablesDaemonPush(value), false, value);
    });
});
