import { useEffect, useState } from "react";
import { api } from "./api";
import { LessonImagePreview, type LessonImage } from "./LessonImagePicker";

type ManagedImage = LessonImage & { lessonId: string; lessonTitle: string; classroomIds: string[]; draft: boolean; published: boolean; trashed: boolean };
type ImageLibrary = { images: ManagedImage[]; classrooms: { id: string; name: string; archived: boolean }[] };
const pageSize = 24;

export function LessonImageManager({ onBack, onOpen }: { onBack: () => void; onOpen: (id: string) => void }) {
  const [library, setLibrary] = useState<ImageLibrary>();
  const [search, setSearch] = useState("");
  const [classroom, setClassroom] = useState("");
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<ImageLibrary>("/lesson-images", { signal: controller.signal }).then(setLibrary).catch((error) => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, [refresh]);

  async function remove(image: ManagedImage) {
    const consequence = image.source === "drive" ? "ไฟล์ต้นฉบับจะยังอยู่ใน Google Drive" : "ไฟล์ที่อัปโหลดจะถูกลบถาวร";
    if (!window.confirm(`ลบ “${image.originalName}” จากบทเรียน “${image.lessonTitle}” หรือไม่? ${consequence}`)) return;
    setPending(image.id);
    setError("");
    setNotice("");
    try {
      const result = await api<{ cleanupPending: boolean }>(`/lesson-pages/${image.lessonId}/images/${image.id}`, { method: "DELETE" });
      setLibrary((current) => current && { ...current, images: current.images.filter((item) => item.id !== image.id) });
      setNotice(result.cleanupPending ? "ลบรูปออกจากบทเรียนแล้ว ไฟล์ที่ค้างจะถูกล้างเมื่อระบบเริ่มใหม่" : "ลบรูปออกจากบทเรียนแล้ว");
    } catch (error) {
      setError(error instanceof Error ? error.message : "ลบรูปไม่สำเร็จ");
      setRefresh((value) => value + 1);
    } finally { setPending(undefined); }
  }

  const query = search.trim().toLocaleLowerCase();
  const images = library?.images.filter((image) =>
    (classroom === "" || (classroom === "unassigned" ? !image.classroomIds.length : image.classroomIds.includes(classroom))) &&
    (!query || `${image.originalName} ${image.lessonTitle}`.toLocaleLowerCase().includes(query))) ?? [];
  const pages = Math.max(1, Math.ceil(images.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const names = new Map(library?.classrooms.map((room) => [room.id, room.archived ? `${room.name} (เก็บถาวร)` : room.name]));

  return <section className="lesson-library">
    <header className="page-heading"><div><button className="text-button" onClick={onBack}>← บทเรียนทั้งหมด</button><h1>รูปภาพบทเรียน</h1></div></header>
    <div className="lesson-image-picker-row">
      <label>ค้นหารูปหรือบทเรียน<input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></label>
      <label>ห้องเรียน<select value={classroom} onChange={(event) => { setClassroom(event.target.value); setPage(0); }}>
        <option value="">ทุกห้องเรียน</option><option value="unassigned">ยังไม่ได้มอบหมาย</option>
        {library?.classrooms.map((room) => <option key={room.id} value={room.id}>{names.get(room.id)}</option>)}
      </select></label>
      <button className="button button-quiet" onClick={() => { setError(""); setRefresh((value) => value + 1); }}>โหลดใหม่</button>
    </div>
    {error && <p className="notice" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!library && !error && <p className="muted" role="status">กำลังโหลดรูปภาพ…</p>}
    {library && !images.length && <p className="muted">ไม่พบรูปภาพ</p>}
    <div className="lesson-image-manager-grid">{images.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((image) => {
      const usage = [image.draft && "ฉบับร่าง", image.published && "ฉบับเผยแพร่"].filter(Boolean).join(" · ");
      return <article className="panel lesson-image-card" key={image.id}>
        {image.trashed ? <span className="lesson-image-placeholder">บทเรียนในถังขยะ</span>
          : <LessonImagePreview key={refresh} src={`/api/lesson-pages/${image.lessonId}/images/${image.id}/content`} alt={image.originalName} />}
        <strong title={image.originalName}>{image.originalName}</strong>
        <span className="muted">{image.source === "drive" ? "Google Drive" : `ไฟล์อัปโหลด · ${Math.max(1, Math.ceil(Number(image.sizeBytes) / 1024))} KiB`}</span>
        <span>{image.lessonTitle}</span>
        <span className="muted">{image.classroomIds.map((id) => names.get(id)).join(", ") || "ยังไม่ได้มอบหมาย"}</span>
        <span className="muted">{usage ? `ใช้อยู่ใน${usage}` : "ยังไม่ได้ใช้"}</span>
        {!image.trashed && <div className="lesson-actions">
          <button className="button button-quiet" onClick={() => onOpen(image.lessonId)}>เปิดบทเรียน</button>
          <button className="button button-danger" disabled={Boolean(pending || usage)} onClick={() => void remove(image)}>ลบรูปภาพ</button>
        </div>}
      </article>;
    })}</div>
    {pages > 1 && <div className="lesson-actions">
      <button className="button button-quiet" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>ก่อนหน้า</button>
      <span className="muted">{currentPage + 1} / {pages}</span>
      <button className="button button-quiet" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>ถัดไป</button>
    </div>}
  </section>;
}
