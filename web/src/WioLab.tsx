import { useEffect, useRef, useState } from "react";
import { wioLabs, wioSketchMaxBytes, type WioLabId } from "../../src/wio-labs";
import { blankBoard, defaultBoardInput, type BoardButton, type BoardSnapshot } from "./wio-board";
import type { SimulatorRequest, SimulatorResponse } from "./wio-simulator.worker";
import "./wio-lab.css";

function readDraft(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; }
  catch { return fallback; }
}

function rgb565(value: number) {
  return `rgb(${((value >> 11) & 31) * 255 / 31} ${((value >> 5) & 63) * 255 / 63} ${(value & 31) * 255 / 31})`;
}

function Display({ board }: { board: BoardSnapshot }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = rgb565(board.background);
    ctx.fillRect(0, 0, board.width, board.height);
    ctx.textBaseline = "top";
    for (const item of board.draws) {
      ctx.fillStyle = rgb565(item.color);
      if (item.kind === "rect") ctx.fillRect(item.x, item.y, item.width, item.height);
      else {
        ctx.font = `${8 * item.size}px monospace`;
        ctx.fillText(item.char, item.x, item.y, 6 * item.size);
      }
    }
  }, [board]);
  return <canvas ref={canvas} width={board.width} height={board.height} aria-label="จอ LCD จำลอง" />;
}

const switchKeys: Readonly<Partial<Record<string, BoardButton>>> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
};
const switchButtons = [
  ["up", "ขึ้น", "↑"], ["left", "ซ้าย", "←"], ["center", "ตรงกลาง", "●"],
  ["right", "ขวา", "→"], ["down", "ลง", "↓"],
] as const;

type BuzzerAudio = { context: AudioContext; volume: GainNode };

function useBuzzerSound(on: boolean) {
  const audio = useRef<BuzzerAudio | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [failed, setFailed] = useState(false);

  function release() {
    const current = audio.current;
    audio.current = null;
    if (current) {
      current.volume.gain.setValueAtTime(0, current.context.currentTime);
      void current.context.close().catch(() => {});
    }
  }

  useEffect(() => release, []);
  useEffect(() => {
    function syncSound() {
      const current = audio.current;
      if (current) current.volume.gain.setValueAtTime(on && enabled && !document.hidden ? 0.05 : 0, current.context.currentTime);
    }
    syncSound();
    document.addEventListener("visibilitychange", syncSound);
    return () => document.removeEventListener("visibilitychange", syncSound);
  }, [enabled, on]);

  async function toggle() {
    if (audio.current) {
      release();
      setEnabled(false);
      return;
    }

    setFailed(false);
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      const volume = context.createGain();
      const oscillator = context.createOscillator();
      volume.gain.value = 0;
      oscillator.frequency.value = 440;
      oscillator.connect(volume);
      volume.connect(context.destination);
      oscillator.start();
      audio.current = { context, volume };
      setEnabled(true);
      await context.resume();
    } catch {
      if (context && context.state === "closed") return;
      if (audio.current?.context === context) release();
      else if (context) void context.close().catch(() => {});
      if (!audio.current) {
        setEnabled(false);
        setFailed(true);
      }
    }
  }

  return { enabled, failed, toggle };
}

