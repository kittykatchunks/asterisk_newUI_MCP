"""Whitelist-only synthetic incident report; never embeds raw SIP or attachments."""

import argparse
import base64
import csv
import datetime
import hashlib
import html
import io
import json
import subprocess
from pathlib import Path

FIELDS = [
    "frame.number", "frame.time_epoch", "ip.src", "ip.dst",
    "udp.srcport", "udp.dstport", "sip.Call-ID", "sip.Method",
    "sip.Status-Code", "sip.CSeq.seq", "sip.CSeq.method",
]
CEL_HEADERS = ["event", "time", "channel", "uniqueid", "linkedid", "context", "extension", "extra"]
METHODS = {"INVITE", "ACK", "BYE", "CANCEL", "OPTIONS", "REGISTER"}
CEL_EVENTS = {"CHAN_START", "ANSWER", "HANGUP", "CHAN_END", "BRIDGE_ENTER", "BRIDGE_EXIT", "USER_DEFINED"}


def alias(mapping, value, prefix):
    if value not in mapping:
        mapping[value] = f"{prefix}-{len(mapping) + 1}"
    return mapping[value]


def decode_packets(path):
    command = ["tshark", "-n", "-r", str(path), "-Y", "sip", "-T", "fields",
               "-E", "separator=/t", "-E", "quote=d", "-E", "occurrence=f"]
    for field in FIELDS:
        command += ["-e", field]
    result = subprocess.run(command, capture_output=True, text=True, check=True, timeout=30)
    packets = []
    for row in csv.reader(io.StringIO(result.stdout), delimiter="\t"):
        if len(row) != len(FIELDS):
            raise ValueError("Unexpected decoded packet shape")
        packet = dict(zip(FIELDS, row))
        if not packet["sip.Call-ID"]:
            raise ValueError("SIP packet has no Call-ID")
        packets.append(packet)
    if not packets:
        raise ValueError("No readable SIP packets; encryption or capture scope may hide signalling")
    return packets


