import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { formatGradebookPoints, gradebookExportRows, gradebookTotalForStudent, type GradebookScore } from "./gradebook";

type GradebookStudent = { studentId: string; studentCode: string | null; studentNumber: number | null; displayName: string; archived: boolean };
type GradebookItem = { id: string; name: string; maxScore: number; kind: "assignment" | "quiz" | "worksheet" | "manual"; archived: boolean; revision?: number; status?: string };
type GradebookData = { students: GradebookStudent[]; items: GradebookItem[]; scores: GradebookScore[] };

function scoreText(score: GradebookScore | undefined) {
  return score ? `${formatGradebookPoints(score.score)} / ${formatGradebookPoints(score.maxScore)}` : "—";
}

export function ClassGradebook({ classroomId, onError }: { classroomId: string; onError: (message: string) => void }) {
  const [data, setData] = useState<GradebookData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [manualDraft, setManualDraft] = useState<Record<string, Record<string, string>>>({});
  const [savingId, setSavingId] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMax, setNewMax] = useState("100");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<GradebookData>(`/classrooms/${classroomId}/gradebook`);
      setData(result);
      setManualDraft(Object.fromEntries(result.items.filter((item) => item.kind === "manual").map((item) => [item.id,
        Object.fromEntries(result.students.map((student) => [student.studentId,
          String(result.scores.find((score) => score.itemId === item.id && score.studentId === student.studentId)?.score ?? "")]))
      ])));
      setIncluded((current) => Object.fromEntries(result.items.map((item) => [item.id, item.archived ? false : current[item.id] ?? true])));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "โหลดสมุดคะแนนไม่สำเร็จ");
    } finally { setLoading(false); }
  }, [classroomId, onError]);

  useEffect(() => { void load(); }, [load]);
  const students = useMemo(() => (data?.students ?? []).filter((student) => showArchived || !student.archived), [data, showArchived]);
  const items = useMemo(() => (data?.items ?? []).filter((item) => showArchived || !item.archived), [data, showArchived]);
  const includedIds = useMemo(() => new Set(items.filter((item) => included[item.id]).map((item) => item.id)), [items, included]);
  const scoreMap = useMemo(() => new Map((data?.scores ?? []).map((score) => [`${score.studentId}:${score.itemId}`, score])), [data]);

  async function createColumn(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      await api(`/classrooms/${classroomId}/gradebook/columns`, { method: "POST", body: JSON.stringify({ name: newName, maxScore: Number(newMax) }) });
      setNewName(""); setNewMax("100"); await load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "สร้างรายการคะแนนไม่สำเร็จ"); }
    finally { setCreating(false); }
  }

  async function saveColumn(item: GradebookItem) {
    if (!data || item.revision === undefined) return;
    setSavingId(item.id);
    try {
      const marks = data.students.map((student) => {
        const value = manualDraft[item.id]?.[student.studentId]?.trim() ?? "";
        const score = value === "" ? null : Number(value);
        if (score !== null && !Number.isFinite(score)) throw new Error(`กรุณาตรวจสอบคะแนนของ ${student.displayName}`);
        return { studentId: student.studentId, score };
      });
      await api(`/classrooms/${classroomId}/gradebook/columns/${item.id}`, { method: "PUT", body: JSON.stringify({ revision: item.revision, marks }) });
      await load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "บันทึกคะแนนไม่สำเร็จ"); }
    finally { setSavingId(""); }
  }

  async function toggleArchive(item: GradebookItem) {
    const action = item.archived ? "restore" : "archive";
    if (!item.archived && !window.confirm(`เก็บ “${item.name}” เข้าคลังหรือไม่? คะแนนเดิมจะยังอยู่`)) return;
    try {
      await api(`/classrooms/${classroomId}/gradebook/columns/${item.id}/${action}`, { method: "POST", body: JSON.stringify({ revision: item.revision }) });
      setIncluded((current) => ({ ...current, [item.id]: action === "restore" }));
      await load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "จัดการรายการคะแนนไม่สำเร็จ"); }
  }

  function totalFor(studentId: string) { return gradebookTotalForStudent(studentId, data?.scores ?? [], includedIds); }

  async function exportWorkbook() {
    if (!data) return;
    try {
      const XLSX = await import("xlsx");
      const chosen = items.filter((item) => included[item.id]);
      const rows = gradebookExportRows(students, chosen, data.scores, includedIds);
      const book = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"] = [{ wch: 9 }, { wch: 17 }, { wch: 26 }, ...chosen.map(() => ({ wch: 24 })), { wch: 20 }, { wch: 12 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(book, sheet, "สมุดคะแนน");
      XLSX.writeFile(book, `สมุดคะแนน-${classroomId.slice(0, 8)}.xlsx`);
    } catch (reason) { onError(reason instanceof Error ? reason.message : "ส่งออก Excel ไม่สำเร็จ"); }
  }

  return <section className="panel class-gradebook">
    <header className="panel-heading"><div><p className="eyebrow">คะแนนและผลการเรียน</p><h2>สมุดคะแนน</h2><p className="muted">คะแนนงานที่เผยแพร่ แบบทดสอบที่ทำเสร็จ และคะแนนที่ครูเพิ่มเอง</p></div>
      <div className="gradebook-tools"><label className="gradebook-archived"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)}/>แสดงข้อมูลที่เก็บแล้ว</label><button className="button button-quiet" onClick={exportWorkbook} disabled={!data}>ส่งออก Excel</button></div>
    </header>
    <form className="gradebook-create" onSubmit={createColumn}><label>รายการคะแนนใหม่<input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={120} placeholder="เช่น แบบฝึกหัดในชั้น" required/></label><label>คะแนนเต็ม<input type="number" min="0.01" max="9999999999.99" step="0.01" value={newMax} onChange={(event) => setNewMax(event.target.value)} required/></label><button className="button button-primary" disabled={creating || !newName.trim()}>{creating ? "กำลังสร้าง…" : "＋ เพิ่มรายการ"}</button></form>
    <div className="gradebook-total-note muted">รวมคะแนนเฉพาะรายการที่เลือกและมีคะแนนบันทึกแล้ว ช่องว่างจะไม่นำมาคำนวณ และ 0 ถือเป็นคะแนนที่บันทึก</div>
    {loading ? <p className="inline-loading"><i className="spinner"/>กำลังโหลดสมุดคะแนน…</p> : !data ? <div className="notice">โหลดข้อมูลไม่สำเร็จ <button className="text-button" onClick={() => void load()}>ลองอีกครั้ง</button></div> : !students.length ? <p className="empty-state">ยังไม่มีนักเรียนในห้องนี้</p> : <div className="table-wrap gradebook-table-wrap"><table className="data-table gradebook-table"><thead><tr><th className="gradebook-student-col">นักเรียน</th>{items.map((item) => <th key={item.id} className="gradebook-item-col"><div className="gradebook-item-heading"><strong>{item.name}</strong><small>{item.kind === "assignment" ? `งาน · คะแนนเต็มปัจจุบัน ${formatGradebookPoints(item.maxScore)}` : (item.kind === "quiz" || item.kind === "worksheet") ? `${item.kind === "quiz" ? "แบบทดสอบ" : "ใบงาน"} · เต็ม ${formatGradebookPoints(item.maxScore)}${item.status === "open" ? " · กำลังทำ" : ""}` : `คะแนนครู · เต็ม ${formatGradebookPoints(item.maxScore)}`}</small><label className="gradebook-include"><input type="checkbox" checked={!!included[item.id]} onChange={(event) => setIncluded((current) => ({ ...current, [item.id]: event.target.checked }))}/>รวมคะแนน</label>{item.kind === "manual" && <button className="text-button gradebook-archive" onClick={() => void toggleArchive(item)}>{item.archived ? "คืนจากคลัง" : "เก็บ"}</button>}{item.kind === "assignment" && item.archived && <small>เก็บในคลัง</small>}</div></th>)}<th className="gradebook-total-col">รวม</th></tr></thead>
        <tbody>{students.map((student) => { const total = totalFor(student.studentId); return <tr key={student.studentId}><td className="gradebook-student-col"><strong>{student.studentNumber ?? "—"}. {student.displayName}</strong><small>{student.studentCode ?? "—"}{student.archived ? " · เก็บในคลัง" : ""}</small></td>{items.map((item) => <td key={item.id} className="gradebook-score-cell">{item.kind === "manual" ? <input aria-label={`${item.name} ${student.displayName}`} type="number" min="0" max={item.maxScore} step="0.01" value={manualDraft[item.id]?.[student.studentId] ?? ""} placeholder="—" disabled={item.archived || !!savingId} onChange={(event) => setManualDraft((current) => ({ ...current, [item.id]: { ...current[item.id], [student.studentId]: event.target.value } }))}/> : <span>{scoreText(scoreMap.get(`${student.studentId}:${item.id}`))}</span>}</td>)}<td className="gradebook-total-cell"><strong>{total.scoredItems ? `${formatGradebookPoints(total.earned)} / ${formatGradebookPoints(total.possible)}` : "—"}</strong><small>{total.percent === null ? "ยังไม่มีคะแนน" : `${total.percent.toFixed(2)}% · ${total.scoredItems} รายการ`}</small></td></tr>; })}</tbody>
      </table></div>}
    {data && items.filter((item) => item.kind === "manual" && !item.archived).map((item) => <div className="gradebook-save-row" key={item.id}><span>{item.name} · บันทึกคะแนนทั้งรายการ</span><button className="button button-primary" disabled={!!savingId} onClick={() => void saveColumn(item)}>{savingId === item.id ? "กำลังบันทึก…" : "บันทึกคะแนน"}</button></div>)}
    <footer className="panel-footer"><span className="muted">คะแนนงานที่แสดงเป็นคะแนนที่เผยแพร่แล้ว คะแนนร่างยังไม่แสดงในสมุดคะแนน</span><button className="button button-quiet" disabled={loading} onClick={() => void load()}>โหลดใหม่</button></footer>
  </section>;
}
