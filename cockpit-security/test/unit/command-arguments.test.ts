import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isValidIpAddress, isValidServiceName, parsePortRange } from "../../src/pages/command-arguments.ts";

describe("parsePortRange", () => {
    test("accepts ports and ranges in both firewall syntaxes", () => {
        assert.deepEqual(parsePortRange("443"), { firewalld: "443", ufw: "443" });
        assert.deepEqual(parsePortRange("8000-8010"), { firewalld: "8000-8010", ufw: "8000:8010" });
    });

    test("rejects options, out of range and reversed values", () => {
        for (const value of ["", "0", "65536", "-1", "--force", "22/udp", "80 443", "9000-8000"])
            assert.equal(parsePortRange(value), null, value);
    });
});

describe("isValidServiceName", () => {
    test("accepts service and ufw profile names", () => {
        for (const value of ["ssh", "Nginx Full", "OpenSSH", "samba-client"])
            assert.equal(isValidServiceName(value), true, value);
    });

    test("rejects options and shell or control characters", () => {
        for (const value of ["", "--dry-run", " ssh", "ssh;reboot", "a\nb", "x".repeat(65)])
            assert.equal(isValidServiceName(value), false, JSON.stringify(value));
    });
});

describe("isValidIpAddress", () => {
    test("accepts IPv4 and IPv6 addresses", () => {
        for (const value of ["192.0.2.1", "2001:db8::1", "::1", "::", "fe80::1:2", "2001:db8:0:0:0:0:0:1", "::ffff:192.0.2.1", "1:2:3:4:5:6:1.2.3.4"])
            assert.equal(isValidIpAddress(value), true, value);
    });

    test("rejects options and malformed values", () => {
        for (const value of ["", "--all", "256.1.1.1", "192.0.2", "host.example", "1.2.3.4 5.6.7.8",
                             ":", "1:2", "2001:::1", "::ffff:999.1.1.1", "1::2::3", "12345::1", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::8", "1.2.3.4::1", ":1::2"])
            assert.equal(isValidIpAddress(value), false, value);
    });
});
