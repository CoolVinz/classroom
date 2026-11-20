import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as THREE from "three";
import { Client } from "@colyseus/sdk";
import { api } from "./api";
import { StudentAttendance } from "./StudentAttendance";
import ModelPreview from "./ModelPreview";
import { loadModel, createModelObject, disposeModelObject } from "./model-view";
import { galleryFileUrl, galleryTicketRequest } from "./gallery-api";
import { animateAvatarCharacter, createAvatarCharacter, defaultAvatarAppearance, disposeAvatarCharacter, type AvatarAppearance } from "./gallery-avatar";
import { correctionOffset, facingRotation, interpolateTrain, jumpHeight, reconcilePosition, touchDirection, walkingStep, type Move, type TrainSample } from "./gallery-motion";
import { canvasAimPoint, wandAim } from "./gallery-aim";
import { enterGalleryFullscreen, unlockGalleryOrientation } from "./gallery-fullscreen";
import { blockPosition, exhibitPosition, trainTrack } from "../../gallery-server/src/train-layout.mjs";
import { canBoardTrain } from "../../gallery-server/src/train-rules.mjs";

type User = { role: "owner" | "teacher" | "student"; displayName: string };
type GalleryModel = { id: string; studentId: string; displayName: string; studentNumber: number | null; assignmentId: string; assignmentTitle: string; originalName: string; mediaType: string; materialAvailable: boolean; thumbnailAvailable: boolean; createdAt: string; hidden: boolean; likes: number; likedByMe: boolean };
type TrainSettings = { mode: "auto" | "manual"; intervalSeconds: 60 | 120; startStudentId: string | null };
type TrainView = TrainSettings & { active: boolean; x: number; z: number; rotation: number; phase: "waiting" | "boarding" | "moving" | "dwell"; stopId: string; nextStopId: string; departureAt: number; arrivalAt: number; seats: number; revision: number; layoutRoster: string };
type Manifest = { enabled: boolean; classroomId: string; classroomName: string; blocks: { studentId: string; displayName: string; studentNumber: number | null; blockIndex: number; layoutIndex: number; archived: boolean }[]; models: GalleryModel[]; nextOffset: number | null; teacher: boolean; viewerStudentId: string | null; train: TrainSettings };
type Avatar = AvatarAppearance & { displayName: string; role: string; x: number; z: number; rotation: number; sequence?: number; jump?: number; movementEpoch?: number; knocked?: boolean; respawnAt?: number; protectedUntil?: number; trainSeat?: number };
type BoltVisual = { group: THREE.Group; trail: THREE.Line; target: THREE.Vector3 };

