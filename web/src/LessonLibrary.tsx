import type { WioLabSettings } from "../../src/wio-labs";
import { WioDemo } from "./WioDemo";
import { WioLabSettingsFields } from "./WioLabSettingsFields";
import { AiImportPanel } from "./AiImportPanel";
import { LessonClassAssignments } from "./LessonClassAssignments";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { LessonContent, type LessonBlock } from "./LessonContent";
import { youtubeVideoId } from "./youtube-url";
import { CodeLessonEditor, CodeLessonFrame } from "./CodeLesson";
import type { CodeBlock } from "./code-lesson";
import { LessonImagePicker, LessonImagePreview, type LessonImage, type LessonImageInput } from "./LessonImagePicker";
import { LessonImageManager } from "./LessonImageManager";

type LessonRow = { id: string; title: string; editorMode: "blocks" | "code"; draftRevision: number; publishedAt: string | null; updatedAt: string };
type Lesson = { id: string; title: string; editorMode: "blocks" | "code"; blocks: LessonBlock[]; quizLinks?: QuizLink[]; wioLab?: WioLabSettings | null; revision: number; publishedTitle: string | null; publishedAt: string | null; publishedRevision: number | null; driveEnabled: boolean };
type ImageBlock = Extract<LessonBlock, { type: "image" }>;
type QuizLink = { quizId: string; label: string };
type QuizOption = { id: string; title: string; publishedTitle: string | null; publishedAt: string | null; trashed?: boolean };

