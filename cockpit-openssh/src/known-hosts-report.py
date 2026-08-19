#!/usr/bin/python3
"""Compare stored SSH known_hosts entries against what the hosts present now.

Installed and driven by cockpit-openssh. This is deliberately report-only: it
never modifies a known_hosts file. A key mismatch is what a man-in-the-middle
looks like, so removing entries automatically would destroy the value of
known_hosts entirely.
"""

import json
import os
import socket
import subprocess
import sys
import time

CONFIG = "/etc/cockpit-openssh/known-hosts-report.conf"
OUTPUT = "/var/lib/cockpit-openssh/known-hosts-report.json"

MARKERS = ("@revoked", "@cert-authority")


def load_config() -> dict | None:
    try:
        with open(CONFIG, encoding="utf-8") as config_file:
            return json.load(config_file)
    except (OSError, ValueError) as exc:
        print(f"cannot read {CONFIG}: {exc}", file=sys.stderr)
        return None


def parse(path: str) -> list[dict]:
    entries = []
    try:
        with open(path, encoding="utf-8", errors="replace") as hosts_file:
            for number, raw in enumerate(hosts_file, 1):
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                fields = line.split()
                offset = 1 if fields[0] in MARKERS else 0
                if len(fields) < offset + 3:
                    continue
                entries.append({
                    "line": number,
                    "hosts": fields[offset],
                    "type": fields[offset + 1],
                    "blob": fields[offset + 2],
                })
    except OSError as exc:
        print(f"cannot read {path}: {exc}", file=sys.stderr)
    return entries


def split_target(host: str) -> tuple[str, str]:
    """Split the [host]:port form used for non-default ports."""
    if host.startswith("[") and "]:" in host:
        name, port = host[1:].split("]:", 1)
        return name, port
    return host, "22"


def resolves(name: str) -> bool:
    try:
        socket.getaddrinfo(name, None)
        return True
    except socket.gaierror:
        return False
    except OSError:
        return True


def keyscan(name: str, port: str, timeout: int) -> set[tuple[str, str]] | None:
    cmd = ["ssh-keyscan", "-T", str(timeout), "-p", port, name]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10, check=False)
    except (subprocess.SubprocessError, OSError):
        return None

    # ssh-keyscan exits 0 even when a host fails, so the output is what counts.
    keys = set()
    for line in proc.stdout.splitlines():
        if line.startswith("#"):
            continue
        fields = line.split()
        if len(fields) >= 3:
            keys.add((fields[1], fields[2]))
    return keys or None


def check(path: str, timeout: int, findings: list[dict]) -> None:
    scanned: dict[tuple[str, str], set[tuple[str, str]] | None] = {}

    for entry in parse(path):
        finding = {"file": path, "host": "", "keyType": entry["type"], "line": entry["line"]}

        if entry["hosts"].startswith("|1|"):
            # HMAC-SHA1 hostnames cannot be reversed, so there is nothing to scan.
            findings.append({**finding, "status": "skipped-hashed"})
            continue

        host = entry["hosts"].split(",")[0]
        if any(char in host for char in "*?!"):
            findings.append({**finding, "host": host, "status": "skipped-pattern"})
            continue

        finding["host"] = host
        name, port = split_target(host)

        if not resolves(name):
            findings.append({**finding, "status": "unresolvable"})
            continue

        if (name, port) not in scanned:
            scanned[(name, port)] = keyscan(name, port, timeout)
        keys = scanned[(name, port)]

        if keys is None:
            status = "unreachable"
        elif (entry["type"], entry["blob"]) in keys:
            status = "match"
        else:
            status = "mismatch"
        findings.append({**finding, "status": status})


def main() -> int:
    config = load_config()
    if config is None:
        return 1

    timeout = int(config.get("timeout", 5))
    findings: list[dict] = []

    for path in config.get("targets", []):
        if not isinstance(path, str) or os.path.islink(path) or not os.path.isfile(path):
            continue
        check(path, timeout, findings)

    counts: dict[str, int] = {}
    for finding in findings:
        counts[finding["status"]] = counts.get(finding["status"], 0) + 1

    report = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "findings": findings,
        "counts": counts,
    }

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    tmp = OUTPUT + ".new"
    with open(tmp, "w", encoding="utf-8") as report_file:
        json.dump(report, report_file, indent=2)
    os.replace(tmp, OUTPUT)

    summary = ", ".join(f"{key}={value}" for key, value in sorted(counts.items()))
    print(f"known_hosts check complete: {summary or 'no entries'}")
    if counts.get("mismatch"):
        print(f"WARNING: {counts['mismatch']} stored key(s) differ from the live host key",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
