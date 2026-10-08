import type * as React from "react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type User = { id: string; username: string; displayName: string; role: "owner" | "teacher" };
type Classroom = { id: string; name: string; studentCount: number };
type Status = "present" | "absent" | "late" | "excused";
type Student = { id: string; studentCode: string | null; displayName: string; archived?: boolean; status?: Status | null };
type View = "home" | "classes" | "summary" | "teachers";
const statuses: Status[] = ["present", "absent", "late", "excused"];
const labels: Record<Status, string> = { present: "มาเรียน", absent: "ขาด", late: "สาย", excused: "ลา" };
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
const showDate = (date: string) => new Intl.DateTimeFormat("th-TH", { dateStyle: "long", timeZone: "Asia/Bangkok" }).format(new Date(date + "T12:00:00+07:00"));

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options, credentials: "same-origin",
    headers: Object.assign({}, options.body ? { "Content-Type": "application/json" } : {}, options.headers ?? {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง");
  return result as T;
}

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "quiet" | "danger" }) {
  const { tone = "primary", className = "", ...rest } = props;
  return <button className={"button button-" + tone + " " + className} {...rest} />;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { const result = await api<{ user: User }>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }); onLogin(result.user); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "เข้าสู่ระบบไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  return <main className="login-page"><section className="login-card"><div className="brand-mark large">ค</div><p className="eyebrow">จัดการชั้นเรียน</p><h1>ยินดีต้อนรับกลับ</h1><p className="muted">เข้าสู่ระบบเพื่อดูห้องเรียนของคุณ</p>
    <form className="form-stack login-form" onSubmit={submit}><label>ชื่อผู้ใช้<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label><label>รหัสผ่าน<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<Button disabled={busy}>{busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}</Button></form><p className="login-footer">พื้นที่ทำงานสำหรับคุณครูและผู้ดูแล</p>
  </section></main>;
}

function App() {
  const [user, setUser] = useState<User | null>(null); const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("home"); const [selected, setSelected] = useState<Classroom | null>(null);
  const [rooms, setRooms] = useState<Classroom[]>([]); const [stats, setStats] = useState<Record<string, number | string> | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!user) return;
    try { const [nextRooms, nextStats] = await Promise.all([api<Classroom[]>("/classrooms"), api<Record<string, number | string>>("/overview")]); setRooms(nextRooms); setStats(nextStats); if (selected) setSelected(nextRooms.find((room) => room.id === selected.id) ?? null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "โหลดข้อมูลไม่สำเร็จ"); }
  }, [user, selected?.id]);
  useEffect(() => { api<{ user: User | null }>("/auth/me").then((result) => setUser(result.user)).catch(() => {}).finally(() => setReady(true)); }, []);
  useEffect(() => { if (user) void refresh(); }, [user, refresh]);
  async function createRoom(name: string) {
    setBusy(true); setError("");
    try { const room = await api<Classroom>("/classrooms", { method: "POST", body: JSON.stringify({ name }) }); setView("classes"); setSelected(room); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "สร้างห้องเรียนไม่สำเร็จ"); throw reason; }
    finally { setBusy(false); }
  }
  async function logout() { try { await api("/auth/logout", { method: "POST" }); } catch { /* Clear the local view even when the network is unavailable. */ } setUser(null); setSelected(null); setView("home"); }
  if (!ready) return <div className="loading"><span className="spinner" />กำลังเปิดห้องเรียนของคุณ…</div>;
  if (!user) return <Login onLogin={setUser} />;
  const pageNames: Record<View, string> = { home: "ภาพรวม", classes: "ห้องเรียน", summary: "สรุปการเข้าเรียน", teachers: "จัดการบัญชีครู" };
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">ค</div><div><strong>ห้องเรียน</strong><span>พื้นที่ของคุณครู</span></div></div><p className="side-caption">เมนู</p>
    <nav className="side-nav" aria-label="เมนูหลัก"><button className={view === "home" && !selected ? "active" : ""} onClick={() => { setView("home"); setSelected(null); }}><span>⌂</span>ภาพรวม</button><button className={view === "classes" ? "active" : ""} onClick={() => { setView("classes"); setSelected(null); }}><span>▦</span>ห้องเรียน</button><button className={view === "summary" ? "active" : ""} onClick={() => { setView("summary"); setSelected(null); }}><span>▤</span>สรุปการเข้าเรียน</button>{user.role === "owner" && <button className={view === "teachers" ? "active" : ""} onClick={() => { setView("teachers"); setSelected(null); }}><span>♙</span>จัดการบัญชีครู</button>}</nav>
    <div className="sidebar-bottom"><div className="profile"><div className="avatar">{user.displayName.slice(0, 1)}</div><div className="profile-copy"><strong>{user.displayName}</strong><span>{user.role === "owner" ? "ผู้ดูแล" : "คุณครู"}</span></div><button className="icon-button" onClick={logout} aria-label="ออกจากระบบ" title="ออกจากระบบ">↗</button></div></div>
  </aside><main className="main-area"><header className="topbar"><div className="breadcrumb">ห้องเรียน <span>/</span> {selected?.name ?? pageNames[view]}</div><div className="date-pill"><i />{showDate(today)}</div></header><div className="page-content">{error && <div className="notice" role="alert">{error}<button onClick={() => setError("")} aria-label="ปิด">×</button></div>}
    {selected ? <ClassDetail room={selected} refresh={refresh} back={() => setSelected(null)} onError={setError} /> : view === "home" ? <Dashboard user={user} rooms={rooms} stats={stats} create={createRoom} open={setSelected} browse={() => setView("classes")} busy={busy} /> : null}
    {!selected && view === "classes" && <ClassList rooms={rooms} create={createRoom} open={setSelected} busy={busy} onError={setError} />}{!selected && view === "summary" && <SummaryPage rooms={rooms} onError={setError} />}{!selected && view === "teachers" && user.role === "owner" && <TeacherAdmin onError={setError} />}
  </div></main></div>;
}

