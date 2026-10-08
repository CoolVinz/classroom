import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import type { StudentUser } from "./StudentPortal";

const passwordMinimum = 12;

export function StudentInvitePage() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
  const [needsPassword, setNeedsPassword] = useState<boolean | null>(null);
  const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { window.history.replaceState(null, "", "/student/activate"); api<{ needsPassword: boolean }>("/auth/student/invite/status", { method: "POST", body: JSON.stringify({ token }) }).then((result) => setNeedsPassword(result.needsPassword)).catch((reason) => setError(reason instanceof Error ? reason.message : "ลิงก์เชิญใช้ไม่ได้")); }, [token]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (needsPassword && password !== confirm) { setError("รหัสผ่านไม่ตรงกัน"); return; }
    setBusy(true);
    try { await api("/auth/student/invite/accept", { method: "POST", body: JSON.stringify({ token, ...(needsPassword ? { password } : {}) }) }); window.location.replace("/"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "เปิดบัญชีไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  return <AccessCard title="เข้าร่วมชั้นเรียน" detail={needsPassword ? "ตั้งรหัสผ่านสำหรับบัญชีนักเรียนของคุณ" : "ยืนยันคำเชิญเพื่อเพิ่มชั้นเรียนในบัญชีของคุณ"} error={error}>
    {needsPassword === null && !error ? <p className="muted">กำลังตรวจสอบลิงก์…</p> : needsPassword !== null && <form className="form-stack login-form" onSubmit={submit}>{needsPassword && <><label>รหัสผ่านใหม่<input type="password" autoComplete="new-password" minLength={passwordMinimum} maxLength={200} value={password} onChange={(event) => setPassword(event.target.value)} required/></label><label>ยืนยันรหัสผ่าน<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required/></label></> }<button className="button button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "เข้าร่วมชั้นเรียน"}</button></form>}
    <a className="text-button" href="/">กลับไปเข้าสู่ระบบ</a>
  </AccessCard>;
}

export function StudentForgotPage() {
  const [email, setEmail] = useState(""); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try { const result = await api<{ message: string }>("/auth/student/password-reset/request", { method: "POST", body: JSON.stringify({ email }) }); setMessage(result.message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "ส่งคำขอไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  return <AccessCard title="ตั้งรหัสผ่านใหม่" detail="กรอกอีเมลของบัญชีนักเรียน" error={error}><form className="form-stack login-form" onSubmit={submit}><label>อีเมล<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required/></label><button className="button button-primary" disabled={busy}>{busy ? "กำลังส่ง…" : "ส่งลิงก์ตั้งรหัสผ่าน"}</button>{message && <p className="success-message" role="status">{message}</p>}</form><a className="text-button" href="/">กลับไปเข้าสู่ระบบ</a></AccessCard>;
}

export function StudentResetPage() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
  const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  useEffect(() => { window.history.replaceState(null, "", "/student/reset"); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (password !== confirm) { setError("รหัสผ่านไม่ตรงกัน"); return; }
    setBusy(true);
    try { await api("/auth/student/password-reset/confirm", { method: "POST", body: JSON.stringify({ token, password }) }); setDone(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "ตั้งรหัสผ่านไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  return <AccessCard title="ตั้งรหัสผ่านใหม่" detail="เลือกรหัสผ่านอย่างน้อย 12 ตัวอักษร" error={error}>{done ? <><p className="success-message" role="status">ตั้งรหัสผ่านแล้ว</p><a className="button button-primary" href="/">เข้าสู่ระบบ</a></> : <form className="form-stack login-form" onSubmit={submit}><label>รหัสผ่านใหม่<input type="password" autoComplete="new-password" minLength={passwordMinimum} maxLength={200} value={password} onChange={(event) => setPassword(event.target.value)} required/></label><label>ยืนยันรหัสผ่าน<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required/></label><button className="button button-primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึกรหัสผ่าน"}</button></form>}</AccessCard>;
}

function AccessCard({ title, detail, error, children }: { title: string; detail: string; error: string; children: ReactNode }) {
  return <main className="login-page"><section className="login-card"><div className="brand-mark large">ค</div><p className="eyebrow">พื้นที่นักเรียน</p><h1>{title}</h1><p className="muted">{detail}</p>{error && <p className="form-error" role="alert">{error}</p>}{children}</section></main>;
}
