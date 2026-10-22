import { Inviter, Registerer, SessionState, UserAgent, Web } from "sip.js";

interface ProofConfig {
  port: number;
  password: string;
}

interface AudioStats {
  packetsSent: number;
  packetsReceived: number;
  audioEnergy: number;
  dtlsConnected: boolean;
  srtpCipher: string;
}

interface ProofResult {
  state: "ready" | "running" | "passed" | "failed";
  message: string;
  stats?: AudioStats;
}

declare global {
  interface Window {
    runProof: (config: ProofConfig) => Promise<void>;
    proofResult: ProofResult;
  }
}

const status = document.querySelector("#status");
if (!(status instanceof HTMLElement)) throw new Error("Missing proof status element");
const output = status;
window.proofResult = { state: "ready", message: "Ready" };

function update(result: ProofResult): void {
  window.proofResult = result;
  output.textContent = JSON.stringify(result, null, 2);
}

async function waitFor(
  check: () => boolean,
  description: string,
  milliseconds = 15000,
): Promise<void> {
  const deadline = performance.now() + milliseconds;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function readAudioStats(pc: RTCPeerConnection): Promise<AudioStats> {
  const stats: AudioStats = {
    packetsSent: 0, packetsReceived: 0, audioEnergy: 0, dtlsConnected: false, srtpCipher: "",
  };
  const report = await pc.getStats();
  report.forEach((entry) => {
    if (entry.type === "outbound-rtp" && entry.kind === "audio") {
      stats.packetsSent += entry.packetsSent ?? 0;
    }
    if (entry.type === "inbound-rtp" && entry.kind === "audio") {
      stats.packetsReceived += entry.packetsReceived ?? 0;
      stats.audioEnergy += entry.totalAudioEnergy ?? 0;
    }
    if (entry.type === "transport" && entry.dtlsState === "connected") {
      stats.dtlsConnected = true;
      stats.srtpCipher = entry.srtpCipher ?? "";
    }
  });
  return stats;
}

window.runProof = async ({ port, password }) => {
  update({ state: "running", message: "Connecting and registering over WSS" });
  const uri = UserAgent.makeURI(`sip:browser-proof@127.0.0.1:${port}`);
  if (!uri) throw new Error("Invalid proof identity URI");
  const ua = new UserAgent({
    uri,
    authorizationUsername: "browser-proof",
    authorizationPassword: password,
    transportOptions: { server: `wss://127.0.0.1:${port}/ws` },
    logLevel: "error",
    logConfiguration: false,
    sessionDescriptionHandlerFactoryOptions: {
      constraints: { audio: true, video: false },
      peerConnectionConfiguration: { iceServers: [] },
    },
  });
  const registerer = new Registerer(ua, { expires: 120 });
  let session: Inviter | undefined;
  const audio = document.createElement("audio");
  audio.autoplay = true;
  document.body.append(audio);
  let failure: unknown;
  try {
    if (!window.isSecureContext) throw new Error("Proof requires a secure context");
    await ua.start();
    let registered = false;
    let rejected = false;
    await registerer.register({
      requestDelegate: {
        onAccept: () => { registered = true; },
        onReject: () => { rejected = true; },
      },
    });
    await waitFor(() => registered || rejected, "SIP registration");
    if (rejected) throw new Error("Registration rejected");
    const target = UserAgent.makeURI(`sip:echo@127.0.0.1:${port}`);
    if (!target) throw new Error("Invalid target URI");
    const mediaOptions: Web.SessionDescriptionHandlerOptions = {
      constraints: { audio: true, video: false },
      offerOptions: { offerToReceiveAudio: true },
    };
    session = new Inviter(ua, target, { sessionDescriptionHandlerOptions: mediaOptions });
    await session.invite();
    await waitFor(
      () => session?.state === SessionState.Established || session?.state === SessionState.Terminated,
      "call establishment",
    );
    if (session.state !== SessionState.Established) throw new Error("Call terminated before establishment");
    const handler = session.sessionDescriptionHandler;
    if (!(handler instanceof Web.SessionDescriptionHandler)) {
      throw new Error("Expected WebRTC session handler");
    }
    const pc = handler.peerConnection;
    if (!pc) throw new Error("Missing WebRTC peer connection");
    audio.srcObject = new MediaStream(pc.getReceivers().map((receiver) => receiver.track));
    await audio.play();
    const deadline = performance.now() + 20000;
    let stats = await readAudioStats(pc);
    while (!(stats.packetsSent >= 70 && stats.packetsReceived >= 70 &&
             stats.audioEnergy > 0 && stats.dtlsConnected && stats.srtpCipher)) {
      if (performance.now() > deadline) {
        const transports: unknown[] = [];
        (await pc.getStats()).forEach((entry) => {
          if (entry.type === "transport") transports.push(entry);
        });
        throw new Error(`Media threshold not reached: ${JSON.stringify(stats)}; ICE=${pc.iceConnectionState}; transport=${JSON.stringify(transports)}; local SDP=${pc.localDescription?.sdp}; remote SDP=${pc.remoteDescription?.sdp}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      stats = await readAudioStats(pc);
    }
    update({ state: "running", message: "Media verified; ending call", stats });
    await session.bye();
    await waitFor(() => session?.state === SessionState.Terminated, "call termination");
    await registerer.unregister();
    update({ state: "passed", message: "WSS registration, DTLS-SRTP audio energy and packet thresholds passed", stats });
  } catch (error) {
    failure = error;
  } finally {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    try {
      await registerer.dispose();
      await ua.stop();
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      update({ state: "failed", message: failure instanceof Error ? failure.message : String(failure) });
    }
  }
};