function PageHeading({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{detail && <p className="muted page-description">{detail}</p>}</div>{action}</div>;
}
function Empty({ icon, title, detail, action }: { icon: string; title: string; detail: string; action?: React.ReactNode }) {
  return <div className="empty"><span>{icon}</span><h3>{title}</h3><p>{detail}</p>{action}</div>;
}
function Stat({ title, value, note, icon, tone }: { title: string; value: number | string; note: string; icon: string; tone: string }) {
  return <article className="stat"><span className={"stat-icon " + tone}>{icon}</span><p>{title}</p><strong>{value}</strong><small>{note}</small></article>;
}
function RoomCard({ room, index, open }: { room: Classroom; index: number; open: (room: Classroom) => void }) {
  return <button className={"room-card room-tone-" + (index % 3)} onClick={() => open(room)}><span className="room-letter">{["ก", "ข", "ค"][index % 3]}</span><span><strong>{room.name}</strong><small>{room.studentCount} นักเรียน</small></span><b>↗</b></button>;
}
function NewRoomModal({ close, create, busy, onError }: { close: () => void; create: (name: string) => Promise<void>; busy: boolean; onError: (message: string) => void }) {
  const [name, setName] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); try { await create(name); close(); } catch (reason) { onError(reason instanceof Error ? reason.message : "สร้างห้องเรียนไม่สำเร็จ"); } }
  return <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal" role="dialog" aria-modal="true" aria-label="สร้างห้องเรียน"><header><h2>สร้างห้องเรียน</h2><button className="icon-button" onClick={close} aria-label="ปิด">×</button></header><form className="form-stack" onSubmit={submit}><label>ชื่อห้องเรียน<input autoFocus placeholder="เช่น ป.4/1" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} required /></label><div className="modal-actions"><Button type="button" tone="quiet" onClick={close}>ยกเลิก</Button><Button disabled={busy || !name.trim()}>บันทึกห้องเรียน</Button></div></form></section></div>;
}
function Dashboard({ user, rooms, stats, create, open, browse, busy }: { user: User; rooms: Classroom[]; stats: Record<string, number | string> | null; create: (name: string) => Promise<void>; open: (room: Classroom) => void; browse: () => void; busy: boolean }) {
  const [showNew, setShowNew] = useState(false); const [error, setError] = useState("");
  return <><PageHeading eyebrow={showDate(today)} title={"สวัสดี " + user.displayName} detail="ดูภาพรวมและบันทึกการเข้าเรียนของวันนี้" action={<Button onClick={() => setShowNew(true)}>＋ สร้างห้องเรียน</Button>} />{error && <div className="notice">{error}</div>}
    <div className="stats-grid"><Stat title="ห้องเรียน" value={stats?.classrooms ?? "—"} note="ห้องที่กำลังดูแล" icon="▦" tone="teal"/><Stat title="นักเรียน" value={stats?.students ?? "—"} note="ในห้องเรียนของคุณ" icon="♙" tone="blue"/><Stat title="มาเรียนวันนี้" value={stats?.present ?? "—"} note="บันทึกแล้ว" icon="✓" tone="green"/><Stat title="ขาดวันนี้" value={stats?.absent ?? "—"} note="บันทึกแล้ว" icon="–" tone="amber"/></div>
    <section className="section"><div className="section-heading"><div><p className="eyebrow">พื้นที่ดูแลของคุณ</p><h2>ห้องเรียนของฉัน</h2></div><button className="text-button" onClick={browse}>ดูทั้งหมด ›</button></div>{rooms.length ? <div className="room-grid">{rooms.slice(0, 3).map((room, index) => <RoomCard key={room.id} room={room} index={index} open={open}/>)}</div> : <Empty icon="▦" title="เริ่มต้นด้วยห้องเรียนแรก" detail="สร้างห้องเรียน แล้วเพิ่มรายชื่อนักเรียนเพื่อเริ่มบันทึกการเข้าเรียน" action={<Button onClick={() => setShowNew(true)}>＋ สร้างห้องเรียน</Button>}/>}</section>
    <section className="today-hint"><span>◷</span><div><strong>บันทึกการเข้าเรียนประจำวัน</strong><p>เปิดห้องเรียนเพื่อบันทึก มาเรียน ขาด สาย หรือลา สำหรับวันนี้</p></div><button className="text-button" onClick={() => rooms[0] && open(rooms[0])} disabled={!rooms.length}>เปิดห้องเรียน ›</button></section>{showNew && <NewRoomModal close={() => setShowNew(false)} create={create} busy={busy} onError={setError}/>}
  </>;
}

