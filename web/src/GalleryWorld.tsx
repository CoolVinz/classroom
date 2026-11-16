import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Client } from "@colyseus/sdk";
import { api } from "./api";
import { StudentAttendance } from "./StudentAttendance";
import ModelPreview from "./ModelPreview";
import { loadModel } from "./model-view";
import { galleryFileUrl, galleryTicketRequest } from "./gallery-api";
import { createAvatarCharacter, defaultAvatarAppearance, disposeAvatarCharacter, type AvatarAppearance } from "./gallery-avatar";

type User = { role: "owner" | "teacher" | "student"; displayName: string };
type GalleryModel = { id: string; studentId: string; displayName: string; studentNumber: number | null; assignmentId: string; assignmentTitle: string; originalName: string; mediaType: string; thumbnailAvailable: boolean; createdAt: string; hidden: boolean; likes: number; likedByMe: boolean };
type Manifest = { classroomId: string; classroomName: string; blocks: { studentId: string; displayName: string; studentNumber: number | null; blockIndex: number; archived: boolean }[]; models: GalleryModel[]; nextOffset: number | null; teacher: boolean; viewerStudentId: string | null };
type Avatar = AvatarAppearance & { displayName: string; role: string; x: number; z: number; rotation: number };

function apiPath(classroomId: string, suffix = "") { return `/classrooms/${classroomId}/gallery${suffix}`; }
function blockPosition(index: number) { return { x: ((index % 4) - 1.5) * 9, z: Math.floor(index / 4) * -9 }; }
function colorFor(value: string) { let hash = 0; for (const ch of value) hash = (hash * 31 + ch.charCodeAt(0)) | 0; return new THREE.Color().setHSL((Math.abs(hash) % 360) / 360, 0.48, 0.56); }

