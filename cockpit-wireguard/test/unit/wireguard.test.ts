import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    clientAllowedIpsFor,
    extraRoutesOf,
    isClientAddressInUse,
    isFullTunnelPeer,
    isLoopbackHost,
    parseConfig,
    parseExtraRoute,
    parseExtraRouteList,
    resolveClientEndpoint,
    serializeConfig,
} from "../../src/wireguard.ts";

const HUB_CONFIG = [
    "[Interface]",
    "PrivateKey = SERVERPRIVATE=",
    "Address = 10.10.20.1/24",
    "ListenPort = 51820",
    "# a hand-written note",
    "PostUp = nft -f /etc/host-setup/vpn/firewall.nft",
    "PostDown = nft delete table inet host_setup_vpn || true",
    "",
    "[Peer]",
    "# Name = phone",
    "# ClientAllowedIPs = 0.0.0.0/0, ::/0",
    "PublicKey = PHONE=",
    "AllowedIPs = 10.10.20.2/32",
    "",
    "[Peer]",
    "# Name = laptop",
    "# ClientAllowedIPs = 10.10.20.0/24, 192.168.1.198/32",
    "PublicKey = LAPTOP=",
    "AllowedIPs = 10.10.20.3/32",
    "# keep me",
    "",
    "[Peer]",
    "# Name = tablet",
    "PublicKey = TABLET=",
    "AllowedIPs = 10.10.20.4/32",
    "",
].join("\n");

describe("config round-trip", () => {
    test("keeps hand-written lines and firewall hooks unchanged", () => {
        assert.equal(serializeConfig(parseConfig("wg0", HUB_CONFIG)), HUB_CONFIG);
    });
});

describe("client routes", () => {
    const iface = parseConfig("wg0", HUB_CONFIG);
    const [phone, laptop, tablet] = iface.peers;

    test("split tunnel adds each extra route after the VPN subnet", () => {
        assert.equal(clientAllowedIpsFor(iface, false, ["192.168.1.198/32", "10.10.20.0/24"]),
                     "10.10.20.0/24, 192.168.1.198/32");
        assert.equal(clientAllowedIpsFor(iface, false, []), "10.10.20.0/24");
    });

    test("full tunnel stays unchanged", () => {
        assert.equal(clientAllowedIpsFor(iface, true, ["192.168.1.198/32"]), "0.0.0.0/0, ::/0");
    });

    test("extra routes are read back from the stored client AllowedIPs", () => {
        assert.deepEqual(extraRoutesOf(iface, laptop), ["192.168.1.198/32"]);
        assert.deepEqual(extraRoutesOf(iface, phone), []);
        assert.deepEqual(extraRoutesOf(iface, tablet), []);
    });

    test("clients without a recorded mode are not treated as full tunnel", () => {
        assert.ok(isFullTunnelPeer(phone));
        assert.ok(!isFullTunnelPeer(laptop));
        assert.ok(!isFullTunnelPeer(tablet));
    });

    test("client addresses already used by another peer are detected", () => {
        assert.ok(isClientAddressInUse(iface, "10.10.20.3"));
        assert.ok(isClientAddressInUse(iface, " 10.10.20.3/32 "));
        assert.ok(!isClientAddressInUse(iface, "10.10.20.3", "LAPTOP="));
        assert.ok(!isClientAddressInUse(iface, "10.10.20.5"));
        const network = parseConfig("wg0", HUB_CONFIG.replace("AllowedIPs = 10.10.20.2/32", "AllowedIPs = 10.10.20.18/28"));
        assert.ok(isClientAddressInUse(network, "10.10.20.16/28"));
    });
});

describe("extra route validation", () => {
    test("accepts IPv4 addresses and networks", () => {
        assert.equal(parseExtraRoute("192.168.1.198").route, "192.168.1.198/32");
        assert.equal(parseExtraRoute(" 192.168.1.0/24 ").route, "192.168.1.0/24");
    });

    test("rejects malformed routes, host bits, ports and /0", () => {
        for (const text of ["192.168.1.300", "192.168.1.0/33", "192.168.1.198:22", "192.168.1.198:22/tcp", "host", "1.2.3", "fd00::/64", "fd00:1:2:3:4:5:6::/112"])
            assert.ok(parseExtraRoute(text).error, text);
        assert.match(parseExtraRoute("192.168.1.5/24").error!, /192\.168\.1\.0\/24/);
        assert.match(parseExtraRoute("0.0.0.0/0").error!, /full tunnel/);
    });

    test("lists are de-duplicated and report each error", () => {
        const parsed = parseExtraRouteList("192.168.1.198\n192.168.1.198/32, 10.0.0.0/8\nbad\n\n");
        assert.deepEqual(parsed.routes, ["192.168.1.198/32", "10.0.0.0/8"]);
        assert.equal(parsed.errors.length, 1);
    });
});

describe("client endpoint", () => {
    test("loopback names are recognized", () => {
        for (const host of ["localhost", "LOCALHOST.", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:7f12:3456]", "0:0:0:0:0:ffff:7f00:1"])
            assert.ok(isLoopbackHost(host), host);
        for (const host of ["50.125.86.239", "vpn.example.com", "localhost.example.com", "128.0.0.1", "::", "::ffff:8000:1", "::ffff:192.168.1.1", "2001:db8::1", ":::1", "1::1::1"])
            assert.ok(!isLoopbackHost(host), host);
    });

    test("loopback fallbacks are never used", () => {
        assert.equal(resolveClientEndpoint(undefined, "localhost", 51820), null);
        assert.equal(resolveClientEndpoint("", "127.0.0.1", 51820), null);
        assert.equal(resolveClientEndpoint("localhost:51820", "", 51820), null);
        assert.equal(resolveClientEndpoint("localhost", "vpn.example.com", 51820), "vpn.example.com:51820");
    });

    test("host:port overrides are kept and bare hosts get the listen port", () => {
        assert.equal(resolveClientEndpoint("50.125.86.239:51821", "localhost", 51820), "50.125.86.239:51821");
        assert.equal(resolveClientEndpoint("vpn.example.com", "", 51820), "vpn.example.com:51820");
        assert.equal(resolveClientEndpoint("[2001:db8::1]:51821", "", 51820), "[2001:db8::1]:51821");
    });
});