function ClassList({ rooms, create, open, busy, onError }: { rooms: Classroom[]; create: (name: string) => Promise<void>; open: (room: Classroom) => void; busy: boolean; onError: (message: string) => void }) {
  const [showNew, setShowNew] = useState(false);
  return <><PageHeading eyebrow="พื้นที่ดูแลของคุณ" title="ห้องเรียน" detail="จัดการรายชื่อและบันทึกการเข้าเรียนในแต่ละห้อง" action={<Button onClick={() => setShowNew(true)}>＋ สร้างห้องเรียน</Button>}/>{rooms.length ? <div className="room-grid room-grid-all">{rooms.map((room, index) => <RoomCard key={room.id} room={room} index={index} open={open}/>)}</div> : <Empty icon="▦" title="ยังไม่มีห้องเรียน" detail="สร้างห้องเรียนแรกของคุณเพื่อเริ่มต้นเพิ่มรายชื่อนักเรียน" action={<Button onClick={() => setShowNew(true)}>＋ สร้างห้องเรียน</Button>}/ >}{showNew && <NewRoomModal close={() => setShowNew(false)} create={create} busy={busy} onError={onError}/>}</>;
}

function ClassDetail({ room, refresh, back, onError }: { room: Classroom; refresh: () => Promise<void>; back: () => void; onError: (message: string) => void }) {
  const [tab, setTab] = useState<"attendance" | "students" | "summary">("attendance"); const [name, setName] = useState(room.name); const [editing, setEditing] = useState(false);
  async function archive() { if (!window.confirm("เก็บห้องเรียนนี้เข้าคลังหรือไม่? ประวัติและรายชื่อจะยังอยู่")) return; try { await api("/classrooms/" + room.id, { method: "PATCH", body: JSON.stringify({ archived: true }) }); await refresh(); back(); } catch (reason) { onError(reason instanceof Error ? reason.message : "เก็บห้องเรียนไม่สำเร็จ"); } }
  async function rename(event: FormEvent) { event.preventDefault(); try { await api("/classrooms/" + room.id, { method: "PATCH", body: JSON.stringify({ name }) }); setEditing(false); await refresh(); } catch (reason) { onError(reason instanceof Error ? reason.message : "เปลี่ยนชื่อไม่สำเร็จ"); } }
  return <><button className="back-link" onClick={back}>‹ ห้องเรียนทั้งหมด</button><div className="room-detail-heading"><div className="room-emblem">{room.name.slice(0, 1)}</div><div className="room-detail-copy"><p className="eyebrow">พื้นที่ดูแลของคุณ</p>{editing ? <form className="rename-form" onSubmit={rename}><input value={name} onChange={(e) => setName(e.target.value)} autoFocus/><Button>บันทึก</Button><Button tone="quiet" type="button" onClick={() => setEditing(false)}>ยกเลิก</Button></form> : <><h1>{room.name}</h1><p className="muted">{room.studentCount} นักเรียน</p></>}</div><div className="room-detail-actions"><button className="text-button" onClick={() => setEditing(true)}>เปลี่ยนชื่อ</button><Button tone="quiet" onClick={archive}>เก็บห้องเรียน</Button></div></div>
    <div className="tabs" role="tablist"><button className={tab === "attendance" ? "selected" : ""} onClick={() => setTab("attendance")}>บันทึกการเข้าเรียน</button><button className={tab === "students" ? "selected" : ""} onClick={() => setTab("students")}>รายชื่อนักเรียน</button><button className={tab === "summary" ? "selected" : ""} onClick={() => setTab("summary")}>สรุปผล</button></div>{tab === "attendance" && <Attendance room={room} onError={onError}/ >}{tab === "students" && <Roster room={room} refresh={refresh} onError={onError}/ >}{tab === "summary" && <RoomSummary room={room} onError={onError}/>}</>;
}

