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
    for (const { x, y, size, color, char } of board.text) {
      ctx.font = `${8 * size}px monospace`;
      ctx.fillStyle = rgb565(color);
      ctx.fillText(char, x, y, 6 * size);
    }
  }, [board]);
  return <canvas ref={canvas} width={board.width} height={board.height} aria-label="จอ LCD จำลอง" />;
}

export default function WioLab({ lab, draftKey, disabled, submit }: {
  lab: WioLabId; draftKey: string; disabled: boolean; submit: (source: string) => Promise<void>;
}) {
  const preset = wioLabs[lab];
  const [source, setSource] = useState(() => readDraft(draftKey, preset.starter));
  const [draftSaved, setDraftSaved] = useState(true);
  const [board, setBoard] = useState(blankBoard);
  const [mode, setMode] = useState<"idle" | "run" | "check">("idle");
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
    if (down && mode === "run") tapped.current[button] = true;
    const buttons = { ...input.current.buttons, [button]: down };
    input.current = { ...input.current, buttons };
    setPressed(buttons);
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
          <div className="wio-device-keys">{(["A", "B", "C"] as const).map((button) =>
            <button key={button} type="button" aria-label={`ปุ่ม ${button}`} aria-pressed={!!pressed[button]} data-pressed={!!pressed[button]}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                updateButton(button, true);
              }}
              onPointerUp={() => updateButton(button, false)}
              onPointerCancel={() => updateButton(button, false)}
              onLostPointerCapture={() => updateButton(button, false)}
              onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") updateButton(button, true); }}
              onKeyUp={(event) => { if (event.key === " " || event.key === "Enter") updateButton(button, false); }}
              onBlur={() => updateButton(button, false)}>{button}</button>)}</div>
          <div className="wio-display"><Display board={board} /></div>
          <div className="wio-device-bottom"><b>Wio Terminal</b><span><i className={board.led ? "wio-led on" : "wio-led"} />LED {board.led ? "ON" : "OFF"}</span></div>
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
      <p>การตรวจฝึกไม่คิดคะแนน กดส่งได้แม้ยังตรวจไม่ผ่าน ทุกครั้งที่ส่งจะเก็บเป็นไฟล์ใหม่ ดาวน์โหลดไปลองคอมไพล์และทดสอบกับบอร์ดจริงได้</p>
    </details>
  </section>;
}
