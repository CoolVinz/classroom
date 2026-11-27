import { Client, type Room } from "@colyseus/sdk";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { activityHeight, activityWidth, choiceColors, choiceZones } from "../../gallery-server/src/live-activity-layout.mjs";
import { ApiError, api } from "./api";
import type { AvatarAppearance } from "./gallery-avatar";

type Player = AvatarAppearance & { x: number; y: number; selected: number; displayName: string; role: string };
type ArenaState = { players: Map<string, Player>; questionIndex: number; phase: string };
type ArenaChoice = { id: string; text: string; imageId: string | null };

function Avatar({ player, own }: { player: Player; own: boolean }) {
  const style = {
    left: `${player.x / activityWidth * 100}%`, top: `${player.y / activityHeight * 100}%`,
    "--skin": player.skinColor, "--hair": player.hairColor, "--shirt": player.shirtColor, "--legs": player.trousersColor,
    "--hat": player.hatColor, "--glasses": player.glassesColor, "--shoes": player.shoeColor,
  } as CSSProperties;
  return <div className={`live-avatar${own ? " is-self" : ""}`} style={style}
    data-hair={player.hairStyle} data-hat={player.hatStyle} data-glasses={player.glassesStyle} data-shoes={player.shoeStyle}>
    <i className="live-avatar-tail"/><i className="live-avatar-head"/><i className="live-avatar-hat"/>
    <i className="live-avatar-glasses"/><i className="live-avatar-body"/><i className="live-avatar-legs"/>
    <small>{player.displayName}{player.role === "teacher" ? " · ครู" : ""}</small>
  </div>;
}