function Attendance({ room, onError }: { room: Classroom; onError: (message: string) => void }) {
  const [date, setDate] = useState(today); const [students, setStudents] = useState<Student[]>([]); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
  const load = useCallback(async () => { setLoading(true); try { const result = await api<{ students: Student[] }>("/classrooms/" + room.id + "/attendance?date=" + date); setStudents(result.students); setSaved(false); } catch (reason) { onError(reason instanceof Error ? reason.message : "โหลดรายชื่อไม่สำเร็จ"); } finally { setLoading(false); } }, [room.id, date, onError]);
  useEffect(() => { void load(); }, [load]);
  const counts = useMemo(() => { const result: Record<Status, number> = { present: 0, absent: 0, late: 0, excused: 0 }; students.forEach((student) => { if (student.status) result[student.status]++; }); return result; }, [students]);
  function mark(studentId: string, status: Status | null) { setSaved(false); setStudents((all) => all.map((s) => s.id === studentId ? { ...s, status } : s)); }
  async function save() { setSaving(true); try { await api("/classrooms/" + room.id + "/attendance", { method: "PUT", body: JSON.stringify({ date, entries: students.map((s) => ({ studentId: s.id, status: s.status ?? null })) }) }); setSaved(true); } catch (reason) { onError(reason instanceof Error ? reason.message : "บันทึกไม่สำเร็จ"); } finally { setSaving(false); } }
  return <section className="panel"><header className="panel-heading"><div><p className="eyebrow">เช็กชื่อรายวัน</p><h2>บันทึกการเข้าเรียน</h2><p className="muted">เลือกสถานะของแต่ละคน แล้วกดบันทึก</p></div><div className="attendance-toolbar"><label className="date-control">วันที่<input type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)}/></label><button className="text-button" disabled={loading || !students.length} onClick={() => { setSaved(false); setStudents((all) => all.map((student) => ({ ...student, status: "present" }))); }}>มาเรียนทุกคน</button></div></header><div className="count-chips">{statuses.map((status) => <span key={status} className={"count-chip " + status}><b>{counts[status]}</b>{labels[status]}</span>)}</div>
    {loading ? <p className="inline-loading"><i className="spinner"/>กำลังโหลดรายชื่อ…</p> : students.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>#</th><th>นักเรียน</th><th>รหัส</th><th>สถานะการเข้าเรียน</th></tr></thead><tbody>{students.map((student, index) => <tr key={student.id}><td className="row-number">{String(index + 1).padStart(2, "0")}</td><td><strong>{student.displayName}</strong></td><td className="muted">{student.studentCode || "—"}</td><td><div className="status-buttons">{statuses.map((status) => <button key={status} className={"status-button " + status + (student.status === status ? " chosen" : "")} aria-pressed={student.status === status} onClick={() => mark(student.id, student.status === status ? null : status)}>{labels[status]}</button>)}</div></td></tr>)}</tbody></table></div> : <Empty icon="♙" title="ยังไม่มีรายชื่อนักเรียน" detail="เพิ่มนักเรียนในแท็บรายชื่อก่อนบันทึกการเข้าเรียน"/>}
    <footer className="panel-footer"><span className="muted">{saved ? "บันทึกการเข้าเรียนแล้ว" : "นักเรียนที่ไม่เลือกสถานะจะยังไม่มีบันทึก"}</span><div><Button tone="quiet" disabled={loading || saving} onClick={() => void load()}>โหลดใหม่</Button><Button disabled={loading || saving || !students.length} onClick={() => void save()}>{saving ? "กำลังบันทึก…" : "บันทึกการเข้าเรียน"}</Button></div></footer>
  </section>;
}

