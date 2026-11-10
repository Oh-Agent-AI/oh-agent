import { useEffect, useState } from "react";
import "../remote.css";
import { DreamSnapshotChannel, DreamVisitorAccess } from "./dreamVisitor";
import { parseDreamCitySnapshot, type DreamCitySnapshotV1 } from "./dreamSnapshotContract";
import { RemoteDreamCityScene } from "./RemoteCityScene";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Visitor view for a host-authorized Dream City publication. */
export function DreamCityApp({ params }: { params: URLSearchParams }) {
  const [snapshot, setSnapshot] = useState<DreamCitySnapshotV1 | null>(null);
  const [status, setStatus] = useState("正在申请进入城市…");
  const roomId = params.getAll("room").length === 1 ? params.get("room") ?? "" : "";
  const sessionId = params.getAll("publication").length === 1 ? params.get("publication") ?? "" : "";
  const inviteId = params.getAll("invite").length === 1 ? params.get("invite") ?? "" : "";
  useEffect(() => {
    let active = true;
    let disconnected = false;
    let closingForError = false;
    let channel: DreamSnapshotChannel | null = null;
    const run = async () => {
      try {
        const access = new DreamVisitorAccess({ origin: location.origin, roomId, sessionId, inviteId }, sessionStorage);
        await access.join(location.hash.slice(1));
        if (!active) return;
        history.replaceState(history.state, "", `${location.pathname}${location.search}`);
        setStatus("等待城市主人批准…");
        let ticket: URL | null = null;
        for (let attempt = 0; active && attempt < 240 && !ticket; attempt++) {
          ticket = await access.ticket();
          if (!ticket) await pause(2500);
        }
        if (!active) return;
        if (!ticket) throw new Error("dream_approval_expired");
        setStatus("正在连接城市…");
        const socket = new WebSocket(ticket.toString());
        channel = new DreamSnapshotChannel(socket, sessionId, () => {
          disconnected = true;
          if (active && !closingForError) { setSnapshot(null); setStatus("连接已关闭，城市已清除。请重新打开链接。"); }
        });
        for (let attempt = 0; active && !disconnected && !channel.isReady() && attempt < 100; attempt++) await pause(100);
        if (!active) return;
        if (!channel.isReady()) throw new Error("dream_connection_unavailable");
        setStatus("正在加载城市…");
        const value = parseDreamCitySnapshot(await channel.snapshot());
        if (!active || disconnected) return;
        setSnapshot(value);
        setStatus("城市漫游");
      } catch (error) {
        if (import.meta.env.DEV) console.warn("Dream test connection failed:", error instanceof Error ? error.message : "unknown");
        if (active && !disconnected) { setSnapshot(null); setStatus("无法进入城市，请检查链接或联系城市主人。"); }
        closingForError = true;
        channel?.close();
      }
    };
    void run();
    return () => { active = false; channel?.close(); };
  }, [roomId, sessionId, inviteId]);

  return <main className="dream-city-app">
    {snapshot && <RemoteDreamCityScene snapshot={snapshot.snapshot} palettes={snapshot.palettes} heroBuildingId={snapshot.heroBuildingId} display={snapshot.display} />}
    <p className="dream-city-status" role="status">{status}</p>
  </main>;
}
import "../remote.css";
