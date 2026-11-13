import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    appendKeyLine,
    buildOptions,
    parseAuthorizedKeyLine,
    parseAuthorizedKeys,
    removeKeyLine,
    replaceKeyLine,
    restrictionsFromOptions,
    serializeKeyLine,
    splitOptions,
    validateExpiryTime,
    validateFromAddresses,
    validatePublicKey,
} from "../../src/authorized-keys.ts";

const FIRST_BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIOJUSxbfdJo4tEfteh65Mp6jdn13HRzGTWPcyHGQvAdh";
const SECOND_BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIEzdBcOj/cIbBDpEdTEWmNI0w6l1bYMoqGCtqmMBMo80";
const THIRD_BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIKnfxm+1Zz1hPLkscUGNwksL+tL1iJJOhxVbbzaOnRjZ";
const RSA_BLOB_PREFIX = "AAAAB3NzaC1yc2EAAAADAQABAAABAQC+BzIy3ZO7lcAInkOfwNhWBh0hZrHxf82gWvzr+ueuv69QrWa7";

describe("parseAuthorizedKeyLine", () => {
    test("plain key with multi-word comment", () => {
        const key = parseAuthorizedKeyLine(`ssh-ed25519 ${FIRST_BLOB} alice laptop`);
        assert.deepEqual(key, {
            raw: `ssh-ed25519 ${FIRST_BLOB} alice laptop`,
            options: "",
            keyType: "ssh-ed25519",
            keyBlob: FIRST_BLOB,
            comment: "alice laptop",
        });
    });

    test("options with quoted commas and spaces", () => {
        const line = `restrict,from="10.0.0.1,192.0.2.0/24",command="echo a, b" ssh-ed25519 ${FIRST_BLOB} bob`;
        const key = parseAuthorizedKeyLine(line);
        assert.equal(key?.options, `restrict,from="10.0.0.1,192.0.2.0/24",command="echo a, b"`);
        assert.equal(key?.keyType, "ssh-ed25519");
        assert.equal(key?.keyBlob, FIRST_BLOB);
        assert.equal(key?.comment, "bob");
    });

    test("escaped quote inside an option value", () => {
        const key = parseAuthorizedKeyLine(`command="say \\"hi there\\"" ssh-ed25519 ${FIRST_BLOB}`);
        assert.equal(key?.options, `command="say \\"hi there\\""`);
        assert.equal(key?.comment, "");
    });

    test("comments, blank lines and garbage are not keys", () => {
        assert.equal(parseAuthorizedKeyLine(""), null);
        assert.equal(parseAuthorizedKeyLine("   "), null);
        assert.equal(parseAuthorizedKeyLine(`# ssh-ed25519 ${FIRST_BLOB}`), null);
        assert.equal(parseAuthorizedKeyLine("not a key"), null);
        assert.equal(parseAuthorizedKeyLine(`from="unterminated ssh-ed25519 ${FIRST_BLOB}`), null);
    });

    test("parseAuthorizedKeys skips comments and blank lines", () => {
        const content = `# header\n\nssh-ed25519 ${FIRST_BLOB} a\n# note\n\nrestrict ssh-ed25519 ${SECOND_BLOB} b\n`;
        const keys = parseAuthorizedKeys(content);
        assert.deepEqual(keys.map(key => key.comment), ["a", "b"]);
        assert.equal(keys[1].options, "restrict");
    });
});

describe("options", () => {
    test("splitOptions keeps quoted commas", () => {
        assert.deepEqual(splitOptions(`restrict,from="a,b",no-pty`), ["restrict", `from="a,b"`, "no-pty"]);
    });

    test("restrictionsFromOptions extracts managed options and keeps the rest", () => {
        const restrictions = restrictionsFromOptions(`no-pty,restrict,from="192.0.2.1,198.51.100.0/24",expiry-time="20300101"`);
        assert.deepEqual(restrictions, {
            restrict: true,
            fromAddresses: "192.0.2.1,198.51.100.0/24",
            expiryTime: "20300101",
            otherOptions: ["no-pty"],
        });
    });

    test("buildOptions output parses back to the same restrictions", () => {
        const restrictions = { restrict: true, fromAddresses: "192.0.2.1,!192.0.2.9", expiryTime: "203001011200", otherOptions: ["no-pty"] };
        const options = buildOptions(restrictions);
        assert.equal(options, `restrict,from="192.0.2.1,!192.0.2.9",expiry-time="203001011200",no-pty`);
        assert.deepEqual(restrictionsFromOptions(options), restrictions);
    });

    test("no options when nothing is restricted", () => {
        assert.equal(buildOptions({ restrict: false, fromAddresses: " ", expiryTime: "", otherOptions: [] }), "");
    });
});