function Roster({ room, refresh, onError }: { room: Classroom; refresh: () => Promise<void>; onError: (message: string) => void }) {
  const [students, setStudents] = useState<Student[]>([]); const [name, setName] = useState(""); const [code, setCode] = useState(""); const [saving, setSaving] = useState(false); const [editId, setEditId] = useState(""); const [editName, setEditName] = useState(""); const [editCode, setEditCode] = useState("");
  const load = useCallback(async () => { try { setStudents(await api<Student[]>("/classrooms/" + room.id + "/students")); } catch (reason) { onError(reason instanceof Error ? reason.message : "โหลดรายชื่อไม่สำเร็จ"); } }, [room.id, onError]);
  useEffect(() => { void load(); }, [load]);
  async function add(event: FormEvent) { event.preventDefault(); setSaving(true); try { await api("/classrooms/" + room.id + "/students", { method: "POST", body: JSON.stringify({ displayName: name, studentCode: code }) }); setName(""); setCode(""); await load(); await refresh(); } catch (reason) { onError(reason instanceof Error ? reason.message : "เพิ่มรายชื่อไม่สำเร็จ"); } finally { setSaving(false); } }
  async function update(student: Student, body: Record<string, unknown>) { try { await api("/classrooms/" + room.id + "/students/" + student.id, { method: "PATCH", body: JSON.stringify(body) }); setEditId(""); await load(); await refresh(); } catch (reason) { onError(reason instanceof Error ? reason.message : "บันทึกไม่สำเร็จ"); } }
  return <section className="panel"><header className="panel-heading compact"><div><p className="eyebrow">รายชื่อห้องเรียน</p><h2>นักเรียน <span className="small-count">{students.filter((s) => !s.archived).length} คน</span></h2></div></header><form className="add-student" onSubmit={add}><label>ชื่อนักเรียน<input placeholder="ชื่อและนามสกุล" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120}/></label><label>รหัสนักเรียน <small>(ไม่บังคับ)</small><input placeholder="เช่น 64001" value={code} onChange={(e) => setCode(e.target.value)} maxLength={50}/></label><Button disabled={saving || !name.trim()}>＋ เพิ่มรายชื่อ</Button></form>
    {students.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>นักเรียน</th><th>รหัสนักเรียน</th><th>สถานะ</th><th></th></tr></thead><tbody>{students.map((student) => <tr key={student.id} className={student.archived ? "archived-row" : ""}>{editId === student.id ? <><td><input className="table-input" value={editName} onChange={(e) => setEditName(e.target.value)}/></td><td><input className="table-input" value={editCode} onChange={(e) => setEditCode(e.target.value)}/></td><td>{student.archived ? "เก็บแล้ว" : "กำลังเรียน"}</td><td className="row-actions"><button className="text-button" onClick={() => void update(student, { displayName: editName, studentCode: editCode })}>บันทึก</button><button className="text-button subdued" onClick={() => setEditId("")}>ยกเลิก</button></td></> : <><td><strong>{student.displayName}</strong></td><td>{student.studentCode || "—"}</td><td><span className={"student-state " + (student.archived ? "inactive" : "")}>{student.archived ? "เก็บแล้ว" : "กำลังเรียน"}</span></td><td className="row-actions"><button className="text-button" onClick={() => { setEditId(student.id); setEditName(student.displayName); setEditCode(student.studentCode ?? ""); }}>แก้ไข</button><button className="text-button subdued" onClick={() => void update(student, { archived: !student.archived })}>{student.archived ? "นำกลับมา" : "เก็บรายชื่อ"}</button></td></>}</tr>)}</tbody></table></div> : <Empty icon="♙" title="ยังไม่มีรายชื่อนักเรียน" detail="เพิ่มชื่อและรหัสนักเรียนจากแบบฟอร์มด้านบน"/>}</section>;
}

