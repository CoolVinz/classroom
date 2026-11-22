import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as THREE from "three";
import { Client } from "@colyseus/sdk";
import { api } from "./api";
import { StudentAttendance } from "./StudentAttendance";
import ModelPreview from "./ModelPreview";
import { loadModel, createModelObject, disposeModelObject } from "./model-view";
import { galleryFileUrl, galleryTicketRequest } from "./gallery-api";
import { galleryModelIdForHit } from "./gallery-picking";
import { animateAvatarCharacter, avatarNameLabelY, createAvatarCharacter, defaultAvatarAppearance, disposeAvatarCharacter, type AvatarAppearance } from "./gallery-avatar";
import { correctionOffset, facingRotation, interpolateTrain, jumpHeight, reconcilePosition, touchDirection, walkingStep, type Move, type TrainSample } from "./gallery-motion";
import { canvasAimPoint, wandAim } from "./gallery-aim";
import { enterGalleryFullscreen, unlockGalleryOrientation } from "./gallery-fullscreen";
import { blockPosition, exhibitPosition, trainTrack } from "../../gallery-server/src/train-layout.mjs";
import { canBoardTrain } from "../../gallery-server/src/train-rules.mjs";

type User = { role: "owner" | "teacher" | "student"; displayName: string };
type GalleryModel = { id: string; studentId: string; displayName: string; studentNumber: number | null; assignmentId: string; assignmentTitle: string; originalName: string; mediaType: string; materialAvailable: boolean; createdAt: string; hidden: boolean; likes: number; likedByMe: boolean };
type VoteSummary = { limit: number; blockTotals: { studentId: string; votes: number }[]; usage: { assignmentId: string; assignmentTitle: string; used: number }[]; myVotes: { fileId: string; assignmentId: string; assignmentTitle: string; originalName: string; displayName: string; studentNumber: number | null; hidden: boolean; unavailable: boolean }[] };
type TrainSettings = { mode: "auto" | "manual"; intervalSeconds: 60 | 120; startStudentId: string | null };
type TrainView = TrainSettings & { active: boolean; x: number; z: number; rotation: number; phase: "waiting" | "boarding" | "moving" | "dwell"; stopId: string; nextStopId: string; departureAt: number; arrivalAt: number; seats: number; revision: number; layoutRoster: string };
type Manifest = { enabled: boolean; classroomId: string; classroomName: string; blocks: { studentId: string; displayName: string; studentNumber: number | null; blockIndex: number; layoutIndex: number; archived: boolean }[]; models: GalleryModel[]; nextOffset: number | null; teacher: boolean; viewerStudentId: string | null; train: TrainSettings };
type GalleryAccessStudent = { studentId: string; accountLinked: boolean; displayName: string; studentNumber: number | null; requiredAssignmentId: string | null; requiredAssignmentTitle: string | null; hasSubmission: boolean; approved: boolean; entryAllowed: boolean };
type GalleryAccess = { mode: "submission" | "approval"; requiredAssignmentId: string | null; requiredAssignmentTitle: string | null; students: GalleryAccessStudent[] };
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
  const [voteSummary, setVoteSummary] = useState<VoteSummary | null>(null);
  const voteSummaryRef = useRef(voteSummary);
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
  const [galleryAccess, setGalleryAccess] = useState<GalleryAccess | null>(null);
  const [entryModeDraft, setEntryModeDraft] = useState<GalleryAccess["mode"] | null>(null);
  const entryMode = entryModeDraft ?? galleryAccess?.mode ?? "submission";
  const [accessMessage, setAccessMessage] = useState("");
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
  const customizerOpenRef = useRef(false);
  const appearanceRef = useRef(appearance);
  const touchRef = useRef({ x: 0, z: 0 });
  const touchKnobRef = useRef<HTMLSpanElement>(null);
  const landscapeRequiredRef = useRef(false);
  const jumpRef = useRef(false);
  const teacher = user.role !== "student";
  useEffect(() => { document.documentElement.classList.toggle("gallery-immersive", immersive); }, [immersive]);
  useEffect(() => {
    const onFullscreenChange = () => { if (!document.fullscreenElement) { setImmersive(false); unlockGalleryOrientation(); } };
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
  useEffect(() => { voteSummaryRef.current = voteSummary; }, [voteSummary]);
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
    const [value, votes] = await Promise.all([
      api<Manifest>(apiPath(classroomId, `?offset=${offset}`)),
      api<VoteSummary>(apiPath(classroomId, "/votes")).catch((reason) => { setError(reason instanceof Error ? reason.message : "โหลดโควตาโหวตไม่สำเร็จ"); return null; }),
    ]);
    setManifest(value); setEnabled(value.enabled);
    setModels((current) => offset ? [...current, ...value.models] : value.models);
    if (votes) setVoteSummary(votes);
  }, [classroomId]);
  const loadGalleryAccess = useCallback(async () => {
    setGalleryAccess(await api<GalleryAccess>(apiPath(classroomId, "/access")));
  }, [classroomId]);
  useEffect(() => { if (teacher) void loadGalleryAccess().catch((reason) => setError(reason instanceof Error ? reason.message : "โหลดสิทธิ์เข้าโลกไม่สำเร็จ")); }, [loadGalleryAccess, teacher]);

  useEffect(() => {
    let alive = true;
    void api<AvatarAppearance>("/gallery/avatar").then((value) => { if (alive) setAppearance(value); }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "โหลดตัวละครไม่สำเร็จ"); });
    void api<{ url: string }>("/gallery/config").then((server) => { if (alive) setConfig(server.url); }).catch(() => {});
    void Promise.all([api<Manifest>(apiPath(classroomId)), api<VoteSummary>(apiPath(classroomId, "/votes")).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "โหลดโควตาโหวตไม่สำเร็จ"); return null; })]).then(([value, votes]) => {
      if (alive) { setManifest(value); setEnabled(value.enabled); setModels(value.models); if (votes) setVoteSummary(votes); }
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
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#d9eee5");
    scene.fog = new THREE.Fog("#d9eee5", 65, 190);
    scene.add(new THREE.HemisphereLight(0xf1fff2, 0x58735f, 2.1));
    const sun = new THREE.DirectionalLight(0xffefd1, 2.3); sun.position.set(-16, 32, 20); scene.add(sun);
    const fill = new THREE.DirectionalLight(0xc4e8df, 0.85); fill.position.set(18, 12, -24); scene.add(fill);
    let groundDepth = Math.max(2120, Math.ceil(manifest.blocks.length / 4) * 17 + 220);
    let groundZ = -groundDepth / 2 + 30;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, groundDepth), new THREE.MeshStandardMaterial({ color: 0xaac39e, roughness: 1 })); floor.rotation.x = -Math.PI / 2; floor.position.set(0, -0.04, groundZ); scene.add(floor);
    const centerWalk = new THREE.Mesh(new THREE.PlaneGeometry(8, groundDepth), new THREE.MeshStandardMaterial({ color: 0xd7c9a7, roughness: 0.94 })); centerWalk.rotation.x = -Math.PI / 2; centerWalk.position.set(0, 0.005, groundZ); scene.add(centerWalk);
    const groundEdges: THREE.Mesh[] = [];
    for (const x of [-4.3, 4.3]) {
      const pathEdge = new THREE.Mesh(new THREE.PlaneGeometry(0.16, groundDepth), new THREE.MeshStandardMaterial({ color: 0xf0dfb8, roughness: 0.9 }));
      pathEdge.rotation.x = -Math.PI / 2; pathEdge.position.set(x, 0.015, groundZ); scene.add(pathEdge); groundEdges.push(pathEdge);
    }
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
    const modelRoots = new WeakMap<THREE.Object3D, string>();
    const modelVoteBadges = new Map<string, { sprite: THREE.Sprite; votes: number }>();
    const textures: THREE.Texture[] = [];
    const disposeTrackedTexture = (texture: THREE.Texture | null) => {
      if (!texture) return;
      texture.dispose(); const index = textures.indexOf(texture); if (index >= 0) textures.splice(index, 1);
    };
    const voteColor = (votes: number, block = false) => votes >= (block ? 15 : 6) ? "#f1c75b" : votes >= (block ? 5 : 3) ? "#9db8c3" : "#bd8251";
    const labelTexture = (text: string, votes = 0) => {
      const canvas = document.createElement("canvas"); canvas.width = 1024; canvas.height = 160;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#173f37"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#f4e8c9"; context.fillRect(12, 12, canvas.width - 24, canvas.height - 24);
      const split = text.indexOf(" · ");
      context.textBaseline = "middle"; context.textAlign = "center"; context.fillStyle = "#b77f37";
      context.font = "bold 78px system-ui, sans-serif"; context.fillText(split < 0 ? "—" : text.slice(0, split), 112, 82);
      context.fillStyle = "#244c42"; context.textAlign = "left"; context.font = "bold 62px system-ui, sans-serif";
      context.fillText(split < 0 ? text.slice(0, 28) : text.slice(split + 3, 34), 220, 82, votes > 0 ? 560 : 780);
      if (votes > 0) { context.fillStyle = voteColor(votes, true); context.fillRect(814, 22, 190, 116); context.fillStyle = "#28483b"; context.textAlign = "center"; context.font = "bold 42px system-ui, sans-serif"; context.fillText(`★ ${votes}`, 909, 65); context.font = "bold 23px system-ui, sans-serif"; context.fillText(`ระดับ${votes >= 15 ? "ทอง" : votes >= 5 ? "เงิน" : "ทองแดง"}`, 909, 112); }
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; textures.push(texture); return texture;
    };
    const landscapeGroup = new THREE.Group(); scene.add(landscapeGroup);
    const titleCanvas = document.createElement("canvas"); titleCanvas.width = 1024; titleCanvas.height = 180;
    const titleContext = titleCanvas.getContext("2d")!; titleContext.fillStyle = "#173f37"; titleContext.fillRect(0, 0, 1024, 180);
    titleContext.strokeStyle = "#e7bd72"; titleContext.lineWidth = 10; titleContext.strokeRect(16, 16, 992, 148);
    titleContext.fillStyle = "#fff4d6"; titleContext.font = "bold 70px system-ui, sans-serif"; titleContext.textAlign = "center"; titleContext.textBaseline = "middle"; titleContext.fillText("สวนผลงานนักเรียน", 512, 90);
    const titleTexture = new THREE.CanvasTexture(titleCanvas); titleTexture.colorSpace = THREE.SRGBColorSpace; textures.push(titleTexture);
    const entrance = new THREE.Group(); scene.add(entrance);
    const archMaterial = new THREE.MeshStandardMaterial({ color: 0x315f4c, roughness: 0.82 });
    for (const x of [-4.4, 4.4]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.42, 4.4, 0.5), archMaterial); post.position.set(x, 2.2, 18); entrance.add(post);
    }
    const archTop = new THREE.Mesh(new THREE.BoxGeometry(9.4, 0.5, 0.62), archMaterial); archTop.position.set(0, 4.1, 18); entrance.add(archTop);
    const archSign = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 1.35), new THREE.MeshBasicMaterial({ map: titleTexture })); archSign.position.set(0, 3.2, 17.66); entrance.add(archSign);
    const blockMap = new Map<string, Manifest["blocks"][number]>();
    const blockGroups = new Map<string, THREE.Group>();
    const blockLabels = new Map<string, { mesh: THREE.Mesh; text: string; votes: number }>();
    const studentModels = new Map<string, GalleryModel[]>();
    const groupStudentModels = () => {
      studentModels.clear();
      for (const item of modelsRef.current) if (!item.hidden) { const group = studentModels.get(item.studentId) ?? []; group.push(item); studentModels.set(item.studentId, group); }
    };
    const trainTrackGroup = new THREE.Group(); scene.add(trainTrackGroup);
    const trainGroup = new THREE.Group(); scene.add(trainGroup);
    trainGroup.visible = false;
    const trainMaterials = new Map<number, THREE.Material>();
    const addTrainPart = (parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], color: number, material?: THREE.Material) => {
      const shared = material ?? trainMaterials.get(color) ?? new THREE.MeshStandardMaterial({ color, roughness: 0.72, flatShading: true });
      if (!material) trainMaterials.set(color, shared);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), shared); mesh.position.set(...position); parent.add(mesh); return mesh;
    };
    addTrainPart(trainGroup, [1.8, 0.7, 2.2], [0, 0.65, 2.3], 0x267a6b);
    addTrainPart(trainGroup, [1.2, 0.9, 1.0], [0, 1.35, 2.7], 0xe8c777);
    addTrainPart(trainGroup, [0.55, 0.9, 0.55], [0, 1.8, 3.4], 0x315a4c);
    addTrainPart(trainGroup, [1.55, 0.12, 0.14], [0, 1.1, 3.43], 0xf5e9c8);
    const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.21, 0.52, 6), trainMaterials.get(0x315a4c)); chimney.position.set(0, 2.05, 2.95); trainGroup.add(chimney);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 5), new THREE.MeshStandardMaterial({ color: 0xffe7a0, emissive: 0xc98622, emissiveIntensity: 0.6, flatShading: true })); lamp.position.set(0, 1.28, 3.48); trainGroup.add(lamp);
    const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x354940, roughness: 0.9, flatShading: true });
    const wheels = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.31, 0.31, 0.14, 8), wheelMaterial, 12);
    const wheelPose = new THREE.Object3D(); let wheelIndex = 0;
    for (const center of [2.2, -1.8, -6.2]) for (const z of [center - 1, center + 1]) for (const x of [-0.9, 0.9]) {
      wheelPose.position.set(x, 0.31, z); wheelPose.rotation.set(0, 0, Math.PI / 2); wheelPose.updateMatrix(); wheels.setMatrixAt(wheelIndex++, wheelPose.matrix);
    }
    trainGroup.add(wheels);
    for (const z of [-1.8, -6.2]) {
      addTrainPart(trainGroup, [2.2, 0.48, 4.0], [0, 0.52, z], 0xe8e0c9);
      addTrainPart(trainGroup, [2.0, 0.35, 3.8], [0, 0.91, z], 0x267a6b);
      addTrainPart(trainGroup, [2.02, 0.09, 0.16], [0, 1.1, z + 1.94], 0xe8c777);
      for (let row = 0; row < 3; row++) for (const x of [-0.55, 0.55]) addTrainPart(trainGroup, [0.72, 0.13, 0.72], [x, 1.18, z + 1.1 - row * 1.1], 0xf5e9c8);
    }
    const trainTarget = { x: 0, z: 2, rotation: 0 };
    const trainSamples: TrainSample[] = [];
    let trainSampleRevision = -1;
    const rebuildTrack = (studentCount: number) => {
      for (const child of [...trainTrackGroup.children]) {
        child.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose?.(); const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []; materials.forEach((material) => material.dispose()); });
      }
      trainTrackGroup.clear();
      const route = trainTrack(studentCount);
      const points = route.map((point) => new THREE.Vector3(point.x, 0.025, point.z));
      if (points.length < 2) return;
      const stations = route.filter((point) => point.id);
      const stationPad = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.45, 1.45, 0.16, 8), new THREE.MeshStandardMaterial({ color: 0xd7c49b, roughness: 0.85 }), stations.length);
      const stationPosts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 1.6, 0.2), new THREE.MeshStandardMaterial({ color: 0x3a6d58, roughness: 0.82 }), stations.length);
      const stationSigns = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.65, 0.12), new THREE.MeshStandardMaterial({ color: 0xf3dfaa, roughness: 0.78 }), stations.length);
      const stationPose = new THREE.Object3D();
      stations.forEach((point, index) => {
        stationPose.position.set(point.x, 0.08, point.z); stationPose.rotation.set(0, 0, 0); stationPose.scale.set(1, 1, 1); stationPose.updateMatrix(); stationPad.setMatrixAt(index, stationPose.matrix);
        stationPose.position.set(point.x + 2.1, 0.86, point.z); stationPose.updateMatrix(); stationPosts.setMatrixAt(index, stationPose.matrix);
        stationPose.position.set(point.x + 2.1, 1.68, point.z); stationPose.updateMatrix(); stationSigns.setMatrixAt(index, stationPose.matrix);
      });
      stationPad.instanceMatrix.needsUpdate = true; stationPosts.instanceMatrix.needsUpdate = true; stationSigns.instanceMatrix.needsUpdate = true;
      trainTrackGroup.add(stationPad, stationPosts, stationSigns);
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
      const text = `${block.studentNumber ?? "—"} · ${block.displayName}`, votes = voteSummaryRef.current?.blockTotals.find((item) => item.studentId === block.studentId)?.votes ?? 0;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(9.1, 1.18), new THREE.MeshBasicMaterial({ map: labelTexture(text, votes) })); label.position.set(0, 2.85, -4.43); group.add(label);
      blockLabels.set(block.studentId, { mesh: label, text, votes });
      blockMap.set(block.studentId, block); blockGroups.set(block.studentId, group);
    };
    const rebuildLandscape = (blocks: Manifest["blocks"][number][], layoutCount: number) => {
      for (const child of [...landscapeGroup.children]) {
        child.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose?.(); const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []; materials.forEach((material) => material.dispose()); });
      }
      landscapeGroup.clear();
      if (!blocks.length) return;
      const count = blocks.length, rows = Math.ceil(layoutCount / 4), treeCount = count * 2 + rows * 2, pose = new THREE.Object3D();
      const pads = new THREE.InstancedMesh(new THREE.BoxGeometry(12, 0.42, 10), new THREE.MeshStandardMaterial({ color: 0x718b67, roughness: 0.98 }), count);
      const decks = new THREE.InstancedMesh(new THREE.BoxGeometry(11.7, 0.08, 9.7), new THREE.MeshStandardMaterial({ color: 0xe8ddc1, roughness: 0.98 }), count);
      const thresholds = new THREE.InstancedMesh(new THREE.BoxGeometry(11.6, 0.08, 0.28), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 }), count);
      const signPosts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 1.58, 0.24), new THREE.MeshStandardMaterial({ color: 0x315f4c, roughness: 0.82 }), count * 2);
      const signBoards = new THREE.InstancedMesh(new THREE.BoxGeometry(9.5, 1.42, 0.18), new THREE.MeshStandardMaterial({ color: 0x315f4c, roughness: 0.82 }), count);
      const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.21, 0.82, 5), new THREE.MeshStandardMaterial({ color: 0x83613f, roughness: 0.98, flatShading: true }), treeCount);
      const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(0.84, 2.22, 5), new THREE.MeshStandardMaterial({ color: 0x4b8060, roughness: 0.94, flatShading: true }), treeCount);
      const flowers = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.18, 0), new THREE.MeshStandardMaterial({ color: 0xe6a66c, roughness: 0.8, flatShading: true }), count * 2);
      const paths = new THREE.InstancedMesh(new THREE.BoxGeometry(72, 0.035, 1.8), new THREE.MeshStandardMaterial({ color: 0xc8b98f, roughness: 1 }), Math.max(1, rows - 1)); paths.count = Math.max(0, rows - 1);
      blocks.forEach((block, index) => {
        const base = blockPosition(block.layoutIndex);
        pose.position.set(base.x, 0.22, base.z); pose.rotation.set(0, 0, 0); pose.scale.set(1, 1, 1); pose.updateMatrix(); pads.setMatrixAt(index, pose.matrix);
        pose.position.y = 0.48; pose.updateMatrix(); decks.setMatrixAt(index, pose.matrix);
        pose.position.set(base.x, 0.55, base.z + 4.55); pose.updateMatrix(); thresholds.setMatrixAt(index, pose.matrix);
        thresholds.setColorAt(index, colorFor(block.studentId).lerp(new THREE.Color("#e8c777"), 0.55));
        pose.position.set(base.x, 3.0, base.z - 4.58); pose.updateMatrix(); signBoards.setMatrixAt(index, pose.matrix);
        for (const [sideIndex, side] of [-1, 1].entries()) {
          const instance = index * 2 + sideIndex;
          pose.position.set(base.x + side * 4.55, 2.85, base.z - 4.58); pose.updateMatrix(); signPosts.setMatrixAt(instance, pose.matrix);
          pose.position.set(base.x + side * 5.08, 1.03, base.z + 3.55); pose.updateMatrix(); trunks.setMatrixAt(instance, pose.matrix);
          pose.position.set(base.x + side * 5.08, 2.32, base.z + 3.55); pose.updateMatrix(); crowns.setMatrixAt(instance, pose.matrix);
          pose.position.set(base.x + side * 4.72, 0.78, base.z + 3.9); pose.scale.set(1, 0.8, 1); pose.updateMatrix(); flowers.setMatrixAt(instance, pose.matrix); pose.scale.set(1, 1, 1);
          flowers.setColorAt(instance, new THREE.Color(sideIndex ? "#e99b73" : "#e5c16d"));
        }
      });
      blocks.forEach((block) => {
        const row = blockPosition(block.layoutIndex).z;
        if (block.layoutIndex % 4 !== 0 || Math.floor(block.layoutIndex / 4) >= rows - 1) return;
        pose.position.set(0, 0.025, row - 8.5); pose.rotation.set(0, 0, 0); pose.scale.set(1, 1, 1); pose.updateMatrix(); paths.setMatrixAt(Math.floor(block.layoutIndex / 4), pose.matrix);
      });
      for (let row = 0; row < rows; row++) for (const [sideIndex, side] of [-1, 1].entries()) {
        const instance = count * 2 + row * 2 + sideIndex, base = blockPosition(row * 4);
        pose.position.set(side * 5.25, 1.03, base.z); pose.updateMatrix(); trunks.setMatrixAt(instance, pose.matrix);
        pose.position.set(side * 5.25, 2.32, base.z); pose.updateMatrix(); crowns.setMatrixAt(instance, pose.matrix);
      }
      for (const mesh of [pads, decks, thresholds, signPosts, signBoards, trunks, crowns, flowers, paths]) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; mesh.computeBoundingSphere(); landscapeGroup.add(mesh); }
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
      for (const [studentId, group] of blockGroups) { const label = blockLabels.get(studentId); if (label) disposeTrackedTexture((label.mesh.material as THREE.MeshBasicMaterial).map); scene.remove(group); disposeAvatarCharacter(group); blockGroups.delete(studentId); blockMap.delete(studentId); blockLabels.delete(studentId); }
      for (const block of blocks) if (current.has(block.studentId)) addBlock(block);
      rebuildLandscape(blocks, layoutCount);
      rebuildTrack(layoutCount);
      const rows = Math.ceil(layoutCount / 4), depth = Math.max(2120, rows * 17 + 220), centerZ = -depth / 2 + 30;
      groundDepth = depth; groundZ = centerZ;
      for (const [mesh, width] of [[floor, 120], [centerWalk, 8], ...groundEdges.map((edge) => [edge, 0.16] as [THREE.Mesh, number])] as [THREE.Mesh, number][]) {
        mesh.geometry.dispose(); mesh.geometry = new THREE.PlaneGeometry(width, depth); mesh.position.z = centerZ;
      }
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
      modelMeshes.set(item.id, exhibit);
      renderedModels.add(item.id);
    };
    const syncExhibits = () => {
      if (layoutChanged) {
        for (const modelId of [...renderedModels]) {
          evictModel(modelId);
          removeModelVoteBadge(modelId);
          const exhibit = modelMeshes.get(modelId); if (exhibit) { scene.remove(exhibit); disposeAvatarCharacter(exhibit); modelMeshes.delete(modelId); }
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
        removeModelVoteBadge(modelId);
        const exhibit = modelMeshes.get(modelId); if (exhibit) { scene.remove(exhibit); disposeAvatarCharacter(exhibit); modelMeshes.delete(modelId); }
        renderedModels.delete(modelId);
      }
    };
    const removeModelVoteBadge = (modelId: string) => {
      const current = modelVoteBadges.get(modelId); if (!current) return;
      current.sprite.parent?.remove(current.sprite); disposeTrackedTexture(current.sprite.material.map);
      current.sprite.material.dispose(); modelVoteBadges.delete(modelId);
    };
    const createVoteBadge = (votes: number) => {
      const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 104;
      const context = canvas.getContext("2d")!; context.fillStyle = voteColor(votes); context.fillRect(8, 8, 240, 88);
      context.fillStyle = "#263d35"; context.textAlign = "center"; context.textBaseline = "middle"; context.font = "bold 42px system-ui, sans-serif"; context.fillText(`★ ${votes}`, 128, 37); context.font = "bold 18px system-ui, sans-serif"; context.fillText(`ระดับ${votes >= 6 ? "ทอง" : votes >= 3 ? "เงิน" : "ทองแดง"}`, 128, 74);
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; textures.push(texture);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })); sprite.position.set(0, 2.55, 0); sprite.scale.set(1.5, 0.61, 1); sprite.renderOrder = 3;
      return sprite;
    };
    const syncVoteVisuals = () => {
      const totals = new Map((voteSummaryRef.current?.blockTotals ?? []).map((item) => [item.studentId, item.votes]));
      for (const [studentId, label] of blockLabels) {
        const votes = totals.get(studentId) ?? 0;
        if (votes === label.votes) continue;
        const material = label.mesh.material as THREE.MeshBasicMaterial;
        disposeTrackedTexture(material.map); material.map = labelTexture(label.text, votes); material.needsUpdate = true;
        label.votes = votes;
      }
      const currentModels = new Map(modelsRef.current.map((item) => [item.id, item]));
      for (const [modelId, exhibit] of modelMeshes) {
        const item = currentModels.get(modelId), votes = item && !item.hidden ? item.likes : 0;
        const current = modelVoteBadges.get(modelId);
        if (current?.votes === votes) continue;
        removeModelVoteBadge(modelId);
        if (votes && votes > 0) { const sprite = createVoteBadge(votes); exhibit.add(sprite); modelVoteBadges.set(modelId, { sprite, votes }); }
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
      const hit = raycaster.intersectObjects([...loadedModels.values()].map((model) => model.object), true)[0];
      const modelId = hit && galleryModelIdForHit(hit.object, modelRoots);
      const model = modelId && modelsRef.current.find((item) => item.id === modelId && !item.hidden);
      if (model) setSelected(model);
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
    let syncedManifest = manifestRef.current, syncedModels = modelsRef.current, syncedPages = displayPagesRef.current, syncedVotes = voteSummaryRef.current;
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
    groupStudentModels(); syncExhibits(); syncVoteVisuals();
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
        exhibit.add(object); modelRoots.set(object, next.item.id); loadedModels.set(next.item.id, { object, triangles: parsed.triangles, textureBytes: parsed.textureBytes ?? 0 }); residentTriangles += parsed.triangles; residentTextureBytes += parsed.textureBytes ?? 0; deferredModels.delete(next.item.id);
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
      room.onLeave((code: number) => { if (alive) { if (code === 4403) { setEnabled(false); setManifest(null); setError("ครูหยุดโลกเสมือนสำหรับนักเรียนแล้ว"); return; } if (code === 4003 && !teacher) { initialized = false; setOnline(0); setError("สิทธิ์เข้าโลกเปลี่ยนแล้ว กรุณาตรวจสอบงานล่าสุดหรือรอครูอนุมัติในหน้าห้องเรียน"); return; } initialized = false; setOnline(0); setError("การเชื่อมต่อโลกเสมือนสิ้นสุด กรุณาออกแล้วเข้าใหม่"); } });
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
            const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(player.role === "teacher" || player.role === "owner" ? `ครู ${player.displayName}` : player.displayName), transparent: true })); label.scale.set(2.6, 0.5, 1); label.position.y = avatarNameLabelY; avatar.add(label); scene.add(avatar); avatarMeshes.set(id, avatar);
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
      if (syncedManifest !== manifestRef.current) { syncedManifest = manifestRef.current; syncBlocks(); syncExhibits(); syncVoteVisuals(); }
      if (syncedModels !== modelsRef.current || syncedPages !== displayPagesRef.current) { syncedModels = modelsRef.current; syncedPages = displayPagesRef.current; groupStudentModels(); syncExhibits(); syncVoteVisuals(); }
      if (syncedVotes !== voteSummaryRef.current) { syncedVotes = voteSummaryRef.current; syncVoteVisuals(); }
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
  async function refreshGalleryAccess() {
    setLoading(true); setError(""); setAccessMessage("");
    try { await loadGalleryAccess(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "โหลดสิทธิ์เข้าโลกไม่สำเร็จ"); }
    finally { setLoading(false); }
  }
  async function saveEntryMode() {
    setLoading(true); setError(""); setAccessMessage("");
    try {
      await api(apiPath(classroomId, "/access"), { method: "PUT", body: JSON.stringify({ mode: entryMode }) });
      await loadGalleryAccess();
      setEntryModeDraft(null);
      setAccessMessage("บันทึกเงื่อนไขเข้าโลกแล้ว");
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกเงื่อนไขเข้าโลกไม่สำเร็จ"); }
    finally { setLoading(false); }
  }
  async function setStudentApproval(student: GalleryAccessStudent, approved: boolean) {
    if (!galleryAccess?.requiredAssignmentId) return;
    setLoading(true); setError(""); setAccessMessage("");
    try {
      await api(apiPath(classroomId, `/access/${student.studentId}`), { method: "PUT", body: JSON.stringify({ assignmentId: galleryAccess.requiredAssignmentId, approved }) });
      await loadGalleryAccess(); setAccessMessage(`${student.displayName}: ${approved ? "อนุมัติแล้ว" : "ถอนการอนุมัติแล้ว"}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกสิทธิ์นักเรียนไม่สำเร็จ"); await loadGalleryAccess().catch(() => {}); }
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
  async function toggleVote(fileId: string, undo: boolean) {
    try {
      const result = await api<{ likes: number; likedByMe: boolean }>(apiPath(classroomId, `/files/${fileId}/like`), { method: undo ? "DELETE" : "PUT" });
      setModels((all) => all.map((item) => item.id === fileId ? { ...item, likes: result.likes, likedByMe: result.likedByMe } : item));
      setSelected((item) => item?.id === fileId ? { ...item, likes: result.likes, likedByMe: result.likedByMe } : item);
      try { setVoteSummary(await api<VoteSummary>(apiPath(classroomId, "/votes"))); }
      catch { setError("บันทึกโหวตแล้ว แต่โหลดยอดล่าสุดไม่สำเร็จ"); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกการถูกใจไม่สำเร็จ"); }
  }

  function like(model: GalleryModel) { return toggleVote(model.id, model.likedByMe); }

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
  const selectedVoteUsed = selected ? voteSummary?.usage.find((item) => item.assignmentId === selected.assignmentId)?.used ?? 0 : 0;
  const selectedVotesRemaining = voteSummary ? Math.max(0, voteSummary.limit - selectedVoteUsed) : 10;
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
        <div className="gallery-toolbar-room"><span className="gallery-room-mark" aria-hidden="true">✦</span><div><strong>{manifest?.classroomName ?? "โลกเสมือน"}</strong><small><span className="gallery-online-dot" aria-hidden="true" />{online} คนออนไลน์ · WASD/Space หรือจอยสติ๊ก</small></div></div>
        <div className="gallery-toolbar-actions">
          <button className="button button-quiet gallery-menu-toggle" aria-expanded={menuOpen} aria-controls="gallery-menu" onClick={() => setMenuOpen((open) => !open)}><span aria-hidden="true">☰</span>{menuOpen ? "ปิดเมนู" : "เมนู"}</button>
          <button className="button button-quiet gallery-fullscreen-toggle" onClick={immersive ? exitFullscreenView : toggleFullscreen}><span aria-hidden="true">⛶</span>{immersive ? "ออกจากเต็มจอ" : "เต็มจอ"}</button>
        </div>
      </header>
      <div id="gallery-menu" className="gallery-menu" hidden={!menuOpen}>
        <div className="gallery-menu-header"><strong>เมนูโลกเสมือน</strong><div><button className="button button-quiet" onClick={() => setMenuOpen(false)}>ปิดเมนู</button>{close && <button className="button button-quiet" onClick={close}>กลับห้องเรียน</button>}</div></div>
        <div className="gallery-menu-room"><strong>{manifest?.classroomName ?? "โลกเสมือน"}</strong><small>{online} คนออนไลน์ · WASD/ลูกศร เดิน · Space กระโดด · ลากเพื่อหมุนมุมมอง</small></div>
        {user.role === "student" && <div className="gallery-attendance"><StudentAttendance /></div>}
        {user.role === "student" && <section className="gallery-management gallery-vote-list"><strong>โหวตผลงานของเพื่อน · ไม่เกิน 10 ครั้งต่องาน</strong>
          {voteSummary?.usage.map((item) => <small key={item.assignmentId}>{item.assignmentTitle}: ใช้แล้ว {item.used}/{voteSummary.limit} · เหลือ {Math.max(0, voteSummary.limit - item.used)}</small>)}
          {voteSummary?.myVotes.length ? voteSummary.myVotes.map((vote) => <div className="gallery-vote-entry" key={vote.fileId}>
            <span><strong>{vote.studentNumber ?? "—"}. {vote.displayName}</strong><small>{vote.assignmentTitle} · {vote.originalName}{vote.hidden ? " · ครูซ่อนผลงาน" : vote.unavailable ? " · งาน/พื้นที่นี้ไม่แสดงแล้ว" : ""}</small></span>
            <button className="text-button" onClick={() => void toggleVote(vote.fileId, true)}>ยกเลิก</button>
          </div>) : <small>{voteSummary ? "ยังไม่ได้โหวต · ยกเลิกโหวตแล้วจะได้สิทธิ์คืน" : "กำลังโหลดโหวต…"}</small>}
        </section>}
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
        {teacher && <section className="gallery-management gallery-access">
          <strong>สิทธิ์เข้าโลกของนักเรียน</strong>
          <p>งานล่าสุด: {galleryAccess?.requiredAssignmentTitle ?? "ยังไม่มีงานที่เปิดอยู่"}</p>
          <div className="gallery-access-mode">
            <label>เงื่อนไข
              <select disabled={loading || !galleryAccess} value={entryMode} onChange={(event) => setEntryModeDraft(event.target.value as GalleryAccess["mode"])}>
                <option value="submission">ส่งงานล่าสุดแล้วเข้าได้</option>
                <option value="approval">ครูอนุมัติรายคนหลังส่งงาน</option>
              </select>
            </label>
            <button className="button button-quiet" disabled={loading || !galleryAccess} onClick={() => void saveEntryMode()}>บันทึก</button>
            <button className="button button-quiet" disabled={loading} onClick={() => void refreshGalleryAccess()}>โหลดสถานะใหม่</button>
          </div>
          {galleryAccess?.mode === "approval" && <div className="gallery-access-roster">
            {galleryAccess.students.map((student) => <div className="gallery-access-student" key={student.studentId}>
              <span>
                <strong>{student.studentNumber ?? "—"}. {student.displayName}</strong>
                <small>{!student.accountLinked ? "ยังไม่เชื่อมบัญชี Google" : !student.hasSubmission ? "ยังไม่ส่งงานล่าสุด" : student.approved ? "อนุมัติแล้ว" : "ส่งแล้ว · ยังไม่ได้อนุมัติ"}</small>
              </span>
              <button className="text-button" disabled={loading || !galleryAccess.requiredAssignmentId || !student.accountLinked || (!student.hasSubmission && !student.approved)} onClick={() => void setStudentApproval(student, !student.approved)}>
                {student.approved ? "ถอนอนุมัติ" : "อนุมัติ"}
              </button>
            </div>)}
            {!galleryAccess.students.length && <small>ยังไม่มีนักเรียนในห้องนี้</small>}
          </div>}
          {accessMessage && <small role="status">{accessMessage}</small>}
        </section>}
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
      {selected && <aside className="gallery-inspect"><button className="icon-button" onClick={() => setSelected(null)} aria-label="ปิด">×</button><p className="eyebrow">{selected.displayName} · เลขที่ {selected.studentNumber ?? "—"}</p><h3>{selected.originalName}</h3><p className="muted">{selected.assignmentTitle}</p><p>{selected.likes} ถูกใจ{selected.likes >= 6 ? " · ระดับทอง" : selected.likes >= 3 ? " · ระดับเงิน" : selected.likes > 0 ? " · ระดับทองแดง" : ""}</p>{selectedPageCount > 1 && <div className="gallery-display-pages"><span>ผลงานในพื้นที่ {selectedPage * 40 + 1}–{Math.min(selectedPage * 40 + 40, selectedStudentWork.length)} จาก {selectedStudentWork.length}</span><button className="text-button" disabled={selectedPage === 0} onClick={() => { const next = selectedStudentWork[(selectedPage - 1) * 40]; setDisplayPages((pages) => ({ ...pages, [selected.studentId]: selectedPage - 1 })); if (next) setSelected(next); }}>ก่อนหน้า</button><button className="text-button" disabled={selectedPage + 1 >= selectedPageCount} onClick={() => { const next = selectedStudentWork[(selectedPage + 1) * 40]; setDisplayPages((pages) => ({ ...pages, [selected.studentId]: selectedPage + 1 })); if (next) setSelected(next); }}>ถัดไป</button></div>}{user.role === "student" && selected.studentId !== manifest?.viewerStudentId && <><small>เหลือ {selectedVotesRemaining}/{voteSummary?.limit ?? 10} โหวตสำหรับงานนี้</small><button className="button button-quiet" disabled={!selected.likedByMe && selectedVotesRemaining <= 0} onClick={() => void like(selected)}>{selected.likedByMe ? "ยกเลิกโหวต · ได้สิทธิ์คืน" : selectedVotesRemaining <= 0 ? "โหวตครบแล้ว" : "โหวตผลงานนี้"}</button></>}{teacher && <button className="button button-quiet" onClick={() => void setHidden(selected)}>{selected.hidden ? "แสดงผลงาน" : "ซ่อนผลงาน"}</button>}<button className="button button-primary" onClick={() => setPreview(selected)}>เปิดดูโมเดล</button></aside>}
      {customizerOpen && <CharacterCustomizer appearance={draftAppearance} onChange={setDraftAppearance} onCancel={() => setCustomizerOpen(false)} onSave={() => void saveAppearance()} saving={loading} error={error} />}
    </section>
    {preview && <ModelPreview file={preview} contentPath={galleryFileUrl(classroomId, preview.id, "content")} materialPath={preview.materialAvailable ? galleryFileUrl(classroomId, preview.id, "material") : undefined} close={() => setPreview(null)} />}
  </>;
}

function CharacterCustomizer({ appearance, onChange, onCancel, onSave, saving, error }: { appearance: AvatarAppearance; onChange: (value: AvatarAppearance) => void; onCancel: () => void; onSave: () => void; saving: boolean; error: string }) {
  const choices = {
    hairStyle: [["none", "ไม่มีผม"], ["short", "สั้น"], ["long", "ยาว"], ["ponytail", "หางม้า"], ["bun", "มวยผม"], ["spiky", "ตั้ง"], ["bob", "บ๊อบ"]],
    hatStyle: [["none", "ไม่มี"], ["cap", "หมวกแก๊ป"], ["beanie", "หมวกไหมพรม"], ["wizard", "หมวกพ่อมด"]],
    glassesStyle: [["none", "ไม่มี"], ["round", "ทรงกลม"], ["square", "ทรงเหลี่ยม"]],
    shoeStyle: [["none", "ไม่มี"], ["sneakers", "รองเท้าผ้าใบ"], ["boots", "รองเท้าบูต"]],
  } as const;
  return <div className="character-editor-backdrop"><section className="character-editor" role="dialog" aria-modal="true" aria-labelledby="character-editor-title">
    <header><h2 id="character-editor-title">ปรับแต่งตัวละคร</h2><button className="icon-button" onClick={onCancel} aria-label="ยกเลิก">×</button></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="character-editor-layout"><div className="character-preview-column"><span>ตัวอย่างตัวละคร</span><CharacterPreview appearance={appearance} /></div>
      <div className="character-controls">
        <section className="character-control-group"><h3>ร่างกาย</h3><label>สีผิว<input type="color" value={appearance.skinColor} onChange={(event) => onChange({ ...appearance, skinColor: event.target.value })} /></label></section>
        <section className="character-control-group"><h3>เสื้อผ้า</h3><label>สีเสื้อ<input type="color" value={appearance.shirtColor} onChange={(event) => onChange({ ...appearance, shirtColor: event.target.value })} /></label><label>สีกางเกง<input type="color" value={appearance.trousersColor} onChange={(event) => onChange({ ...appearance, trousersColor: event.target.value })} /></label><label>รองเท้า<select value={appearance.shoeStyle} onChange={(event) => onChange({ ...appearance, shoeStyle: event.target.value as AvatarAppearance["shoeStyle"] })}>{choices.shoeStyle.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label>สีรองเท้า<input type="color" value={appearance.shoeColor} onChange={(event) => onChange({ ...appearance, shoeColor: event.target.value })} /></label></section>
        <section className="character-control-group"><h3>ทรงผมและเครื่องประดับ</h3><label>ทรงผม<select value={appearance.hairStyle} onChange={(event) => onChange({ ...appearance, hairStyle: event.target.value as AvatarAppearance["hairStyle"] })}>{choices.hairStyle.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label>สีผม<input type="color" value={appearance.hairColor} onChange={(event) => onChange({ ...appearance, hairColor: event.target.value })} /></label><label>หมวก<select value={appearance.hatStyle} onChange={(event) => onChange({ ...appearance, hatStyle: event.target.value as AvatarAppearance["hatStyle"] })}>{choices.hatStyle.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label>สีหมวก<input type="color" value={appearance.hatColor} onChange={(event) => onChange({ ...appearance, hatColor: event.target.value })} /></label><label>แว่นตา<select value={appearance.glassesStyle} onChange={(event) => onChange({ ...appearance, glassesStyle: event.target.value as AvatarAppearance["glassesStyle"] })}>{choices.glassesStyle.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label>สีแว่นตา<input type="color" value={appearance.glassesColor} onChange={(event) => onChange({ ...appearance, glassesColor: event.target.value })} /></label></section>
      </div>
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
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.add(new THREE.HemisphereLight(0xfff7ea, 0x788b92, 1.65));
    const key = new THREE.DirectionalLight(0xffecce, 2.05);
    key.position.set(-3, 5, 4);
    const rim = new THREE.DirectionalLight(0xc9e8ff, 1.7);
    rim.position.set(2, 3, -4);
    scene.add(key, rim);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
    const resize = () => {
      const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      const distance = Math.max(2.6, 1.3 / camera.aspect) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      camera.position.set(0, 1.32, distance);
      camera.lookAt(0, 1.065, 0);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, lastFrame = 0;
    const render = (time: number) => {
      frame = requestAnimationFrame(render);
      if (characterRef.current && lastFrame && !reducedMotion.matches) {
        characterRef.current.rotation.y += Math.min(time - lastFrame, 40) * 0.00052;
      }
      lastFrame = time;
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      disposeAvatarCharacter(scene);
      renderer.dispose(); renderer.forceContextLoss();
      sceneRef.current = null; characterRef.current = null;
    };
  }, []);
  useEffect(() => {
    const scene = sceneRef.current; if (!scene) return;
    const previous = characterRef.current;
    const character = createAvatarCharacter(appearance);
    character.rotation.y = previous?.rotation.y ?? -0.36;
    if (previous) { scene.remove(previous); disposeAvatarCharacter(previous); }
    scene.add(character); characterRef.current = character;
  }, [appearance]);
  return <canvas ref={canvasRef} className="character-preview" aria-label="ตัวอย่างตัวละครที่กำลังหมุน" />;
}