function apiPath(classroomId: string, suffix = "") { return `/classrooms/${classroomId}/gallery${suffix}`; }
function colorFor(value: string) { let hash = 0; for (const ch of value) hash = (hash * 31 + ch.charCodeAt(0)) | 0; return new THREE.Color().setHSL((Math.abs(hash) % 360) / 360, 0.48, 0.56); }
function stationLabel(id: string, blocks: Manifest["blocks"]) { if (!id || id === "entrance") return "สถานีทางเข้า"; const row = Number(id.slice(4)); const first = blocks.find((block) => Math.ceil((block.layoutIndex + 1) / 4) === row && block.studentNumber !== null); return first ? `สถานีแถวที่ ${row} · เลขที่ ${first.studentNumber}` : `สถานีแถวที่ ${row}`; }
function countdown(at: number, now: number) { const seconds = Math.max(0, Math.ceil((at - now) / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function moveTouchJoystick(event: ReactPointerEvent<HTMLDivElement>, knob: HTMLSpanElement | null, value: { x: number; z: number }) {
  const rect = event.currentTarget.getBoundingClientRect(), radius = rect.width * 0.29;
  const direction = touchDirection(event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2, radius);
  value.x = direction.x; value.z = direction.z;
  if (knob) knob.style.transform = `translate(${direction.x * radius}px, ${direction.z * radius}px)`;
}
function resetTouchJoystick(knob: HTMLSpanElement | null, value: { x: number; z: number }) {
  value.x = 0; value.z = 0;
  if (knob) knob.style.transform = "translate(0, 0)";
}

export function GalleryWorld({ classroomId, user, close, logout }: { classroomId: string; user: User; close?: () => void; logout?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const manifestRef = useRef(manifest);
  const [config, setConfig] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [models, setModels] = useState<GalleryModel[]>([]);
  const modelsRef = useRef(models);
  const [displayPages, setDisplayPages] = useState<Record<string, number>>({});
  const displayPagesRef = useRef(displayPages);
  const [selected, setSelected] = useState<GalleryModel | null>(null);
  const [preview, setPreview] = useState<GalleryModel | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(0);
  const [trainView, setTrainView] = useState<TrainView | null>(null);
  const [trainClock, setTrainClock] = useState(Date.now());
  const [trainSeat, setTrainSeat] = useState(-1);
  const [trainAction, setTrainAction] = useState<"board" | "leave" | null>(null);
  const [trainForm, setTrainForm] = useState<TrainSettings>({ mode: "auto", intervalSeconds: 120, startStudentId: null });
  const [trainMessage, setTrainMessage] = useState("");
  const trainRef = useRef<TrainView | null>(null);
  const trainSeatRef = useRef(-1);
  const lastSavedTrainSettings = useRef<TrainSettings | null>(null);
  const [wandMode, setWandMode] = useState(false);
  const [aimValid, setAimValid] = useState(false);
  const crosshairRef = useRef<HTMLDivElement>(null);
  const aimPoint = useRef(new THREE.Vector2());
  const [castReady, setCastReady] = useState(true);
  const [knockSeconds, setKnockSeconds] = useState(0);
  const roomRef = useRef<any>(null);
  const wandRef = useRef(false);
  const knockedRef = useRef(false);
  const fireWandRef = useRef<() => void>(() => {});
  const lastKnockSecond = useRef(-1);
  const castReadyAt = useRef(0);
  const knockUntil = useRef(0);
  const boltMeshes = useRef(new Map<string, BoltVisual>());
  const effectMeshes = useRef<Array<{ mesh: THREE.Mesh; until: number }>>([]);
  const [appearance, setAppearance] = useState<AvatarAppearance>(defaultAvatarAppearance);
  const [draftAppearance, setDraftAppearance] = useState<AvatarAppearance>(defaultAvatarAppearance);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [immersive, setImmersive] = useState(true);
  const [landscapeRequired, setLandscapeRequired] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(Boolean(document.fullscreenElement));
  const customizerOpenRef = useRef(false);
  const appearanceRef = useRef(appearance);
  const touchRef = useRef({ x: 0, z: 0 });
  const touchKnobRef = useRef<HTMLSpanElement>(null);
  const landscapeRequiredRef = useRef(false);
  const jumpRef = useRef(false);
  const teacher = user.role !== "student";
  useEffect(() => { document.documentElement.classList.toggle("gallery-immersive", immersive); }, [immersive]);
  useEffect(() => {
    const onFullscreenChange = () => { const active = Boolean(document.fullscreenElement); setNativeFullscreen(active); if (!active) { setImmersive(false); unlockGalleryOrientation(); } };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.fullscreenElement) setImmersive(false); };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("fullscreenchange", onFullscreenChange); window.removeEventListener("keydown", onKeyDown); };
  }, []);
  useEffect(() => () => { window.setTimeout(() => {
    if (document.querySelector(".gallery-shell")) return;
    document.documentElement.classList.remove("gallery-immersive");
    unlockGalleryOrientation();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, 0); }, []);
  useEffect(() => {
    aimPoint.current.set(0, 0);
    setAimValid(false);
    if (crosshairRef.current) { crosshairRef.current.style.left = "50%"; crosshairRef.current.style.top = "50%"; }
  }, [wandMode]);
  useEffect(() => {
    if (!knockSeconds) return;
    const timer = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((knockUntil.current - Date.now()) / 1000));
      setKnockSeconds((current) => current === seconds ? current : seconds);
    }, 200);
    return () => window.clearInterval(timer);
  }, [knockSeconds > 0]);
  useEffect(() => { modelsRef.current = models; }, [models]);
  useEffect(() => { displayPagesRef.current = displayPages; }, [displayPages]);
  useEffect(() => { manifestRef.current = manifest; }, [manifest]);
  useEffect(() => {
    if (!manifest?.train) return;
    if (!lastSavedTrainSettings.current || JSON.stringify(lastSavedTrainSettings.current) !== JSON.stringify(manifest.train)) {
      lastSavedTrainSettings.current = { ...manifest.train }; setTrainForm({ ...manifest.train });
    }
  }, [manifest?.train]);
  useEffect(() => { lastSavedTrainSettings.current = null; setTrainView(null); setTrainSeat(-1); setDisplayPages({}); }, [classroomId]);
  customizerOpenRef.current = customizerOpen;
  wandRef.current = wandMode;
  appearanceRef.current = appearance;
  const load = useCallback(async (offset = 0) => {
    const value = await api<Manifest>(apiPath(classroomId, `?offset=${offset}`));
    setManifest(value); setEnabled(value.enabled);
    setModels((current) => offset ? [...current, ...value.models] : value.models);
  }, [classroomId]);

  useEffect(() => {
    let alive = true;
    void api<AvatarAppearance>("/gallery/avatar").then((value) => { if (alive) setAppearance(value); }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "โหลดตัวละครไม่สำเร็จ"); });
    void api<{ url: string }>("/gallery/config").then((server) => { if (alive) setConfig(server.url); }).catch(() => {});
    void api<Manifest>(apiPath(classroomId)).then((value) => {
      if (alive) { setManifest(value); setEnabled(value.enabled); setModels(value.models); }
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
    const touchDevice = window.matchMedia("(pointer: coarse)").matches;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false }); }
    catch { setError("อุปกรณ์นี้ไม่รองรับการแสดงโลกสามมิติ"); return; }
    renderer.setPixelRatio(1);
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#cce7ed");
    scene.fog = new THREE.Fog("#cce7ed", 45, 150);
    scene.add(new THREE.HemisphereLight(0xeafaff, 0x667263, 2.2));
    const sun = new THREE.DirectionalLight(0xfff5da, 2.5); sun.position.set(10, 25, 12); scene.add(sun);
    const groundDepth = Math.max(2120, Math.ceil(manifest.blocks.length / 4) * 17 + 220);
    const groundZ = -groundDepth / 2 + 30;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, groundDepth), new THREE.MeshStandardMaterial({ color: 0xd9e5d4 })); floor.rotation.x = -Math.PI / 2; floor.position.set(0, -0.04, groundZ); scene.add(floor);
    const gridSize = Math.max(200, groundDepth); let grid = new THREE.GridHelper(gridSize, Math.round(gridSize / 10), 0x9eaf9b, 0xb7c6b5); grid.position.set(0, 0, groundZ); scene.add(grid);
    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 800);
    const avatarMeshes = new Map<string, THREE.Group>();
    const syncAppearance = (avatar: THREE.Group, value: AvatarAppearance, withWand: boolean) => {
      const signature = JSON.stringify([value, withWand]);
      if (avatar.userData.appearance === signature) return;
      const previous = avatar.userData.character as THREE.Group | undefined;
      if (previous) { avatar.remove(previous); disposeAvatarCharacter(previous); }
      const character = createAvatarCharacter(value, withWand); avatar.add(character);
      avatar.userData.character = character; avatar.userData.appearance = signature;
    };
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
    const studentModels = new Map<string, GalleryModel[]>();
    const groupStudentModels = () => {
      studentModels.clear();
      for (const item of modelsRef.current) if (!item.hidden) { const group = studentModels.get(item.studentId) ?? []; group.push(item); studentModels.set(item.studentId, group); }
    };
    const trainTrackGroup = new THREE.Group(); scene.add(trainTrackGroup);
    const trainGroup = new THREE.Group(); scene.add(trainGroup);
    trainGroup.visible = false;
    const addTrainPart = (parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], color: number, material?: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material ?? new THREE.MeshStandardMaterial({ color, roughness: 0.72 })); mesh.position.set(...position); parent.add(mesh); return mesh;
    };
    addTrainPart(trainGroup, [1.8, 0.7, 2.2], [0, 0.65, 2.3], 0x2a7d87);
    addTrainPart(trainGroup, [1.2, 0.9, 1.0], [0, 1.35, 2.7], 0xe9bc56);
    addTrainPart(trainGroup, [0.55, 0.55, 0.55], [0, 1.8, 3.4], 0x394b54);
    for (const z of [-1.8, -6.2]) {
      addTrainPart(trainGroup, [2.2, 0.48, 4.0], [0, 0.52, z], 0xb84d4d);
      addTrainPart(trainGroup, [2.0, 0.35, 3.8], [0, 0.91, z], 0xd98167);
      for (let row = 0; row < 3; row++) for (const x of [-0.55, 0.55]) addTrainPart(trainGroup, [0.72, 0.13, 0.72], [x, 1.18, z + 1.1 - row * 1.1], 0xf4d987);
    }
    const trainTarget = { x: 0, z: 2, rotation: 0 };
    const trainSamples: TrainSample[] = [];
    let trainSampleRevision = -1;
    const rebuildTrack = (studentCount: number) => {
      for (const child of [...trainTrackGroup.children]) {
        child.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose?.(); const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []; materials.forEach((material) => material.dispose()); });
      }
      trainTrackGroup.clear();
      const points = trainTrack(studentCount).map((point) => new THREE.Vector3(point.x, 0.025, point.z));
      if (points.length < 2) return;
      for (let index = 0; index < points.length; index++) {
        const from = points[index]!, to = points[(index + 1) % points.length]!;
        const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz), segment = new THREE.Group();
        segment.position.set((from.x + to.x) / 2, 0.025, (from.z + to.z) / 2); segment.rotation.y = Math.atan2(dx, dz);
        addTrainPart(segment, [2.8, 0.08, length], [0, 0, 0], 0x73685a);
        addTrainPart(segment, [0.12, 0.12, length], [-0.85, 0.08, 0], 0x393d3b);
        addTrainPart(segment, [0.12, 0.12, length], [0.85, 0.08, 0], 0x393d3b);
        trainTrackGroup.add(segment);
      }
    };
    let blockSignature = "", layoutChanged = false;
    const addBlock = (block: Manifest["blocks"][number]) => {
      const position = blockPosition(block.layoutIndex); const group = new THREE.Group(); group.position.set(position.x, 0, position.z); scene.add(group);
      const platform = new THREE.Mesh(new THREE.BoxGeometry(12, 0.55, 10), new THREE.MeshStandardMaterial({ color: colorFor(block.studentId) })); platform.position.y = 0.28; group.add(platform);
      const back = new THREE.Mesh(new THREE.BoxGeometry(10.8, 3.7, 0.28), new THREE.MeshStandardMaterial({ color: 0xf5f3e9 })); back.position.set(0, 2.15, -4.55); group.add(back);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 0.9), new THREE.MeshBasicMaterial({ map: labelTexture(`${block.studentNumber ?? "—"} · ${block.displayName}`) })); label.position.set(0, 4.1, -4.35); group.add(label);
      blockMap.set(block.studentId, block); blockGroups.set(block.studentId, group);
    };
    const syncBlocks = () => {
      const roster = manifestRef.current?.blocks ?? [], current = new Set(roster.map((block) => block.studentId));
      const snapshot = trainRef.current?.layoutRoster ? JSON.parse(trainRef.current.layoutRoster) as { studentId: string; studentNumber: number | null; displayName: string }[] : null;
      const layoutCount = snapshot?.length ?? roster.length;
      const positions = snapshot ? new Map(snapshot.map((block, index) => [block.studentId, index])) : null;
      const blocks = roster.flatMap((block) => {
        const layoutIndex = positions?.get(block.studentId);
        return layoutIndex === undefined && positions ? [] : [{ ...block, layoutIndex: layoutIndex ?? block.layoutIndex }];
      });
      const signature = JSON.stringify(blocks.map((block) => [block.studentId, block.layoutIndex, block.studentNumber, block.displayName]));
      if (signature === blockSignature) return;
      blockSignature = signature; layoutChanged = true;
      for (const [studentId, group] of blockGroups) { scene.remove(group); disposeAvatarCharacter(group); blockGroups.delete(studentId); blockMap.delete(studentId); }
      for (const block of blocks) if (current.has(block.studentId)) addBlock(block);
      rebuildTrack(layoutCount);
      const rows = Math.ceil(layoutCount / 4), depth = Math.max(2120, rows * 17 + 220), centerZ = -depth / 2 + 30;
      floor.geometry.dispose(); floor.geometry = new THREE.PlaneGeometry(120, depth); floor.position.z = centerZ;
      scene.remove(grid); grid.geometry.dispose(); (Array.isArray(grid.material) ? grid.material : [grid.material]).forEach((material) => material.dispose()); grid = new THREE.GridHelper(Math.max(200, depth), Math.round(Math.max(200, depth) / 10), 0x9eaf9b, 0xb7c6b5); grid.position.set(0, 0, centerZ); scene.add(grid);
    };
    syncBlocks();
    const addExhibit = (item: GalleryModel) => {
      const block = blockMap.get(item.studentId); if (!block) return;
      const owned = studentModels.get(item.studentId) ?? [];
      const page = displayPagesRef.current[item.studentId] ?? 0;
      const slot = owned.slice(page * 40, (page + 1) * 40).findIndex((candidate) => candidate.id === item.id);
      if (slot < 0) return;
      const base = blockPosition(block.layoutIndex), offset = exhibitPosition(slot);
      const exhibit = new THREE.Group(); exhibit.position.set(base.x + offset.x, 1.3 + (slot % 2) * 0.3, base.z + offset.z); scene.add(exhibit);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1.25, 0.12), new THREE.MeshStandardMaterial({ color: 0xf4f6f2 })); panel.position.z = -0.08; exhibit.add(panel);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.08, 0.82), new THREE.MeshBasicMaterial({ color: 0xb8d1d1 })); screen.position.set(0, 0.12, 0.0); exhibit.add(screen);
      if (item.thumbnailAvailable) loader.load(galleryFileUrl(classroomId, item.id, "thumbnail"), (texture) => { textures.push(texture); (screen.material as THREE.MeshBasicMaterial).map = texture; screen.material.needsUpdate = true; }, undefined, () => {});
      const plaque = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.28), new THREE.MeshBasicMaterial({ map: labelTexture(item.originalName.slice(0, 22)) })); plaque.position.set(0, -0.54, 0.07); exhibit.add(plaque);
      (panel as THREE.Mesh).userData.model = item; raycastables.push(panel); modelMeshes.set(item.id, exhibit);
      renderedModels.add(item.id);
    };
    const syncExhibits = () => {
      if (layoutChanged) {
        for (const modelId of [...renderedModels]) {
          evictModel(modelId);
          const exhibit = modelMeshes.get(modelId); if (exhibit) { scene.remove(exhibit); disposeAvatarCharacter(exhibit); modelMeshes.delete(modelId); }
          for (let i = raycastables.length - 1; i >= 0; i--) if (raycastables[i].userData.model?.id === modelId) raycastables.splice(i, 1);
          renderedModels.delete(modelId);
        }
        layoutChanged = false;
      }
      for (const item of modelsRef.current) {
        const owned = studentModels.get(item.studentId) ?? [];
        const page = displayPagesRef.current[item.studentId] ?? 0;
        if (!item.hidden && owned.slice(page * 40, (page + 1) * 40).some((candidate) => candidate.id === item.id) && !renderedModels.has(item.id)) addExhibit(item);
      }
      const visible = new Set<string>();
      for (const item of modelsRef.current.filter((candidate) => !candidate.hidden)) {
        const owned = studentModels.get(item.studentId) ?? [];
        const page = displayPagesRef.current[item.studentId] ?? 0;
        if (owned.slice(page * 40, (page + 1) * 40).some((candidate) => candidate.id === item.id)) visible.add(item.id);
      }
      for (const modelId of renderedModels) if (!visible.has(modelId)) {
        evictModel(modelId);
        const exhibit = modelMeshes.get(modelId); if (exhibit) { scene.remove(exhibit); disposeAvatarCharacter(exhibit); modelMeshes.delete(modelId); }
        for (let i = raycastables.length - 1; i >= 0; i--) if (raycastables[i].userData.model?.id === modelId) raycastables.splice(i, 1);
        renderedModels.delete(modelId);
      }
    };
    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2();
    let activePointer: number | null = null, dragged = false, lastX = 0, lastY = 0, startX = 0, startY = 0, yaw = 0, cameraPitch = 0.34;
    const moveCrosshair = (event: PointerEvent) => {
      if (!wandRef.current || customizerOpenRef.current || document.hidden) return;
      const point = canvasAimPoint(event.clientX, event.clientY, canvas.getBoundingClientRect());
      aimPoint.current.set(point.x, point.y);
      if (crosshairRef.current) { crosshairRef.current.style.left = `${(point.x + 1) * 50}%`; crosshairRef.current.style.top = `${(1 - point.y) * 50}%`; }
    };
    const cancelPointer = () => {
      const captured = activePointer; activePointer = null; dragged = false;
      if (captured !== null && canvas.hasPointerCapture(captured)) canvas.releasePointerCapture(captured);
    };
    const keys = new Set<string>(); const keyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!customizerOpenRef.current && key === "f" && wandRef.current && !target?.matches("input, textarea, select") && !target?.isContentEditable) { event.preventDefault(); fireWandRef.current(); return; }
      if (customizerOpenRef.current || target?.matches("input, textarea, select, button") || target?.isContentEditable) return;
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) {
        event.preventDefault(); if (key === " ") { if (!event.repeat) jumpRef.current = true; } else keys.add(key);
      }
    };
    const keyUp = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
    const onBlur = () => { keys.clear(); resetTouchJoystick(touchKnobRef.current, touchRef.current); jumpRef.current = false; cancelPointer(); };
    const updateOrientation = () => {
      const required = touchDevice && window.innerHeight > window.innerWidth;
      landscapeRequiredRef.current = required;
      setLandscapeRequired((current) => current === required ? current : required);
      if (required) onBlur();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (customizerOpenRef.current || document.hidden || activePointer !== null) return;
      activePointer = event.pointerId; dragged = false; lastX = startX = event.clientX; lastY = startY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      if (event.pointerType !== "touch") moveCrosshair(event);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (customizerOpenRef.current || document.hidden) return;
      if (activePointer === null) { if (event.pointerType !== "touch") moveCrosshair(event); return; }
      if (activePointer !== event.pointerId) return;
      dragged ||= Math.hypot(event.clientX - startX, event.clientY - startY) >= 5;
      if (dragged) {
        yaw -= (event.clientX - lastX) * 0.005;
        cameraPitch = THREE.MathUtils.clamp(cameraPitch - (event.clientY - lastY) * 0.003, 0.08, 0.85);
      }
      lastX = event.clientX; lastY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (activePointer !== event.pointerId) return;
      const tapped = !dragged && Math.hypot(event.clientX - startX, event.clientY - startY) < 5;
      cancelPointer();
      if (!tapped || customizerOpenRef.current || document.hidden) return;
      if (wandRef.current) { moveCrosshair(event); return; }
      const point = canvasAimPoint(event.clientX, event.clientY, canvas.getBoundingClientRect()); pointer.set(point.x, point.y);
      camera.updateMatrixWorld(); raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(raycastables, false)[0];
      if (hit?.object.userData.model) setSelected(hit.object.userData.model as GalleryModel);
    };
    const onPointerCancel = (event: PointerEvent) => { if (activePointer === event.pointerId) cancelPointer(); };
    const resize = () => { const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    let alive = true, frame = 0, lastSend = 0, lastFrame = performance.now(), local = { x: 0, z: 0, rotation: 0 }, room: any;
    let initialized = false, sequence = 0, lastAcknowledged = -1, jumpTime = -Infinity, movementEpoch = 0, pending: Move[] = [], unsent = { dx: 0, dz: 0 };
    let visualOffset = { x: 0, z: 0 };
    const aimOrigin = new THREE.Vector3(), aimBodies: THREE.Object3D[] = [];
    let lastAimCheck = 0, cooldownTimer: number | undefined;
    const currentAim = () => {
      if (!teacher || !wandRef.current || !initialized || !room?.connection?.isOpen || customizerOpenRef.current || document.hidden || !document.hasFocus()) return null;
      aimBodies.length = 0;
      for (const avatar of avatarMeshes.values()) if (avatar.userData.role === "student" && avatar.userData.character) aimBodies.push(avatar.userData.character);
      aimOrigin.set(local.x + Math.sin(local.rotation) * 0.45, 1.45, local.z + Math.cos(local.rotation) * 0.45);
      return wandAim(raycaster, camera, aimPoint.current, aimOrigin, aimBodies);
    };
    fireWandRef.current = () => {
      if (Date.now() < castReadyAt.current) return;
      const aim = currentAim();
      if (!aim) { setAimValid(false); return; }
      room.send("cast", { shotId: crypto.randomUUID(), ...aim });
      castReadyAt.current = Date.now() + 2000; setCastReady(false); cooldownTimer = window.setTimeout(() => setCastReady(true), 2000);
    };
    let hiddenAt = document.hidden ? performance.now() : 0;
    let syncedManifest = manifestRef.current, syncedModels = modelsRef.current, syncedPages = displayPagesRef.current;
    const modelAbort = new AbortController();
    const loadedModels = new Map<string, { object: THREE.Group; triangles: number; textureBytes: number }>();
    const deferredModels = new Map<string, number>();
    let residentTextureBytes = 0;
    let residentTriangles = 0, activeModelLoad: { id: string; controller: AbortController } | null = null, lastModelScan = 0;
    const evictModel = (id: string) => {
      const loaded = loadedModels.get(id); if (!loaded) return;
      modelMeshes.get(id)?.remove(loaded.object); disposeModelObject(loaded.object);
      residentTextureBytes -= loaded.textureBytes;
      residentTriangles -= loaded.triangles; loadedModels.delete(id);
    };
    groupStudentModels(); syncExhibits();
    const updateNearbyModels = () => {
      const candidates = [...studentModels.entries()].flatMap(([studentId, owned]) => {
        const block = blockMap.get(studentId);
        if (!block) return [];
        const page = displayPagesRef.current[studentId] ?? 0;
        return owned.slice(page * 40, (page + 1) * 40).map((item) => {
        const position = blockPosition(block.layoutIndex);
        return { item, distance: Math.hypot(position.x - local.x, position.z - local.z) };
        });
      });
      const desired = new Set(candidates.filter((candidate) => candidate.distance < 62).map((candidate) => candidate.item.id));
      for (const id of loadedModels.keys()) if (!desired.has(id)) evictModel(id);
      if (activeModelLoad && !desired.has(activeModelLoad.id)) activeModelLoad.controller.abort();
      if (activeModelLoad || document.hidden) return;
      const next = candidates.filter((candidate) => candidate.distance < 50 && !loadedModels.has(candidate.item.id) && deferredModels.get(candidate.item.id) !== residentTriangles).sort((a, b) => a.distance - b.distance)[0];
      if (!next) return;
      const controller = new AbortController(); activeModelLoad = { id: next.item.id, controller };
      void loadModel(next.item, galleryFileUrl(classroomId, next.item.id, "content"), controller.signal,
        next.item.materialAvailable ? galleryFileUrl(classroomId, next.item.id, "material") : undefined).then((parsed) => {
        if (controller.signal.aborted || !alive || !desired.has(next.item.id)) return;
        if (residentTriangles + parsed.triangles > 1_000_000 || residentTextureBytes + (parsed.textureBytes ?? 0) > 128 * 1024 * 1024) { deferredModels.set(next.item.id, residentTriangles); return; }
        const exhibit = modelMeshes.get(next.item.id); if (!exhibit) return;
        const object = createModelObject(parsed);
        const bounds = new THREE.Box3().setFromObject(object), center = bounds.getCenter(new THREE.Vector3()), radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.1);
        object.scale.setScalar(1.2 / radius); object.position.copy(center).multiplyScalar(-1.2 / radius); object.position.y += 0.25;
        exhibit.add(object); loadedModels.set(next.item.id, { object, triangles: parsed.triangles, textureBytes: parsed.textureBytes ?? 0 }); residentTriangles += parsed.triangles; residentTextureBytes += parsed.textureBytes ?? 0; deferredModels.delete(next.item.id);
      }).catch(() => { if (!controller.signal.aborted) deferredModels.set(next.item.id, residentTriangles); })
        .finally(() => { if (activeModelLoad?.controller === controller) activeModelLoad = null; });
    };
    const client = new Client(config);
    let lastTrainUi = 0, lastTrainActionScan = 0;
    const trainSeatPosition = (seat: number) => {
      const localX = seat % 2 === 0 ? -0.55 : 0.55;
      const localZ = -1.8 - Math.floor(seat / 6) * 4.4 - Math.floor((seat % 6) / 2) * 1.1;
      const cosine = Math.cos(trainTarget.rotation), sine = Math.sin(trainTarget.rotation);
      return { x: trainTarget.x + cosine * localX + sine * localZ, z: trainTarget.z - sine * localX + cosine * localZ, rotation: trainTarget.rotation };
    };
    const cleanup = () => {
      for (const id of loadedModels.keys()) evictModel(id);
      alive = false; cancelAnimationFrame(frame); window.clearTimeout(cooldownTimer); castReadyAt.current = 0; setCastReady(true); setAimValid(false); fireWandRef.current = () => {}; modelAbort.abort(); activeModelLoad?.controller.abort(); room?.leave(); roomRef.current = null; onBlur(); observer.disconnect();
      scene.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose?.(); const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []; materials.forEach((material) => material.dispose()); });
      renderer.dispose(); renderer.forceContextLoss(); textures.forEach((texture) => texture.dispose()); avatarMeshes.clear(); boltMeshes.current.clear(); effectMeshes.current = [];
      window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", onBlur); window.removeEventListener("resize", updateOrientation); window.removeEventListener("orientationchange", updateOrientation); screen.orientation?.removeEventListener("change", updateOrientation); document.removeEventListener("visibilitychange", onVisibilityChange); unlockGalleryOrientation();
      canvas.removeEventListener("pointerdown", onPointerDown); canvas.removeEventListener("pointermove", onPointerMove); canvas.removeEventListener("pointerup", onPointerUp); canvas.removeEventListener("pointercancel", onPointerCancel); canvas.removeEventListener("lostpointercapture", onPointerCancel);
    };
    const ticketRequest = galleryTicketRequest(classroomId);
    void api<{ ticket: string; url: string }>(ticketRequest.path, ticketRequest.options).then(async ({ ticket }) => {
      if (!alive) return;
      room = await client.joinOrCreate("classroom", { classroomId, ticket });
      if (!alive) { void room.leave(); return; }
      roomRef.current = room;
      setError("");
      room.onLeave((code: number) => { if (alive) { if (code === 4403) { setEnabled(false); setManifest(null); setError("ครูหยุดโลกเสมือนสำหรับนักเรียนแล้ว"); return; } initialized = false; setOnline(0); setError("การเชื่อมต่อโลกเสมือนสิ้นสุด กรุณาออกแล้วเข้าใหม่"); } });
      room.onMessage("gallery-refresh", () => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "โหลดผลงานใหม่ไม่สำเร็จ")); });
      room.onMessage("cast-result", ({ ok }: { ok: boolean }) => { if (!ok) setError("ยิงไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง"); });
      room.onMessage("train-result", ({ ok, message }: { ok: boolean; message: string }) => { setTrainMessage(message); if (!ok) setError(message); });
      room.onMessage("knocked", ({ respawnAt }: { respawnAt: number }) => { knockedRef.current = true; knockUntil.current = respawnAt; setKnockSeconds(Math.max(1, Math.ceil((respawnAt - Date.now()) / 1000))); });
      room.onMessage("respawn", ({ movementEpoch: epoch, x, z }: { movementEpoch: number; x: number; z: number }) => { knockedRef.current = false; knockUntil.current = 0; setKnockSeconds(0); movementEpoch = epoch; local = { x, z, rotation: 0 }; unsent = { dx: 0, dz: 0 }; pending = []; lastAcknowledged = -1; visualOffset = { x: 0, z: 0 }; });
      room.onMessage("wand-impact", ({ x, y, z }: { x: number; y: number; z: number }) => {
        if (effectMeshes.current.length >= 20) { const old = effectMeshes.current.shift()!; scene.remove(old.mesh); old.mesh.geometry.dispose(); (old.mesh.material as THREE.Material).dispose(); }
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color: 0x84f4ff, transparent: true, opacity: 0.9 }));
        mesh.position.set(x, y, z); scene.add(mesh); effectMeshes.current.push({ mesh, until: performance.now() + 450 });
      });
      room.onStateChange((state: any) => {
        if (!alive) return;
        if (state.train) {
          const wire = state.train as TrainView;
          const priorTrain = trainRef.current;
          const priorLayout = priorTrain?.layoutRoster;
          if (wire.revision !== trainSampleRevision || wire.layoutRoster !== priorLayout) { trainSamples.length = 0; trainSampleRevision = wire.revision; }
          trainRef.current = { ...wire };
          trainSamples.push({ at: performance.now(), x: wire.x, z: wire.z, rotation: wire.rotation });
          if (trainSamples.length > 4) trainSamples.shift();
          trainGroup.visible = wire.active;
          if (wire.layoutRoster && wire.layoutRoster !== priorLayout) { syncBlocks(); syncExhibits(); }
          if (Date.now() - lastTrainUi > 500) {
            lastTrainUi = Date.now(); setTrainClock(lastTrainUi);
            setTrainView((current) => current?.revision === wire.revision && current.phase === wire.phase && current.stopId === wire.stopId && current.nextStopId === wire.nextStopId && current.departureAt === wire.departureAt && current.arrivalAt === wire.arrivalAt && current.seats === wire.seats && current.active === wire.active ? current : { ...wire });
          }
        }
        const activeBolts = new Set<string>();
        state.bolts?.forEach((bolt: { id: string; x: number; y: number; z: number }, id: string) => {
          activeBolts.add(id); let visual = boltMeshes.current.get(id);
          if (!visual) {
            const group = new THREE.Group();
            group.add(new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd665 })));
            group.add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0x62eaff, transparent: true, opacity: 0.5 })));
            const trailGeometry = new THREE.BufferGeometry(); trailGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
            const trail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ color: 0xffec9a, transparent: true, opacity: 0.85 }));
            group.add(trail); group.position.set(bolt.x, bolt.y, bolt.z); scene.add(group);
            visual = { group, trail, target: new THREE.Vector3(bolt.x, bolt.y, bolt.z) }; boltMeshes.current.set(id, visual);
          }
          const next = new THREE.Vector3(bolt.x, bolt.y, bolt.z), start = visual.target.clone().sub(next);
          visual.target.copy(next);
          if (start.lengthSq() > 0.0001) { const positions = visual.trail.geometry.getAttribute("position"); positions.setXYZ(0, start.x, start.y, start.z); positions.setXYZ(1, 0, 0, 0); positions.needsUpdate = true; }
        });
        for (const [id, visual] of boltMeshes.current) if (!activeBolts.has(id)) { scene.remove(visual.group); disposeAvatarCharacter(visual.group); boltMeshes.current.delete(id); }
        setOnline((current) => current === state.players.size ? current : state.players.size);
        const present = new Set<string>();
        state.players.forEach((player: Avatar, id: string) => {
          present.add(id); let avatar = avatarMeshes.get(id);
          if (!avatar) {
            avatar = new THREE.Group(); avatar.position.set(player.x, 0, player.z); avatar.rotation.y = player.rotation;
            avatar.userData.walkPhase = 0; avatar.userData.walking = 0; avatar.userData.jumpTime = -Infinity;
            const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(player.role === "teacher" || player.role === "owner" ? `ครู ${player.displayName}` : player.displayName), transparent: true })); label.scale.set(2.6, 0.5, 1); label.position.y = 2.25; avatar.add(label); scene.add(avatar); avatarMeshes.set(id, avatar);
          }
          syncAppearance(avatar, id === room.sessionId ? appearanceRef.current : player, id === room.sessionId && teacher);
          avatar.userData.target = { x: player.x, z: player.z, rotation: player.rotation };
          avatar.userData.role = player.role;
          avatar.userData.trainSeat = player.trainSeat ?? -1;
          const character=avatar.userData.character as THREE.Group|undefined;
          if (character) { character.rotation.z = player.knocked ? -Math.PI/2 : 0; character.position.y = player.knocked ? 0.35 : 0; }
          avatar.userData.knocked = player.knocked;
          if (id === room.sessionId) {
            const nextSeat = player.trainSeat ?? -1;
            trainSeatRef.current = nextSeat; setTrainSeat((current) => current === nextSeat ? current : nextSeat);
            if (trainSeatRef.current >= 0) local = { x: player.x, z: player.z, rotation: player.rotation };
            knockedRef.current=Boolean(player.knocked);
            if (player.knocked) knockUntil.current = player.respawnAt ?? 0;
            else knockUntil.current = 0;
            const seconds=player.knocked ? Math.max(1,Math.ceil(((player.respawnAt??0)-Date.now())/1000)) : 0;
            if (seconds!==lastKnockSecond.current) { lastKnockSecond.current=seconds; setKnockSeconds(seconds); }
            const epoch=player.movementEpoch??0;
            if (epoch!==movementEpoch) { movementEpoch=epoch; local={x:player.x,z:player.z,rotation:player.rotation}; pending=[]; unsent={dx:0,dz:0}; visualOffset={x:0,z:0}; lastAcknowledged=player.sequence??-1; }
          }
          if ((player.protectedUntil ?? 0)>Date.now() && !avatar.userData.shield) {
            const shield=new THREE.Mesh(new THREE.TorusGeometry(0.68,0.035,5,20),new THREE.MeshBasicMaterial({color:0x64dbef,transparent:true,opacity:0.65})); shield.rotation.x=Math.PI/2; shield.position.y=0.06; avatar.add(shield); avatar.userData.shield=shield;
            avatar.userData.shieldExpires = player.protectedUntil;
          } else if ((player.protectedUntil ?? 0)<=Date.now() && avatar.userData.shield) { avatar.remove(avatar.userData.shield); avatar.userData.shield.geometry.dispose(); (avatar.userData.shield.material as THREE.Material).dispose(); avatar.userData.shield=null; }
          if (avatar.userData.jump !== undefined && avatar.userData.jump !== player.jump) avatar.userData.jumpTime = performance.now();
          avatar.userData.jump = player.jump;
          if (id === room.sessionId) {
            if (!initialized) { local = { x: player.x, z: player.z, rotation: player.rotation }; initialized = true; }
            // Replay movement not yet acknowledged instead of snapping to a delayed server position.
            if (player.sequence !== undefined && player.sequence > lastAcknowledged) {
              const corrected = reconcilePosition(player, player.sequence, pending, unsent);
              visualOffset = correctionOffset(local, corrected, visualOffset);
              Object.assign(local, corrected);
              pending = pending.filter((move) => move.sequence > player.sequence!); lastAcknowledged = player.sequence;
            }
          }
        });
        for (const [id, avatar] of avatarMeshes) if (!present.has(id)) { scene.remove(avatar); disposeAvatarCharacter(avatar); avatar.traverse((object) => { if (object instanceof THREE.Sprite) object.material.map?.dispose(); }); avatarMeshes.delete(id); }
      });
    }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "เชื่อมต่อโลกเสมือนไม่สำเร็จ"); });
    const render = (time: number) => {
      if (!alive || document.hidden) { frame = 0; return; } frame = requestAnimationFrame(render); const dt = Math.min((time - lastFrame) / 1000, 0.05); lastFrame = time;
      for (const visual of boltMeshes.current.values()) visual.group.position.lerp(visual.target, 1 - Math.exp(-45 * dt));
      for (let i = effectMeshes.current.length - 1; i >= 0; i--) { const effect = effectMeshes.current[i]!; const left = effect.until - time; if (left <= 0) { scene.remove(effect.mesh); effect.mesh.geometry.dispose(); (effect.mesh.material as THREE.Material).dispose(); effectMeshes.current.splice(i, 1); } else { effect.mesh.scale.setScalar(1 + (1 - left / 450) * 2); (effect.mesh.material as THREE.MeshBasicMaterial).opacity = left / 450; } }
      if (time - lastModelScan > 500) { lastModelScan = time; updateNearbyModels(); }
      if (syncedManifest !== manifestRef.current) { syncedManifest = manifestRef.current; syncBlocks(); syncExhibits(); }
      if (syncedModels !== modelsRef.current || syncedPages !== displayPagesRef.current) { syncedModels = modelsRef.current; syncedPages = displayPagesRef.current; groupStudentModels(); syncExhibits(); }
      const forward = Number(keys.has("w") || keys.has("arrowup") || touchRef.current.z < -0.15) - Number(keys.has("s") || keys.has("arrowdown") || touchRef.current.z > 0.15);
      const side = Number(keys.has("d") || keys.has("arrowright") || touchRef.current.x > 0.15) - Number(keys.has("a") || keys.has("arrowleft") || touchRef.current.x < -0.15);
      const bufferedTrain = interpolateTrain(trainSamples, time);
      if (bufferedTrain) { trainTarget.x = bufferedTrain.x; trainTarget.z = bufferedTrain.z; trainTarget.rotation = bufferedTrain.rotation; }
      const active = initialized && room?.connection?.isOpen && !customizerOpenRef.current && !document.hidden && !landscapeRequiredRef.current && (touchDevice || document.hasFocus()) && !knockedRef.current && trainSeatRef.current < 0;
      if (!active) onBlur();
      const step = active ? walkingStep(forward, side, yaw, dt) : { dx: 0, dz: 0 };
      local.x += step.dx; local.z += step.dz; unsent.dx += step.dx; unsent.dz += step.dz;
      if (step.dx || step.dz) local.rotation = facingRotation(step.dx, step.dz);
      if (active && jumpRef.current) {
        jumpRef.current = false;
        if (time - jumpTime >= 900) { jumpTime = time; room.send("jump"); }
      }
      const decay = Math.exp(-12 * dt);
      visualOffset.x *= decay; visualOffset.z *= decay;
      const visual = trainSeatRef.current >= 0 ? trainSeatPosition(trainSeatRef.current) : { x: local.x + visualOffset.x, z: local.z + visualOffset.z, rotation: local.rotation };
      trainGroup.position.set(trainTarget.x, 0, trainTarget.z);
      trainGroup.rotation.y = trainTarget.rotation;
      if (time - lastTrainActionScan > 250) {
        lastTrainActionScan = time;
        const train = trainRef.current;
        const stopped = Boolean(train && ["waiting", "boarding", "dwell"].includes(train.phase));
        const action = trainSeatRef.current >= 0 && stopped ? "leave" : train && canBoardTrain({ active: train.active, phase: train.phase, seats: train.seats, distance: Math.hypot(local.x - train.x, local.z - train.z) }) ? "board" : null;
        setTrainAction((current) => current === action ? current : action);
      }
      for (const [id, avatar] of avatarMeshes) {
        const self = id === room?.sessionId, seat = avatar.userData.trainSeat as number, target = seat >= 0 ? trainSeatPosition(seat) : self ? visual : avatar.userData.target;
        const previousX = avatar.position.x, previousZ = avatar.position.z;
        const blend = seat >= 0 || self ? 1 : 1 - Math.exp(-16 * dt);
        avatar.position.x += (target.x - avatar.position.x) * blend; avatar.position.z += (target.z - avatar.position.z) * blend;
        avatar.rotation.y += Math.atan2(Math.sin(target.rotation - avatar.rotation.y), Math.cos(target.rotation - avatar.rotation.y)) * blend;
        const height = jumpHeight((time - (self ? jumpTime : avatar.userData.jumpTime)) / 1000); avatar.position.y = avatar.userData.knocked ? 0 : height;
        const speed = seat >= 0 ? 0 : (self ? Math.hypot(step.dx, step.dz) : Math.hypot(avatar.position.x - previousX, avatar.position.z - previousZ)) / Math.max(dt, 0.001);
        avatar.userData.walking += (Math.min(1, speed / 4) - avatar.userData.walking) * (1 - Math.exp(-15 * dt));
        avatar.userData.walkPhase += Math.min(speed, 5) * dt * 2.4;
        const character = avatar.userData.character as THREE.Group | undefined;
        if (character) animateAvatarCharacter(character, avatar.userData.walkPhase, avatar.userData.knocked ? 0 : avatar.userData.walking, height > 0, avatar.userData.knocked, self && teacher && wandRef.current);
        if (avatar.userData.shield && avatar.userData.shieldExpires <= Date.now()) { avatar.remove(avatar.userData.shield); avatar.userData.shield.geometry.dispose(); (avatar.userData.shield.material as THREE.Material).dispose(); avatar.userData.shield = null; }
      }
      if (initialized && trainSeatRef.current < 0 && room?.connection?.isOpen && time - lastSend > 100) {
        if (lastAcknowledged < 0) room.send("move", { ...local, movementEpoch });
        else if (unsent.dx || unsent.dz) {
          const move = { ...unsent, sequence: ++sequence }; pending.push(move); room.send("move", { ...move, rotation: local.rotation, movementEpoch });
        }
        unsent = { dx: 0, dz: 0 }; lastSend = time;
      }
      const distance = 8 + cameraPitch * 10; camera.position.set(visual.x + Math.sin(yaw) * distance, 2 + cameraPitch * 10, visual.z + Math.cos(yaw) * distance); camera.lookAt(visual.x, 1.2, visual.z);
      if (time - lastAimCheck >= 100) {
        lastAimCheck = time;
        const valid = Boolean(currentAim());
        setAimValid((current) => current === valid ? current : valid);
      }
      renderer.render(scene, camera);
    };
    const onVisibilityChange = () => {
      onBlur();
      if (document.hidden) { hiddenAt = performance.now(); activeModelLoad?.controller.abort(); setAimValid(false); }
      else {
        const now = performance.now(), paused = hiddenAt ? now - hiddenAt : 0;
        if (Number.isFinite(jumpTime)) jumpTime += paused;
        for (const avatar of avatarMeshes.values()) if (Number.isFinite(avatar.userData.jumpTime)) avatar.userData.jumpTime += paused;
        trainSamples.length = 0;
        const latestTrain = trainRef.current;
        if (latestTrain) trainSamples.push({ at: now, x: latestTrain.x, z: latestTrain.z, rotation: latestTrain.rotation });
        hiddenAt = 0;
        if (alive && !frame) { lastFrame = now; frame = requestAnimationFrame(render); }
      }
    };
    canvas.addEventListener("pointerdown", onPointerDown); canvas.addEventListener("pointermove", onPointerMove); canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel); canvas.addEventListener("lostpointercapture", onPointerCancel);
    window.addEventListener("keydown", keyDown); window.addEventListener("keyup", keyUp); window.addEventListener("blur", onBlur); window.addEventListener("resize", updateOrientation); window.addEventListener("orientationchange", updateOrientation); screen.orientation?.addEventListener("change", updateOrientation); document.addEventListener("visibilitychange", onVisibilityChange);
    updateOrientation();
    frame = requestAnimationFrame(render);
    return () => { modelAbort.abort(); cleanup(); };
  }, [classroomId, config, Boolean(manifest), load, teacher]);

  async function setWorld(value: boolean) {
    if (!value && !window.confirm("หยุดโลกสำหรับนักเรียน? นักเรียนที่กำลังเข้าชมจะถูกตัดการเชื่อมต่อ ผลงานและการถูกใจจะยังอยู่ ครูยังเข้าชมได้")) return;
    setLoading(true); setError("");
    try { await api(apiPath(classroomId), { method: "PUT", body: JSON.stringify({ enabled: value }) }); setEnabled(value); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกการตั้งค่าไม่สำเร็จ"); }
    finally { setLoading(false); }
  }
  async function saveTrainSettings() {
    setLoading(true); setError("");
    try {
      await api(apiPath(classroomId, "/train"), { method: "PUT", body: JSON.stringify(trainForm) });
      lastSavedTrainSettings.current = { ...trainForm };
      setTrainMessage("บันทึกตารางรถไฟแล้ว · จะใช้ในการออกเที่ยวถัดไป"); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกตารางรถไฟไม่สำเร็จ"); }
    finally { setLoading(false); }
  }
  function trainCommand(type: "train-start" | "train-board" | "train-leave") {
    const train = trainRef.current;
    if (!train || !roomRef.current?.connection?.isOpen) return;
    roomRef.current.send(type, { revision: train.revision });
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
      if (roomRef.current?.connection?.isOpen) roomRef.current.send("refresh-avatar");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกตัวละครไม่สำเร็จ"); }
    finally { setLoading(false); }
  }

  const trainOpen = Boolean(trainView?.active && ["waiting", "boarding", "dwell"].includes(trainView.phase));
  const trainStatus = !trainView ? "กำลังเชื่อมต่อรถไฟ…" : !trainView.active ? "ไม่มีนักเรียนในห้อง จึงยังไม่มีเส้นทางรถไฟ" : trainView.phase === "moving"
    ? `กำลังไป${stationLabel(trainView.nextStopId, manifest?.blocks ?? [])} · ถึงประมาณ ${countdown(trainView.arrivalAt, trainClock)}`
    : trainView.phase === "dwell" ? `จอดที่${stationLabel(trainView.stopId, manifest?.blocks ?? [])} · ออกใน ${countdown(trainView.departureAt, trainClock)}`
    : trainView.phase === "boarding" ? `จอดที่${stationLabel(trainView.stopId, manifest?.blocks ?? [])} · รอบถัดไปออกใน ${countdown(trainView.departureAt, trainClock)}`
    : `จอดที่${stationLabel(trainView.stopId, manifest?.blocks ?? [])} · ${trainView.mode === "manual" ? "รอครูเริ่มเที่ยวรถ" : "รอรอบถัดไป"}`;
  const selectedStudentWork = selected ? models.filter((item) => item.studentId === selected.studentId && !item.hidden) : [];
  const selectedPage = selected ? displayPages[selected.studentId] ?? 0 : 0;
  const selectedPageCount = Math.ceil(selectedStudentWork.length / 40);
  function toggleFullscreen() {
    setImmersive(true);
    if (!document.fullscreenElement) void enterGalleryFullscreen();
  }
  function exitFullscreenView() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => setImmersive(false));
    else { unlockGalleryOrientation(); setImmersive(false); }
  }

  if (enabled === false && !teacher) return <main className="public-lesson-page"><section className="panel"><h2>โลกเสมือนยังไม่พร้อม</h2><p>{error || "กรุณากลับไปยังห้องเรียนแล้วลองอีกครั้ง."}</p><a href="/">กลับไปห้องเรียน</a></section></main>;
  return <>
    <section className="gallery-shell">
      <header className={`gallery-toolbar${menuOpen ? " menu-open" : ""}`}>
        <div className="gallery-toolbar-room"><strong>{manifest?.classroomName ?? "โลกเสมือน"}</strong><small>{online} คนออนไลน์ · WASD/ลูกศร เดิน · Space กระโดด · ลากเพื่อหมุนมุมมอง</small></div>
        <div className="gallery-toolbar-actions">
          <button className="button button-quiet" aria-expanded={menuOpen} aria-controls="gallery-menu" onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? "ปิดเมนู" : "เมนู"}</button>
          <button className="button button-quiet" onClick={nativeFullscreen ? exitFullscreenView : toggleFullscreen}>{nativeFullscreen ? "ออกจากเต็มจอ" : "เต็มจอ"}</button>{immersive && !nativeFullscreen && <button className="button button-quiet" onClick={exitFullscreenView}>ออกจากเต็มจอ</button>}
        </div>
      </header>
      <div id="gallery-menu" className="gallery-menu" hidden={!menuOpen}>
        <div className="gallery-menu-header"><strong>เมนูโลกเสมือน</strong><div><button className="button button-quiet" onClick={() => setMenuOpen(false)}>ปิดเมนู</button>{close && <button className="button button-quiet" onClick={close}>กลับห้องเรียน</button>}</div></div>
        <div className="gallery-menu-room"><strong>{manifest?.classroomName ?? "โลกเสมือน"}</strong><small>{online} คนออนไลน์ · WASD/ลูกศร เดิน · Space กระโดด · ลากเพื่อหมุนมุมมอง</small></div>
        {user.role === "student" && <div className="gallery-attendance"><StudentAttendance /></div>}
        <aside className="gallery-train-panel" aria-label="รถไฟเที่ยวชมโลกเสมือน">
          <div className="gallery-train-status"><strong>🚂 รถไฟเที่ยวชม</strong><span>{trainStatus}</span><small>{trainView?.active ? `${trainView.seats}/12 ที่นั่ง · ${trainView.mode === "auto" ? "อัตโนมัติ" : "เริ่มโดยครู"}` : ""}</small></div>
          <div className="gallery-train-actions">{teacher && trainView?.active && trainView.mode === "manual" && trainView.phase === "waiting" && <button className="button button-quiet" onClick={() => trainCommand("train-start")}>เริ่มเที่ยวรถ · นับถอยหลัง 10 วินาที</button>}</div>
          {teacher && <div className="gallery-train-settings">
            <label>ตารางรถ<select value={trainForm.mode} onChange={(event) => setTrainForm({ ...trainForm, mode: event.target.value as TrainSettings["mode"] })}><option value="auto">อัตโนมัติ</option><option value="manual">ครูเริ่มเอง</option></select></label>
            {trainForm.mode === "auto" && <label>ช่วงเวลา<select value={trainForm.intervalSeconds} onChange={(event) => setTrainForm({ ...trainForm, intervalSeconds: Number(event.target.value) as 60 | 120 })}><option value={60}>ทุก 1 นาที</option><option value={120}>ทุก 2 นาที</option></select></label>}
            <label>เริ่มจาก<select value={trainForm.startStudentId ?? ""} onChange={(event) => setTrainForm({ ...trainForm, startStudentId: event.target.value || null })}><option value="">สถานีทางเข้า</option>{manifest?.blocks.filter((block) => block.studentNumber !== null).map((block) => <option key={block.studentId} value={block.studentId}>เลขที่ {block.studentNumber} · {block.displayName}</option>)}</select></label>
            <button className="button button-quiet" disabled={loading} onClick={() => void saveTrainSettings()}>บันทึกตาราง</button>
            <small>ใช้การตั้งค่าเมื่อรถว่างก่อนออกเที่ยวถัดไป · เลขที่ที่เลือกเริ่มที่สถานีประจำกลุ่มแถว</small>
            {trainMessage && <small role="status">{trainMessage}</small>}
          </div>}
        </aside>
        <div className="gallery-management"><strong>ตัวละคร</strong><div className="gallery-management-actions"><button className="button button-quiet" onClick={() => { setError(""); setDraftAppearance({ ...appearance }); setCustomizerOpen(true); setMenuOpen(false); }}>ปรับแต่งตัวละคร</button></div></div>
        {teacher && <div className="gallery-management"><strong>จัดการโลกเสมือน</strong><p>{enabled ? "เปิดสำหรับนักเรียน" : "หยุดสำหรับนักเรียน · ครูเข้าชมได้"}</p><div className="gallery-management-actions"><button className="button button-quiet" disabled={loading} onClick={() => void setWorld(!enabled)}>{enabled ? "หยุดโลกสำหรับนักเรียน" : "เปิดโลกสำหรับนักเรียน"}</button><button className="button button-quiet" aria-pressed={wandMode} onClick={() => { setWandMode((value) => !value); setSelected(null); setMenuOpen(false); }}>{wandMode ? "เก็บไม้กายสิทธิ์" : "ถือไม้กายสิทธิ์"}</button></div></div>}
        {manifest?.nextOffset !== null && <button className="button button-quiet" onClick={() => void load(manifest?.nextOffset ?? 0)}>โหลดผลงานเพิ่ม</button>}
        {teacher && models.some((item) => item.hidden) && <aside className="gallery-hidden-tray"><strong>ผลงานที่ซ่อน</strong>{models.filter((item) => item.hidden).map((item) => <div key={item.id}><span>{item.displayName} · {item.originalName}</span><button className="text-button" onClick={() => void setHidden(item)}>แสดง</button></div>)}</aside>}
        {logout && <button className="button button-quiet" onClick={logout}>ออกจากระบบ</button>}
        {error && <div className="notice" role="alert">{error}</div>}{!config && <p className="gallery-service-note">ยังไม่ได้ตั้งค่า Colyseus ใน Coolify</p>}
      </div>
      {error && !menuOpen && <div className="notice" role="alert">{error}</div>}
      <canvas ref={canvasRef} className="gallery-canvas" aria-label="โลกเสมือนห้องเรียน กด WASD เพื่อเดิน Space เพื่อกระโดด และลากเพื่อหมุนมุมมอง" />
      {landscapeRequired && <div className="gallery-rotate-prompt" role="alert"><strong>หมุนโทรศัพท์เป็นแนวนอนเพื่อเล่น</strong><span>หมุนอุปกรณ์เพื่อให้ปุ่มควบคุมแสดงครบ</span>{close && <button className="button button-quiet" onClick={close}>กลับห้องเรียน</button>}</div>}
      {wandMode && !customizerOpen && <>
        <div ref={crosshairRef} className={`gallery-crosshair${aimValid ? "" : " unavailable"}`} style={{ left: `${(aimPoint.current.x + 1) * 50}%`, top: `${(1 - aimPoint.current.y) * 50}%` }} aria-hidden="true">{aimValid ? "＋" : "×"}</div>
        <p className="gallery-aim-hint">เลื่อนเมาส์หรือแตะเพื่อเล็ง · ลากเพื่อหมุนกล้อง · กด F หรือปุ่มยิง{!aimValid && <span>จุดนี้ยิงไม่ได้ — เลือกจุดเล็งใหม่</span>}</p>
        <button className="gallery-fire button button-primary" disabled={!castReady || !aimValid || knockSeconds > 0} onClick={() => fireWandRef.current()}>{castReady ? "ยิงเวทมนตร์ · F" : "กำลังชาร์จ…"}</button>
      </>}
      {knockSeconds > 0 && <div className="gallery-knockdown" role="status">ถูกเวทมนตร์! จะกลับเข้าโลกใน {knockSeconds} วินาที</div>}
      {trainAction && <button className="gallery-train-quick-action button button-primary" onClick={() => trainCommand(trainAction === "board" ? "train-board" : "train-leave")}>{trainAction === "board" ? "ขึ้นรถไฟ" : "ลงจากรถไฟ"}</button>}
      <div className="gallery-touch" role="group" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); moveTouchJoystick(event, touchKnobRef.current, touchRef.current); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTouchJoystick(event, touchKnobRef.current, touchRef.current); }} onPointerUp={() => resetTouchJoystick(touchKnobRef.current, touchRef.current)} onPointerCancel={() => resetTouchJoystick(touchKnobRef.current, touchRef.current)} onLostPointerCapture={() => resetTouchJoystick(touchKnobRef.current, touchRef.current)} aria-label="ลากจอยสติ๊กเพื่อเดิน"><span ref={touchKnobRef} className="gallery-touch-knob" aria-hidden="true" /></div>
      <button className="gallery-jump button button-quiet" disabled={customizerOpen || knockSeconds > 0} onPointerDown={(event) => { event.preventDefault(); jumpRef.current = true; }} onClick={(event) => { if (event.detail === 0) jumpRef.current = true; }}>กระโดด ↑</button>
      {selected && <aside className="gallery-inspect"><button className="icon-button" onClick={() => setSelected(null)} aria-label="ปิด">×</button><p className="eyebrow">{selected.displayName} · เลขที่ {selected.studentNumber ?? "—"}</p><h3>{selected.originalName}</h3><p className="muted">{selected.assignmentTitle}</p><p>{selected.likes} ถูกใจ</p>{selectedPageCount > 1 && <div className="gallery-display-pages"><span>ผลงานในพื้นที่ {selectedPage * 40 + 1}–{Math.min(selectedPage * 40 + 40, selectedStudentWork.length)} จาก {selectedStudentWork.length}</span><button className="text-button" disabled={selectedPage === 0} onClick={() => { const next = selectedStudentWork[(selectedPage - 1) * 40]; setDisplayPages((pages) => ({ ...pages, [selected.studentId]: selectedPage - 1 })); if (next) setSelected(next); }}>ก่อนหน้า</button><button className="text-button" disabled={selectedPage + 1 >= selectedPageCount} onClick={() => { const next = selectedStudentWork[(selectedPage + 1) * 40]; setDisplayPages((pages) => ({ ...pages, [selected.studentId]: selectedPage + 1 })); if (next) setSelected(next); }}>ถัดไป</button></div>}{user.role === "student" && selected.studentId !== manifest?.viewerStudentId && <button className="button button-quiet" onClick={() => void like(selected)}>{selected.likedByMe ? "ยกเลิกถูกใจ" : "ถูกใจ"}</button>}{teacher && <button className="button button-quiet" onClick={() => void setHidden(selected)}>{selected.hidden ? "แสดงผลงาน" : "ซ่อนผลงาน"}</button>}<button className="button button-primary" onClick={() => setPreview(selected)}>เปิดดูโมเดล</button></aside>}
      {customizerOpen && <CharacterCustomizer appearance={draftAppearance} onChange={setDraftAppearance} onCancel={() => setCustomizerOpen(false)} onSave={() => void saveAppearance()} saving={loading} error={error} />}
    </section>
    {preview && <ModelPreview file={preview} contentPath={galleryFileUrl(classroomId, preview.id, "content")} materialPath={preview.materialAvailable ? galleryFileUrl(classroomId, preview.id, "material") : undefined} close={() => setPreview(null)} />}
  </>;
}

