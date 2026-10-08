import type * as React from "react";
import { useMemo, useState } from "react";
import { api } from "./api";
import { previewRoster, readRosterFile, type RosterMapping, type RosterPreview, type RosterSheet } from "./roster-import";

type Student = { studentCode: string | null; email?: string | null; archived?: boolean };

export function StudentRosterImport({ classroomId, students, onImported, onError }: {
  classroomId: string; students: Student[]; onImported: () => Promise<void>; onError: (message: string) => void;
}) {
  const [sheets, setSheets] = useState<RosterSheet[]>([]);
  const [sheetName, setSheetName] = useState("");
  const [codeColumn, setCodeColumn] = useState(-1);
  const [nameMode, setNameMode] = useState<"full" | "split">("full");
  const [fullNameColumn, setFullNameColumn] = useState(-1);
  const [firstNameColumn, setFirstNameColumn] = useState(-1);
  const [lastNameColumn, setLastNameColumn] = useState(-1);
  const [emailColumn, setEmailColumn] = useState(-1);
  const [saving, setSaving] = useState(false);
  const [fileName, setFileName] = useState("");
  const [notice, setNotice] = useState("");
  const sheet = sheets.find((item) => item.name === sheetName);
  const headers = (sheet?.rows[0] ?? []).map((header, index) => String(header || "Column " + (index + 1)));
  const codes = useMemo(() => new Set(students.map((student) => student.studentCode).filter((code): code is string => !!code)), [students]);
  const emails = useMemo(() => new Set(students.map((student) => student.email?.toLowerCase()).filter((email): email is string => !!email)), [students]);
  const mapping: RosterMapping = nameMode === "full"
    ? { code: codeColumn, fullName: fullNameColumn, ...(emailColumn >= 0 ? { email: emailColumn } : {}) }
    : { code: codeColumn, firstName: firstNameColumn, lastName: lastNameColumn, ...(emailColumn >= 0 ? { email: emailColumn } : {}) };
  const preview: RosterPreview | null = sheet && codeColumn >= 0
    && (nameMode === "full" ? fullNameColumn >= 0 : firstNameColumn >= 0 && lastNameColumn >= 0)
    ? previewRoster(sheet.rows, mapping, codes, emails)
    : null;
  const previewRows = preview ? [
    ...preview.add.map((row) => ({ ...row, status: "เพิ่ม" })),
    ...preview.skipped.map((row) => ({ ...row, status: "ข้ามรหัสเดิม" })),
    ...preview.errors.map(({ row, message }) => ({ row, studentCode: "", displayName: message, email: "", status: "ต้องแก้" })),
  ] : [];

  async function chooseFile(file?: File) {
    if (!file) return;
    setNotice("");
    setFileName(file.name);
    try {
      const nextSheets = await readRosterFile(file);
      setSheets(nextSheets);
      setSheetName(nextSheets[0]?.name ?? "");
      setCodeColumn(findHeader(nextSheets[0]?.rows[0] ?? [], /รหัส|student.?id|^id$|code/i));
      setFullNameColumn(findHeader(nextSheets[0]?.rows[0] ?? [], /ชื่อ.?นามสกุล|ชื่อ.*สกุล|full.?name|student.?name|^name$/i));
      setFirstNameColumn(findHeader(nextSheets[0]?.rows[0] ?? [], /ชื่อ|first.?name/i));
      setLastNameColumn(findHeader(nextSheets[0]?.rows[0] ?? [], /สกุล|last.?name/i));
      setEmailColumn(findHeader(nextSheets[0]?.rows[0] ?? [], /อีเมล|email|e-mail/i));
      setNameMode("full");
    } catch (reason) {
      setSheets([]); setFileName("");
      onError(reason instanceof Error ? reason.message : "อ่านไฟล์รายชื่อไม่สำเร็จ");
    }
  }

  function chooseSheet(name: string) {
    setSheetName(name);
    const next = sheets.find((item) => item.name === name);
    const row = next?.rows[0] ?? [];
    setCodeColumn(findHeader(row, /รหัส|student.?id|^id$|code/i));
    setFullNameColumn(findHeader(row, /ชื่อ.?นามสกุล|ชื่อ.*สกุล|full.?name|student.?name|^name$/i));
    setFirstNameColumn(findHeader(row, /ชื่อ|first.?name/i));
    setLastNameColumn(findHeader(row, /สกุล|last.?name/i));
    setEmailColumn(findHeader(row, /อีเมล|email|e-mail/i));
  }

  async function importRows() {
    if (!preview?.add.length || preview.errors.length) return;
    setSaving(true);
    try {
      const result = await api<{ added: number; skipped: number }>("/classrooms/" + classroomId + "/roster/import", {
        method: "POST", body: JSON.stringify({ students: preview.add.map(({ studentCode, displayName, email }) => ({ studentCode, displayName, email })) }),
      });
      setSheets([]); setFileName("");
      await onImported();
      setNotice(`นำเข้า ${result.added} คน และข้ามรหัสเดิม ${result.skipped} คนแล้ว`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "นำเข้ารายชื่อไม่สำเร็จ");
    } finally { setSaving(false); }
  }

  return <section className="panel roster-import"><header className="panel-heading compact"><div><p className="eyebrow">นำเข้ารายชื่อจากตาราง</p><h2>Excel หรือ CSV</h2><p className="muted">จับคู่คอลัมน์ก่อนนำเข้า ระบบจะข้ามรหัสนักเรียนที่มีอยู่แล้ว</p></div></header>
    <div className="roster-import-controls"><label className="import-file">เลือกไฟล์<input type="file" accept=".xlsx,.csv" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void chooseFile(file); }}/></label>{fileName && <span className="muted">{fileName}</span>}
      {sheets.length > 1 && <label>แผ่นงาน<select value={sheetName} onChange={(event) => chooseSheet(event.target.value)}>{sheets.map((item) => <option key={item.name}>{item.name}</option>)}</select></label>}
      {sheet && <>
        <label>รหัสนักเรียน<select value={codeColumn} onChange={(event) => setCodeColumn(Number(event.target.value))}><option value={-1}>เลือกคอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label>
        <label>ชื่อในตาราง<select value={nameMode} onChange={(event) => setNameMode(event.target.value as "full" | "split")}><option value="full">คอลัมน์ชื่อเต็ม</option><option value="split">แยกชื่อและนามสกุล</option></select></label>
        {nameMode === "full" ? <label>ชื่อเต็ม<select value={fullNameColumn} onChange={(event) => setFullNameColumn(Number(event.target.value))}><option value={-1}>เลือกคอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label> : <><label>ชื่อ<select value={firstNameColumn} onChange={(event) => setFirstNameColumn(Number(event.target.value))}><option value={-1}>เลือกคอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label><label>นามสกุล<select value={lastNameColumn} onChange={(event) => setLastNameColumn(Number(event.target.value))}><option value={-1}>เลือกคอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label></>}
        <label>อีเมล <small>(ไม่บังคับ)</small><select value={emailColumn} onChange={(event) => setEmailColumn(Number(event.target.value))}><option value={-1}>ไม่ใช้คอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label>
      </>}
    </div>
    {notice && <p className="success-message" role="status">{notice}</p>}
    {preview && <><div className="import-counts"><span>เพิ่มใหม่ <b>{preview.add.length}</b></span><span>ข้ามรหัสเดิม <b>{preview.skipped.length}</b></span><span>ต้องแก้ <b>{preview.errors.length}</b></span></div>
      <div className="import-preview"><table className="data-table"><thead><tr><th>แถว</th><th>รหัสนักเรียน</th><th>ชื่อ</th><th>อีเมล</th><th>สถานะ</th></tr></thead><tbody>
        {previewRows.slice(0, 20).map((row) => <tr key={row.row + "-" + row.status}><td>{row.row}</td><td>{row.studentCode}</td><td>{row.displayName}</td><td>{row.email ?? "—"}</td><td>{row.status}</td></tr>)}
      </tbody></table></div>{previewRows.length > 20 && <p className="muted">แสดงตัวอย่าง 20 แถวแรก</p>}
      <footer className="panel-footer"><span className="muted">รหัสเดิมและนักเรียนที่เก็บไว้จะไม่เปลี่ยนแปลง</span><Button disabled={saving || !preview.add.length || !!preview.errors.length} onClick={() => void importRows()}>{saving ? "กำลังนำเข้า…" : "ยืนยันนำเข้า"}</Button></footer>
    </>}
  </section>;
}

function findHeader(headers: unknown[], pattern: RegExp) {
  return headers.findIndex((header) => pattern.test(String(header ?? "").trim().toLowerCase()));
}

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "quiet" }) {
  const { tone = "primary", className = "", ...rest } = props;
  return <button className={"button button-" + tone + " " + className} {...rest} />;
}
