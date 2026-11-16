import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { LessonContent, type LessonBlock } from "./LessonContent";
import { youtubeVideoId } from "./youtube-url";
import { CodeLessonEditor, CodeLessonFrame } from "./CodeLesson";
import type { CodeBlock } from "./code-lesson";

type LessonRow = { id: string; title: string; editorMode: "blocks" | "code"; draftRevision: number; publishedAt: string | null; updatedAt: string };
type Lesson = { id: string; title: string; editorMode: "blocks" | "code"; blocks: LessonBlock[]; quizLinks?: QuizLink[]; revision: number; publishedTitle: string | null; publishedAt: string | null; publishedRevision: number | null };
type LessonImage = { id: string; originalName: string; sizeBytes: number };
type QuizLink = { quizId: string; label: string };
type QuizOption = { id: string; title: string; publishedTitle: string | null; publishedAt: string | null; trashed?: boolean };

export function LessonLibrary({ onError, onDirtyChange }: { onError: (message: string) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [lessons, setLessons] = useState<LessonRow[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [title, setTitle] = useState("");
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [blocks, setBlocks] = useState<LessonBlock[]>([]);
  const [revision, setRevision] = useState(0);
  const [videoUrl, setVideoUrl] = useState("");
  const [preview, setPreview] = useState(false);
  const [creationMode, setCreationMode] = useState<"blocks" | "code">("blocks");
  const [images, setImages] = useState<LessonImage[]>([]);
  const [quizLinks, setQuizLinks] = useState<QuizLink[]>([]);
  const [quizzes, setQuizzes] = useState<QuizOption[]>([]);
  const [linkQuizId, setLinkQuizId] = useState("");
  const [busy, setBusy] = useState(false);
  const codeImageUrl = useCallback((imageId: string) => lesson ? `/api/lesson-pages/${lesson.id}/images/${imageId}/content` : "", [lesson?.id]);
  const dirty = Boolean(lesson && (lesson.title !== title || JSON.stringify(lesson.blocks) !== JSON.stringify(blocks) || JSON.stringify(lesson.quizLinks ?? []) !== JSON.stringify(quizLinks)));
  const publicUrl = lesson && location.origin + "/lessons/" + lesson.id;

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty || busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  const load = useCallback(async (trashed = false) => setLessons(await api<LessonRow[]>(`/lesson-pages${trashed ? "?trashed=true" : ""}`)), []);
  useEffect(() => { void load(showTrash).catch((error) => onError(error instanceof Error ? error.message : "โหลดบทเรียนไม่สำเร็จ")); }, [load, onError, showTrash]);
  useEffect(() => { void Promise.all([api<QuizOption[]>("/quizzes"), api<QuizOption[]>("/quizzes?trashed=true")]).then(([active, trash]) => setQuizzes([...active, ...trash.map((quiz) => ({ ...quiz, trashed: true }))])).catch(() => {}); }, []);

  async function trashLesson(id: string, name: string, expectedRevision: number, discardEdits = false) {
    if (!window.confirm(`ย้าย “${name}” ไปถังขยะหรือไม่? หน้าสาธารณะและภาพจะหยุดเปิดใช้งาน${discardEdits ? " และการแก้ไขที่ยังไม่บันทึกจะหายไป" : ""}`)) return;
    setBusy(true);
    try {
      await api(`/lesson-pages/${id}/trash`, { method: "POST", body: JSON.stringify({ expectedRevision }) });
      setLesson(null); setShowTrash(false); await load(false);
    } catch (error) { onError(error instanceof Error ? error.message : "ย้ายบทเรียนไปถังขยะไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  async function restoreLesson(item: LessonRow) {
    try {
      await api(`/lesson-pages/${item.id}/restore`, { method: "POST", body: JSON.stringify({ expectedRevision: item.draftRevision }) });
      setShowTrash(false); await load(false);
    } catch (error) { onError(error instanceof Error ? error.message : "กู้คืนบทเรียนไม่สำเร็จ"); }
  }
  async function deleteLesson(item: LessonRow) {
    const confirmTitle = window.prompt(`ลบบทเรียน “${item.title}” ถาวรและลบภาพทั้งหมดหรือไม่? พิมพ์ชื่อบทเรียนเพื่อยืนยัน`);
    if (confirmTitle === null) return;
    try {
      const result = await api<{ cleanupPending: boolean }>(`/lesson-pages/${item.id}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: item.draftRevision, confirmTitle }) });
      await load(true);
      if (result.cleanupPending) onError("ลบบทเรียนแล้ว แต่ไฟล์ภาพบางส่วนรอการล้างข้อมูลเมื่อเริ่มระบบครั้งถัดไป");
    } catch (error) { onError(error instanceof Error ? error.message : "ลบบทเรียนถาวรไม่สำเร็จ"); }
  }

  async function open(id: string) {
    try {
      const [result, nextImages] = await Promise.all([api<Lesson>("/lesson-pages/" + id), api<LessonImage[]>(`/lesson-pages/${id}/images`)]);
      setLesson(result); setTitle(result.title); setBlocks(result.blocks); setRevision(result.revision); setImages(nextImages); setQuizLinks(result.quizLinks ?? []); setPreview(false);
    } catch (error) { onError(error instanceof Error ? error.message : "เปิดบทเรียนไม่สำเร็จ"); }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try { const result = await api<Lesson>("/lesson-pages", { method: "POST", body: JSON.stringify({ title, editorMode: creationMode }) }); await load(); setTitle(result.title); setLesson(result); setBlocks(result.blocks); setRevision(result.revision); setImages([]); setQuizLinks([]); }
    catch (error) { onError(error instanceof Error ? error.message : "สร้างบทเรียนไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  async function save(publish = false) {
    if (!lesson) return;
    setBusy(true);
    try {
      const result = await api<Lesson>(`/lesson-pages/${lesson.id}/${publish ? "publish" : "draft"}`, {
        method: publish ? "POST" : "PUT", body: JSON.stringify({ title, blocks, quizLinks, expectedRevision: revision }),
      });
      setLesson(result); setTitle(result.title); setBlocks(result.blocks); setRevision(result.revision); setQuizLinks(result.quizLinks ?? []); await load();
    } catch (error) { onError(error instanceof Error ? error.message : "บันทึกบทเรียนไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  async function unpublish() {
    if (!lesson || !window.confirm("ยกเลิกการเผยแพร่บทเรียนนี้หรือไม่? ลิงก์จะเปิดไม่ได้จนกว่าจะเผยแพร่อีกครั้ง")) return;
    setBusy(true);
    try { await api(`/lesson-pages/${lesson.id}/unpublish`, { method: "POST", body: JSON.stringify({ expectedRevision: revision }) }); await open(lesson.id); await load(); }
    catch (error) { onError(error instanceof Error ? error.message : "ยกเลิกการเผยแพร่ไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  function updateBlock(index: number, patch: Partial<LessonBlock>) {
    setBlocks((all) => all.map((item, i) => i === index ? { ...item, ...patch } as LessonBlock : item));
  }

  async function addImage(file?: File) {
    if (!lesson || !file) return;
    const form = new FormData(); form.set("file", file);
    try {
      const image = await api<{ id: string }>(`/lesson-pages/${lesson.id}/images`, { method: "POST", body: form });
      setBlocks((all) => [...all, { type: "image", imageId: image.id, alt: file.name, caption: "" }]);
    } catch (error) { onError(error instanceof Error ? error.message : "อัปโหลดภาพไม่สำเร็จ"); }
  }

  async function uploadCodeImage(file: File) {
    if (!lesson) throw new Error("กรุณาบันทึกบทเรียนก่อนอัปโหลดภาพ");
    try {
      const form = new FormData(); form.set("file", file);
      const image = await api<LessonImage>(`/lesson-pages/${lesson.id}/images`, { method: "POST", body: form });
      setImages((all) => [image, ...all.filter((item) => item.id !== image.id)]);
      return image;
    } catch (error) { onError(error instanceof Error ? error.message : "อัปโหลดภาพไม่สำเร็จ"); throw error; }
  }

  function addVideo() {
    const videoId = youtubeVideoId(videoUrl);
    if (!videoId) { onError("กรุณาวางลิงก์ YouTube ที่ถูกต้อง"); return; }
    setBlocks((all) => [...all, { type: "youtube", videoId, caption: "" }]); setVideoUrl("");
  }

  if (!lesson) return <section className="lesson-library">
    <header className="page-heading"><div><p className="eyebrow">เนื้อหาสำหรับนักเรียน</p><h1>บทเรียน</h1><p className="muted page-description">สร้างบทเรียนแล้วส่งลิงก์ให้นักเรียนเปิดอ่าน</p></div></header>
    <div className="lesson-library-toolbar"><button className="button button-quiet" onClick={() => setShowTrash((value) => !value)}>{showTrash ? "← บทเรียนทั้งหมด" : "ถังขยะ"}</button></div>
    {!showTrash && <form className="lesson-create" onSubmit={create}><label>ชื่อบทเรียน<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="เช่น การสร้างโมเดล 3 มิติ" required /></label><label>รูปแบบบทเรียน<select value={creationMode} onChange={(event) => setCreationMode(event.target.value as "blocks" | "code")}><option value="blocks">ตัวสร้างบล็อก</option><option value="code">HTML / CSS / JavaScript</option></select></label><button className="button button-primary" disabled={busy}>＋ สร้างบทเรียน</button></form>}
    <h2>{showTrash ? "ถังขยะบทเรียน" : "บทเรียนของฉัน"}</h2>
    {lessons.length ? <div className="lesson-list">{lessons.map((item) => <div className="lesson-library-row" key={item.id}><button className="lesson-list-item" disabled={showTrash} onClick={() => void open(item.id)}><span><strong>{item.title}</strong><small>{item.publishedAt ? "เผยแพร่แล้ว" : "ฉบับร่าง"} · {item.editorMode === "code" ? "HTML / CSS / JavaScript" : "ตัวสร้างบล็อก"} · แก้ไข {new Intl.DateTimeFormat("th-TH", { dateStyle: "medium" }).format(new Date(item.updatedAt))}</small></span><b>{showTrash ? "อยู่ในถังขยะ" : "แก้ไข ↗"}</b></button>{showTrash ? <div className="lesson-actions"><button className="button button-quiet" onClick={() => void restoreLesson(item)}>กู้คืน</button><button className="button button-danger" onClick={() => void deleteLesson(item)}>ลบถาวร</button></div> : <button className="button button-quiet" onClick={() => void trashLesson(item.id, item.title, item.draftRevision)}>ย้ายไปถังขยะ</button>}</div>)}</div> : <div className="panel lesson-empty"><h2>{showTrash ? "ถังขยะว่าง" : "ยังไม่มีบทเรียน"}</h2><p className="muted">{showTrash ? "บทเรียนที่ย้ายไปถังขยะจะแสดงที่นี่" : "เพิ่มข้อความ รูปภาพ และวิดีโอ YouTube ได้ในแต่ละบทเรียน"}</p></div>}
  </section>;

  return <section className="lesson-editor">
    <header className="page-heading"><div><button className="text-button" onClick={() => { if (dirty && !window.confirm("ออกจากบทเรียนโดยไม่บันทึกการแก้ไขหรือไม่?")) return; setLesson(null); void load(); }}>← บทเรียนทั้งหมด</button><p className="eyebrow">{lesson.publishedAt ? "เผยแพร่แล้ว" : "ฉบับร่าง"}</p><h1>แก้ไขบทเรียน</h1></div><div className="lesson-actions">
      {lesson.publishedAt && publicUrl && <><button className="button button-quiet" onClick={() => window.open(publicUrl, "_blank", "noopener,noreferrer")}>ดูหน้าสาธารณะ</button><button className="button button-quiet" onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => onError("คัดลอกลิงก์แล้ว")).catch(() => onError("คัดลอกลิงก์ไม่สำเร็จ"))}>คัดลอกลิงก์</button></>}
      <button className="button button-danger" disabled={busy} onClick={() => void trashLesson(lesson.id, title, revision, dirty)}>ย้ายไปถังขยะ</button>
      <button className="button button-quiet" disabled={busy || !dirty} onClick={() => void save(false)}>บันทึกฉบับร่าง</button>
      <button className="button button-primary" disabled={busy || !dirty && Boolean(lesson.publishedAt)} onClick={() => void save(true)}>{lesson.publishedAt ? "บันทึกและเผยแพร่" : "เผยแพร่"}</button>
      {lesson.publishedAt && <button className="button button-danger" disabled={busy || dirty} onClick={() => void unpublish()}>ยกเลิกเผยแพร่</button>}
    </div></header>
    {revision !== lesson.revision && <p className="notice">บทเรียนนี้ถูกแก้ไขอีกหน้าต่างหนึ่ง กรุณากลับไปโหลดข้อมูลล่าสุดก่อนบันทึก</p>}
    <label className="lesson-title-field">ชื่อบทเรียน<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} /></label>
    <section className="panel lesson-quiz-links"><h2>ปุ่มแบบทดสอบในบทเรียน</h2><p className="muted">ปุ่มจะแสดงนอกเนื้อหา HTML และเปิดแบบทดสอบสำหรับนักเรียนที่เข้าสู่ระบบแล้ว</p>
      {quizLinks.map((link, index) => <div className="lesson-quiz-link" key={link.quizId}><label>แบบทดสอบ<select value={link.quizId} onChange={(event) => setQuizLinks((all) => all.map((item, i) => i === index ? { ...item, quizId: event.target.value } : item))}>{quizzes.filter((quiz) => quiz.id === link.quizId || !quiz.trashed).map((quiz) => <option key={quiz.id} value={quiz.id}>{quiz.publishedTitle ?? quiz.title}{quiz.trashed ? " · อยู่ในถังขยะชั่วคราว" : quiz.publishedAt ? " · เผยแพร่แล้ว" : " · ยังไม่เผยแพร่"}</option>)}</select></label><label>ข้อความบนปุ่ม<input value={link.label} maxLength={100} onChange={(event) => setQuizLinks((all) => all.map((item, i) => i === index ? { ...item, label: event.target.value } : item))}/></label><button className="text-button danger" onClick={() => setQuizLinks((all) => all.filter((_, i) => i !== index))}>นำออก</button></div>)}
      <div className="lesson-add-controls"><select aria-label="เลือกแบบทดสอบ" value={linkQuizId} onChange={(event) => setLinkQuizId(event.target.value)}><option value="">เลือกแบบทดสอบ</option>{quizzes.filter((quiz) => !quiz.trashed && !quizLinks.some((link) => link.quizId === quiz.id)).map((quiz) => <option key={quiz.id} value={quiz.id}>{quiz.title}</option>)}</select><button className="button button-quiet" disabled={!linkQuizId} onClick={() => { const quiz = quizzes.find((item) => item.id === linkQuizId); if (quiz) setQuizLinks((all) => [...all, { quizId: quiz.id, label: quiz.publishedTitle ?? quiz.title }]); setLinkQuizId(""); }}>＋ เพิ่มปุ่มแบบทดสอบ</button></div>
    </section>
    {lesson.editorMode === "code" ? <CodeLessonEditor code={blocks[0] as CodeBlock} images={images} onChange={(code) => setBlocks([code])} onUpload={uploadCodeImage} /> : <div className="lesson-block-list">{blocks.map((item, index) => <article className="lesson-block-editor" key={item.type === "image" ? item.imageId : index}>
      <header><strong>{item.type === "text" ? "ข้อความ" : item.type === "image" ? "รูปภาพ" : "YouTube"}</strong><div><button aria-label="เลื่อนขึ้น" disabled={!index} onClick={() => setBlocks((all) => { const next = [...all]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>↑</button><button aria-label="เลื่อนลง" disabled={index === blocks.length - 1} onClick={() => setBlocks((all) => { const next = [...all]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next; })}>↓</button><button className="text-button danger" onClick={() => setBlocks((all) => all.filter((_, i) => i !== index))}>ลบ</button></div></header>
      {item.type === "text" ? <><label>หัวข้อย่อย<input value={item.heading ?? ""} onChange={(event) => updateBlock(index, { heading: event.target.value })} maxLength={120} /></label><label>ข้อความ<textarea rows={5} value={item.text} onChange={(event) => updateBlock(index, { text: event.target.value })} maxLength={10000} /></label></> : item.type === "image" ? <><img className="lesson-editor-image" src={`/api/lesson-pages/${lesson.id}/images/${item.imageId}/content`} alt={item.alt} /><label>คำอธิบายภาพ<input value={item.alt} onChange={(event) => updateBlock(index, { alt: event.target.value })} maxLength={300} /></label><label>คำบรรยาย<input value={item.caption ?? ""} onChange={(event) => updateBlock(index, { caption: event.target.value })} maxLength={500} /></label></> : item.type === "youtube" ? <><a href={`https://www.youtube.com/watch?v=${item.videoId}`} target="_blank" rel="noreferrer">เปิดวิดีโอ YouTube</a><label>คำบรรยาย<input value={item.caption ?? ""} onChange={(event) => updateBlock(index, { caption: event.target.value })} maxLength={500} /></label></> : null}
    </article>)}</div>}
    {lesson.editorMode === "blocks" && (
      <>
        <div className="lesson-add-controls">
          <button className="button button-quiet" onClick={() => setBlocks((all) => [...all, { type: "text", heading: "", text: "" }])}>＋ เพิ่มข้อความ</button>
          <label className="button button-quiet">＋ เพิ่มรูปภาพ<input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void addImage(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
          <div><input aria-label="ลิงก์ YouTube" value={videoUrl} onChange={(event) => setVideoUrl(event.target.value)} placeholder="วางลิงก์ YouTube" /><button className="button button-quiet" onClick={addVideo}>＋ เพิ่มวิดีโอ</button></div>
        </div>
        <label className="lesson-preview-toggle"><input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)} /> แสดงตัวอย่างบทเรียน</label>
        {preview && <div className="lesson-reading panel"><LessonContent title={title} blocks={blocks} imageUrl={codeImageUrl} /></div>}
      </>
    )}
    {lesson.editorMode === "code" && <CodeLessonFrame code={blocks[0] as CodeBlock} imageUrl={codeImageUrl} />}
  </section>;
}