function CharacterCustomizer({ appearance, onChange, onCancel, onSave, saving, error }: { appearance: AvatarAppearance; onChange: (value: AvatarAppearance) => void; onCancel: () => void; onSave: () => void; saving: boolean; error: string }) {
  const selections = [
    ["hairStyle", "ทรงผม", [["none", "ไม่มีผม"], ["short", "สั้น"], ["long", "ยาว"], ["ponytail", "หางม้า"], ["bun", "มวยผม"], ["spiky", "ตั้ง"], ["bob", "บ๊อบ"]]],
    ["hatStyle", "หมวก", [["none", "ไม่มี"], ["cap", "หมวกแก๊ป"], ["beanie", "หมวกไหมพรม"], ["wizard", "หมวกพ่อมด"]]],
    ["glassesStyle", "แว่นตา", [["none", "ไม่มี"], ["round", "ทรงกลม"], ["square", "ทรงเหลี่ยม"]]],
    ["shoeStyle", "รองเท้า", [["none", "ไม่มี"], ["sneakers", "รองเท้าผ้าใบ"], ["boots", "รองเท้าบูต"]]],
  ] as const;
  const colors = [["skinColor", "สีผิว"], ["hairColor", "สีผม"], ["shirtColor", "เสื้อ"], ["trousersColor", "กางเกง"], ["hatColor", "หมวก"], ["glassesColor", "แว่นตา"], ["shoeColor", "รองเท้า"]] as const;
  return <div className="character-editor-backdrop"><section className="character-editor" role="dialog" aria-modal="true" aria-labelledby="character-editor-title">
    <header><h2 id="character-editor-title">ปรับแต่งตัวละคร</h2><button className="icon-button" onClick={onCancel} aria-label="ยกเลิก">×</button></header>
    {error && <p className="form-error" role="alert">{error}</p>}<CharacterPreview appearance={appearance} />
    <div className="character-controls">
      {selections.map(([key, label, options]) => <label key={key}>{label}<select value={appearance[key]} onChange={(event) => onChange({ ...appearance, [key]: event.target.value } as AvatarAppearance)}>{options.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>)}
      {colors.map(([key, label]) => <label key={key}>{label}<input type="color" value={appearance[key]} onChange={(event) => onChange({ ...appearance, [key]: event.target.value })} /></label>)}
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
