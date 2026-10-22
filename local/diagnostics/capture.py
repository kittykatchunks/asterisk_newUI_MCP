"""Fixed-scope, bounded local SIP capture. No caller-supplied commands or filters."""

import argparse
import datetime
import hashlib
import json
import re
import signal
import subprocess
import time
from pathlib import Path

FILTER = "udp port 5060"
INTERFACE = "eth0"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--customer", choices=("customer-a", "customer-b"), required=True)
    parser.add_argument("--incident", required=True)
    parser.add_argument("--seconds", type=int, choices=range(1, 61), required=True)
    parser.add_argument("--max-bytes", type=int, choices=range(65536, 1048577), required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"incident-[0-9a-f]{32}", args.incident):
        raise ValueError("Invalid synthetic incident identifier")
    directory = Path("/evidence")
    pcap = directory / "signalling.pcap"
    # The runner creates a new incident directory for every invocation.
    if pcap.exists():
        raise RuntimeError("Refusing to overwrite original packet evidence")
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with (directory / "capture.stderr").open("xb") as stderr:
        process = subprocess.Popen(
            ["tcpdump", "-Z", "root", "-i", INTERFACE, "-p", "-s", "0", "-U", "-n",
             "-w", str(pcap), FILTER],
            stdout=subprocess.DEVNULL, stderr=stderr,
        )
        reason = "duration_limit"
        stopped_by_limit = False
        try:
            deadline = time.monotonic() + args.seconds
            ready = False
            while process.poll() is None:
                if pcap.exists() and pcap.stat().st_size >= 24 and not ready:
                    (directory / "ready").write_text(started)
                    ready = True
                if pcap.exists() and pcap.stat().st_size >= args.max_bytes:
                    reason = "size_limit"
                    break
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.02)
            else:
                raise RuntimeError("Packet collector exited before its configured limit")
            stopped_by_limit = True
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise RuntimeError("Packet collector did not stop cleanly")
        if not stopped_by_limit or process.returncode != 0:
            raise RuntimeError(f"Packet collector failed: exit {process.returncode}")
    diagnostics = (directory / "capture.stderr").read_text()
    dropped = re.search(r"(\d+) packets dropped by kernel", diagnostics)
    if not dropped:
        raise RuntimeError("Collector did not report packet-loss statistics")
    manifest = {
        "schema": 1,
        "customer": args.customer,
        "incident": args.incident,
        "started_utc": started,
        "ended_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": "network packets, customer container network namespace",
        "interface": INTERFACE,
        "filter": FILTER,
        "seconds_limit": args.seconds,
        "bytes_limit": args.max_bytes,
        "size_limit_note": "Sampled every 20 ms; buffered packets can exceed this soft byte limit.",
        "stop_reason": reason,
        "kernel_dropped_packets": int(dropped[1]),
        "pcap_bytes": pcap.stat().st_size,
        "pcap_sha256": hashlib.sha256(pcap.read_bytes()).hexdigest(),
        "collector_version": subprocess.check_output(["tcpdump", "--version"], text=True).splitlines()[0],
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"PASS {args.customer}: capture stopped at {reason}; kernel drops={dropped[1]}")


if __name__ == "__main__":
    main()
