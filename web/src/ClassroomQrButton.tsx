import { lazy, Suspense, useId, useRef, useState } from "react";

const QrCode = lazy(() => import("qrcode.react").then(({ QRCodeSVG }) => ({ default: QRCodeSVG })));

export function ClassroomQrButton({ classroomId, name }: { classroomId: string; name: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<"copied" | "manual">();
  const url = `${location.origin}/classrooms/${classroomId}/join`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopy("copied");
    } catch {
      setCopy("manual");
    }
  }

  return <>
    <button className="button button-primary" type="button" onClick={() => {
      setCopy(undefined);
      dialog.current?.showModal();
      setOpen(true);
    }}>แสดง QR เข้าห้องเรียน</button>
    <dialog className="classroom-qr-dialog" ref={dialog} aria-labelledby={titleId} onClose={() => setOpen(false)}>
      <h2 id={titleId}>{name}</h2>
      <p className="muted">ใช้กล้องมือถือสแกน QR แล้วเข้าสู่ระบบด้วยบัญชี Google ของโรงเรียน</p>
      <div className="classroom-qr-image">
        {open && <Suspense fallback={<p role="status">กำลังสร้าง QR…</p>}>
          <QrCode value={url} size={440} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000"
            title={`QR เข้าห้องเรียน ${name}`} role="img" />
        </Suspense>}
      </div>
      <div className="classroom-qr-actions">
        <button className="button button-quiet" type="button" onClick={() => void copyLink()}>คัดลอกลิงก์</button>
        <form method="dialog"><button className="button button-primary">ปิด</button></form>
      </div>
      {copy === "copied" && <p role="status">คัดลอกลิงก์แล้ว</p>}
      {copy === "manual" && <label className="classroom-qr-link">ลิงก์เข้าห้องเรียน
        <input readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
      </label>}
    </dialog>
  </>;
}
