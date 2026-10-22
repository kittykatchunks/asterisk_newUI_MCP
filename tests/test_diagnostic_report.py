import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "diagnostic_report", Path(__file__).resolve().parents[1] / "local" / "diagnostics" / "report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ReportTests(unittest.TestCase):
    def fixture(self):
        secret = 'private-id<script>alert(1)</script>'
        packets = []
        for frame, (method, code) in enumerate(
                [("INVITE", ""), ("", "401"), ("ACK", ""), ("INVITE", ""),
                 ("", "200"), ("ACK", ""), ("BYE", ""), ("", "200")], 1):
            packet = dict.fromkeys(report.FIELDS, "")
            packet.update({
                "frame.number": str(frame), "frame.time_epoch": "1792690000.0",
                "ip.src": "192.0.2.1", "ip.dst": "192.0.2.2",
                "sip.Call-ID": secret, "sip.Method": method, "sip.Status-Code": code,
            })
            packets.append(packet)
        import csv
        import io
        output = io.StringIO()
        writer = csv.writer(output)
        for event, extra in [("PROOF_SIP_DIALOG", json.dumps({"extra": secret})),
                             ("ANSWER", ""), ("HANGUP", ""), ("CHAN_END", "")]:
            writer.writerow([event, "", "PJSIP/private", "private-channel", "", "", "", extra])
        manifest = dict.fromkeys([
            "incident", "started_utc", "ended_utc", "filter", "seconds_limit", "bytes_limit",
            "size_limit_note", "stop_reason", "kernel_dropped_packets", "pcap_bytes", "pcap_sha256",
        ], "synthetic")
        return manifest, packets, output.getvalue()

    def test_whitelist_redaction_and_correlation(self):
        document, dialogs, correlations = report.make_report(*self.fixture())
        self.assertEqual((dialogs, correlations), (1, 1))
        for value in ("192.0.2.1", "192.0.2.2", "private-id", "private-channel", "<script>"):
            self.assertNotIn(value, document)
        self.assertIn("dialog-1", document)
        self.assertIn("ANSWER", document)
        self.assertIn("SIP 401", document)

    def test_unmatched_cel_is_explicit_failure(self):
        manifest, packets, _ = self.fixture()
        with self.assertRaisesRegex(ValueError, "No explicit SIP"):
            report.make_report(manifest, packets, "")

    def test_incomplete_capture_is_not_success(self):
        manifest, packets, cel = self.fixture()
        with self.assertRaisesRegex(ValueError, "expected challenged"):
            report.make_report(manifest, packets[:3], cel)

    def test_unrecognised_method_does_not_enter_report(self):
        manifest, packets, cel = self.fixture()
        packets[0]["sip.Method"] = "<script>secret</script>"
        with self.assertRaisesRegex(ValueError, "Unsupported method"):
            report.make_report(manifest, packets, cel)


if __name__ == "__main__":
    unittest.main()
