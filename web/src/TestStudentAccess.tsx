import { useEffect, useState } from "react";
import { api } from "./api";

export function TestStudentLogin({ signedIn }: { signedIn: boolean }) {
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const validToken = /^[A-Za-z0-9_-]{43}$/.test(token);

  useEffect(() => {
    // Keep the bearer link out of browser history once this page has loaded it.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ path: string }>("/auth/test-student/redeem", {
        method: "POST", body: JSON.stringify({ token }),
      });
      setToken("");
      window.location.replace(result.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "เข้าสู่ระบบทดสอบไม่สำเร็จ");
      setBusy(false);
    }
  }

  return <main className="login-page"><section className="login-card">
    <div className="brand-mark large">ค</div>
    <h1>เข้าเป็นนักเรียนทดสอบ</h1>
    {signedIn ? <p role="alert">มีบัญชีเข้าสู่ระบบอยู่ กรุณาเปิดลิงก์เดิมในหน้าต่างไม่ระบุตัวตน</p>
      : validToken ? <><p className="muted">ลิงก์นี้ใช้ได้ครั้งเดียวสำหรับห้องเรียนทดสอบ</p>
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void signIn()}>
          {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ห้องเรียนทดสอบ"}
        </button></>
      : <p role="alert">ลิงก์ไม่สมบูรณ์ ให้ผู้ดูแลสร้างลิงก์ใหม่</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <a href="/" className="text-button">กลับหน้าห้องเรียน</a>
  </section></main>;
}

export function TestStudentAccess({ classroomId, studentId, name, onError }: {
  classroomId: string; studentId: string; name: string; onError: (message: string) => void;
}) {
  const [link, setLink] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `/classrooms/${classroomId}/testers/${studentId}`;

  async function issue() {
    setBusy(true);
    setLink("");
    setNotice("");
    try {
      const result = await api<{ path: string }>(path + "/link", { method: "POST" });
      const url = new URL(result.path, window.location.origin).href;
      setLink(url);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "สร้างลิงก์ทดสอบไม่สำเร็จ");
    } finally { setBusy(false); }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setNotice("คัดลอกแล้ว เปิดในหน้าต่างไม่ระบุตัวตน");
    } catch {
      setNotice("เลือกข้อความจากช่องลิงก์แล้วคัดลอก");
    }
  }

  async function revoke() {
    setBusy(true);
    setNotice("");
    try {
      await api(path + "/access", { method: "DELETE" });
      setLink("");
      setNotice("ยกเลิกลิงก์และการเข้าสู่ระบบแล้ว");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "ยกเลิกสิทธิ์ทดสอบไม่สำเร็จ");
    } finally { setBusy(false); }
  }

  return <div className="form-stack tester-access">
    <div>
      <button className="text-button" type="button" disabled={busy} onClick={() => void issue()}>สร้างลิงก์เข้าสู่ระบบทดสอบ</button>{" "}
      <button className="text-button subdued" type="button" disabled={busy} onClick={() => void revoke()}>ยกเลิกสิทธิ์ทดสอบ</button>
    </div>
    {link && <div>
      <label>ลิงก์ใช้ครั้งเดียว · หมดอายุใน 10 นาที
        <input className="table-input" readOnly value={link} aria-label={`ลิงก์ทดสอบ ${name}`} onFocus={(event) => event.currentTarget.select()}/>
      </label>
      <button className="text-button" type="button" onClick={() => void copy()}>คัดลอกลิงก์</button>
    </div>}
    {notice && <small role="status">{notice}</small>}
  </div>;
}
