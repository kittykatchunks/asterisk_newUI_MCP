"""Validate only the two explicit test dialogs against fresh isolated CEL."""
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from management_outage_proof import correlate

headers = ["event", "time", "channel", "uniqueid", "linkedid", "context", "extension", "extra"]
with Path("/var/log/asterisk/cel-custom/Master.csv").open() as stream:
    rows = list(csv.DictReader(stream, fieldnames=headers))
print(json.dumps(correlate(rows, sys.argv[1:])))