describe("serialization", () => {
    test("round trip with and without options", () => {
        for (const line of [
            `ssh-ed25519 ${FIRST_BLOB} alice laptop`,
            `ssh-ed25519 ${FIRST_BLOB}`,
            `restrict,from="192.0.2.0/24,198.51.100.7" ssh-ed25519 ${FIRST_BLOB} c`,
        ]) {
            const key = parseAuthorizedKeyLine(line);
            assert.ok(key);
            assert.equal(serializeKeyLine(key), line);
        }
    });

    test("serialized key with new options parses back", () => {
        const options = buildOptions({ restrict: true, fromAddresses: "192.0.2.1", expiryTime: "", otherOptions: [] });
        const line = serializeKeyLine({ options, keyType: "ssh-ed25519", keyBlob: FIRST_BLOB, comment: "x y" });
        const key = parseAuthorizedKeyLine(line);
        assert.equal(key?.options, options);
        assert.equal(key?.keyBlob, FIRST_BLOB);
        assert.equal(key?.comment, "x y");
    });
});

describe("file editing", () => {
    const first = `ssh-ed25519 ${FIRST_BLOB} first`;
    const second = `restrict,from="192.0.2.1" ssh-ed25519 ${SECOND_BLOB} second`;
    const third = `ssh-ed25519 ${THIRD_BLOB} third`;
    const content = `# managed keys\n\n${first}\n# keep me\n\n${second}\n${third}\n`;

    test("removes exactly the selected key and keeps other lines", () => {
        // Raw index 1 is a blank line here, and second is the key at parsed index 1.
        const keys = parseAuthorizedKeys(content);
        assert.equal(keys[1].raw, second);
        const updated = removeKeyLine(content, keys[1].raw);
        assert.equal(updated, `# managed keys\n\n${first}\n# keep me\n\n${third}\n`);
    });

    test("removal of a key that is gone returns null", () => {
        assert.equal(removeKeyLine(`${first}\n`, second), null);
    });

    test("replace edits only the matching line", () => {
        const replacement = `restrict ssh-ed25519 ${THIRD_BLOB} third`;
        assert.equal(replaceKeyLine(content, third, replacement),
                     `# managed keys\n\n${first}\n# keep me\n\n${second}\n${replacement}\n`);
    });

    test("append adds a missing trailing newline", () => {
        assert.equal(appendKeyLine("# a", first), `# a\n${first}\n`);
        assert.equal(appendKeyLine("", first), `${first}\n`);
        assert.equal(appendKeyLine(`${second}\n`, first), `${second}\n${first}\n`);
    });
});

describe("validation", () => {
    test("accepts valid keys", () => {
        assert.equal(validatePublicKey(`ssh-ed25519 ${FIRST_BLOB} user@host`), null);
        assert.equal(validatePublicKey(`ssh-ed25519 ${FIRST_BLOB}`), null);
    });

    test("rejects bad keys", () => {
        assert.equal(validatePublicKey("hello"), "invalid-key-format");
        assert.equal(validatePublicKey(`ssh-ed25519 ${FIRST_BLOB}\nssh-ed25519 ${SECOND_BLOB}`), "invalid-key-format");
        assert.equal(validatePublicKey(`restrict ssh-ed25519 ${FIRST_BLOB}`), "options-in-key");
        assert.equal(validatePublicKey(`ssh-dss ${FIRST_BLOB}`), "unsupported-key-type");
        // Blob of an RSA key labelled as ed25519.
        assert.equal(validatePublicKey(`ssh-ed25519 ${RSA_BLOB_PREFIX}`), "invalid-key-data");
        assert.equal(validatePublicKey(`ssh-ed25519 ${FIRST_BLOB} bad"comment`), "invalid-comment");
    });

    test("from addresses", () => {
        assert.equal(validateFromAddresses(""), null);
        assert.equal(validateFromAddresses("192.0.2.1,198.51.100.0/24,!203.0.113.5,*.example.com,2001:db8::/32"), null);
        assert.equal(validateFromAddresses(`192.0.2.1" ,command="sh`), "invalid-from-addresses");
        assert.equal(validateFromAddresses("192.0.2.1 198.51.100.1"), "invalid-from-addresses");
        assert.equal(validateFromAddresses("192.0.2.1,"), "invalid-from-addresses");
        assert.equal(validateFromAddresses("a\nb"), "invalid-from-addresses");
    });

    test("expiry time", () => {
        assert.equal(validateExpiryTime(""), null);
        assert.equal(validateExpiryTime("20301231"), null);
        assert.equal(validateExpiryTime("203012312359Z"), null);
        assert.equal(validateExpiryTime("20301231235959"), null);
        assert.equal(validateExpiryTime("20301331"), "invalid-expiry-time");
        assert.equal(validateExpiryTime("2030-12-31"), "invalid-expiry-time");
        assert.equal(validateExpiryTime(`2030"`), "invalid-expiry-time");
    });
});