export function LiveActivityArena({ id, path, questionIndex, answering, teacher, choices, correctChoiceId, selected }: {
  id: string; path: string; questionIndex: number; answering: boolean; teacher: boolean; choices: ArenaChoice[];
  correctChoiceId?: string | null; selected: number | null;
}) {
  const connection = useRef<Room<ArenaState> | null>(null);
  const currentQuestion = useRef(questionIndex);
  currentQuestion.current = questionIndex;
  const [players, setPlayers] = useState<[string, Player][]>([]);
  const [ownId, setOwnId] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [roomIndex, setRoomIndex] = useState(-2);
  const axis = useRef({ x: 0, y: 0 });
  const touch = useRef<number | null>(null);
  const [thumb, setThumb] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const controller = new AbortController();
    let joined: Room<ArenaState> | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    setError(""); setPlayers([]); setOwnId(""); setRoomIndex(-2);
    async function connect() {
      let admitted: Room<ArenaState> | null = null;
      try {
        const { ticket, url } = await api<{ ticket: string; url: string }>(path + "/ticket", { method: "POST", signal: controller.signal });
        admitted = await new Client(url).joinOrCreate<ArenaState>("live-activity", { activityId: id, ticket });
        if (controller.signal.aborted) { void admitted.leave(); return; }
        const room = admitted;
        joined = room;
        connection.current = room;
        setOwnId(room.sessionId); setError("");
        const read = (state: ArenaState) => {
          if (!state?.players || controller.signal.aborted) return;
          setRoomIndex(state.questionIndex);
          setPlayers(Array.from(state.players, ([key, player]) => [key, {
            ...((player as Player & { toJSON?: () => Player }).toJSON?.() ?? player),
          }]));
        };
        read(room.state);
        room.onStateChange(read);
        room.onMessage("activity-error", (message: string) => { if (!controller.signal.aborted) setError(message); });
        room.onLeave((code) => {
          if (controller.signal.aborted) return;
          connection.current = null;
          setOwnId(""); setPlayers([]); setRoomIndex(-2);
          if (code === 4403) return;
          setError("การเชื่อมต่อขาดหาย กำลังเชื่อมต่อใหม่…");
          reconnect = setTimeout(() => { void connect(); }, 1300);
        });
      } catch (reason) {
        if (controller.signal.aborted) return;
        const code = (reason as { code?: number })?.code;
        if (admitted) void admitted.leave();
        setError(code === 4009 ? "เปิดกิจกรรมในอีกแท็บอยู่ กรุณาปิดแท็บนั้นแล้วลองใหม่"
          : code === 4008 ? "ห้องกิจกรรมเต็มแล้ว"
          : reason instanceof ApiError ? reason.message : "เชื่อมต่อห้องกิจกรรมไม่ได้");
      }
    }
    void connect();
    return () => {
      controller.abort();
      clearTimeout(reconnect);
      connection.current = null;
      if (joined) void joined.leave();
    };
  }, [id, path, retry]);

  useEffect(() => {
    const keys = new Set<string>();
    const directions = ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"];
    const clear = () => { keys.clear(); axis.current = { x: 0, y: 0 }; touch.current = null; setThumb(axis.current); };
    const down = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!(event.target instanceof HTMLElement) || event.target.closest("input,textarea,select,[contenteditable]") || !directions.includes(key)) return;
      event.preventDefault();
      keys.add(key);
    };
    const up = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    const timer = setInterval(() => {
      if (document.hidden) return;
      const room = connection.current;
      if (!room?.connection.isOpen || room.state.questionIndex !== currentQuestion.current) return;
      const dx = axis.current.x + Number(keys.has("d") || keys.has("arrowright")) - Number(keys.has("a") || keys.has("arrowleft"));
      const dy = axis.current.y + Number(keys.has("s") || keys.has("arrowdown")) - Number(keys.has("w") || keys.has("arrowup"));
      if (dx || dy) {
        const divisor = Math.max(1, Math.hypot(dx, dy));
        room.send("step", { questionIndex: currentQuestion.current, dx: dx / divisor, dy: dy / divisor });
      }
    }, 85);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);

  function updateStick(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - box.left - box.width / 2) / (box.width * 0.38);
    const dy = (event.clientY - box.top - box.height / 2) / (box.height * 0.38);
    const length = Math.max(1, Math.hypot(dx, dy));
    axis.current = { x: dx / length, y: dy / length };
    setThumb(axis.current);
  }

  function resetStick(event: PointerEvent<HTMLDivElement>) {
    if (touch.current !== event.pointerId) return;
    touch.current = null;
    axis.current = { x: 0, y: 0 };
    setThumb(axis.current);
  }

  function enter(choice: number) {
    const room = connection.current;
    if (room?.connection.isOpen && room.state.phase === "answering" && room.state.questionIndex === questionIndex) {
      setError("");
      room.send("area", { questionIndex, choice });
    }
  }

  const own = roomIndex === questionIndex && answering ? players.find(([key]) => key === ownId)?.[1] : undefined;
  const currentPick = own ? own.selected < 0 ? null : own.selected : selected;
  return <section className="live-arena-panel" aria-label="ห้องกิจกรรมสองมิติ">
    <div className="live-arena-meta"><span aria-live="polite">{ownId ? `${players.length} คนในห้อง` : "กำลังเข้าห้องกิจกรรม…"}</span><span className="live-keyboard">WASD หรือปุ่มลูกศร</span></div>
    <div className="live-arena">
      {choiceZones(choices.length).map((zone) => <div key={choices[zone.index].id} aria-hidden="true"
        className={`live-zone${correctChoiceId === choices[zone.index].id ? " is-correct" : ""}`}
        style={{ left: `${zone.x}%`, top: `${zone.y / activityHeight * 100}%`, width: `${zone.width}%`, height: `${zone.height / activityHeight * 100}%`, background: choiceColors[zone.index] }}>
        {String.fromCharCode(65 + zone.index)}</div>)}
      {players.map(([key, player]) => <Avatar key={key} player={player} own={key === ownId} />)}
      {ownId && <div className="live-joystick" role="group" aria-label="จอยสติ๊กสำหรับเดิน"
        onPointerDown={(event) => { if (touch.current !== null) return; event.preventDefault(); touch.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); updateStick(event); }}
        onPointerMove={(event) => { if (touch.current === event.pointerId) updateStick(event); }}
        onPointerUp={resetStick} onPointerCancel={resetStick} onLostPointerCapture={resetStick}>
        <i style={{ transform: `translate(${thumb.x * 22}px,${thumb.y * 22}px)` }}/></div>}
    </div>
    {choices.length > 0 && <div className="live-options">{choices.map((choice, index) => <button key={choice.id} type="button"
      disabled={teacher || !answering || !ownId || roomIndex !== questionIndex}
      aria-pressed={currentPick === index} onClick={() => enter(index)} className={correctChoiceId === choice.id ? "is-correct" : ""}
      style={{ "--choice": choiceColors[index] } as CSSProperties}>
      <b>{String.fromCharCode(65 + index)}</b>
      {choice.imageId && <img src={`/api${path}/images/${choice.imageId}`} alt={choice.text ? "" : `ภาพตัวเลือก ${index + 1}`}/>}
      {choice.text && <span>{choice.text}</span>}
      {correctChoiceId === choice.id && <span className="live-correct-label">✓ คำตอบที่ถูก</span>}
    </button>)}</div>}
    {!teacher && answering && <p className="muted" role="status">{currentPick === null ? "เดินหรือเลือกปุ่มเพื่อเข้าพื้นที่คำตอบ" : `อยู่ในพื้นที่ ${String.fromCharCode(65 + currentPick)} · เปลี่ยนได้จนกว่าจะล็อก`}</p>}
    {error && <p className="notice" role="alert">{error}{!ownId && <> <button className="text-button" onClick={() => setRetry((value) => value + 1)}>ลองเชื่อมต่ออีกครั้ง</button></>}</p>}
  </section>;
}