export default function WioLab({ lab, draftKey, disabled, submit }: {
  lab: WioLabId; draftKey: string; disabled: boolean; submit: (source: string) => Promise<void>;
}) {
  const preset = wioLabs[lab];
  const [source, setSource] = useState(() => readDraft(draftKey, preset.starter));
  const [draftSaved, setDraftSaved] = useState(true);
  const [board, setBoard] = useState(blankBoard);
  const [mode, setMode] = useState<"idle" | "run" | "check">("idle");
  const buzzerOn = mode === "run" && board.buzzer;
  const sound = useBuzzerSound(buzzerOn);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [sending, setSending] = useState(false);
  const [light, setLight] = useState(defaultBoardInput.light);
  const [pressed, setPressed] = useState(defaultBoardInput.buttons);
  const input = useRef(defaultBoardInput);
  const tapped = useRef<typeof defaultBoardInput.buttons>({});
  const dispose = useRef<(() => void) | undefined>(undefined);
  const sourceBytes = new TextEncoder().encode(source).length;
  const validSize = source.trim().length > 0 && sourceBytes <= wioSketchMaxBytes;

  useEffect(() => {
    try { localStorage.setItem(draftKey, source); setDraftSaved(true); }
    catch { setDraftSaved(false); }
  }, [draftKey, source]);

  useEffect(() => {
    function release() {
      input.current = { ...input.current, buttons: {} };
      tapped.current = {};
      setPressed({});
    }
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
      dispose.current?.();
    };
  }, []);

  function stop() {
    dispose.current?.();
    dispose.current = undefined;
    tapped.current = {};
    setMode("idle");
  }

  function run(nextMode: "run" | "check") {
    if (!validSize) return;
    stop();
    setNotice(undefined);
    if (nextMode === "run") setBoard(blankBoard);
    let worker: Worker;
    try { worker = new Worker(new URL("./wio-simulator.worker.ts", import.meta.url), { type: "module" }); }
    catch { setNotice({ text: "เปิดตัวจำลองไม่ได้ในเบราว์เซอร์นี้", error: true }); return; }
    let timer: number;
    let watchdog: number;
    const fail = (text: string) => { stop(); setNotice({ text, error: true }); };
    const send = (message: SimulatorRequest) => {
      watchdog = window.setTimeout(() => fail("ตัวจำลองทำงานเกินเวลา ลองตรวจสอบคำสั่งในลูป"), 4000);
      worker.postMessage(message);
    };
    const tick = () => {
      if (document.hidden) { timer = window.setTimeout(tick, 100); return; }
      const inputs = { ...input.current, buttons: { ...input.current.buttons, ...tapped.current } };
      tapped.current = {};
      send({ type: "tick", inputs });
    };
    dispose.current = () => {
      window.clearTimeout(timer);
      window.clearTimeout(watchdog);
      worker.terminate();
    };
    worker.onmessage = ({ data }: MessageEvent<SimulatorResponse>) => {
      window.clearTimeout(watchdog);
      if (data.type === "error") fail(data.message);
      else if (data.type === "result") {
        stop();
        setNotice({ text: (data.passed ? "ผ่านการตรวจฝึก · " : "ยังไม่ผ่าน · ") + data.message, error: !data.passed });
      } else {
        if (data.board) setBoard(data.board);
        timer = window.setTimeout(tick, 25);
      }
    };
    worker.onerror = () => fail("เปิดตัวจำลองไม่ได้ ลองโหลดหน้าใหม่");
    setMode(nextMode);
    send(nextMode === "run" ? { type: "start", source, inputs: input.current } : { type: "check", lab, source });
  }

  function updateButton(button: BoardButton, down: boolean) {
    if (!!input.current.buttons[button] === down) return;
    if (down && mode === "run") tapped.current[button] = true;
    const buttons = { ...input.current.buttons, [button]: down };
    input.current = { ...input.current, buttons };
    setPressed(buttons);
  }

  function boardButton(button: BoardButton, label: string, glyph: string) {
    return <button key={button} type="button" aria-label={label} aria-pressed={!!pressed[button]}
      data-key={button} data-pressed={!!pressed[button]}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        updateButton(button, true);
      }}
      onPointerUp={() => updateButton(button, false)}
      onPointerCancel={() => updateButton(button, false)}
      onLostPointerCapture={() => updateButton(button, false)}
      onKeyDown={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        if (!event.repeat) updateButton(button, true);
      }}
      onKeyUp={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        updateButton(button, false);
      }}
      onClick={(event) => { if (event.detail === 0 && mode === "run") tapped.current[button] = true; }}
      onBlur={() => updateButton(button, false)}>{glyph}</button>;
  }

  function changeSource(next: string) {
    if (mode !== "idle") stop();
    setNotice(undefined);
    setSource(next);
  }

  function download() {
    const a = document.createElement("a");
    const url = URL.createObjectURL(new Blob([source], { type: "text/plain;charset=utf-8" }));
    a.href = url;
    a.download = `wio-${lab}.ino`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function sendSketch() {
    if (!validSize || disabled || sending) return;
    setSending(true);
    setNotice(undefined);
    try {
      await submit(source);
      setNotice({ text: "ส่งไฟล์ .ino แล้ว ครูสามารถเปิดดูและให้คะแนนได้" });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "ส่งไฟล์ไม่สำเร็จ", error: true });
    } finally { setSending(false); }
  }

  return <section className="wio-lab" aria-label="ห้องปฏิบัติการ Wio Terminal">
    <header className="wio-lab-header">
      <div><p className="eyebrow">WIO TERMINAL LAB</p><h3>{preset.title}</h3></div>
      <span className="wio-state" data-running={mode === "run"}>{mode === "run" ? "กำลังรัน" : mode === "check" ? "กำลังตรวจ" : "หยุดอยู่"}</span>
    </header>
    <div className="wio-workbench">
      <div className="wio-editor">
        <label htmlFor="wio-sketch">Arduino sketch (.ino)</label>
        <textarea id="wio-sketch" dir="ltr" spellCheck={false} autoCapitalize="off" autoComplete="off"
          maxLength={wioSketchMaxBytes} value={source} onChange={(event) => changeSource(event.target.value)} />
        <small className="muted">{draftSaved ? "เก็บฉบับร่างในเบราว์เซอร์นี้" : "เบราว์เซอร์นี้บันทึกฉบับร่างไม่ได้ กรุณาดาวน์โหลดไฟล์"}</small>
      </div>
      <div className="wio-peripherals">
        <div className="wio-device">
          <div className="wio-device-keys">{(["A", "B", "C"] as const).map((button) => boardButton(button, `ปุ่ม ${button}`, button))}</div>
          <div className="wio-display"><Display board={board} /></div>
          <div className="wio-device-bottom"><b>Wio Terminal</b><span><i className={board.led ? "wio-led on" : "wio-led"} />LED {board.led ? "ON" : "OFF"}</span></div>
          <div className="wio-device-controls">
            <div className="wio-switch" role="group" aria-label="สวิตช์ห้าทิศทาง"
              onKeyDown={(event) => {
                const button = switchKeys[event.key];
                if (!button) return;
                event.preventDefault();
                if (!event.repeat) updateButton(button, true);
              }}
              onKeyUp={(event) => {
                const button = switchKeys[event.key];
                if (!button) return;
                event.preventDefault();
                updateButton(button, false);
              }}
              onBlur={(event) => {
                if (event.currentTarget.contains(event.relatedTarget)) return;
                for (const [button] of switchButtons) updateButton(button, false);
              }}>
              {switchButtons.map(([button, label, glyph]) => boardButton(button, `สวิตช์ ${label}`, glyph))}
            </div>
            <div className="wio-buzzer">
              <span data-active={buzzerOn}>บัซเซอร์ {buzzerOn ? "ดัง" : "เงียบ"}</span>
              <button type="button" className="button button-quiet" aria-pressed={sound.enabled}
                onClick={() => void sound.toggle()}>{sound.enabled ? "ปิดเสียง" : "เปิดเสียง"}</button>
              {sound.failed && <small role="status">เบราว์เซอร์เปิดเสียงไม่ได้</small>}
            </div>
          </div>
        </div>
        <label className="wio-light">แสง (WIO_LIGHT) <output>{light}</output>
          <input type="range" min={0} max={1023} value={light} onChange={(event) => {
            const next = Number(event.target.value);
            input.current = { ...input.current, light: next };
            setLight(next);
          }} />
        </label>
        <details className="wio-serial"><summary>Serial Monitor</summary><pre aria-label="ข้อความ Serial">{board.serial || "ยังไม่มีข้อความ"}</pre></details>
      </div>
    </div>
    <div className="wio-actions">
      <button type="button" className="button button-primary" onClick={() => run("run")} disabled={!validSize || mode !== "idle"}>รันโค้ด</button>
      <button type="button" className="button button-quiet" disabled={mode === "idle"} onClick={stop}>หยุด</button>
      <button type="button" className="button button-quiet" disabled={!validSize || mode === "check"} onClick={() => run("check")}>ตรวจฝึก</button>
      <button type="button" className="button button-quiet" onClick={() => {
        if (source !== preset.starter && !window.confirm("คืนโค้ดเริ่มต้นหรือไม่? ฉบับร่างในเบราว์เซอร์จะถูกแทนที่")) return;
        changeSource(preset.starter); setBoard(blankBoard);
      }}>คืนโค้ดเริ่มต้น</button>
      <button type="button" className="button button-quiet" disabled={!validSize} onClick={download}>ดาวน์โหลด .ino</button>
      <button type="button" className="button button-primary" disabled={!validSize || disabled || sending} onClick={() => void sendSketch()}>{sending ? "กำลังส่ง…" : "ส่งไฟล์ .ino ให้ครู"}</button>
    </div>
    {sourceBytes > wioSketchMaxBytes && <p role="alert" className="wio-notice" data-error>โค้ดต้องมีขนาดไม่เกิน 16 KiB</p>}
    {notice && <p role={notice.error ? "alert" : "status"} className="wio-notice" data-error={notice.error}>{notice.text}</p>}
    <details className="wio-help">
      <summary>คำสั่งที่รองรับและการส่งงาน</summary>
      <p>ตัวจำลองฝึกพื้นฐาน Arduino ใช้ <code>setup()</code>, <code>loop()</code>, ตัวแปร <code>int</code> / <code>bool</code>, <code>if</code> / <code>else</code>, <code>while</code>, <code>delay()</code>, GPIO, Serial และคำสั่ง LCD พื้นฐานของ <code>TFT_eSPI</code></p>
      <p>เมื่อโฟกัสสวิตช์ห้าทิศทาง ใช้ปุ่มลูกศรเพื่อเปลี่ยนทิศ และใช้ Enter หรือ Space กดปุ่มที่เลือกอยู่ เปิดเสียงบัซเซอร์ได้จากแผงควบคุม</p>
      <p>การตรวจฝึกไม่คิดคะแนน กดส่งได้แม้ยังตรวจไม่ผ่าน ทุกครั้งที่ส่งจะเก็บเป็นไฟล์ใหม่ ดาวน์โหลดไปลองคอมไพล์และทดสอบกับบอร์ดจริงได้</p>
    </details>
  </section>;
}
