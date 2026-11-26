import { lazy, Suspense, useId, useState } from "react";
import { wioLabIds, wioLabs, type WioLabId } from "../../src/wio-labs";

const WioLab = lazy(() => import("./WioLab"));

export function WioDemo({ draftScope, preset }: { draftScope: string; preset?: WioLabId }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<WioLabId>("blink");
  const lab = preset ?? choice;
  const draftKey = `classroom:wio-demo:${draftScope}:${lab}`;
  return <section className="wio-demo">
    <button className="button button-quiet" type="button" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(!open)}>{open ? "ปิดตัวจำลองตัวอย่าง" : "ทดลองตัวจำลอง"}</button>
    <div id={id} hidden={!open}>{open && <>
      {!preset && <label>แบบฝึกสำหรับสาธิต<select value={choice} onChange={(event) => setChoice(event.target.value as WioLabId)}>
        {wioLabIds.map((value) => <option key={value} value={value}>{wioLabs[value].title}</option>)}
      </select></label>}
      <Suspense fallback={<p className="inline-loading">กำลังเปิด Wio Terminal…</p>}>
        <WioLab key={draftKey} lab={lab} draftKey={draftKey} />
      </Suspense>
    </>}</div>
  </section>;
}