function SummaryPage({ rooms, onError }: { rooms: Classroom[]; onError: (message: string) => void }) {
  const [roomId, setRoomId] = useState(""); const room = rooms.find((item) => item.id === roomId);
  return <><PageHeading eyebrow="ภาพรวมการมาเรียน" title="สรุปการเข้าเรียน" detail="ดูบันทึกของนักเรียนในช่วงเวลาที่เลือก"/>{rooms.length ? <><label className="room-select">ห้องเรียน<select value={roomId} onChange={(e) => setRoomId(e.target.value)}><option value="">เลือกห้องเรียน</option>{rooms.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{room && <RoomSummary room={room} onError={onError}/>}</> : <Empty icon="▦" title="ยังไม่มีห้องเรียน" detail="สร้างห้องเรียนและเพิ่มรายชื่อนักเรียนก่อนดูสรุป"/>}</>;
}
type SummaryStudent = { studentId: string; studentCode: string | null; displayName: string; present: number; absent: number; late: number; excused: number; archived: boolean };
function RoomSummary({ room, onError }: { room: Classroom; onError: (message: string) => void }) {
  const [from, setFrom] = useState(today); const [to, setTo] = useState(today); const [rows, setRows] = useState<SummaryStudent[]>([]); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); try { const result = await api<{ students: SummaryStudent[] }>("/classrooms/" + room.id + "/summary?from=" + from + "&to=" + to); setRows(result.students); } catch (reason) { onError(reason instanceof Error ? reason.message : "โหลดสรุปไม่สำเร็จ"); } finally { setLoading(false); } }, [room.id, from, to, onError]);
  useEffect(() => { void load(); }, [load]);
  return <section className="panel"><header className="panel-heading"><div><p className="eyebrow">{room.name}</p><h2>สรุปผลการเข้าเรียน</h2><p className="muted">แสดงจำนวนรายการที่บันทึกในช่วงวันที่เลือก</p></div><div className="date-range"><label>ตั้งแต่<input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)}/></label><label>ถึง<input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)}/></label></div></header>{loading ? <p className="inline-loading"><i className="spinner"/>กำลังคำนวณ…</p> : rows.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>นักเรียน</th><th>มาเรียน</th><th>ขาด</th><th>สาย</th><th>ลา</th><th>บันทึกแล้ว</th></tr></thead><tbody>{rows.map((student) => <tr key={student.studentId}><td><strong>{student.displayName}</strong>{student.archived && <small> · เก็บรายชื่อแล้ว</small>}</td><td>{student.present}</td><td>{student.absent}</td><td>{student.late}</td><td>{student.excused}</td><td>{student.present + student.absent + student.late + student.excused}</td></tr>)}</tbody></table></div> : <Empty icon="▤" title="ยังไม่มีข้อมูลในช่วงนี้" detail="เมื่อบันทึกการเข้าเรียนแล้ว สรุปจะแสดงที่นี่"/>}</section>;
}