export function GalleryWorld({ classroomId, user, close }: { classroomId: string; user: User; close?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const manifestRef = useRef(manifest);
  const [config, setConfig] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [models, setModels] = useState<GalleryModel[]>([]);
  const modelsRef = useRef(models);
  const [selected, setSelected] = useState<GalleryModel | null>(null);
  const [preview, setPreview] = useState<GalleryModel | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(0);
  const roomRef = useRef<any>(null);
  const [appearance, setAppearance] = useState<AvatarAppearance>(defaultAvatarAppearance);
  const [draftAppearance, setDraftAppearance] = useState<AvatarAppearance>(defaultAvatarAppearance);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const customizerOpenRef = useRef(false);
  const teacher = user.role !== "student";
  useEffect(() => { modelsRef.current = models; }, [models]);
  useEffect(() => { manifestRef.current = manifest; }, [manifest]);
  customizerOpenRef.current = customizerOpen;
  const load = useCallback(async (offset = 0) => {
    const value = await api<Manifest>(apiPath(classroomId, `?offset=${offset}`));
    setManifest(value); setEnabled(value.teacher ? true : true);
    setModels((current) => offset ? [...current, ...value.models] : value.models);
  }, [classroomId]);

  useEffect(() => {
    let alive = true;
    void api<AvatarAppearance>("/gallery/avatar").then((value) => { if (alive) setAppearance(value); }).catch(() => {});
    void api<{ url: string }>("/gallery/config").then((server) => { if (alive) setConfig(server.url); }).catch(() => {});
    void api<Manifest>(apiPath(classroomId)).then((value) => {
      if (alive) { setManifest(value); setEnabled(true); setModels(value.models); }
    }).catch((reason) => {
      if (!alive) return;
      setEnabled(false);
      if (!teacher) setError(reason instanceof Error ? reason.message : "เปิดโลกเสมือนไม่สำเร็จ");
    });
    return () => { alive = false; };
  }, [classroomId, teacher]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !manifest || !config) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); }
    catch { setError("อุปกรณ์นี้ไม่รองรับการแสดงโลกสามมิติ"); return; }
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#cce7ed");
    scene.fog = new THREE.Fog("#cce7ed", 45, 150);
    scene.add(new THREE.HemisphereLight(0xeafaff, 0x667263, 2.2));
    const sun = new THREE.DirectionalLight(0xfff5da, 2.5); sun.position.set(10, 25, 12); scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshStandardMaterial({ color: 0xd9e5d4 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.04; scene.add(floor);
    const grid = new THREE.GridHelper(1000, 100, 0x9eaf9b, 0xb7c6b5); grid.position.y = 0; scene.add(grid);
    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 800);
    const avatarMeshes = new Map<string, THREE.Group>();
    const modelMeshes = new Map<string, THREE.Object3D>();
    const renderedModels = new Set<string>();
    const raycastables: THREE.Object3D[] = [];
    const textures: THREE.Texture[] = [];
    const loader = new THREE.TextureLoader();
    const labelTexture = (text: string) => {
      const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 96;
      const context = canvas.getContext("2d")!; context.fillStyle = "#ffffff"; context.fillRect(0, 0, 512, 96); context.fillStyle = "#17454b"; context.font = "bold 35px sans-serif"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(text.slice(0, 30), 256, 48);
      const texture = new THREE.CanvasTexture(canvas); textures.push(texture); return texture;
    };
    const blockMap = new Map<string, Manifest["blocks"][number]>();
    const blockGroups = new Map<string, THREE.Group>();
    const addBlock = (block: Manifest["blocks"][number]) => {
      const position = blockPosition(block.blockIndex); const group = new THREE.Group(); group.position.set(position.x, 0, position.z); scene.add(group);
      const platform = new THREE.Mesh(new THREE.BoxGeometry(7, 0.55, 6), new THREE.MeshStandardMaterial({ color: colorFor(block.studentId) })); platform.position.y = 0.28; group.add(platform);
      const back = new THREE.Mesh(new THREE.BoxGeometry(6.2, 3.7, 0.28), new THREE.MeshStandardMaterial({ color: 0xf5f3e9 })); back.position.set(0, 2.15, -2.1); group.add(back);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(5.3, 0.9), new THREE.MeshBasicMaterial({ map: labelTexture(`${block.studentNumber ?? "—"} · ${block.displayName}`) })); label.position.set(0, 4.1, -1.9); group.add(label);
      blockMap.set(block.studentId, block); blockGroups.set(block.studentId, group);
    };
    const syncBlocks = () => {
      const blocks = manifestRef.current?.blocks ?? [], current = new Set(blocks.map((block) => block.studentId));
      for (const block of blocks) if (!blockGroups.has(block.studentId)) addBlock(block);
      for (const [studentId, group] of blockGroups) if (!current.has(studentId)) { scene.remove(group); blockGroups.delete(studentId); blockMap.delete(studentId); }
    };
    syncBlocks();
    const addExhibit = (item: GalleryModel) => {
      const block = blockMap.get(item.studentId); if (!block) return;
      const owned = modelsRef.current.filter((candidate) => candidate.studentId === item.studentId && !candidate.hidden);
      const slot = owned.findIndex((candidate) => candidate.id === item.id);
      const base = blockPosition(block.blockIndex);
      const exhibit = new THREE.Group(); exhibit.position.set(base.x - 2.2 + slot * 1.45, 1.3 + (slot % 2) * 0.3, base.z - 1.1); scene.add(exhibit);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1.25, 0.12), new THREE.MeshStandardMaterial({ color: 0xf4f6f2 })); panel.position.z = -0.08; exhibit.add(panel);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.08, 0.82), new THREE.MeshBasicMaterial({ color: 0xb8d1d1 })); screen.position.set(0, 0.12, 0.0); exhibit.add(screen);
      if (item.thumbnailAvailable) loader.load(galleryFileUrl(classroomId, item.id, "thumbnail"), (texture) => { textures.push(texture); (screen.material as THREE.MeshBasicMaterial).map = texture; screen.material.needsUpdate = true; }, undefined, () => {});
      const plaque = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.28), new THREE.MeshBasicMaterial({ map: labelTexture(item.originalName.slice(0, 22)) })); plaque.position.set(0, -0.54, 0.07); exhibit.add(plaque);
      (panel as THREE.Mesh).userData.model = item; raycastables.push(panel); modelMeshes.set(item.id, exhibit);
      renderedModels.add(item.id);
    };
    const syncExhibits = () => {
      for (const item of modelsRef.current) if (!item.hidden && !renderedModels.has(item.id)) addExhibit(item);
      const visible = new Set(modelsRef.current.filter((item) => !item.hidden).map((item) => item.id));
      for (const modelId of renderedModels) if (!visible.has(modelId)) {
        const exhibit = modelMeshes.get(modelId); if (exhibit) { scene.remove(exhibit); modelMeshes.delete(modelId); }
        for (let i = raycastables.length - 1; i >= 0; i--) if (raycastables[i].userData.model?.id === modelId) raycastables.splice(i, 1);
        renderedModels.delete(modelId);
      }
    };
    syncExhibits();
    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2(); let drag = false; let lastX = 0; let startX = 0; let startY = 0; let yaw = 0; let cameraPitch = 0.34;
    const keys = new Set<string>(); const keyDown = (event: KeyboardEvent) => { if (["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); if (customizerOpenRef.current) return; keys.add(event.key.toLowerCase()); } };
    const keyUp = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
    const onBlur = () => keys.clear();
    const onPointerDown = (event: PointerEvent) => { if (customizerOpenRef.current) return; drag = true; lastX = event.clientX; startX = event.clientX; startY = event.clientY; canvas.setPointerCapture(event.pointerId); };
    const onPointerMove = (event: PointerEvent) => { if (!drag || customizerOpenRef.current) return; const delta = event.clientX - lastX; yaw -= delta * 0.005; cameraPitch = THREE.MathUtils.clamp(cameraPitch - event.movementY * 0.003, 0.08, 0.85); lastX = event.clientX; };
    const onPointerUp = (event: PointerEvent) => { if (!drag) return; drag = false; if (!customizerOpenRef.current && Math.hypot(event.clientX - startX, event.clientY - startY) < 5) { const rect = canvas.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(raycastables, false)[0]; if (hit?.object.userData.model) setSelected(hit.object.userData.model as GalleryModel); } };
    const resize = () => { const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", onPointerDown); canvas.addEventListener("pointermove", onPointerMove); canvas.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", keyDown); window.addEventListener("keyup", keyUp); window.addEventListener("blur", onBlur);
    let alive = true, frame = 0, lastSend = 0, lastFrame = performance.now(), local = { x: 0, z: 0, rotation: 0 }, room: any;
    const modelAbort = new AbortController();
    const client = new Client(config);
    const cleanup = () => { alive = false; cancelAnimationFrame(frame); room?.leave(); roomRef.current = null; observer.disconnect(); scene.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose?.(); const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []; materials.forEach((material) => material.dispose()); }); renderer.dispose(); renderer.forceContextLoss(); textures.forEach((texture) => texture.dispose()); avatarMeshes.clear(); window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", onBlur); canvas.removeEventListener("pointerdown", onPointerDown); canvas.removeEventListener("pointermove", onPointerMove); canvas.removeEventListener("pointerup", onPointerUp); };
    const ticketRequest = galleryTicketRequest(classroomId);
    void api<{ ticket: string; url: string }>(ticketRequest.path, ticketRequest.options).then(async ({ ticket }) => {
      if (!alive) return;
      room = await client.joinOrCreate("classroom", { classroomId, ticket });
      roomRef.current = room;
      room.onMessage("gallery-refresh", () => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "โหลดผลงานใหม่ไม่สำเร็จ")); });
      room.onStateChange((state: any) => {
        setOnline(state.players.size);
        const present = new Set<string>();
        state.players.forEach((player: Avatar, id: string) => {
          present.add(id); let avatar = avatarMeshes.get(id);
          const currentAppearance = JSON.stringify({ skinColor: player.skinColor, hairColor: player.hairColor, shirtColor: player.shirtColor, trousersColor: player.trousersColor, hairStyle: player.hairStyle });
          if (!avatar) { avatar = new THREE.Group(); const character = createAvatarCharacter(player); character.userData.appearance = currentAppearance; avatar.add(character); avatar.userData.character = character; const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(player.role === "teacher" || player.role === "owner" ? `ครู ${player.displayName}` : player.displayName), transparent: true })); label.scale.set(2.6, 0.5, 1); label.position.y = 2.25; avatar.add(label); scene.add(avatar); avatarMeshes.set(id, avatar); }
          else if (avatar.userData.character?.userData.appearance !== currentAppearance) { const previous = avatar.userData.character as THREE.Object3D | undefined; if (previous) { avatar.remove(previous); disposeAvatarCharacter(previous); } const character = createAvatarCharacter(player); character.userData.appearance = currentAppearance; avatar.add(character); avatar.userData.character = character; }
          avatar.position.set(player.x, 0, player.z); avatar.rotation.y = player.rotation;
          if (id === room.sessionId) local = { x: player.x, z: player.z, rotation: player.rotation };
        });
        for (const [id, avatar] of avatarMeshes) if (!present.has(id)) { scene.remove(avatar); avatarMeshes.delete(id); }
      });
    }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "เชื่อมต่อโลกเสมือนไม่สำเร็จ"); });
    void (async () => {
      let residentTriangles = 0;
      const nearby = [...modelsRef.current].filter((item) => !item.hidden).sort((a, b) => {
        const pa = blockPosition(blockMap.get(a.studentId)?.blockIndex ?? 0), pb = blockPosition(blockMap.get(b.studentId)?.blockIndex ?? 0);
        return Math.hypot(pa.x, pa.z) - Math.hypot(pb.x, pb.z);
      }).slice(0, 12);
      for (const item of nearby) {
        if (modelAbort.signal.aborted) return;
        try {
          const parsed = await loadModel(item, galleryFileUrl(classroomId, item.id, "content"), modelAbort.signal);
          if (residentTriangles + parsed.triangles > 1_000_000) continue;
          residentTriangles += parsed.triangles;
          const exhibit = modelMeshes.get(item.id); if (!exhibit) continue;
          const object = new THREE.Group();
          const geometries: THREE.BufferGeometry[] = [];
          for (const part of parsed.parts) {
            const geometry = new THREE.BufferGeometry(); geometries.push(geometry);
            geometry.setAttribute("position", new THREE.BufferAttribute(part.positions, 3)); geometry.setAttribute("normal", new THREE.BufferAttribute(part.normals, 3));
            if (part.indices) geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
            object.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x4b9a80, roughness: 0.72 })));
          }
          const bounds = new THREE.Box3().setFromObject(object), center = bounds.getCenter(new THREE.Vector3()), radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.1);
          object.position.sub(center); object.scale.setScalar(1.2 / radius); object.position.y += 0.25;
          exhibit.add(object);
        } catch { /* The saved thumbnail remains available when a model cannot be parsed. */ }
      }
    })();
    const render = (time: number) => {
      if (!alive) return; frame = requestAnimationFrame(render); const dt = Math.min((time - lastFrame) / 1000, 0.05); lastFrame = time;
      syncBlocks();
      syncExhibits();
      const forward = Number(keys.has("w") || keys.has("arrowup") || touchRef.current.z < -0.15) - Number(keys.has("s") || keys.has("arrowdown") || touchRef.current.z > 0.15);
      const side = Number(keys.has("d") || keys.has("arrowright") || touchRef.current.x > 0.15) - Number(keys.has("a") || keys.has("arrowleft") || touchRef.current.x < -0.15);
      if (customizerOpenRef.current) { keys.clear(); touchRef.current.x = 0; touchRef.current.z = 0; }
      if (!customizerOpenRef.current && (forward || side)) { const direction = yaw; local.x += (Math.sin(direction) * forward + Math.cos(direction) * side) * 5 * dt; local.z += (-Math.cos(direction) * forward + Math.sin(direction) * side) * 5 * dt; local.rotation = Math.atan2(local.x - camera.position.x, local.z - camera.position.z); }
      const self = room && avatarMeshes.get(room.sessionId); if (self) { self.position.set(local.x, 0, local.z); self.rotation.y = local.rotation; }
      if (room && !customizerOpenRef.current && time - lastSend > 100) { room.send("move", local); lastSend = time; }
      const distance = 8 + cameraPitch * 10; camera.position.set(local.x + Math.sin(yaw) * distance, 2 + cameraPitch * 10, local.z + Math.cos(yaw) * distance); camera.lookAt(local.x, 1.2, local.z);
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(render);
    return () => { modelAbort.abort(); cleanup(); };
  }, [classroomId, config, Boolean(manifest), load]);

  async function setWorld(value: boolean) {
    setLoading(true); setError("");
    try { await api(apiPath(classroomId), { method: "PUT", body: JSON.stringify({ enabled: value }) }); setEnabled(value); if (value) await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกการตั้งค่าไม่สำเร็จ"); }
    finally { setLoading(false); }
  }
  async function setHidden(model: GalleryModel) {
    try { await api(apiPath(classroomId, `/files/${model.id}/visibility`), { method: "PUT", body: JSON.stringify({ hidden: !model.hidden }) }); setModels((all) => all.map((item) => item.id === model.id ? { ...item, hidden: !item.hidden } : item)); setSelected(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "เปลี่ยนการแสดงโมเดลไม่สำเร็จ"); }
  }
  async function like(model: GalleryModel) {
    try {
      const result = await api<{ likes: number }>(apiPath(classroomId, `/files/${model.id}/like`), { method: model.likedByMe ? "DELETE" : "PUT" });
      setModels((all) => all.map((item) => item.id === model.id ? { ...item, likes: result.likes, likedByMe: !item.likedByMe } : item));
      setSelected((item) => item?.id === model.id ? { ...item, likes: result.likes, likedByMe: !item.likedByMe } : item);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกการถูกใจไม่สำเร็จ"); }
  }

  async function saveAppearance() {
    setLoading(true); setError("");
    try {
      const saved = await api<AvatarAppearance>("/gallery/avatar", { method: "PUT", body: JSON.stringify(draftAppearance) });
      setAppearance(saved); setDraftAppearance(saved); setCustomizerOpen(false);
      roomRef.current?.send("refresh-avatar");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกตัวละครไม่สำเร็จ"); }
    finally { setLoading(false); }
  }

  if (enabled === false && teacher) return <section className="panel gallery-enable"><h2>โลกเสมือน · {manifest?.classroomName ?? "ห้องเรียน"}</h2><p className="muted">เปิดโลกเพื่อให้นักเรียนและครูเดินชมผลงานโมเดล 3 มิติในห้องเรียน</p><button className="button button-primary" disabled={loading} onClick={() => void setWorld(true)}>{loading ? "กำลังเปิด…" : "เปิดโลกเสมือน"}</button>{error && <p className="form-error">{error}</p>}</section>;
  if (enabled === false && !teacher) return <main className="public-lesson-page"><section className="panel"><h2>โลกเสมือนยังไม่พร้อม</h2><p>{error || "กรุณากลับไปยังห้องเรียนแล้วลองอีกครั้ง."}</p><a href="/">กลับไปห้องเรียน</a></section></main>;
  return <>{user.role === "student" && <div className="gallery-attendance"><StudentAttendance /></div>}<section className="gallery-shell"><header className="gallery-toolbar"><div><strong>{manifest?.classroomName ?? "โลกเสมือน"}</strong><small>{online} คนออนไลน์ · WASD เดิน · ลากหน้าจอเพื่อหมุนมุมมอง</small></div><div className="gallery-toolbar-actions"><button className="button button-quiet" onClick={() => { setDraftAppearance({ ...appearance }); setCustomizerOpen(true); }}>ปรับแต่งตัวละคร</button>{close && <button className="button button-quiet" onClick={close}>กลับ</button>}</div></header>{error && <div className="notice" role="alert">{error}</div>}{!config && <p className="gallery-service-note">ยังไม่ได้ตั้งค่า Colyseus ใน Coolify</p>}<canvas ref={canvasRef} className="gallery-canvas" aria-label="โลกเสมือนห้องเรียน กด WASD เพื่อเดินและลากหน้าจอเพื่อหมุนมุมมอง"/><div className="gallery-touch" onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={(event) => { const rect = event.currentTarget.getBoundingClientRect(); touchRef.current.x = (event.clientX - rect.left) / rect.width * 2 - 1; touchRef.current.z = (event.clientY - rect.top) / rect.height * 2 - 1; }} onPointerUp={() => { touchRef.current.x = 0; touchRef.current.z = 0; }} aria-label="ควบคุมการเดินด้วยสัมผัส">◉</div>{manifest?.nextOffset !== null && <button className="gallery-more button button-quiet" onClick={() => void load(manifest?.nextOffset ?? 0)}>โหลดผลงานเพิ่ม</button>}{teacher && models.some((item) => item.hidden) && <aside className="gallery-hidden-tray"><strong>ผลงานที่ซ่อน</strong>{models.filter((item) => item.hidden).map((item) => <div key={item.id}><span>{item.displayName} · {item.originalName}</span><button className="text-button" onClick={() => void setHidden(item)}>แสดง</button></div>)}</aside>}{selected && <aside className="gallery-inspect"><button className="icon-button" onClick={() => setSelected(null)} aria-label="ปิด">×</button><p className="eyebrow">{selected.displayName} · เลขที่ {selected.studentNumber ?? "—"}</p><h3>{selected.originalName}</h3><p className="muted">{selected.assignmentTitle}</p><p>{selected.likes} ถูกใจ</p>{user.role === "student" && selected.studentId !== manifest?.viewerStudentId && <button className="button button-quiet" onClick={() => void like(selected)}>{selected.likedByMe ? "ยกเลิกถูกใจ" : "ถูกใจ"}</button>}{teacher && <button className="button button-quiet" onClick={() => void setHidden(selected)}>{selected.hidden ? "แสดงผลงาน" : "ซ่อนผลงาน"}</button>}<button className="button button-primary" onClick={() => setPreview(selected)}>เปิดดูโมเดล</button></aside>}{customizerOpen && <CharacterCustomizer appearance={draftAppearance} onChange={setDraftAppearance} onCancel={() => setCustomizerOpen(false)} onSave={() => void saveAppearance()} saving={loading} error={error} />}</section>{preview && <ModelPreview file={preview} contentPath={galleryFileUrl(classroomId, preview.id, "content")} close={() => setPreview(null)} />}</>;
}

function CharacterCustomizer({ appearance, onChange, onCancel, onSave, saving, error }: { appearance: AvatarAppearance; onChange: (value: AvatarAppearance) => void; onCancel: () => void; onSave: () => void; saving: boolean; error: string }) {
  return <div className="character-editor-backdrop"><section className="character-editor" role="dialog" aria-modal="true" aria-labelledby="character-editor-title">
    <header><h2 id="character-editor-title">ปรับแต่งตัวละคร</h2><button className="icon-button" onClick={onCancel} aria-label="ยกเลิก">×</button></header>
    {error && <p className="form-error" role="alert">{error}</p>}<CharacterPreview appearance={appearance} />
    <div className="character-controls">
      {([["skinColor", "สีผิว"], ["hairColor", "สีผม"], ["shirtColor", "เสื้อ"], ["trousersColor", "กางเกง"]] as const).map(([key, label]) => <label key={key}>{label}<input type="color" value={appearance[key]} onChange={(event) => onChange({ ...appearance, [key]: event.target.value })} /></label>)}
      <label className="character-hair-style">ทรงผม<select value={appearance.hairStyle} onChange={(event) => onChange({ ...appearance, hairStyle: event.target.value as AvatarAppearance["hairStyle"] })}><option value="none">ไม่มีผม</option><option value="short">สั้น</option><option value="long">ยาว</option></select></label>
    </div>
    <footer><button className="button button-quiet" onClick={onCancel} disabled={saving}>ยกเลิก</button><button className="button button-primary" onClick={onSave} disabled={saving}>{saving ? "กำลังบันทึก…" : "บันทึกตัวละคร"}</button></footer>
  </section></div>;
}

function CharacterPreview({ appearance }: { appearance: AvatarAppearance }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const characterRef = useRef<THREE.Group | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true }); } catch { return; }
    const scene = new THREE.Scene(); sceneRef.current = scene; scene.add(new THREE.HemisphereLight(0xffffff, 0x65736f, 2));
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20); camera.position.set(0, 1.35, 5.6); camera.lookAt(0, 1, 0);
    const resize = () => { renderer.setSize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight), false); camera.aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1); camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    let frame = 0, alive = true;
    const render = () => { if (!alive) return; frame = requestAnimationFrame(render); if (characterRef.current) characterRef.current.rotation.y += 0.006; renderer.render(scene, camera); };
    render();
    return () => { alive = false; cancelAnimationFrame(frame); observer.disconnect(); scene.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose?.(); const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []; materials.forEach((material) => material.dispose()); }); renderer.dispose(); renderer.forceContextLoss(); sceneRef.current = null; characterRef.current = null; };
  }, []);
  useEffect(() => {
    const scene = sceneRef.current; if (!scene) return;
    if (characterRef.current) { scene.remove(characterRef.current); disposeAvatarCharacter(characterRef.current); }
    const character = createAvatarCharacter(appearance); character.position.y = -0.02; scene.add(character); characterRef.current = character;
  }, [appearance]);
  return <canvas ref={canvasRef} className="character-preview" aria-label="ตัวอย่างตัวละครที่กำลังหมุน" />;
}

const touchRef = { current: { x: 0, z: 0 } };
