import { wioLabIds, wioLabs, wioMaxScore, type WioLabId, type WioLabSettings } from "../../src/wio-labs";

export function defaultWioLabSettings(preset: WioLabId): WioLabSettings {
  return { preset, title: wioLabs[preset].title, instructions: wioLabs[preset].instructions, maxScore: 100 };
}

export function WioLabSettingsFields({ lab, change }: { lab: WioLabSettings; change: (lab: WioLabSettings) => void }) {
  return <>
    <label>แบบฝึก Wio Terminal<select value={lab.preset} onChange={(event) => {
      const next = defaultWioLabSettings(event.target.value as WioLabId);
      change({
        preset: next.preset, maxScore: lab.maxScore,
        title: lab.title === wioLabs[lab.preset].title ? next.title : lab.title,
        instructions: lab.instructions === wioLabs[lab.preset].instructions ? next.instructions : lab.instructions,
      });
    }}>{wioLabIds.map((id) => <option key={id} value={id}>{wioLabs[id].title}</option>)}</select></label>
    <label>ชื่องาน Wio Terminal<input required maxLength={120} value={lab.title} onChange={(event) => change({ ...lab, title: event.target.value })} /></label>
    <label>คำชี้แจงงาน Wio Terminal<textarea rows={3} maxLength={5000} value={lab.instructions} onChange={(event) => change({ ...lab, instructions: event.target.value })} /></label>
    <label>คะแนนเต็มงาน Wio Terminal<input required type="number" step="0.01" min="0.01" max={wioMaxScore} value={lab.maxScore || ""} onChange={(event) => change({ ...lab, maxScore: Number(event.target.value) })} /></label>
  </>;
}
