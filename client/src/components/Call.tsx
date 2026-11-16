import { useEffect, useRef, useState } from "react";
import { calls, useCall, type PeerState } from "../call";
import { useStore } from "../store";
import { chatAvatarId, chatTitle, duration, userName } from "../util";
import { Avatar, Icon } from "./ui";

function VideoEl({ stream, muted = false, mirror = false }: { stream: MediaStream | null; muted?: boolean; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={mirror ? "mirror" : ""} />;
}

function AudioEl({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

function PeerTile({ id, peer }: { id: string; peer: PeerState }) {
  const users = useStore((s) => s.users);
  const u = users[id];
  const hasVideo = peer.video && peer.stream?.getVideoTracks().some((t) => t.readyState === "live");
  return (
    <div className="call-tile">
      {hasVideo ? <VideoEl stream={peer.stream} /> : <AudioEl stream={peer.stream} />}
      {!hasVideo && <Avatar id={id} mediaId={u?.avatar_id} name={userName(u)} size={96} />}
      <div className="call-tile-name">
        {userName(u)} {!peer.audio && <Icon name="micOff" size={14} />}
        {peer.state !== "connected" && <span className="muted small"> · {peer.state}</span>}
      </div>
    </div>
  );
}

export function CallOverlay() {
  const { incoming, active } = useCall();
  const me = useStore((s) => s.me);
  const chats = useStore((s) => s.chats);
  const users = useStore((s) => s.users);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active?.connected) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active?.connected]);
  if (!me) return null;

  if (incoming && !active) {
    const chat = chats[incoming.chat_id];
    const caller = users[incoming.caller_id];
    const title = chat?.kind === "group" ? chat.name : userName(caller);
    return (
      <div className="incoming-call">
        <Avatar id={incoming.caller_id} mediaId={chat ? chatAvatarId(chat, me.id, users) : caller?.avatar_id} name={title} size={72} group={chat?.kind === "group"} />
        <div className="grow min0">
          <div className="chat-name">{title}</div>
          <div className="small muted">
            {chat?.kind === "group" ? `${userName(caller)} · ` : ""}Incoming {incoming.video ? "video" : "voice"} call
          </div>
        </div>
        <button className="call-btn decline" title="Decline" onClick={() => calls.reject()}>
          <Icon name="hangup" />
        </button>
        <button className="call-btn accept" title="Accept" onClick={() => calls.accept()}>
          <Icon name={incoming.video ? "video" : "phone"} />
        </button>
      </div>
    );
  }

  if (!active) return null;
  const chat = chats[active.chatId];
  const title = chat ? chatTitle(chat, me.id, users) : "Call";
  const peers = Object.entries(active.peers);
  const status = active.error
    ? active.error
    : active.connected && active.startedAt
      ? duration((Date.now() - active.startedAt) / 1000)
      : active.outgoing
        ? peers.length
          ? "Connecting…"
          : "Ringing…"
        : "Connecting…";

  return (
    <div className="call-screen">
      <div className="call-top">
        <div className="chat-name big">{title}</div>
        <div className="muted">
          <Icon name="lock" size={12} /> {status}
        </div>
      </div>
      <div className={"call-grid n" + Math.min(peers.length, 4)}>
        {peers.length === 0 && chat && (
          <div className="call-tile">
            <Avatar id={chat.id} mediaId={chatAvatarId(chat, me.id, users)} name={title} size={128} group={chat.kind === "group"} />
          </div>
        )}
        {peers.map(([id, p]) => (
          <PeerTile key={id} id={id} peer={p} />
        ))}
      </div>
      {active.video && active.local && !active.cameraOff && (
        <div className="call-self">
          <VideoEl stream={active.local} muted mirror />
        </div>
      )}
      <div className="call-controls">
        <button className={"call-btn" + (active.video && !active.cameraOff ? " on" : "")} title="Camera" onClick={() => calls.toggleCamera()}>
          <Icon name={active.video && !active.cameraOff ? "video" : "videoOff"} />
        </button>
        {active.video && (
          <button className="call-btn" title="Switch camera" onClick={() => calls.flipCamera()}>
            <Icon name="flip" />
          </button>
        )}
        <button className={"call-btn" + (active.muted ? " off" : " on")} title={active.muted ? "Unmute" : "Mute"} onClick={() => calls.toggleMute()}>
          <Icon name={active.muted ? "micOff" : "mic"} />
        </button>
        <button className="call-btn decline" title="End call" onClick={() => calls.hangup()}>
          <Icon name="hangup" />
        </button>
      </div>
    </div>
  );
}
