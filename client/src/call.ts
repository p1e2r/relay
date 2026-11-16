import { create } from "zustand";
import { api, realtime } from "./api";
import type { CallInfo } from "./types";

export interface PeerState {
  stream: MediaStream | null;
  audio: boolean;
  video: boolean;
  state: string;
}

export interface ActiveCall {
  id: string | null;
  chatId: string;
  video: boolean;
  outgoing: boolean;
  connected: boolean;
  startedAt: number | null;
  peers: Record<string, PeerState>;
  local: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  error?: string;
}

interface CallUI {
  incoming: CallInfo | null;
  active: ActiveCall | null;
}

export const useCall = create<CallUI>(() => ({ incoming: null, active: null }));

// ---- ringtone (generated, no audio assets needed) ----
let ringCtx: AudioContext | null = null;
let ringTimer: number | undefined;
function ring(kind: "incoming" | "outgoing" | null) {
  clearInterval(ringTimer);
  ringTimer = undefined;
  if (!kind) return;
  try {
    ringCtx = ringCtx || new AudioContext();
  } catch {
    return;
  }
  const beep = () => {
    if (!ringCtx) return;
    const t = ringCtx.currentTime;
    const freqs = kind === "incoming" ? [880, 660] : [440];
    freqs.forEach((f, i) => {
      const o = ringCtx!.createOscillator();
      const g = ringCtx!.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.25);
      g.gain.exponentialRampToValueAtTime(0.15, t + i * 0.25 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.25 + 0.22);
      o.connect(g).connect(ringCtx!.destination);
      o.start(t + i * 0.25);
      o.stop(t + i * 0.25 + 0.25);
    });
  };
  beep();
  ringTimer = window.setInterval(beep, kind === "incoming" ? 1500 : 3000);
}

class CallManager {
  private pcs = new Map<string, RTCPeerConnection>();
  private queued = new Map<string, RTCIceCandidateInit[]>();
  private iceServers: RTCIceServer[] | null = null;
  meId = "";

  private set(patch: Partial<ActiveCall>) {
    const a = useCall.getState().active;
    if (a) useCall.setState({ active: { ...a, ...patch } });
  }

  private setPeer(id: string, patch: Partial<PeerState>) {
    const a = useCall.getState().active;
    if (!a) return;
    const prev = a.peers[id] || { stream: null, audio: true, video: a.video, state: "connecting" };
    useCall.setState({ active: { ...a, peers: { ...a.peers, [id]: { ...prev, ...patch } } } });
  }

  private async ice(): Promise<RTCIceServer[]> {
    if (!this.iceServers) {
      try {
        const r = await api<{ ice_servers: RTCIceServer[] }>("GET", "/ice");
        this.iceServers = r.ice_servers;
      } catch {
        this.iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
      }
    }
    return this.iceServers;
  }

