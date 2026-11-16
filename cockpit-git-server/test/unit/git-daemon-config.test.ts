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

    test("detects the option before a trailing comment", () => {
        assert.equal(defaultsEnableReceivePack('GIT_DAEMON_OPTIONS="--enable=receive-pack" # legacy clients'), true);
        assert.equal(defaultsEnableReceivePack("GIT_DAEMON_OPTIONS='--verbose --enable=receive-pack'  # x"), true);
        assert.equal(defaultsEnableReceivePack('GIT_DAEMON_OPTIONS="--verbose" # --enable=receive-pack'), false);
    });

    test("ignores comments, other options and other variables", () => {
        assert.equal(defaultsEnableReceivePack(DEBIAN_DEFAULTS), false);
        assert.equal(defaultsEnableReceivePack('# GIT_DAEMON_OPTIONS="--enable=receive-pack"'), false);
        assert.equal(defaultsEnableReceivePack('GIT_DAEMON_OPTIONS="--enable=receive-pack-extra"'), false);
        assert.equal(defaultsEnableReceivePack('OTHER="--enable=receive-pack"'), false);
    });
});

const READ_ONLY = "--disable=receive-pack --forbid-override=receive-pack";

describe("removeReceivePackFromDefaults", () => {
    test("keeps other options and forbids per-repository overrides", () => {
        const result = removeReceivePackFromDefaults('A=1\nGIT_DAEMON_OPTIONS="--verbose --enable=receive-pack"\n');
        assert.equal(result, `A=1\nGIT_DAEMON_OPTIONS="--verbose ${READ_ONLY}"\n`);
        assert.equal(defaultsEnableReceivePack(result), false);
    });

    test("keeps a trailing comment outside the quotes", () => {
        assert.equal(removeReceivePackFromDefaults('GIT_DAEMON_OPTIONS="--enable=receive-pack" # legacy clients'),
                     `GIT_DAEMON_OPTIONS="${READ_ONLY}" # legacy clients`);
    });

    test("does not duplicate options when run twice", () => {
        const once = removeReceivePackFromDefaults('GIT_DAEMON_OPTIONS="--allow-override=receive-pack"\n');
        assert.equal(removeReceivePackFromDefaults(once), once);
        assert.equal(once, `GIT_DAEMON_OPTIONS="${READ_ONLY}"\n`);
    });

    test("adds the options line when missing", () => {
        assert.equal(removeReceivePackFromDefaults("A=1\n"), `A=1\nGIT_DAEMON_OPTIONS="${READ_ONLY}"\n`);
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
GIT_DAEMON_OPTIONS="${READ_ONLY}"
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
                     `GIT_DAEMON_OPTIONS="${READ_ONLY}"\nGIT_DAEMON_ENABLE=true\nGIT_DAEMON_USER=git\nGIT_DAEMON_BASE_PATH=/srv/git\nGIT_DAEMON_DIRECTORY=/srv/git\n`);
    });
});

describe("repositoryConfigEnablesDaemonPush", () => {
    test("reads git config --bool output", () => {
        assert.equal(repositoryConfigEnablesDaemonPush("true\n"), true);
        for (const value of ["", "false\n"])
            assert.equal(repositoryConfigEnablesDaemonPush(value), false, value);
    });
});
