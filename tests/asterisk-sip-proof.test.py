import hashlib
import importlib.util
import json
import pathlib
import re
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
HERE = ROOT / "local/asterisk-build"
sys.path[:0] = [str(HERE), str(ROOT / "tests")]
import sip_candidate_client as client
import sip_rtp_proof as sip

spec = importlib.util.spec_from_file_location("sip_proof", HERE / "sip-proof.py")
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class SipProofTests(unittest.TestCase):
    def test_digest_method_and_qop_with_known_inputs(self):
        md5 = lambda value: hashlib.md5(value.encode()).hexdigest()
        for method in ("INVITE", "REGISTER"):
            for qop in (False, True):
                challenge = 'Digest realm="proof", nonce="nonce", algorithm=MD5, opaque="x"'
                if qop:
                    challenge += ', qop="auth,auth-int"'
                with patch.object(sip.uuid, "uuid4") as uuid:
                    uuid.return_value.hex = "cnonce"
                    value = sip.authorization(challenge, "password", "sip:pbx", method)
                ha1 = md5("proof-client:proof:password")
                ha2 = md5(f"{method}:sip:pbx")
                expected = md5(f"{ha1}:nonce:00000001:cnonce:auth:{ha2}" if qop
                               else f"{ha1}:nonce:{ha2}")
                self.assertIn(f'response="{expected}"', value)
                self.assertIn('opaque="x"', value)
        with self.assertRaisesRegex(RuntimeError, "MD5"):
            sip.authorization('Digest algorithm=SHA-256', "password", "sip:pbx")
        with self.assertRaisesRegex(RuntimeError, "qop"):
            sip.authorization('Digest realm="r", nonce="n", qop="auth-int"', "p", "sip:p")
        with self.assertRaisesRegex(RuntimeError, "Unsupported"):
            sip.authorization("Digest ", "p", "sip:p", "BYE")

    def test_registration_challenge_and_expiry(self):
        probe = client.RegistrationProbe.__new__(client.RegistrationProbe)
        probe.cseq = 1
        probe.ip, probe.port = "172.20.0.3", 4000
        probe.from_value, probe.to_value = "<sip:proof-client@172.20.0.3>;tag=x", "<sip:echo@pbx>"
        probe.uri, probe.call_id = "sip:echo@pbx", "call"
        challenge = 'Digest realm="proof", nonce="nonce"'
        with patch.object(probe, "final_response", side_effect=[
                (401, {"www-authenticate": [challenge]}, ""), (200, {}, "")]) as exchange:
            self.assertEqual(probe.register("pbx", "password", 60)[0], 200)
        packets = [call.args[0].decode() for call in exchange.call_args_list]
        self.assertIn("REGISTER sip:pbx SIP/2.0", packets[0])
        self.assertIn("To: <sip:proof-client@pbx>", packets[0])
        self.assertIn("Expires: 60", packets[0])
        self.assertNotIn("Authorization:", packets[0])
        self.assertIn("Authorization: Digest ", packets[1])
        self.assertNotEqual(packets[0].split("CSeq: ")[1], packets[1].split("CSeq: ")[1])
        with patch.object(probe, "final_response", return_value=(200, {}, "")):
            with self.assertRaisesRegex(RuntimeError, "401"):
                probe.register("pbx", "p", 0)
        for expiry in (1, 60):
            self.assertEqual(client.contact_expiry({"contact": [f"<sip:p@host>;expires={expiry}"]}), expiry)
        for headers in ({}, {"contact": ["a", "b"]}, {"contact": ["a"]},
                        {"contact": ["a;expires=0"]}, {"contact": ["a;expires=61"]}):
            with self.assertRaises(RuntimeError):
                client.contact_expiry(headers)

    def test_media_exact_peer_codec_and_range(self):
        sdp = "c=IN IP4 172.20.0.2\r\nm=audio 10000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"
        self.assertEqual(client.validate_media(sdp, "172.20.0.2"), 10000)
        for invalid in (sdp.replace("10000", "9999"), sdp.replace("10000", "10101"),
                        sdp.replace("RTP/AVP 0", "RTP/AVP 0 101"), sdp.replace("PCMU", "PCMA"),
                        sdp + "c=IN IP4 8.8.8.8\r\n"):
            with self.assertRaises(RuntimeError):
                client.validate_media(invalid, "172.20.0.2")

    def test_rtp_bounds_extensions_padding_and_threshold(self):
        header = struct.pack("!BBHII", 0x80, 0, 1, 160, 123)
        self.assertEqual(sip.rtp_payload(header + b"audio"), b"audio")
        extension = bytes([0x90]) + header[1:] + b"\x00\x01\x00\x01abcd"
        self.assertEqual(sip.rtp_payload(extension + b"audio"), b"audio")
        padded = bytes([0xA0]) + header[1:] + b"audio\x01"
        self.assertEqual(sip.rtp_payload(padded), b"audio")
        for invalid in (b"", header[:11], bytes([0x81]) + header[1:],
                        bytes([0x90]) + header[1:], extension[:-1],
                        bytes([0xA0]) + header[1:] + b"\x00",
                        bytes([0xA0]) + header[1:] + b"\xff",
                        header[:1] + b"\x08" + header[2:] + b"audio"):
            with self.assertRaises(RuntimeError):
                sip.rtp_payload(invalid)
        for count in (70, 100):
            sip.validate_echo_count(100, count)
        for sent, matched in ((100, 69), (99, 70), (100, 101)):
            with self.assertRaises(RuntimeError):
                sip.validate_echo_count(sent, matched)

    def test_sip_exchange_correlates_and_deadlines(self):
        for malformed in (b"x" * 8193, b"SIP/2.0 200 OK", b"SIP/2.0 200 OK\r\nbadheader\r\n\r\n"):
            with self.assertRaises(RuntimeError):
                sip.parse_message(malformed)
        probe = sip.Probe.__new__(sip.Probe)
        probe.cseq, probe.call_id = 3, "expected"
        responses = [
            b"SIP/2.0 200 OK\r\nCSeq: 2 REGISTER\r\nCall-ID: old\r\n\r\n",
            b"SIP/2.0 200 OK\r\nCSeq: 3 REGISTER\r\nCall-ID: expected\r\n\r\n"]
        from unittest.mock import Mock
        probe.sip = Mock()
        probe.sip.recv.side_effect = responses
        with patch.object(sip.select, "select", return_value=([probe.sip], [], [])):
            self.assertEqual(probe.final_response(b"request", "REGISTER")[0], 200)
        probe.sip.recv.return_value = b"SIP/2.0 200 OK\r\nCSeq: 3 REGISTER\r\nCall-ID: foreign\r\n\r\n"
        probe.sip.recv.side_effect = None
        with patch.object(sip.select, "select", return_value=([probe.sip], [], [])):
            with self.assertRaisesRegex(RuntimeError, "dialog"):
                probe.final_response(b"request", "REGISTER")
        with patch.object(sip.time, "monotonic", side_effect=[0, 6]):
            with self.assertRaisesRegex(RuntimeError, "Timed out"):
                probe.final_response(b"request", "REGISTER")

    def test_actual_echo_loop_threshold_with_synthetic_clock_and_sockets(self):
        for limit in (69, 70, 100):
            class Rtp:
                def __init__(self):
                    self.packets, self.sent = [], 0

                def send(self, packet):
                    self.sent += 1
                    if self.sent <= limit:
                        self.packets.append(packet)

                def recv(self, size):
                    return self.packets.pop(0)

            rtp, sip_socket = Rtp(), object()
            clock = iter(index * 0.002 for index in range(10000))
            with patch.object(sip.time, "monotonic", side_effect=lambda: next(clock)), \
                    patch.object(sip.select, "select", side_effect=lambda *args: (
                        [rtp] if rtp.packets else [], [], [])):
                if limit == 69:
                    with self.assertRaisesRegex(RuntimeError, "69/100"):
                        sip.verify_rtp_echo(sip_socket, rtp, "deterministic-test", lambda: None)
                else:
                    self.assertEqual(sip.verify_rtp_echo(
                        sip_socket, rtp, "deterministic-test", lambda: None), limit)
            self.assertEqual(rtp.sent, 100)

    def test_client_refuses_unexpected_negative_auth_success(self):
        from unittest.mock import Mock
        for failure in ("register", "invite"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                control = pathlib.Path(directory)
                (control / "secret").write_text("a" * 64)
                for phase in client.PHASES:
                    (control / f"{phase}.ack").touch()
                probe = Mock(ip="172.20.0.3", port=4000, server=("172.20.0.2", 5060))
                probe.register.side_effect = (
                    [(200, {}, "")] if failure == "register" else [
                        (401, {}, ""), (200, {"contact": ["<sip:p@host>;expires=60"]}, "")])
                wrong = Mock()
                wrong.invite.return_value = (200, {}, "")
                with patch.object(client, "RegistrationProbe", return_value=probe), \
                        patch.object(client, "Probe", return_value=wrong):
                    with self.assertRaisesRegex(RuntimeError, "not explicitly rejected"):
                        client.execute("pbx", control)
                report = json.loads((control / "client-report.json").read_text())
                self.assertFalse(report["passed"])
                self.assertFalse(report["mediaPassed"])
                probe.close.assert_called_once()

    def test_cli_contact_and_object_parsers_fail_closed(self):
        proof.contacts("No objects found.\n")
        output = ("  Contact: <Aor/ContactUri> <Hash> <Status> <RTT(ms)>\n"
                  "  Contact: proof-client/sip:proof-client@172.20.0.3:4000 abc NonQual nan\n"
                  "Objects found: 1\n")
        self.assertEqual(len(proof.contacts(output, "172.20.0.3", 4000)), 1)
        for bad in (output.replace("4000", "4001"), output.replace("proof-client/", "other/"),
                    output.replace("found: 1", "found: 2")):
            with self.assertRaises(ValueError):
                proof.contacts(bad, "172.20.0.3", 4000)
        proof.object_rows(" Endpoint: <Endpoint/CID> <State>\n Endpoint: proof-client Not in use\nObjects found: 1\n",
                          "Endpoint", "proof-client")
        with self.assertRaises(ValueError):
            proof.object_rows("No objects found.", "Endpoint", "proof-client")

    def test_exact_attempt_two_contact_row_excludes_multispace_header(self):
        report = json.loads((HERE / "sip-proof-attempt-2-report.json").read_text())
        progress = report["lastClientProgress"]
        raw = report["cliObservations"][-1]["output"]
        legacy_rows = [line.strip() for line in raw.splitlines()
                       if re.match(r"^\s*Contact:\s+(?!<)", line)]
        self.assertEqual(len(legacy_rows), 2)
        rows = proof.contacts(raw, progress["clientAddress"], progress["clientPort"])
        self.assertEqual(len(rows), 1)
        self.assertNotIn("<Aor/ContactUri", rows[0])
        with self.assertRaises(ValueError):
            proof.contacts(raw, progress["clientAddress"], progress["clientPort"] + 1)
        with self.assertRaises(ValueError):
            proof.contacts(raw.replace("Objects found: 1", "Objects found: 2"),
                           progress["clientAddress"], progress["clientPort"])

    def test_preflight_client_can_exit_cleanly_without_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            control = pathlib.Path(directory)
            (control / "preflight-exit").touch()
            result = subprocess.run(
                [sys.executable, "-B", str(ROOT / "tests/sip_candidate_client.py"),
                 "--host=not-resolved.invalid", "--control", directory],
                capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((control / "python-ready.json").read_text()), {"pythonReady": True})
            self.assertFalse((control / "client-report.json").exists())

    def test_approval_and_client_report_size(self):
        result = subprocess.run([sys.executable, "-B", str(HERE / "sip-proof.py"),
                                 "--work-dir", "not-created"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--approve-isolated-sip-rtp-proof", result.stderr)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "report.json"
            with self.assertRaisesRegex(RuntimeError, "8192"):
                client.write_json(path, {"value": "x" * 8192})
            self.assertFalse(path.exists())
        self.assertNotIn("secret", proof.sanitize("password=secret\nAuthorization: digest\nokay", "secret"))

    def test_mocked_orchestration_success_and_failures_cleanup(self):
        for failure in (None, "queue-mode", "queue-observer", "limits", "preflight", "bridge-drift", "network", "contact", "contact-and-inventory",
                        "client", "stop", "ownership"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory) / "run"
                queue_mode = failure in ("queue-mode", "queue-observer")
                states, created, calls = {}, {}, []
                image = "sha256:" + "a" * 64
                netid = "c" * 64
                pbxip, clientip = "172.20.0.2", "172.20.0.3"
                network = None
                removed = set()
                baseline = proof.runtime.read_json(HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]

                def fake_command(args, timeout=20):
                    nonlocal network
                    calls.append(args)
                    if args[:2] == ["image", "inspect"]:
                        return json.dumps([dict(Id=proof.CARRIER, Os="linux", Architecture="amd64")]), ""
                    if args[0] == "ps":
                        if "--filter" in args:
                            return "\n".join(key for key in states if key not in removed), ""
                        return "existing changed" if failure == "contact-and-inventory" and "b" * 64 in removed else "existing untouched", ""
                    if args[:2] == ["network", "ls"]:
                        return "old existing-network", ""
                    if args[:2] == ["network", "create"]:
                        network = args[-1]
                        return netid, ""
                    if args[:2] == ["network", "inspect"]:
                        if args[-1] == "bridge":
                            return json.dumps([dict(Name="bridge", Id="changed" if failure == "bridge-drift" and "b" * 64 in removed else "bridge-id", Created="before",
                                                    Driver="bridge", Internal=False, IPAM={}, Options={}, Containers={})]), ""
                        members = {key: dict(IPv4Address=(pbxip if role == "pbx" else clientip) + "/16")
                                   for role, key in created.items() if key not in removed}
                        if failure == "network":
                            members["foreign"] = {}
                        return json.dumps([dict(Name=network, Labels={proof.LABEL: next(iter(states.values()))["Config"]["Labels"][proof.LABEL]},
                                                Internal=True, Driver="bridge", Containers=members)]), ""
                    if args[:2] == ["network", "rm"]:
                        self.assertEqual(args[-1], netid)
                        return netid, ""
                    if args[0] == "create":
                        role = "client" if "--entrypoint=python3" in args else "pbx"
                        identifier = ("d" if role == "client" else "b") * 64
                        created[role] = identifier
                        owner = args[args.index("--label") + 1].split("=")[1]
                        host = dict(NetworkMode=args[next(i for i, arg in enumerate(args) if arg.startswith("--network="))].split("=")[1], ReadonlyRootfs=True, Privileged=False,
                                    Memory=134217728 if role == "client" else 4294967296,
                                    MemorySwap=134217728 if role == "client" else 4294967296,
                                    NanoCpus=500000000 if role == "client" else 4000000000,
                                    PidsLimit=32 if role == "client" else 256,
                                    PortBindings={}, CapDrop=["ALL"], SecurityOpt=["no-new-privileges:true"],
                                    RestartPolicy=dict(Name="no"), LogConfig=dict(Type="local", Config={
                                        "max-size": "2m", "max-file": "1", "compress": "false"}),
                                    Ulimits=[dict(Name="core", Hard=0, Soft=0)])
                        if failure == "limits":
                            host["MemorySwap"] = -1
                        states[identifier] = dict(
                            Id=identifier, Name="/" + args[args.index("--name") + 1],
                            Image=proof.CARRIER if role == "client" else image, HostConfig=host, Mounts=[],
                            Config=dict(User="1000:999" if role == "client" else "10001:10001",
                                        Entrypoint=["python3"] if role == "client" else proof.runtime.ENTRYPOINT,
                                        Cmd=(["-B", "/client/sip_candidate_client.py", "--host=pbx", "--control=/control"]
                                             + (["--queue-timeout"] if "--queue-timeout" in args else [])),
                                        Labels={proof.LABEL: owner}),
                            State=dict(Running=False, ExitCode=0, OOMKilled=False, Status="created"))
                        removed.discard(identifier)
                        return identifier, ""
                    if args[0] == "inspect":
                        state = json.loads(json.dumps(states[args[-1]]))
                        if failure == "ownership" and "--filter" in calls[-2]:
                            state["Name"] = "/foreign"
                        return json.dumps([state]), ""
                    if args[0] == "start":
                        states[args[-1]]["State"].update(Running=True, Status="running")
                        if args[-1] == created.get("client"):
                            (root / "control/python-ready.json").write_text(
                                '{"pythonReady":false}' if failure == "preflight" else '{"pythonReady":true}')
                            progress = dict(passed=True, registrationPassed=True, mediaPassed=not queue_mode,
                                            clientAddress=clientip, pbxAddress=pbxip, clientPort=4000,
                                            rtp=dict(sentDistinctFrames=100, echoedDistinctFrames=100), phases=[])
                            for phase in proof.QUEUE_PHASES if queue_mode else proof.PHASES:
                                progress["phases"].append(dict(phase=phase))
                                (root / f"control/{phase}.json").write_text(json.dumps(progress))
                            (root / "control/client-report.json").write_text(json.dumps(progress))
                        return args[-1], ""
                    if args[0] in ("wait", "stop"):
                        states[args[-1]]["State"]["Running"] = False
                        return ("1" if failure in ("client", "stop") else "0") if args[0] == "wait" else args[-1], ""
                    if args[0] == "logs":
                        return "password=secret\nsafe log\n", ""
                    if args[0] == "rm":
                        self.assertIn(args[-1], states)
                        removed.add(args[-1])
                        return args[-1], ""
                    raise AssertionError(args)

                def fake_cli(container, text, diagnostics):
                    if text == "core waitfullybooted":
                        return "Asterisk has fully booted.\n"
                    if text == "module show":
                        return "\n".join(f"{name} fixture 0 Running core"
                                         for name in proof.runtime.module_links(proof.runtime.manifest()))
                    if text.startswith("core show help"):
                        return "No such command"
                    if text.startswith("queue policy"):
                        return json.dumps(baseline)
                    if text == "pjsip show endpoints":
                        return " Endpoint: proof-client Not in use\nObjects found: 1\n"
                    if text == "pjsip show transports":
                        return " Transport: transport-udp udp 0 0 0.0.0.0:5060\nObjects found: 1\n"
                    if text == "pjsip show aors":
                        return " Aor: proof-client 1\nObjects found: 1\n"
                    if text == "pjsip show contacts":
                        ack = len(list((root / "control").glob("*.ack")))
                        if "client" in created and 1 <= ack <= (4 if queue_mode else 3):
                            return (" Contact: proof-client/sip:proof-client@" +
                                    ("8.8.8.8" if failure in ("contact", "contact-and-inventory") else clientip) +
                                    ":4000 hash NonQual nan\nObjects found: 1\n")
                        return "No objects found.\n"
                    if text == "core show channels concise":
                        return ""
                    raise AssertionError(text)

                with patch.object(proof.desktop, "verify_image", return_value=(image, HERE / "image-payload-validation-nss.json")), \
                        patch.object(proof.desktop, "command", side_effect=fake_command), \
                        patch.object(proof.desktop, "cli", side_effect=fake_cli), \
                        patch.object(proof.runtime_sip_queue, "observe",
                                     side_effect=ValueError("queue observation failed") if failure == "queue-observer" else None,
                                     return_value=dict(passed=True, mediaVerified=False)) as queue_observer:
                    if failure in (None, "queue-mode"):
                        result = proof.proof(root, queue_timeout=queue_mode)
                        self.assertTrue(result["passed"])
                        self.assertTrue(result["registrationPassed"])
                        self.assertEqual(result["mediaPassed"], not queue_mode)
                        if queue_mode:
                            self.assertTrue(result["sipQueueTimeout"]["passed"])
                            self.assertFalse(result["mediaTested"])
                            queue_observer.assert_called_once()
                        else:
                            queue_observer.assert_not_called()
                        self.assertTrue(result["pythonPreflightPassed"])
                        self.assertEqual(result["initialBridge"], result["finalBridge"])
                    else:
                        with self.assertRaises((ValueError, RuntimeError)) as caught:
                            proof.proof(root, queue_timeout=queue_mode)
                        if failure == "contact-and-inventory":
                            self.assertIn("Dynamic contact", str(caught.exception))
                report = json.loads((root / "sip-proof-report.json").read_text())
                self.assertEqual(report["passed"], failure in (None, "queue-mode"))
                if failure != "ownership":
                    self.assertEqual(set(states), removed)
                    self.assertFalse((root / "control/secret").exists())
                    self.assertFalse((root / "etc/pjsip.conf").exists())
                if failure in ("contact", "contact-and-inventory"):
                    self.assertTrue(any("8.8.8.8" in observation["output"]
                                        for observation in report["cliObservations"]))
                    self.assertEqual(report["lastClientProgress"]["phases"][-1]["phase"], "registered")
                for call in calls:
                    self.assertNotIn("pull", call[:2])
                    self.assertNotIn("build", call[:2])
                    self.assertNotIn("-p", call)


if __name__ == "__main__":
    unittest.main()