  private async media(video: boolean): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
    });
  }

  async start(chatId: string, video: boolean) {
    if (useCall.getState().active) return;
    useCall.setState({
      active: { id: null, chatId, video, outgoing: true, connected: false, startedAt: null, peers: {}, local: null, muted: false, cameraOff: false },
    });
    try {
      const local = await this.media(video);
      this.set({ local });
      await this.ice();
      realtime.send({ type: "call.start", chat_id: chatId, video });
      ring("outgoing");
    } catch (e: any) {
      this.set({ error: "Couldn't access your microphone" + (video ? " or camera" : "") });
      setTimeout(() => this.cleanup(), 2500);
    }
  }

  async accept() {
    const inc = useCall.getState().incoming;
    if (!inc) return;
    ring(null);
    useCall.setState({
      incoming: null,
      active: { id: inc.id, chatId: inc.chat_id, video: inc.video, outgoing: false, connected: false, startedAt: null, peers: {}, local: null, muted: false, cameraOff: false },
    });
    try {
      const local = await this.media(inc.video);
      this.set({ local });
      await this.ice();
      realtime.send({ type: "call.accept", call_id: inc.id });
    } catch {
      this.set({ error: "Couldn't access your microphone" });
      realtime.send({ type: "call.reject", call_id: inc.id });
      setTimeout(() => this.cleanup(), 2500);
    }
  }

  reject() {
    const inc = useCall.getState().incoming;
    ring(null);
    if (inc) realtime.send({ type: "call.reject", call_id: inc.id });
    useCall.setState({ incoming: null });
  }

  hangup() {
    const a = useCall.getState().active;
    if (a?.id) realtime.send({ type: "call.leave", call_id: a.id });
    this.cleanup();
  }

  toggleMute() {
    const a = useCall.getState().active;
    if (!a) return;
    const muted = !a.muted;
    a.local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ muted });
    if (a.id) realtime.send({ type: "call.media", call_id: a.id, audio: !muted, video: a.video && !a.cameraOff });
  }

  async toggleCamera() {
    const a = useCall.getState().active;
    if (!a) return;
    if (!a.video) {
      // Upgrade a voice call to video.
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = cam.getVideoTracks()[0];
        a.local?.addTrack(track);
        for (const [peer, pc] of this.pcs) {
          pc.addTrack(track, a.local!);
          await this.renegotiate(peer, pc);
        }
        this.set({ video: true, cameraOff: false, local: a.local });
        if (a.id) realtime.send({ type: "call.media", call_id: a.id, audio: !a.muted, video: true });
      } catch {}
      return;
    }
    const cameraOff = !a.cameraOff;
    a.local?.getVideoTracks().forEach((t) => (t.enabled = !cameraOff));
    this.set({ cameraOff });
    if (a.id) realtime.send({ type: "call.media", call_id: a.id, audio: !a.muted, video: !cameraOff });
  }

  async flipCamera() {
    const a = useCall.getState().active;
    const old = a?.local?.getVideoTracks()[0];
    if (!a || !old) return;
    const facing = (old.getSettings().facingMode || "user") === "user" ? "environment" : "user";
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
      const track = cam.getVideoTracks()[0];
      for (const pc of this.pcs.values()) pc.getSenders().find((s) => s.track?.kind === "video")?.replaceTrack(track);
      a.local!.removeTrack(old);
      old.stop();
      a.local!.addTrack(track);
      this.set({ local: a.local });
    } catch {}
  }

  private async renegotiate(peer: string, pc: RTCPeerConnection) {
    const a = useCall.getState().active;
    if (!a?.id) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    realtime.send({ type: "call.signal", call_id: a.id, to: peer, data: { sdp: pc.localDescription } });
  }

  private async peer(userId: string, initiator: boolean): Promise<RTCPeerConnection> {
    const existing = this.pcs.get(userId);
    if (existing) return existing;
    const a = useCall.getState().active!;
    const pc = new RTCPeerConnection({ iceServers: await this.ice() });
    this.pcs.set(userId, pc);
    this.setPeer(userId, {});
    a.local?.getTracks().forEach((t) => pc.addTrack(t, a.local!));
    pc.ontrack = (e) => this.setPeer(userId, { stream: e.streams[0] || new MediaStream([e.track]) });
    pc.onicecandidate = (e) => {
      const id = useCall.getState().active?.id;
      if (e.candidate && id) realtime.send({ type: "call.signal", call_id: id, to: userId, data: { candidate: e.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => {
      this.setPeer(userId, { state: pc.connectionState });
      if (pc.connectionState === "connected") {
        const cur = useCall.getState().active;
        if (cur && !cur.connected) this.set({ connected: true, startedAt: Date.now() });
        ring(null);
      }
      if (pc.connectionState === "failed") pc.restartIce();
    };
    if (initiator) await this.renegotiate(userId, pc);
    return pc;
  }

  private async onSignal(from: string, data: any) {
    if (!useCall.getState().active) return;
    if (data?.sdp) {
      const pc = await this.peer(from, false);
      await pc.setRemoteDescription(data.sdp);
      for (const c of this.queued.get(from) || []) await pc.addIceCandidate(c).catch(() => {});
      this.queued.delete(from);
      if (data.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const id = useCall.getState().active?.id;
        realtime.send({ type: "call.signal", call_id: id, to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data?.candidate) {
      const pc = this.pcs.get(from);
      if (pc?.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else this.queued.set(from, [...(this.queued.get(from) || []), data.candidate]);
    }
  }

  private closePeer(userId: string) {
    this.pcs.get(userId)?.close();
    this.pcs.delete(userId);
    const a = useCall.getState().active;
    if (a) {
      const peers = { ...a.peers };
      delete peers[userId];
      useCall.setState({ active: { ...a, peers } });
    }
  }

  cleanup() {
    ring(null);
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
    this.queued.clear();
    useCall.getState().active?.local?.getTracks().forEach((t) => t.stop());
    useCall.setState({ active: null });
  }

  handle(ev: any) {
    const { active, incoming } = useCall.getState();
    switch (ev.type) {
      case "call.started":
        if (active && !active.id && active.chatId === ev.call.chat_id) this.set({ id: ev.call.id });
        break;
      case "call.incoming":
        if (ev.call.caller_id === this.meId && !ev.call.answered) return; // my own call on another device
        if (active?.id === ev.call.id) return;
        if (active) return; // busy: just let it ring out
        useCall.setState({ incoming: ev.call });
        ring("incoming");
        break;
      case "call.peers":
        if (active?.id === ev.call_id) ev.peers.forEach((p: string) => this.peer(p, true));
        break;
      case "call.joined":
        if (ev.user_id === this.meId && incoming?.id === ev.call_id && !active) {
          ring(null);
          useCall.setState({ incoming: null }); // answered on another device
        } else if (active?.id === ev.call_id && ev.user_id !== this.meId) {
          ring(null);
          this.setPeer(ev.user_id, {});
        }
        break;
      case "call.signal":
        if (active?.id === ev.call_id) this.onSignal(ev.from, ev.data);
        break;
      case "call.media":
        if (active?.id === ev.call_id) this.setPeer(ev.user_id, { audio: ev.audio !== false, video: ev.video !== false });
        break;
      case "call.left":
        if (active?.id === ev.call_id) this.closePeer(ev.user_id);
        break;
      case "call.rejected":
        if (incoming?.id === ev.call_id && ev.user_id === this.meId) {
          ring(null);
          useCall.setState({ incoming: null });
        }
        break;
      case "call.ended":
        if (incoming?.id === ev.call_id) {
          ring(null);
          useCall.setState({ incoming: null });
        }
        if (active && active.id === ev.call_id) {
          if (!active.connected) this.set({ error: ev.status === "rejected" ? "Call declined" : "No answer" });
          setTimeout(() => this.cleanup(), active.connected ? 0 : 1500);
        }
        break;
    }
  }
}

export const calls = new CallManager();
