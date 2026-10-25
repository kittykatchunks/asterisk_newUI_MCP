import unittest

from management_outage_proof import Observation, correlate, payload


class ObservationTests(unittest.TestCase):
    def complete(self):
        observation = Observation(100)
        for window in range(60):
            for frame in range(50):
                now = 100 + window + frame / 50
                self.assertEqual(observation.sent_at(now), window)
                observation.received(bytes([window, frame]), window, now)
        return observation

    def test_exact_duration_and_every_window(self):
        result = self.complete().result(160)
        self.assertEqual(result["seconds"], 60)
        self.assertEqual(len(result["windows"]), 60)
        self.assertTrue(all(w["sent"] == 50 and w["echoed"] == 50 for w in result["windows"]))
        self.assertIsNone(self.complete().sent_at(160))

    def test_short_observation_and_single_bad_window_fail(self):
        with self.assertRaisesRegex(RuntimeError, "shorter"):
            self.complete().result(159.999)
        observation = self.complete()
        observation.sent[35] = 39
        with self.assertRaisesRegex(RuntimeError, "only 39 sent"):
            observation.result(160)
        observation = self.complete()
        observation.echoes[35] = {bytes([35, frame]) for frame in range(34)}
        with self.assertRaisesRegex(RuntimeError, "34/50"):
            observation.result(160)
        observation.echoes[35].add(bytes([35, 34]))
        self.assertEqual(observation.result(160)["windows"][35]["echoed"], 35)

    def test_receive_gap_and_duplicate_echo_fail(self):
        with self.assertRaisesRegex(RuntimeError, "gap"):
            Observation(100).check_gap(101.001)
        duplicate = Observation(100)
        duplicate.received(b"duplicate", 0, 100.1)
        duplicate.received(b"duplicate", 0, 101)
        with self.assertRaisesRegex(RuntimeError, "gap"):
            duplicate.check_gap(101.101)
        observation = self.complete()
        observation.echoes[12] = set()
        for _ in range(50):
            observation.received(b"duplicate", 12, 161)
        with self.assertRaisesRegex(RuntimeError, "1/50"):
            observation.result(160)

    def test_rtp_parser_rejects_truncation_and_bad_padding(self):
        self.assertEqual(payload(bytes([0x80, 0]) + bytes(10) + b"audio"), b"audio")
        self.assertEqual(payload(bytes([0xA0, 0]) + bytes(10) + b"audio\x01"), b"audio")
        for data in [b"", bytes([0x81, 0]) + bytes(10), bytes([0x90, 0]) + bytes(10),
                     bytes([0xA0, 0]) + bytes(10) + b"\x00",
                     bytes([0x80, 8]) + bytes(10) + b"audio"]:
            with self.assertRaises(RuntimeError):
                payload(data)

    def test_cel_uses_named_event_and_exact_json_call_id(self):
        rows = []
        for index, call_id in enumerate(["first", "second"]):
            for event in ["CHAN_START", "ANSWER", "PROOF_SIP_DIALOG", "HANGUP", "CHAN_END"]:
                rows.append({"event": event, "extra": '{"extra":"' + call_id + '"}',
                             "uniqueid": str(index), "linkedid": str(index),
                             "context": "sip-proof", "extension": "echo"})
        self.assertEqual(len(correlate(rows, ["first", "second"])["dialogs"]), 2)
        with self.assertRaisesRegex(RuntimeError, "exactly one CEL"):
            correlate(rows, ["fir", "second"])
        with self.assertRaisesRegex(RuntimeError, "Missing/duplicate"):
            correlate(rows + [rows[0]], ["first", "second"])
        with self.assertRaisesRegex(RuntimeError, "exactly one CEL"):
            correlate([row for row in rows if row is not rows[2]], ["first", "second"])


if __name__ == "__main__":
    unittest.main()
