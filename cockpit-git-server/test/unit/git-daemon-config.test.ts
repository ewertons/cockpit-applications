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

const READ_ONLY_BLOCK = `# Added by cockpit-git-server: push is accepted over SSH only.
GIT_DAEMON_OPTIONS="$GIT_DAEMON_OPTIONS --disable=receive-pack --forbid-override=receive-pack"
`;

describe("removeReceivePackFromDefaults", () => {
    test("appends the read-only options and leaves existing lines unchanged", () => {
        const original = 'A=1\nGIT_DAEMON_OPTIONS="--listen=$GIT_DAEMON_ADDRESS --enable=receive-pack" # legacy\n';
        const result = removeReceivePackFromDefaults(original);
        assert.equal(result, original + READ_ONLY_BLOCK);
        assert.equal(defaultsEnableReceivePack(result), false);
    });

    test("keeps a multi-line value intact", () => {
        const original = 'GIT_DAEMON_OPTIONS="--verbose \\\n  --enable=receive-pack"\n';
        assert.equal(removeReceivePackFromDefaults(original), original + READ_ONLY_BLOCK);
    });

    test("ends a trailing backslash continuation before appending", () => {
        assert.equal(removeReceivePackFromDefaults("A=1 \\\n"), "A=1 \\\n\n" + READ_ONLY_BLOCK);
    });

    test("is idempotent and moves the block after later assignments", () => {
        const once = removeReceivePackFromDefaults("A=1\n");
        assert.equal(removeReceivePackFromDefaults(once), once);
        const later = once + 'GIT_DAEMON_OPTIONS="--enable=receive-pack"\n';
        assert.equal(defaultsEnableReceivePack(later), true);
        assert.equal(removeReceivePackFromDefaults(later), 'A=1\nGIT_DAEMON_OPTIONS="--enable=receive-pack"\n' + READ_ONLY_BLOCK);
    });
});

describe("configureReadOnlyDefaults", () => {
    test("rewrites Debian defaults and forces receive-pack off", () => {
        const result = configureReadOnlyDefaults(DEBIAN_DEFAULTS, "/srv/git");
        assert.equal(result, `# Defaults for git-daemon
GIT_DAEMON_ENABLE=true
GIT_DAEMON_USER=git
GIT_DAEMON_BASE_PATH=/srv/git
GIT_DAEMON_DIRECTORY=/srv/git
GIT_DAEMON_OPTIONS=""
` + READ_ONLY_BLOCK);
    });

    test("overrides receive-pack set by earlier versions and adds missing settings", () => {
        const result = configureReadOnlyDefaults('GIT_DAEMON_OPTIONS="--enable=receive-pack"', "/srv/git");
        assert.equal(defaultsEnableReceivePack(result), false);
        assert.match(result, /^GIT_DAEMON_ENABLE=true$/m);
        assert.match(result, /^GIT_DAEMON_BASE_PATH=\/srv\/git$/m);
    });

    test("handles an empty file", () => {
        assert.equal(configureReadOnlyDefaults("", "/srv/git"),
                     "GIT_DAEMON_ENABLE=true\nGIT_DAEMON_USER=git\nGIT_DAEMON_BASE_PATH=/srv/git\nGIT_DAEMON_DIRECTORY=/srv/git\n" + READ_ONLY_BLOCK);
    });
});

describe("repositoryConfigEnablesDaemonPush", () => {
    test("reads git config --bool output", () => {
        assert.equal(repositoryConfigEnablesDaemonPush("true\n"), true);
        for (const value of ["", "false\n"])
            assert.equal(repositoryConfigEnablesDaemonPush(value), false, value);
    });
});
