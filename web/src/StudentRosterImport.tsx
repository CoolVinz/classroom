import type * as React from "react";
import { useMemo, useState } from "react";
import { api } from "./api";
import { previewRoster, readPastedRoster, readRosterFile, suggestRosterColumns, type RosterMapping, type RosterPreview, type RosterSheet } from "./roster-import";

type Student = { studentCode: string | null; studentNumber: number | null; email?: string | null; archived?: boolean };

export function StudentRosterImport({ classroomId, students, onImported, onError }: {
  classroomId: string; students: Student[]; onImported: () => Promise<void>; onError: (message: string) => void;
}) {
  const [sheets, setSheets] = useState<RosterSheet[]>([]);
  const [sheetName, setSheetName] = useState("");
  const [codeColumn, setCodeColumn] = useState(-1); const [numberColumn, setNumberColumn] = useState(-1);
  const [nameMode, setNameMode] = useState<"full" | "split">("full");
  const [fullNameColumn, setFullNameColumn] = useState(-1); const [firstNameColumn, setFirstNameColumn] = useState(-1);
  const [lastNameColumn, setLastNameColumn] = useState(-1); const [prefixColumn, setPrefixColumn] = useState(-1); const [emailColumn, setEmailColumn] = useState(-1);
  const [hasHeader, setHasHeader] = useState(true); const [saving, setSaving] = useState(false); const [reading, setReading] = useState(false);
  const [pastedText, setPastedText] = useState(""); const [fileName, setFileName] = useState(""); const [notice, setNotice] = useState("");
  const sheet = sheets.find((item) => item.name === sheetName);
  const headers = (sheet?.rows[0] ?? []).map((value, index) => hasHeader
    ? String(value || "Column " + (index + 1))
    : `คอลัมน์ ${index + 1} (ตัวอย่าง: ${String(value || "ว่าง").slice(0, 24)})`);
  const codes = useMemo(() => new Set(students.map((student) => student.studentCode).filter((code): code is string => !!code)), [students]);
  const emails = useMemo(() => new Set(students.map((student) => student.email?.toLowerCase()).filter((email): email is string => !!email)), [students]);
  const existing = useMemo(() => new Map(students.map((student, index) => [student.studentCode ?? `\0${index}`, { studentNumber: student.studentNumber, archived: student.archived }])), [students]);
  const mapping: RosterMapping = {
    code: codeColumn, studentNumber: numberColumn,
    ...(nameMode === "full" ? { fullName: fullNameColumn } : { firstName: firstNameColumn, lastName: lastNameColumn, prefix: prefixColumn }),
    ...(emailColumn >= 0 ? { email: emailColumn } : {}),
  };
  const preview: RosterPreview | null = sheet && codeColumn >= 0
    && (nameMode === "full" ? fullNameColumn >= 0 : firstNameColumn >= 0 && lastNameColumn >= 0)
    ? previewRoster(sheet.rows, mapping, codes, emails, existing, hasHeader)
    : null;
  const previewRows = preview ? [
    ...preview.add.map((row) => ({ ...row, status: "เพิ่ม" })),
    ...preview.update.map((row) => ({ ...row, displayName: "เติมเลขที่", status: "อัปเดตเลขที่" })),
    ...preview.skipped.map((row) => ({ ...row, status: "ข้ามรหัสเดิม" })),
    ...preview.errors.map(({ row, message }) => ({ row, studentCode: "", studentNumber: undefined, displayName: message, email: "", status: "ต้องแก้" })),
  ] : [];

  function clearMapping() {
    setCodeColumn(-1); setNumberColumn(-1); setFullNameColumn(-1); setFirstNameColumn(-1); setLastNameColumn(-1); setPrefixColumn(-1); setEmailColumn(-1);
  }
  function applyHeaderMapping(values: unknown[]) {
    const columns = suggestRosterColumns(values);
    setCodeColumn(columns.code); setNumberColumn(columns.studentNumber); setFullNameColumn(columns.fullName);
    setFirstNameColumn(columns.firstName); setLastNameColumn(columns.lastName); setPrefixColumn(columns.prefix); setEmailColumn(columns.email);
    setNameMode(columns.fullName < 0 && columns.firstName >= 0 && columns.lastName >= 0 ? "split" : "full");
  }
  function setHeaderMode(enabled: boolean) {
    setHasHeader(enabled);
    if (enabled) applyHeaderMapping(sheet?.rows[0] ?? []);
    else { clearMapping(); setNameMode("full"); }
  }
  async function chooseFile(file?: File) {
    if (!file) return;
    setReading(true); setNotice(""); setSheets([]); setPastedText(""); setFileName(file.name); setHasHeader(true);
    try { const next = await readRosterFile(file); setSheets(next); setSheetName(next[0]?.name ?? ""); applyHeaderMapping(next[0]?.rows[0] ?? []); }
    catch (reason) { setSheets([]); setFileName(""); onError(reason instanceof Error ? reason.message : "อ่านไฟล์รายชื่อไม่สำเร็จ"); }
    finally { setReading(false); }
  }
  async function choosePastedData() {
    setReading(true); setNotice(""); setSheets([]); setFileName(""); setHasHeader(true);
    try { const next = await readPastedRoster(pastedText); setSheets([next]); setSheetName(next.name); setFileName(next.name); applyHeaderMapping(next.rows[0] ?? []); }
    catch (reason) { onError(reason instanceof Error ? reason.message : "อ่านข้อมูลที่วางไม่สำเร็จ"); }
    finally { setReading(false); }
  }
  function chooseSheet(name: string) {
    setSheetName(name);
    const next = sheets.find((item) => item.name === name);
    if (hasHeader) applyHeaderMapping(next?.rows[0] ?? []); else clearMapping();
  }
  async function importRows() {
    if (!preview || (!preview.add.length && !preview.update.length) || preview.errors.length) return;
    setSaving(true);
    try {
      const result = await api<{ added: number; updated: number; skipped: number }>("/classrooms/" + classroomId + "/roster/import", {
        method: "POST", body: JSON.stringify({ students: [
          ...preview.add.map(({ studentCode, studentNumber, displayName, email }) => ({ studentCode, studentNumber, displayName, email })),
          ...preview.update.map(({ studentCode, studentNumber }) => ({ studentCode, studentNumber })),
        ] }),
      });
      setSheets([]); setFileName(""); setPastedText(""); await onImported();
      setNotice(`เพิ่ม ${result.added} คน เติมเลขที่ ${result.updated} คน และข้าม ${result.skipped} คนแล้ว`);
    } catch (reason) { onError(reason instanceof Error ? reason.message : "นำเข้ารายชื่อไม่สำเร็จ"); }
    finally { setSaving(false); }
  }

  return <section className="panel roster-import"><header className="panel-heading compact"><div><p className="eyebrow">นำเข้ารายชื่อจากตาราง</p><h2>Excel, CSV หรือวางข้อมูล</h2><p className="muted">จับคู่คอลัมน์ก่อนนำเข้า ระบบจะข้ามรหัสเดิม และสร้างอีเมลโรงเรียนจากรหัสตัวเลขเมื่อไม่มีอีเมล</p></div></header>
    <div className="roster-import-controls"><label className="import-file">เลือกไฟล์<input type="file" accept=".xlsx,.csv" disabled={saving || reading} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void chooseFile(file); }}/></label>{fileName && <span className="muted">{fileName}</span>}
      <details className="import-paste"><summary>หรือวางข้อมูลจาก Google Sheets</summary><label>ข้อมูลรายชื่อ<small>คัดลอกเซลล์ทั้งตาราง (ไม่เกิน 1,000 คน และ 5 MB)</small><textarea rows={5} value={pastedText} disabled={saving || reading} onChange={(event) => { setPastedText(event.target.value); setSheets([]); setFileName(""); setNotice(""); }}/></label><Button type="button" tone="quiet" disabled={saving || reading || !pastedText.trim()} onClick={() => void choosePastedData()}>{reading ? "กำลังอ่านข้อมูล…" : "ดูตัวอย่างข้อมูลที่วาง"}</Button></details>
      {sheets.length > 1 && <label>แผ่นงาน<select value={sheetName} onChange={(event) => chooseSheet(event.target.value)}>{sheets.map((item) => <option key={item.name}>{item.name}</option>)}</select></label>}
      {sheet && <>
        <label className="header-row-toggle"><input type="checkbox" checked={hasHeader} onChange={(event) => setHeaderMode(event.target.checked)}/> แถวแรกมีหัวคอลัมน์</label>
        <label>รหัสนักเรียน<select value={codeColumn} onChange={(event) => setCodeColumn(Number(event.target.value))}><option value={-1}>เลือกคอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label>
        <label>เลขที่ <small>(ไม่บังคับ)</small><select value={numberColumn} onChange={(event) => setNumberColumn(Number(event.target.value))}><option value={-1}>ไม่ใช้คอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label>
        <label>ชื่อในตาราง<select value={nameMode} onChange={(event) => setNameMode(event.target.value as "full" | "split")}><option value="full">คอลัมน์ชื่อเต็ม</option><option value="split">แยกชื่อและนามสกุล</option></select></label>
        {nameMode === "full" ? <label>ชื่อเต็ม<select value={fullNameColumn} onChange={(event) => setFullNameColumn(Number(event.target.value))}><option value={-1}>เลือกคอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label> : <><label>คำนำหน้า <small>(ไม่บังคับ)</small><select value={prefixColumn} onChange={(event) => setPrefixColumn(Number(event.target.value))}><option value={-1}>ไม่ใช้คอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label><label>ชื่อ<select value={firstNameColumn} onChange={(event) => setFirstNameColumn(Number(event.target.value))}><option value={-1}>เลือกคอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label><label>นามสกุล<select value={lastNameColumn} onChange={(event) => setLastNameColumn(Number(event.target.value))}><option value={-1}>เลือกคอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label></>}
        <label>อีเมล <small>(ไม่บังคับ)</small><select value={emailColumn} onChange={(event) => setEmailColumn(Number(event.target.value))}><option value={-1}>ไม่ใช้คอลัมน์</option>{headers.map((header, index) => <option value={index} key={index}>{header}</option>)}</select></label>
      </>}
    </div>
    {notice && <p className="success-message" role="status">{notice}</p>}
    {preview && <><div className="import-counts"><span>เพิ่มใหม่ <b>{preview.add.length}</b></span><span>เติมเลขที่ <b>{preview.update.length}</b></span><span>ข้ามรหัสเดิม <b>{preview.skipped.length}</b></span><span>ต้องแก้ <b>{preview.errors.length}</b></span></div>
      <div className="import-preview"><table className="data-table"><thead><tr><th>แถว</th><th>เลขที่</th><th>รหัสนักเรียน</th><th>ชื่อ</th><th>สถานะ</th></tr></thead><tbody>
        {previewRows.slice(0, 20).map((row) => <tr key={row.row + "-" + row.status}><td>{row.row}</td><td>{row.studentNumber ?? "—"}</td><td>{row.studentCode}</td><td>{row.displayName}</td><td>{row.status}</td></tr>)}
      </tbody></table></div>{previewRows.length > 20 && <p className="muted">แสดงตัวอย่าง 20 แถวแรก</p>}
      <footer className="panel-footer"><span className="muted">เลขที่เดิม ชื่อ และอีเมลของนักเรียนเดิมจะไม่เปลี่ยนแปลง</span><Button disabled={saving || reading || (!preview.add.length && !preview.update.length) || !!preview.errors.length} onClick={() => void importRows()}>{saving ? "กำลังนำเข้า…" : "ยืนยันนำเข้า"}</Button></footer>
    </>}
  </section>;
}

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "quiet" }) {
  const { tone = "primary", className = "", ...rest } = props;
  return <button className={"button button-" + tone + " " + className} {...rest} />;
}