export function LessonLibrary({ teacherId, onError, onDirtyChange }: { teacherId: string; onError: (message: string) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [lessons, setLessons] = useState<LessonRow[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const [title, setTitle] = useState("");
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [blocks, setBlocks] = useState<LessonBlock[]>([]);
  const [revision, setRevision] = useState(0);
  const [videoUrl, setVideoUrl] = useState("");
  const [preview, setPreview] = useState(false);
  const [creationMode, setCreationMode] = useState<"blocks" | "code">("blocks");
  const [images, setImages] = useState<LessonImage[]>([]);
  const [imageTarget, setImageTarget] = useState<{ block?: ImageBlock } | null>(null);
  const currentBlocks = useRef(blocks);
  const [wioLab, setWioLab] = useState<WioLabSettings | null>(null);
  const [quizLinks, setQuizLinks] = useState<QuizLink[]>([]);
  const [quizzes, setQuizzes] = useState<QuizOption[]>([]);
  const [linkQuizId, setLinkQuizId] = useState("");
  const [busy, setBusy] = useState(false);
  const codeImageUrl = useCallback((imageId: string) => lesson ? `/api/lesson-pages/${lesson.id}/images/${imageId}/content` : "", [lesson?.id]);
  const dirty = Boolean(lesson && (lesson.title !== title || JSON.stringify(lesson.blocks) !== JSON.stringify(blocks) || JSON.stringify(lesson.quizLinks ?? []) !== JSON.stringify(quizLinks) || JSON.stringify(lesson.wioLab ?? null) !== JSON.stringify(wioLab)));
  const publicUrl = lesson && location.origin + "/lessons/" + lesson.id;

  useLayoutEffect(() => { currentBlocks.current = blocks; }, [blocks]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty || busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  const load = useCallback(async (trashed = false) => setLessons(await api<LessonRow[]>(`/lesson-pages${trashed ? "?trashed=true" : ""}`)), []);
  useEffect(() => { void load(showTrash).catch((error) => onError(error instanceof Error ? error.message : "โหลดบทเรียนไม่สำเร็จ")); }, [load, onError, showTrash]);
  const loadQuizOptions = useCallback(async () => {
    const [active, trash] = await Promise.all([api<QuizOption[]>("/quizzes"), api<QuizOption[]>("/quizzes?trashed=true")]);
    setQuizzes([...active, ...trash.map((quiz) => ({ ...quiz, trashed: true }))]);
  }, []);
  useEffect(() => { void loadQuizOptions().catch(() => {}); }, [loadQuizOptions]);

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
      setLesson(result); setTitle(result.title); setBlocks(result.blocks); setRevision(result.revision); setImages(nextImages); setQuizLinks(result.quizLinks ?? []); setWioLab(result.wioLab ?? null); setPreview(false); setShowImages(false); setImageTarget(null);
    } catch (error) { onError(error instanceof Error ? error.message : "เปิดบทเรียนไม่สำเร็จ"); }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try { const result = await api<Lesson>("/lesson-pages", { method: "POST", body: JSON.stringify({ title, editorMode: creationMode }) }); await load(); setTitle(result.title); setLesson(result); setBlocks(result.blocks); setRevision(result.revision); setImages([]); setQuizLinks([]); setWioLab(null); setImageTarget(null); }
    catch (error) { onError(error instanceof Error ? error.message : "สร้างบทเรียนไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  async function save(publish = false) {
    if (!lesson) return;
    setBusy(true);
    try {
      const result = await api<Lesson>(`/lesson-pages/${lesson.id}/${publish ? "publish" : "draft"}`, {
        method: publish ? "POST" : "PUT", body: JSON.stringify({ title, blocks, quizLinks, wioLab, expectedRevision: revision }),
      });
      setLesson(result); setTitle(result.title); setBlocks((current) => current === blocks ? result.blocks : current); setRevision(result.revision); setQuizLinks(result.quizLinks ?? []); setWioLab(result.wioLab ?? null); await load();
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

  async function addLessonImage(input: LessonImageInput, signal: AbortSignal) {
    if (!lesson) throw new Error("กรุณาบันทึกบทเรียนก่อนอัปโหลดภาพ");
    const path = `/lesson-pages/${lesson.id}/images`;
    let image: LessonImage;
    if (typeof input === "string") image = await api<LessonImage>(path + "/drive", { method: "POST", body: JSON.stringify({ link: input }), signal });
    else {
      const form = new FormData(); form.set("file", input);
      image = await api<LessonImage>(path, { method: "POST", body: form, signal });
    }
    if (!signal.aborted) setImages((all) => [image, ...all.filter((item) => item.id !== image.id)]);
    return image;
  }

  function useBlockImage(image: LessonImage) {
    const original = imageTarget?.block;
    setImageTarget(null);
    if (!original) {
      setBlocks((all) => [...all, { type: "image", imageId: image.id, alt: image.originalName, caption: "" }]);
    } else if (currentBlocks.current.includes(original)) {
      setBlocks((all) => all.map((item) => item === original ? { ...original, imageId: image.id } : item));
    } else onError("บล็อกรูปภาพเปลี่ยนระหว่างเพิ่มรูป กรุณาเลือกตำแหน่งอีกครั้ง แล้วเลือกรูปจากรายการ");
  }

  function addVideo() {
    const videoId = youtubeVideoId(videoUrl);
    if (!videoId) { onError("กรุณาวางลิงก์ YouTube ที่ถูกต้อง"); return; }
    setBlocks((all) => [...all, { type: "youtube", videoId, caption: "" }]); setVideoUrl("");
  }

  if (!lesson && showImages) return <LessonImageManager onBack={() => setShowImages(false)} onOpen={(id) => void open(id)} />;

  if (!lesson) return <section className="lesson-library">
    <header className="page-heading"><div><p className="eyebrow">เนื้อหาสำหรับนักเรียน</p><h1>บทเรียน</h1><p className="muted page-description">สร้างบทเรียนแล้วส่งลิงก์ให้นักเรียนเปิดอ่าน</p></div></header>
    <div className="lesson-library-toolbar"><button className="button button-quiet" onClick={() => setShowTrash((value) => !value)}>{showTrash ? "← บทเรียนทั้งหมด" : "ถังขยะ"}</button><button className="button button-quiet" onClick={() => setShowImages(true)}>รูปภาพบทเรียน</button></div>
    {!showTrash && <form className="lesson-create" onSubmit={create}><label>ชื่อบทเรียน<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="เช่น การสร้างโมเดล 3 มิติ" required /></label><label>รูปแบบบทเรียน<select value={creationMode} onChange={(event) => setCreationMode(event.target.value as "blocks" | "code")}><option value="blocks">ตัวสร้างบล็อก</option><option value="code">HTML / CSS / JavaScript</option></select></label><button className="button button-primary" disabled={busy}>＋ สร้างบทเรียน</button></form>}
    {!showTrash && <AiImportPanel kind="pack" onImported={(id) => {
      void load().catch((error) => onError(error.message));
      void loadQuizOptions().catch((error) => onError(error.message));
      void open(id);
    }} />}
    <h2>{showTrash ? "ถังขยะบทเรียน" : "บทเรียนของฉัน"}</h2>
    {lessons.length ? <div className="lesson-list">{lessons.map((item) => <div className="lesson-library-row" key={item.id}><button className="lesson-list-item" disabled={showTrash} onClick={() => void open(item.id)}><span><strong>{item.title}</strong><small>{item.publishedAt ? "เผยแพร่แล้ว" : "ฉบับร่าง"} · {item.editorMode === "code" ? "HTML / CSS / JavaScript" : "ตัวสร้างบล็อก"} · แก้ไข {new Intl.DateTimeFormat("th-TH", { dateStyle: "medium" }).format(new Date(item.updatedAt))}</small></span><b>{showTrash ? "อยู่ในถังขยะ" : "แก้ไข ↗"}</b></button>{showTrash ? <div className="lesson-actions"><button className="button button-quiet" onClick={() => void restoreLesson(item)}>กู้คืน</button><button className="button button-danger" onClick={() => void deleteLesson(item)}>ลบถาวร</button></div> : <button className="button button-quiet" onClick={() => void trashLesson(item.id, item.title, item.draftRevision)}>ย้ายไปถังขยะ</button>}</div>)}</div> : <div className="panel lesson-empty"><h2>{showTrash ? "ถังขยะว่าง" : "ยังไม่มีบทเรียน"}</h2><p className="muted">{showTrash ? "บทเรียนที่ย้ายไปถังขยะจะแสดงที่นี่" : "เพิ่มข้อความ รูปภาพ และวิดีโอ YouTube ได้ในแต่ละบทเรียน"}</p></div>}
  </section>;

  return <section className="lesson-editor">
    <header className="page-heading"><div><button className="text-button" onClick={() => { if (dirty && !window.confirm("ออกจากบทเรียนโดยไม่บันทึกการแก้ไขหรือไม่?")) return; setLesson(null); void load(); }}>← บทเรียนทั้งหมด</button><p className="eyebrow">{lesson.publishedAt ? "เผยแพร่แล้ว" : "ฉบับร่าง"}</p><h1>แก้ไขบทเรียน</h1></div><div className="lesson-actions">
      {lesson.publishedAt && publicUrl && <><button className="button button-quiet" onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => onError("คัดลอกลิงก์แล้ว")).catch(() => onError("คัดลอกลิงก์ไม่สำเร็จ"))}>คัดลอกลิงก์</button></>}
      <button className="button button-danger" disabled={busy} onClick={() => void trashLesson(lesson.id, title, revision, dirty)}>ย้ายไปถังขยะ</button>
      <button className="button button-quiet" disabled={busy || !dirty} onClick={() => void save(false)}>บันทึกฉบับร่าง</button>
      <button className="button button-primary" disabled={busy || !dirty && Boolean(lesson.publishedAt)} onClick={() => void save(true)}>{lesson.publishedAt ? "บันทึกและเผยแพร่" : "เผยแพร่"}</button>
      {lesson.publishedAt && <button className="button button-danger" disabled={busy || dirty} onClick={() => void unpublish()}>ยกเลิกเผยแพร่</button>}
    </div></header>
    {revision !== lesson.revision && <p className="notice">บทเรียนนี้ถูกแก้ไขอีกหน้าต่างหนึ่ง กรุณากลับไปโหลดข้อมูลล่าสุดก่อนบันทึก</p>}
    <label className="lesson-title-field">ชื่อบทเรียน<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} /></label>
    {wioLab && <section className="panel learning-panel">
      <h2>แบบฝึก Wio Terminal สำหรับบทเรียน</h2>
      <p className="muted">การมอบหมายบทเรียนที่เผยแพร่แล้วจะสร้างงานจากแบบฝึกนี้ หรือเลือกงานที่มีอยู่ในห้องได้</p>
      <div className="assignment-form"><WioLabSettingsFields lab={wioLab} change={setWioLab} /></div>
    </section>}
    <section className="panel learning-panel">
      <h2>ทดสอบตัวอย่าง Arduino</h2>
      <p className="muted">วางโค้ดตัวอย่างเพื่อตรวจสอบก่อนเผยแพร่ แล้วใส่โค้ดเป็นข้อความที่นักเรียนคัดลอกได้</p>
      <WioDemo key={lesson.id} draftScope={`${teacherId}:lesson:${lesson.id}`} preset={wioLab?.preset} />
    </section>
    <LessonClassAssignments key={lesson.id} id={lesson.id} published={Boolean(lesson.publishedAt)} publishedRevision={lesson.publishedRevision} onError={onError} />
    <section className="panel lesson-quiz-links"><h2>ปุ่มแบบทดสอบในบทเรียน</h2><p className="muted">ปุ่มจะแสดงนอกเนื้อหา HTML และเปิดแบบทดสอบสำหรับนักเรียนที่เข้าสู่ระบบแล้ว</p>
      {quizLinks.map((link, index) => <div className="lesson-quiz-link" key={link.quizId}><label>แบบทดสอบ<select value={link.quizId} onChange={(event) => setQuizLinks((all) => all.map((item, i) => i === index ? { ...item, quizId: event.target.value } : item))}>{quizzes.filter((quiz) => quiz.id === link.quizId || !quiz.trashed).map((quiz) => <option key={quiz.id} value={quiz.id}>{quiz.publishedTitle ?? quiz.title}{quiz.trashed ? " · อยู่ในถังขยะชั่วคราว" : quiz.publishedAt ? " · เผยแพร่แล้ว" : " · ยังไม่เผยแพร่"}</option>)}</select></label><label>ข้อความบนปุ่ม<input value={link.label} maxLength={100} onChange={(event) => setQuizLinks((all) => all.map((item, i) => i === index ? { ...item, label: event.target.value } : item))}/></label><button className="text-button danger" onClick={() => setQuizLinks((all) => all.filter((_, i) => i !== index))}>นำออก</button></div>)}
      <div className="lesson-add-controls"><select aria-label="เลือกแบบทดสอบ" value={linkQuizId} onChange={(event) => setLinkQuizId(event.target.value)}><option value="">เลือกแบบทดสอบ</option>{quizzes.filter((quiz) => !quiz.trashed && !quizLinks.some((link) => link.quizId === quiz.id)).map((quiz) => <option key={quiz.id} value={quiz.id}>{quiz.title}</option>)}</select><button className="button button-quiet" disabled={!linkQuizId} onClick={() => { const quiz = quizzes.find((item) => item.id === linkQuizId); if (quiz) setQuizLinks((all) => [...all, { quizId: quiz.id, label: quiz.publishedTitle ?? quiz.title }]); setLinkQuizId(""); }}>＋ เพิ่มปุ่มแบบทดสอบ</button></div>
    </section>
    {lesson.editorMode === "code" ? <CodeLessonEditor key={lesson.id} code={blocks[0] as CodeBlock} images={images} imageUrl={codeImageUrl}
      driveEnabled={lesson.driveEnabled} onAdd={addLessonImage} onChange={(update) => setBlocks((all) => [update(all[0] as CodeBlock)])} /> : <div className="lesson-block-list">{blocks.map((item, index) => <article className="lesson-block-editor" key={index}>
      <header><strong>{item.type === "text" ? "ข้อความ" : item.type === "image" ? "รูปภาพ" : "YouTube"}</strong><div><button aria-label="เลื่อนขึ้น" disabled={!index} onClick={() => setBlocks((all) => { const next = [...all]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>↑</button><button aria-label="เลื่อนลง" disabled={index === blocks.length - 1} onClick={() => setBlocks((all) => { const next = [...all]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next; })}>↓</button><button className="text-button danger" onClick={() => setBlocks((all) => all.filter((_, i) => i !== index))}>ลบ</button></div></header>
      {item.type === "text" ? <><label>หัวข้อย่อย<input value={item.heading ?? ""} onChange={(event) => updateBlock(index, { heading: event.target.value })} maxLength={120} /></label><label>ข้อความ<textarea rows={5} value={item.text} onChange={(event) => updateBlock(index, { text: event.target.value })} maxLength={10000} /></label></> : item.type === "image" ? <><LessonImagePreview className="lesson-editor-image" src={codeImageUrl(item.imageId)} alt={item.alt} /><label>คำอธิบายภาพ<input value={item.alt} onChange={(event) => updateBlock(index, { alt: event.target.value })} maxLength={300} /></label><label>คำบรรยาย<input value={item.caption ?? ""} onChange={(event) => updateBlock(index, { caption: event.target.value })} maxLength={500} /></label><button className="text-button" aria-expanded={imageTarget?.block === item} onClick={() => setImageTarget({ block: item })}>เปลี่ยนรูปภาพ</button>
        {imageTarget?.block === item && <LessonImagePicker images={images} imageUrl={codeImageUrl} driveEnabled={lesson.driveEnabled} onAdd={addLessonImage} onChoose={useBlockImage} onClose={() => setImageTarget(null)} replacing />}
      </> : item.type === "youtube" ? <><a href={`https://www.youtube.com/watch?v=${item.videoId}`} target="_blank" rel="noreferrer">เปิดวิดีโอ YouTube</a><label>คำบรรยาย<input value={item.caption ?? ""} onChange={(event) => updateBlock(index, { caption: event.target.value })} maxLength={500} /></label></> : null}
    </article>)}</div>}
    {lesson.editorMode === "blocks" && (
      <>
        <div className="lesson-add-controls">
          <button className="button button-quiet" onClick={() => setBlocks((all) => [...all, { type: "text", heading: "", text: "" }])}>＋ เพิ่มข้อความ</button>
          <button className="button button-quiet" aria-expanded={Boolean(imageTarget && !imageTarget.block)} onClick={() => setImageTarget({})}>＋ เพิ่มรูปภาพ</button>
          <div><input aria-label="ลิงก์ YouTube" value={videoUrl} onChange={(event) => setVideoUrl(event.target.value)} placeholder="วางลิงก์ YouTube" /><button className="button button-quiet" onClick={addVideo}>＋ เพิ่มวิดีโอ</button></div>
        </div>
        {imageTarget && !imageTarget.block && <LessonImagePicker images={images} imageUrl={codeImageUrl} driveEnabled={lesson.driveEnabled} onAdd={addLessonImage} onChoose={useBlockImage} onClose={() => setImageTarget(null)} replacing={false} />}
        <label className="lesson-preview-toggle"><input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)} /> แสดงตัวอย่างบทเรียน</label>
        {preview && <div className="lesson-reading panel"><LessonContent title={title} blocks={blocks} imageUrl={codeImageUrl} /></div>}
      </>
    )}
    {lesson.editorMode === "code" && <CodeLessonFrame code={blocks[0] as CodeBlock} imageUrl={codeImageUrl} />}
  </section>;
}