type Teacher = { id: string; username: string; displayName: string; active: boolean };
function TeacherAdmin({ onError }: { onError: (message: string) => void }) {
  const [teachers, setTeachers] = useState<Teacher[]>([]); const [name, setName] = useState(""); const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setTeachers(await api<Teacher[]>("/teachers")); } catch (reason) { onError(reason instanceof Error ? reason.message : "โหลดบัญชีไม่สำเร็จ"); } }, [onError]); useEffect(() => { void load(); }, [load]);
  async function create(event: FormEvent) { event.preventDefault(); setBusy(true); try { await api("/teachers", { method: "POST", body: JSON.stringify({ displayName: name, username, password }) }); setName(""); setUsername(""); setPassword(""); await load(); } catch (reason) { onError(reason instanceof Error ? reason.message : "สร้างบัญชีไม่สำเร็จ"); } finally { setBusy(false); } }
  async function active(teacher: Teacher) { try { await api("/teachers/" + teacher.id, { method: "PATCH", body: JSON.stringify({ active: !teacher.active }) }); await load(); } catch (reason) { onError(reason instanceof Error ? reason.message : "เปลี่ยนสถานะไม่สำเร็จ"); } }
  async function reset(teacher: Teacher) { const next = window.prompt("ตั้งรหัสผ่านใหม่ให้ " + teacher.displayName + " (อย่างน้อย 12 ตัวอักษร)"); if (!next) return; try { await api("/teachers/" + teacher.id + "/reset-password", { method: "POST", body: JSON.stringify({ password: next }) }); window.alert("เปลี่ยนรหัสผ่านแล้ว ครูต้องเข้าสู่ระบบใหม่"); } catch (reason) { onError(reason instanceof Error ? reason.message : "เปลี่ยนรหัสผ่านไม่สำเร็จ"); } }
  return <><PageHeading eyebrow="บัญชีผู้ใช้งาน" title="จัดการบัญชีครู" detail="สร้างบัญชีครูและดูแลการเข้าใช้งาน"/><section className="panel"><header className="panel-heading compact"><div><h2>เพิ่มบัญชีครู</h2><p className="muted">ส่งชื่อผู้ใช้และรหัสผ่านเริ่มต้นให้ครู</p></div></header><form className="teacher-form" onSubmit={create}><label>ชื่อที่แสดง<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required/></label><label>ชื่อผู้ใช้<input value={username} onChange={(e) => setUsername(e.target.value)} minLength={3} maxLength={40} required/></label><label>รหัสผ่านเริ่มต้น<input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required/></label><Button disabled={busy || password.length < 12}>＋ สร้างบัญชีครู</Button></form></section><section className="panel"><header className="panel-heading compact"><div><p className="eyebrow">บัญชีที่สร้างแล้ว</p><h2>ครูในระบบ <small>{teachers.length} คน</small></h2></div></header>{teachers.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>ชื่อ</th><th>ชื่อผู้ใช้</th><th>สถานะ</th><th></th></tr></thead><tbody>{teachers.map((teacher) => <tr key={teacher.id}><td><strong>{teacher.displayName}</strong></td><td>{teacher.username}</td><td><span className={"student-state " + (teacher.active ? "" : "inactive")}>{teacher.active ? "ใช้งาน" : "ปิดบัญชี"}</span></td><td className="row-actions"><button className="text-button" onClick={() => void reset(teacher)}>ตั้งรหัสผ่านใหม่</button><button className="text-button subdued" onClick={() => void active(teacher)}>{teacher.active ? "ปิดบัญชี" : "เปิดบัญชี"}</button></td></tr>)}</tbody></table></div> : <Empty icon="♙" title="ยังไม่มีบัญชีครูเพิ่ม" detail="เพิ่มบัญชีจากแบบฟอร์มด้านบน"/>}</section></>;
}

export { App };
