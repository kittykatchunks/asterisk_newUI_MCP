import argparse
import os
import pathlib
import signal
import subprocess
import sys


parser = argparse.ArgumentParser()
parser.add_argument("--log", type=pathlib.Path, required=True)
parser.add_argument("--maximum-bytes", type=int, default=16 * 1024 * 1024)
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
if args.maximum_bytes <= 0 or not args.command:
    parser.error("A positive log limit and command are required")
with args.log.open("xb") as output:
    process = subprocess.Popen(
        args.command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    total = 0
    overflow = False
    try:
        while chunk := process.stdout.read(65536):
            available = args.maximum_bytes - total
            output.write(chunk[:available])
            total += min(len(chunk), available)
            if len(chunk) > available:
                overflow = True
                break
        if not overflow:
            process.wait()
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        process.stdout.close()
print(f"LOG={args.log} BYTES={total} CHILD_EXIT={process.returncode}", flush=True)
with args.log.open("rb") as output:
    output.seek(max(0, total - 8192))
    print(output.read().decode("utf-8", errors="replace"), flush=True)
if overflow:
    raise SystemExit("Command terminated: bounded log capacity exceeded")
sys.exit(process.returncode if process.returncode >= 0 else 128 - process.returncode)