def make_report(manifest, packets, cel_text):
    calls, hosts, channels = {}, {}, {}
    ladders = []
    correlations = []
    codes, methods = set(), set()
    for packet in packets:
        call = alias(calls, packet["sip.Call-ID"], "dialog")
        source = alias(hosts, packet["ip.src"], "endpoint")
        target = alias(hosts, packet["ip.dst"], "endpoint")
        code = packet["sip.Status-Code"]
        method = packet["sip.Method"]
        if code:
            if not code.isdigit() or not 100 <= int(code) <= 699:
                raise ValueError("Invalid SIP status code")
            codes.add(code)
            label = f"SIP {code}"
        else:
            if method not in METHODS:
                raise ValueError("Unsupported method in synthetic capture")
            methods.add(method)
            label = method
        timestamp = datetime.datetime.fromtimestamp(
            float(packet["frame.time_epoch"]), datetime.timezone.utc).isoformat()
        frame = int(packet["frame.number"])
        ladders.append((frame, timestamp, call, source, label, target))
    rows = list(csv.DictReader(io.StringIO(cel_text), fieldnames=CEL_HEADERS))
    for row in rows:
        if row["event"] != "PROOF_SIP_DIALOG":
            continue
        extra = json.loads(row["extra"])
        call_id = extra.get("extra")
        if call_id in calls:
            correlations.append((call_id, row["uniqueid"]))
    if not correlations:
        raise ValueError("No explicit SIP Call-ID to CEL channel correlation found")
    history = []
    for call_id, channel_id in correlations:
        for row in rows:
            if row["uniqueid"] == channel_id and row["event"] in CEL_EVENTS:
                history.append((calls[call_id], alias(channels, channel_id, "channel"), row["event"]))
    if not {"401", "200"} <= codes or not {"INVITE", "ACK", "BYE"} <= methods:
        raise ValueError("Capture does not contain the expected challenged and completed call")
    escaped = lambda value: html.escape(str(value), quote=True)
    ladder_rows = "\n".join(
        f'<tr data-dialog="{call}" data-message="{escaped(label)}">'
        f'<td><details><summary>Packet {frame}</summary>'
        f'<p>Network evidence; UDP SIP. {source} to {target}. '
        'Raw headers and payload are excluded from this redacted export.</p>'
        f'</details></td><td>{escaped(timestamp)}</td><td>{call}</td>'
        f'<td>{source}</td><td class="message">{escaped(label)} &#8594;</td><td>{target}</td></tr>'
        for frame, timestamp, call, source, label, target in ladders
    )
    history_rows = "\n".join(
        f'<tr data-dialog="{row[0]}">' + "".join(f"<td>{escaped(value)}</td>" for value in row) + "</tr>"
        for row in history
    )
    dialog_options = "".join(
        f'<option value="{value}">{value}</option>' for value in calls.values()
    )
    # Only fixed local assets are executable; packet values never enter JavaScript.
    script = Path(__file__).with_name("report.js").read_text(encoding="utf-8").replace("\r\n", "\n")
    style = Path(__file__).with_name("report.css").read_text(encoding="utf-8").replace("\r\n", "\n")
    digest = lambda text: base64.b64encode(hashlib.sha256(text.encode()).digest()).decode()
    csp = (
        "default-src 'none'; "
        f"script-src 'sha256-{digest(script)}'; style-src 'sha256-{digest(style)}'; "
        "connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'"
    )
    challenge_count = sum(1 for row in ladders if row[4] == "SIP 401")
    bye_count = sum(1 for row in ladders if row[4] == "BYE")
    safe_manifest = {
        key: manifest[key] for key in (
            "incident", "started_utc", "ended_utc", "filter", "seconds_limit", "bytes_limit",
            "size_limit_note", "stop_reason", "kernel_dropped_packets", "pcap_bytes", "pcap_sha256",
        )
    }
    document = f"""<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Synthetic engineering evidence</title>
<meta http-equiv="Content-Security-Policy" content="{escaped(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>{style}</style>
<h1>Synthetic engineering incident evidence</h1>
<p>Incident: {escaped(manifest["incident"])}</p>
<p>Source: network packets at one customer container interface. UTC timestamps.
Scope: local UDP SIP test calls; not TLS/WSS or RTP payload capture.</p>
<p>Redacted derivative: endpoint, dialog and channel identifiers are pseudonymised.
Raw messages, credentials, caller identities, SDP and packet attachments are excluded.
No AI analysis or engineer-reviewed fault attribution is included.</p>
<h2>Observed signalling ladder</h2>
<p class="notice">{challenge_count} authentication challenge responses (401) and
{bye_count} BYE requests observed. A 401 is part of normal digest authentication;
neither count establishes a fault or successful completion of every dialog.</p>
<div class="controls">
<div><label for="dialog-filter">Dialog</label><select id="dialog-filter"><option value="">All dialogs</option>{dialog_options}</select></div>
<div><label for="message-filter">Message filter</label><input id="message-filter" type="search" placeholder="INVITE, BYE, SIP 401" autocomplete="off"></div>
<button id="reset-filters" type="button">Reset filters</button></div>
<p id="visible-count" role="status">All packets shown; filters require JavaScript.</p>
<p id="empty-state" hidden>No packets match these filters.</p>
<noscript><p>Interactive filtering is unavailable. All packet evidence remains visible.</p></noscript>
<p>Printing includes all packets, regardless of the current filters.</p>
<div class="table-scroll"><table id="packets"><caption>Observed SIP messages</caption>
<thead><tr><th scope="col">Packet</th><th scope="col">UTC</th><th scope="col">Dialog</th><th scope="col">From</th><th scope="col">Message</th><th scope="col">To</th></tr></thead>
<tbody>{ladder_rows}</tbody></table></div>
<h2>Explicit CEL correlations</h2>
<p>Matched using a synthetic dialplan CEL event carrying the received SIP Call-ID,
not timestamps alone. Only correlated channel event types are shown.</p>
<div class="table-scroll"><table id="events"><caption>Correlated channel events</caption>
<thead><tr><th scope="col">Dialog</th><th scope="col">Channel</th><th scope="col">Event</th></tr></thead>
<tbody>{history_rows}</tbody></table></div>
<h2>Observations and limitations</h2>
<p>Observed challenges and call termination do not establish a provider fault.
Capture starts after activation; no earlier packets exist in this evidence.
Kernel loss statistics do not prove end-to-end completeness.
This local fixture is not approved for arbitrary customer trace export.</p>
<h2>Original packet integrity and capture limits</h2>
<pre>{escaped(json.dumps(safe_manifest, indent=2))}</pre>
<p>Hash identifies the captured file; it does not prove fault attribution.</p>
<script>{script}</script></html>
"""
    return document, len(calls), len(correlations)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", default="/evidence")
    args = parser.parse_args()
    directory = Path(args.directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    pcap = directory / "signalling.pcap"
    if hashlib.sha256(pcap.read_bytes()).hexdigest() != manifest["pcap_sha256"]:
        raise ValueError("Original packet evidence hash mismatch")
    cel = directory / "cel.csv"
    manifest["cel_sha256"] = hashlib.sha256(cel.read_bytes()).hexdigest()
    document, dialogs, correlations = make_report(manifest, decode_packets(pcap), cel.read_text())
    report = directory / "report.html"
    report.write_text(document, encoding="utf-8")
    manifest["report_sha256"] = hashlib.sha256(report.read_bytes()).hexdigest()
    (directory / "export-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"PASS report: {dialogs} SIP dialogs, {correlations} explicit CEL correlations; original hash verified")


if __name__ == "__main__":
    main()
