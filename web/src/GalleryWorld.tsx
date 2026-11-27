import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as THREE from "three";
import { Client } from "@colyseus/sdk";
import { api } from "./api";
import { StudentAttendance } from "./StudentAttendance";
import ModelPreview from "./ModelPreview";
import { loadModel, createModelObject, disposeModelObject } from "./model-view";
import { galleryFileUrl, galleryTicketRequest } from "./gallery-api";
import { galleryModelIdForHit } from "./gallery-picking";
import { animateAvatarCharacter, avatarHipHeight, avatarNameLabelY, createAvatarCharacter, defaultAvatarAppearance, disposeAvatarCharacter, type AvatarAppearance } from "./gallery-avatar";
import { correctionOffset, facingRotation, interpolateTrain, jumpHeight, reconcilePosition, touchDirection, walkingStep, type Move, type TrainSample } from "./gallery-motion";
import { canvasAimPoint, wandAim } from "./gallery-aim";
import { enterGalleryFullscreen, unlockGalleryOrientation } from "./gallery-fullscreen";
import { blockPosition, exhibitPosition, trainStartStation, trainTrack } from "../../gallery-server/src/train-layout.mjs";
import { aisleTreeTrunk, avatarHeight, avatarRadius, blockingProp, jumpApex, slidePastProps, studentSpaceCollision } from "../../gallery-server/src/student-space.mjs";
import { canBoardTrain, stationWaitMs } from "../../gallery-server/src/train-rules.mjs";
import { LANDING_HEIGHT, VEHICLE_BAY_Z, VEHICLE_ENTER_DISTANCE, vehicleKinds, vehicleSpecs, type VehicleKind } from "../../gallery-server/src/vehicles.mjs";
import { broomSeatHeight, knockMessages, vehicleModel, vehicleNames, type VehicleState } from "./gallery-vehicles";
import { createPresentBlast, createPresentModel, createSantaModel, disposeSantaModel } from "./gallery-santa";
import { depot, nearPlace, portal, rentalPads, shop } from "../../gallery-server/src/world-places.mjs";
import { createActivityLandmarks, itemNames, shopItems, type ShopPrices, type Wallet } from "./gallery-activities";
import { rankWanted, type PatrolSettings } from "../../gallery-server/src/patrol.mjs";
import { createGalleryJail, MostWanted, PatrolSettingsForm, type OfficerView, type WantedEntry } from "./gallery-patrol";

type User = { role: "owner" | "teacher" | "student"; displayName: string };
type GalleryModel = { id: string; spaceId: string; studentId: string; displayName: string; studentNumber: number | null; assignmentId: string; assignmentTitle: string; originalName: string; mediaType: string; materialAvailable: boolean; createdAt: string; hidden: boolean; likes: number; likedByMe: boolean };
type VoteSummary = { limit: number; blockTotals: { spaceId?: string; studentId?: string; votes: number }[]; usage: { assignmentId: string; assignmentTitle: string; used: number }[]; myVotes: { fileId: string; assignmentId: string; assignmentTitle: string; originalName: string; displayName: string; studentNumber: number | null; hidden: boolean; unavailable: boolean }[] };
type TrainSettings = { mode: "auto" | "manual"; intervalSeconds: 60 | 120; startStudentId: string | null; stationWaitSeconds?: Record<string, number> };
type TrainView = Omit<TrainSettings, "stationWaitSeconds"> & { active: boolean; x: number; z: number; rotation: number; phase: "waiting" | "boarding" | "moving" | "dwell"; stopId: string; nextStopId: string; departureAt: number; arrivalAt: number; seats: number; revision: number; layoutRoster: string; exhibitionAssignmentId?: string };
type SantaSettings = { fuseSeconds: number; respawnSeconds: number };
type Space = { spaceId: string; displayName: string; studentNumber: number | null; layoutIndex: number };
type Manifest = { enabled: boolean; classroomId: string; classroomName: string; blocks: Space[]; models: GalleryModel[]; nextOffset: number | null; teacher: boolean; viewerStudentId: string | null; exhibition: { requested: string | null; displayed: string | null; options: { id: string; title: string }[] }; trainStudents: { id: string; displayName: string; studentNumber: number }[]; train: TrainSettings; santa: SantaSettings; shop: ShopPrices; patrol?: PatrolSettings };
type ModelAdjustment = { yaw: number; tilt: number; size: number };
const initialModelAdjustment: ModelAdjustment = { yaw: 0, tilt: 0, size: 100 };
const pageSize = 40;
type GalleryAccessStudent = { studentId: string; accountLinked: boolean; displayName: string; studentNumber: number | null; requiredAssignmentId: string | null; requiredAssignmentTitle: string | null; hasSubmission: boolean; approved: boolean; entryAllowed: boolean };
type GalleryAccess = { mode: "submission" | "approval"; requiredAssignmentId: string | null; requiredAssignmentTitle: string | null; students: GalleryAccessStudent[] };
type Avatar = AvatarAppearance & { displayName: string; role: string; x: number; z: number; rotation: number; sequence?: number; jump?: number; movementEpoch?: number; knocked?: boolean; knockCause?: string; respawnAt?: number; protectedUntil?: number; wantedCount?: number; wantedSince?: number; jailedUntil?: number; trainSeat?: number; vehicleId?: string };
type VehicleAvailability = Pick<VehicleState, "id" | "kind" | "revision" | "driverId" | "rental" | "hitLimit" | "hitsRemaining" | "fuelCapacity" | "fuelRemaining" | "landing"> & { driverName?: string };
type GalleryMenu = "menu" | "tools" | "settings";
type Activity = "" | "portal" | "shop" | "depot";
type BoltVisual = { group: THREE.Group; trail: THREE.Line; target: THREE.Vector3 };
type PresentView = { x: number; z: number; expiresAt: number };
type SantaView = { enabled: boolean; x: number; z: number; rotation: number };

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
  const santaActiveRef = useRef(false);
  const presentPositionsRef = useRef(new Map<string, PresentView>());
  const [displayPages, setDisplayPages] = useState<Record<string, number>>({});
  const displayPagesRef = useRef(displayPages);
  const [selected, setSelected] = useState<GalleryModel | null>(null);
  const selectedRef = useRef(selected);
  const [adjustment, setAdjustment] = useState(initialModelAdjustment);
  const adjustmentRef = useRef(adjustment);
  const [preview, setPreview] = useState<GalleryModel | null>(null);
  const [exhibitionDraft, setExhibitionDraft] = useState<string | null>(null);
  const loadRequest = useRef(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(0);
  const [trainView, setTrainView] = useState<TrainView | null>(null);
  const [trainClock, setTrainClock] = useState(Date.now());
  const [trainSeat, setTrainSeat] = useState(-1);
  const [trainAction, setTrainAction] = useState<"board" | "leave" | null>(null);
  const [trainForm, setTrainForm] = useState<TrainSettings>({ mode: "auto", intervalSeconds: 120, startStudentId: null });
  const [trainMessage, setTrainMessage] = useState("");
  const [santaMessage, setSantaMessage] = useState("");
  const [santaForm, setSantaForm] = useState<SantaSettings>({ fuseSeconds: 5, respawnSeconds: 10 });
  const lastSavedSantaSettings = useRef<SantaSettings | null>(null);
  const [vehicles, setVehicles] = useState<VehicleAvailability[] | null>(null);
  const [driving, setDriving] = useState<VehicleKind | "">("");
  const [vehicleNearby, setVehicleNearby] = useState("");
  const [canExitVehicle, setCanExitVehicle] = useState(true);
  const [vehicleMessage, setVehicleMessage] = useState("");
  const drivingRef = useRef("");
  const drivingKindRef = useRef<VehicleKind | "">("");
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [votePending, setVotePending] = useState(false);
  const [voteNotice, setVoteNotice] = useState<{ fileId: string; text: string } | null>(null);
  const voteInFlight = useRef<AbortController | null>(null);
  const [activity, setActivity] = useState<Activity>("");
  const [activityPanel, setActivityPanel] = useState<"" | "shop" | "depot">("");
  const activityPanelRef = useRef(false);
  const [activityMessage, setActivityMessage] = useState("");
  const [shopPrices, setShopPrices] = useState<ShopPrices | null>(null);
  const [quote, setQuote] = useState<{ item: keyof ShopPrices; price: number; requestId: string } | null>(null);
  const [activityPending, setActivityPending] = useState(false);
  const activityTimeout = useRef<number | undefined>(undefined);
  const liftRef = useRef(0);
  const [galleryAccess, setGalleryAccess] = useState<GalleryAccess | null>(null);
  const [entryModeDraft, setEntryModeDraft] = useState<GalleryAccess["mode"] | null>(null);
  const entryMode = entryModeDraft ?? galleryAccess?.mode ?? "submission";
  const [accessMessage, setAccessMessage] = useState("");
  const trainRef = useRef<TrainView | null>(null);
  const trainSeatRef = useRef(-1);
  const lastSavedTrainSettings = useRef<TrainSettings | null>(null);
  const [wandMode, setWandMode] = useState(false);
  const [aimValid, setAimValid] = useState(false);
  const [santaActive, setSantaActive] = useState(false);
  const [nearestPresent, setNearestPresent] = useState("");
  const [openingPresent, setOpeningPresent] = useState("");
  const [giftMessage, setGiftMessage] = useState("");
  const [blastDeadline, setBlastDeadline] = useState(0);
  const [blastSeconds, setBlastSeconds] = useState(0);
  const crosshairRef = useRef<HTMLDivElement>(null);
  const aimPoint = useRef(new THREE.Vector2());
  const [castReady, setCastReady] = useState(true);
  const [knockSeconds, setKnockSeconds] = useState(0);
  const [wanted, setWanted] = useState<{ entries: WantedEntry[]; targetId: string } | null>(null);
  const [knockCause, setKnockCause] = useState("wand");
  const roomRef = useRef<any>(null);
  const wandRef = useRef(false);
  const knockedRef = useRef(false);
  const fireWandRef = useRef<() => void>(() => {});
  const lastKnockSecond = useRef(-1);
  const castReadyAt = useRef(0);
  const knockUntil = useRef(0);
  const boltMeshes = useRef(new Map<string, BoltVisual>());
  const effectMeshes = useRef<Array<{ mesh: THREE.Mesh; until: number; duration: number; velocity?: THREE.Vector3 }>>([]);
  const [appearance, setAppearance] = useState<AvatarAppearance>(defaultAvatarAppearance);
  const [draftAppearance, setDraftAppearance] = useState<AvatarAppearance>(defaultAvatarAppearance);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState<GalleryMenu | null>(null);
  const menuOpen = activeMenu !== null;
  const menuButtons = useRef<Partial<Record<GalleryMenu, HTMLButtonElement>>>({});
  const menuOpenRef = useRef(false);
  const [immersive, setImmersive] = useState(true);
  const [landscapeRequired, setLandscapeRequired] = useState(false);
  const customizerOpenRef = useRef(false);
  const appearanceRef = useRef(appearance);
  const touchRef = useRef({ x: 0, z: 0 });
  const touchKnobRef = useRef<HTMLSpanElement>(null);
  const landscapeRequiredRef = useRef(false);
  const jumpRef = useRef(false);
  const teacher = user.role !== "student";
  const canEquipWand = teacher || Boolean(wallet?.spells);
  const canEquipWandRef = useRef(canEquipWand);
  canEquipWandRef.current = canEquipWand;
  activityPanelRef.current = Boolean(activityPanel);
  useEffect(() => {
    if (!canEquipWand) setWandMode(false);
  }, [canEquipWand]);
  useEffect(() => {
    if (activityPanel && activity !== activityPanel) {
      setActivityPanel(""); setShopPrices(null); setQuote(null);
    }
  }, [activity, activityPanel]);
  useEffect(() => () => window.clearTimeout(activityTimeout.current), []);
  useEffect(() => { document.documentElement.classList.toggle("gallery-immersive", immersive); }, [immersive]);
  useEffect(() => {
    const onFullscreenChange = () => { if (!document.fullscreenElement) { setImmersive(false); unlockGalleryOrientation(); } };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeMenu) {
        setActiveMenu(null);
        menuButtons.current[activeMenu]?.focus({ preventScroll: true });
      } else if (!document.fullscreenElement) setImmersive(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("fullscreenchange", onFullscreenChange); window.removeEventListener("keydown", onKeyDown); };
  }, [activeMenu]);
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
  selectedRef.current = selected;
  adjustmentRef.current = adjustment;
  useEffect(() => { setAdjustment(initialModelAdjustment); }, [selected?.id, selected?.spaceId]);
  useEffect(() => { voteSummaryRef.current = voteSummary; }, [voteSummary]);
  useEffect(() => { santaActiveRef.current = santaActive; }, [santaActive]);
  useEffect(() => {
    if (!blastDeadline) { setBlastSeconds(0); return; }
    const update = () => setBlastSeconds(Math.max(0, Math.ceil((blastDeadline - Date.now()) / 1000)));
    update(); const timer = window.setInterval(update, 200);
    return () => window.clearInterval(timer);
  }, [blastDeadline]);
  useEffect(() => {
    if (!giftMessage) return;
    const timer = window.setTimeout(() => setGiftMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [giftMessage]);
  useEffect(() => { displayPagesRef.current = displayPages; }, [displayPages]);
  useEffect(() => { manifestRef.current = manifest; }, [manifest]);
  useEffect(() => {
    if (!manifest?.train) return;
    if (!lastSavedTrainSettings.current || JSON.stringify(lastSavedTrainSettings.current) !== JSON.stringify(manifest.train)) {
      lastSavedTrainSettings.current = { ...manifest.train }; setTrainForm({ ...manifest.train });
    }
  }, [manifest?.train]);
  useEffect(() => {
    if (!manifest?.santa) return;
    if (!lastSavedSantaSettings.current || JSON.stringify(lastSavedSantaSettings.current) !== JSON.stringify(manifest.santa)) {
      lastSavedSantaSettings.current = { ...manifest.santa }; setSantaForm({ ...manifest.santa });
    }
  }, [manifest?.santa]);
  useEffect(() => {
    lastSavedTrainSettings.current = null; lastSavedSantaSettings.current = null; setTrainView(null); setTrainSeat(-1); setDisplayPages({});
    setSantaActive(false); setNearestPresent(""); setGiftMessage(""); setSantaForm({ fuseSeconds: 5, respawnSeconds: 10 });
    setWanted(null); setActiveMenu(null);
    window.clearTimeout(activityTimeout.current);
    setWallet(null); setShopPrices(null); setQuote(null); setActivityPanel(""); setActivity(""); setActivityMessage(""); setActivityPending(false);
    setVotePending(false); setVoteNotice(null); setSelected(null); setPreview(null); setExhibitionDraft(null);
    return () => { loadRequest.current++; voteInFlight.current?.abort(); voteInFlight.current = null; };
  }, [classroomId]);
  customizerOpenRef.current = customizerOpen;
  menuOpenRef.current = menuOpen;
  wandRef.current = wandMode;
  appearanceRef.current = appearance;
  const load = useCallback(async (offset = 0) => {
    const request = ++loadRequest.current;
    const priorLayout = manifestRef.current?.exhibition.displayed ?? null;
    const limit = offset ? 0 : modelsRef.current.length;
    const [value, votes] = await Promise.all([
      api<Manifest>(apiPath(classroomId, `?offset=${offset}&limit=${limit}${offset ? `&layout=${priorLayout ?? ""}` : ""}`)),
      api<VoteSummary>(apiPath(classroomId, "/votes")).catch(() => null),
    ]);
    if (request !== loadRequest.current) return;
    setManifest(value); setEnabled(value.enabled);
    setModels((current) => offset ? [...new Map([...current, ...value.models].map((model) => [model.id, model])).values()] : value.models);
    if (votes) setVoteSummary(votes);
  }, [classroomId]);
  useEffect(() => {
    if (!selected) return;
    const current = models.find((model) => model.id === selected.id);
    if (!current || current.hidden || current.spaceId !== selected.spaceId) { setSelected(null); setPreview(null); }
    else if (current !== selected) setSelected(current);
  }, [models, selected]);
  useEffect(() => { setDisplayPages({}); }, [manifest?.exhibition.displayed]);
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
    const modelMeshes = new Map<string, THREE.Group>();
    const modelRoots = new WeakMap<THREE.Object3D, string>();
    const modelVoteBadges = new Map<string, { ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; votes: number }>();
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
      context.font = "bold 78px system-ui, sans-serif"; if (split >= 0) context.fillText(text.slice(0, split), 112, 82);
      context.fillStyle = "#244c42"; context.textAlign = "left"; context.font = "bold 62px system-ui, sans-serif";
      const textStart = split < 0 ? 40 : 220;
      context.fillText(split < 0 ? text : text.slice(split + 3), textStart, 82, (votes > 0 ? 790 : 990) - textStart);
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
    const spaceModels = new Map<string, GalleryModel[]>();
    const groupSpaceModels = () => {
      spaceModels.clear();
      for (const item of modelsRef.current) {
        if (item.hidden) continue;
        const group = spaceModels.get(item.spaceId) ?? [];
        group.push(item);
        spaceModels.set(item.spaceId, group);
      }
    };
    const trainTrackGroup = new THREE.Group(); scene.add(trainTrackGroup);
    const trainGroup = new THREE.Group(); scene.add(trainGroup);
    const santaGroup = createSantaModel(); santaGroup.visible = false; scene.add(santaGroup);
    const santaTarget = new THREE.Vector3(-29, 0, 8);
    const jail = createGalleryJail(labelTexture("เรือนจำ"));
    jail.visible = false;
    scene.add(jail);
    const patrolLabels = { foot: labelTexture("สายตรวจ"), car: labelTexture("รถสายตรวจ") };
    const patrolModels = new Map<string, { group: THREE.Group; state: OfficerView; target: THREE.Vector3; phase: number }>();
    const syncPatrol = (id: string, wire: OfficerView) => {
      let visual = patrolModels.get(id);
      if (!visual) {
        const car = wire.kind === "car";
        const group = car ? vehicleModel("car", true) : createAvatarCharacter({ ...defaultAvatarAppearance, shirtColor: "#193f66", trousersColor: "#17263d", hatStyle: "cap", hatColor: "#1d4065", glassesStyle: "square", glassesColor: "#17263d" });
        const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: patrolLabels[car ? "car" : "foot"], transparent: true }));
        label.position.y = avatarNameLabelY;
        label.scale.set(2.5, 0.45, 1);
        group.add(label);
        group.position.set(wire.x, 0, wire.z);
        group.rotation.y = wire.rotation;
        scene.add(group);
        visual = { group, state: wire, target: group.position.clone(), phase: 0 };
        patrolModels.set(id, visual);
      }
      visual.state = wire;
      visual.target.set(wire.x, 0, wire.z);
    };
    const presentMeshes = new Map<string, THREE.Group>();
    const blastMeshes = new Map<string, THREE.Group>();
    const presentPositions = new Map<string, PresentView>();
    const vehicleMeshes = new Map<string, { group: THREE.Group; state: VehicleState; position: THREE.Vector3 }>();
    const landmarks = new THREE.Group();
    landmarks.visible = false;
    scene.add(landmarks);
    createActivityLandmarks(landmarks, (title) => {
      const image = document.createElement("canvas");
      image.width = 512; image.height = 80;
      const context = image.getContext("2d")!;
      context.fillStyle = "#234c40"; context.fillRect(0, 0, 512, 80);
      context.fillStyle = "#fff2c8"; context.font = "bold 54px system-ui, sans-serif";
      context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(title, 256, 40);
      const texture = new THREE.CanvasTexture(image);
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.push(texture);
      return texture;
    });
    trainGroup.visible = false;
    const trainMaterials = new Map<number, THREE.Material>();
    const addTrainPart = (parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], color: number, material?: THREE.Material) => {
      const shared = material ?? trainMaterials.get(color) ?? new THREE.MeshStandardMaterial({ color, roughness: 0.72, flatShading: true });
      if (!material) trainMaterials.set(color, shared);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), shared); mesh.position.set(...position); parent.add(mesh); return mesh;
    };
    const bays = new THREE.Group();
    scene.add(bays);
    for (const kind of vehicleKinds) addTrainPart(bays, [5, 0.05, 6], [vehicleSpecs[kind].bayX, 0.015, VEHICLE_BAY_Z], 0xafa894);
    for (const pad of rentalPads) addTrainPart(landmarks, [5, 0.05, 5], [pad.x, 0.015, pad.z], 0xbbac8a);
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
    let blockSignature = "", collisionEnabled = false;
    let props = studentSpaceCollision(0);
    const addBlock = (block: Space) => {
      const { x, z } = blockPosition(block.layoutIndex);
      const group = new THREE.Group(); group.position.set(x, 0, z); scene.add(group);
      const text = block.studentNumber === null ? block.displayName : `${block.studentNumber} · ${block.displayName}`;
      const votes = voteSummaryRef.current?.blockTotals.find((item) => (item.spaceId ?? item.studentId) === block.spaceId)?.votes ?? 0;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(8.8, 0.86), new THREE.MeshBasicMaterial({ map: labelTexture(text, votes) }));
      label.rotation.x = -Math.PI / 2; label.position.set(0, 0.528, 4.33); group.add(label);
      blockLabels.set(block.spaceId, { mesh: label, text, votes });
      blockMap.set(block.spaceId, block); blockGroups.set(block.spaceId, group);
    };
    const rebuildLandscape = (spaces: Pick<Space, "spaceId" | "layoutIndex">[]) => {
      for (const child of landscapeGroup.children) {
        if (child instanceof THREE.InstancedMesh) child.dispose();
        disposeAvatarCharacter(child);
      }
      landscapeGroup.clear();
      if (!spaces.length) return;
      const count = spaces.length, rows = Math.ceil(count / 4), pose = new THREE.Object3D();
      const pads = new THREE.InstancedMesh(new THREE.BoxGeometry(12, 0.42, 10), new THREE.MeshStandardMaterial({ color: 0x718b67, roughness: 0.98 }), count);
      const decks = new THREE.InstancedMesh(new THREE.BoxGeometry(11.7, 0.08, 9.7), new THREE.MeshStandardMaterial({ color: 0xe8ddc1, roughness: 0.98 }), count);
      const accents = new THREE.InstancedMesh(new THREE.BoxGeometry(11.6, 0.01, 0.16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 }), count);
      const tree = aisleTreeTrunk;
      const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, tree.width / 2, tree.height, 5), new THREE.MeshStandardMaterial({ color: 0x83613f, roughness: 0.98, flatShading: true }), rows * 2);
      const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(0.84, 2.22, 5), new THREE.MeshStandardMaterial({ color: 0x4b8060, roughness: 0.94, flatShading: true }), rows * 2);
      const paths = new THREE.InstancedMesh(new THREE.BoxGeometry(72, 0.035, 1.8), new THREE.MeshStandardMaterial({ color: 0xc8b98f, roughness: 1 }), Math.max(1, rows - 1)); paths.count = rows - 1;
      spaces.forEach((space, index) => {
        const { x, z } = blockPosition(space.layoutIndex);
        pose.position.set(x, 0.22, z); pose.updateMatrix(); pads.setMatrixAt(index, pose.matrix);
        pose.position.y = 0.48; pose.updateMatrix(); decks.setMatrixAt(index, pose.matrix);
        pose.position.set(x, 0.527, z + 4.78); pose.updateMatrix(); accents.setMatrixAt(index, pose.matrix);
        accents.setColorAt(index, colorFor(space.spaceId).lerp(new THREE.Color("#e8c777"), 0.55));
      });
      for (let row = 0; row < rows; row++) {
        const { z } = blockPosition(row * 4);
        if (row < rows - 1) { pose.position.set(0, 0.025, z - 8.5); pose.updateMatrix(); paths.setMatrixAt(row, pose.matrix); }
        for (const [sideIndex, side] of [-1, 1].entries()) {
          const instance = row * 2 + sideIndex;
          pose.position.set(side * tree.x, tree.y, z); pose.updateMatrix(); trunks.setMatrixAt(instance, pose.matrix);
          pose.position.y = 2.32; pose.updateMatrix(); crowns.setMatrixAt(instance, pose.matrix);
        }
      }
      for (const mesh of [pads, decks, accents, trunks, crowns, paths]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere(); landscapeGroup.add(mesh);
      }
    };
    const syncBlocks = () => {
      const world = manifestRef.current, wire = trainRef.current;
      const roster = !world || (wire?.exhibitionAssignmentId !== undefined &&
        (wire.exhibitionAssignmentId || null) !== world.exhibition.displayed) ? [] : world.blocks;
      const snapshot = wire?.layoutRoster ? JSON.parse(wire.layoutRoster) as { studentId: string }[] : null;
      const landscape = snapshot?.map((block, layoutIndex) => ({ spaceId: block.studentId, layoutIndex })) ?? roster;
      const positions = new Map(landscape.map((block) => [block.spaceId, block.layoutIndex]));
      const blocks = roster.flatMap((block) => {
        const layoutIndex = positions.get(block.spaceId);
        return layoutIndex === undefined ? [] : [{ ...block, layoutIndex }];
      });
      const signature = JSON.stringify([landscape.map((block) => block.spaceId), blocks]);
      if (signature === blockSignature) return;
      blockSignature = signature;
      for (const [id, group] of blockGroups) {
        const label = blockLabels.get(id);
        if (label) disposeTrackedTexture((label.mesh.material as THREE.MeshBasicMaterial).map);
        scene.remove(group); disposeAvatarCharacter(group);
      }
      blockGroups.clear(); blockMap.clear(); blockLabels.clear();
      for (const block of blocks) addBlock(block);
      const count = landscape.length;
      props = studentSpaceCollision(count);
      rebuildLandscape(landscape);
      rebuildTrack(count);
      const depth = Math.max(2120, Math.ceil(count / 4) * 17 + 220);
      if (groundDepth === depth) return;
      groundDepth = depth; groundZ = -depth / 2 + 30;
      for (const [mesh, width] of [[floor, 120], [centerWalk, 8], ...groundEdges.map((edge) => [edge, 0.16] as [THREE.Mesh, number])] as [THREE.Mesh, number][]) {
        mesh.geometry.dispose(); mesh.geometry = new THREE.PlaneGeometry(width, depth); mesh.position.z = groundZ;
      }
    };
    syncBlocks();
    const slotModels = (id: string, models: GalleryModel[]) => {
      const page = Math.min(displayPagesRef.current[id] ?? 0, Math.max(0, Math.ceil(models.length / pageSize) - 1));
      return models.slice(page * pageSize, (page + 1) * pageSize);
    };
    const removeModelVoteBadge = (id: string) => {
      const current = modelVoteBadges.get(id); if (!current) return;
      current.ring.removeFromParent(); current.ring.geometry.dispose(); current.ring.material.dispose();
      modelVoteBadges.delete(id);
    };
    const syncExhibits = () => {
      const visible = new Set<string>();
      for (const [spaceId, models] of spaceModels) {
        const block = blockMap.get(spaceId);
        if (!block) continue;
        const base = blockPosition(block.layoutIndex);
        slotModels(spaceId, models).forEach((item, slot) => {
          const offset = exhibitPosition(slot);
          let exhibit = modelMeshes.get(item.id);
          if (!exhibit) {
            exhibit = new THREE.Group(); scene.add(exhibit); modelMeshes.set(item.id, exhibit);
          }
          exhibit.position.set(base.x + offset.x, 1.3 + (slot % 2) * 0.3, base.z + offset.z);
          const badge = modelVoteBadges.get(item.id);
          if (badge) badge.ring.position.y = 0.535 - exhibit.position.y;
          visible.add(item.id);
        });
      }
      for (const [id, exhibit] of modelMeshes) if (!visible.has(id)) {
        evictModel(id);
        if (activeModelLoad?.id === id) activeModelLoad.controller.abort();
        removeModelVoteBadge(id); scene.remove(exhibit); modelMeshes.delete(id);
      }
    };
    const syncVoteVisuals = () => {
      const totals = new Map((voteSummaryRef.current?.blockTotals ?? []).map((item) => [item.spaceId ?? item.studentId, item.votes]));
      for (const [id, label] of blockLabels) {
        const votes = totals.get(id) ?? 0;
        if (votes === label.votes) continue;
        const material = label.mesh.material as THREE.MeshBasicMaterial;
        disposeTrackedTexture(material.map); material.map = labelTexture(label.text, votes); material.needsUpdate = true;
        label.votes = votes;
      }
      const currentModels = new Map(modelsRef.current.map((item) => [item.id, item]));
      for (const [id, exhibit] of modelMeshes) {
        const votes = currentModels.get(id)?.likes ?? 0;
        const current = modelVoteBadges.get(id);
        if (current?.votes === votes) continue;
        removeModelVoteBadge(id);
        if (votes > 0) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.43, 12), new THREE.MeshBasicMaterial({ color: voteColor(votes) }));
          ring.rotation.x = -Math.PI / 2; ring.position.y = 0.535 - exhibit.position.y;
          exhibit.add(ring); modelVoteBadges.set(id, { ring, votes });
        }
      }
    };
    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2();
    let activePointer: number | null = null, dragged = false, lastX = 0, lastY = 0, startX = 0, startY = 0, yaw = 0, cameraPitch = 0.34;
    const moveCrosshair = (event: PointerEvent) => {
      if (!wandRef.current || menuOpenRef.current || customizerOpenRef.current || document.hidden) return;
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
      if (menuOpenRef.current || activityPanelRef.current || customizerOpenRef.current || target?.matches("input, textarea, select") || (key === " " && target?.matches("button")) || target?.isContentEditable) return;
      const drivingKind = drivingKindRef.current;
      if (drivingKind && vehicleSpecs[drivingKind].flying && (key === "q" || key === "e")) {
        event.preventDefault(); keys.add(key); return;
      }
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) {
        event.preventDefault(); if (key === " ") { if (!event.repeat) jumpRef.current = true; } else keys.add(key);
      }
    };
    const keyUp = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
    const onBlur = () => { keys.clear(); resetTouchJoystick(touchKnobRef.current, touchRef.current); jumpRef.current = false; liftRef.current = 0; cancelPointer(); };
    const updateOrientation = () => {
      const required = touchDevice && window.innerHeight > window.innerWidth;
      landscapeRequiredRef.current = required;
      setLandscapeRequired((current) => current === required ? current : required);
      if (required) onBlur();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (menuOpenRef.current || activityPanelRef.current || customizerOpenRef.current || document.hidden || activePointer !== null) return;
      activePointer = event.pointerId; dragged = false; lastX = startX = event.clientX; lastY = startY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      if (event.pointerType !== "touch") moveCrosshair(event);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (menuOpenRef.current || activityPanelRef.current || customizerOpenRef.current || document.hidden) return;
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
      if (!tapped || customizerOpenRef.current || document.hidden || drivingRef.current) return;
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
      if (!canEquipWandRef.current || !wandRef.current || !initialized || !room?.connection?.isOpen || customizerOpenRef.current ||
        menuOpenRef.current || activityPanelRef.current || document.hidden || (!touchDevice && !document.hasFocus()) ||
        knockedRef.current || drivingRef.current || (!teacher && trainSeatRef.current >= 0)) return null;
      aimBodies.length = 0;
      for (const [id, avatar] of avatarMeshes) if (id !== room.sessionId && avatar.userData.role === "student" && avatar.userData.character) aimBodies.push(avatar.userData.character);
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
    let viewedPivot: THREE.Group | undefined, appliedAdjustment = initialModelAdjustment;
    const modelAbort = new AbortController();
    const loadedModels = new Map<string, { object: THREE.Group; pivot: THREE.Group; triangles: number; textureBytes: number }>();
    const deferredModels = new Map<string, number>();
    let residentTextureBytes = 0;
    let residentTriangles = 0, activeModelLoad: { id: string; controller: AbortController } | null = null, lastModelScan = 0;
    const evictModel = (id: string) => {
      const loaded = loadedModels.get(id); if (!loaded) return;
      loaded.pivot.removeFromParent(); disposeModelObject(loaded.object);
      residentTextureBytes -= loaded.textureBytes;
      residentTriangles -= loaded.triangles; loadedModels.delete(id);
      if (alive && selectedRef.current?.id === id) { setSelected(null); setPreview(null); }
    };
    groupSpaceModels(); syncExhibits(); syncVoteVisuals();
    const updateNearbyModels = () => {
      const candidates = [...spaceModels.entries()].flatMap(([spaceId, owned]) => {
        const block = blockMap.get(spaceId);
        if (!block) return [];
        return slotModels(spaceId, owned).map((item) => {
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
        object.scale.setScalar(1.2 / radius); object.position.copy(center).multiplyScalar(-1.2 / radius);
        const pivot = new THREE.Group(); pivot.position.y = 0.25; pivot.add(object); exhibit.add(pivot);
        modelRoots.set(object, next.item.id); loadedModels.set(next.item.id, { object, pivot, triangles: parsed.triangles, textureBytes: parsed.textureBytes ?? 0 });
        residentTriangles += parsed.triangles; residentTextureBytes += parsed.textureBytes ?? 0; deferredModels.delete(next.item.id);
      }).catch(() => { if (!controller.signal.aborted) deferredModels.set(next.item.id, residentTriangles); })
        .finally(() => { if (activeModelLoad?.controller === controller) activeModelLoad = null; });
    };
    const client = new Client(config);
    let lastTrainUi = 0, lastTrainActionScan = 0, lastVehicleSend = 0;
    const trainSeatPosition = (seat: number) => {
      const localX = seat % 2 === 0 ? -0.55 : 0.55;
      const localZ = -1.8 - Math.floor(seat / 6) * 4.4 - Math.floor((seat % 6) / 2) * 1.1;
      const cosine = Math.cos(trainTarget.rotation), sine = Math.sin(trainTarget.rotation);
      return { x: trainTarget.x + cosine * localX + sine * localZ, z: trainTarget.z - sine * localX + cosine * localZ, rotation: trainTarget.rotation };
    };
    const cleanup = () => {
      alive = false;
      for (const id of loadedModels.keys()) evictModel(id);
      cancelAnimationFrame(frame); window.clearTimeout(cooldownTimer); castReadyAt.current = 0; setCastReady(true); setAimValid(false); fireWandRef.current = () => {}; modelAbort.abort(); activeModelLoad?.controller.abort(); room?.leave(); roomRef.current = null; onBlur(); observer.disconnect();
      scene.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose?.(); const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []; materials.forEach((material) => material.dispose()); });
      renderer.dispose(); renderer.forceContextLoss(); textures.forEach((texture) => texture.dispose()); avatarMeshes.clear(); boltMeshes.current.clear(); effectMeshes.current = [];
      drivingRef.current = ""; drivingKindRef.current = ""; setDriving(""); setVehicleNearby(""); setVehicles(null);
      setActivity("");
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
      room.onLeave((code: number) => { if (alive) { drivingRef.current = ""; drivingKindRef.current = ""; setDriving(""); setVehicleNearby(""); setVehicles(null); setActivity(""); if (code === 4403) { setEnabled(false); setManifest(null); setError("ครูหยุดโลกเสมือนสำหรับนักเรียนแล้ว"); return; } if (code === 4003 && !teacher) { initialized = false; setOnline(0); setError("สิทธิ์เข้าโลกเปลี่ยนแล้ว กรุณาตรวจสอบงานล่าสุดหรือรอครูอนุมัติในหน้าห้องเรียน"); return; } initialized = false; setOnline(0); setError("การเชื่อมต่อโลกเสมือนสิ้นสุด กรุณาออกแล้วเข้าใหม่"); } });
      room.onMessage("gallery-refresh", () => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "โหลดผลงานใหม่ไม่สำเร็จ")); });
      room.onMessage("cast-result", ({ ok, spells }: { ok: boolean; spells?: number }) => {
        if (typeof spells === "number") setWallet((prior) => prior && { ...prior, spells });
        if (!ok) setGiftMessage("ยิงไม่ได้ในขณะนี้");
        else if (spells === 0) setGiftMessage("ใช้เวทมนตร์ครบแล้ว ซื้อไม้กายสิทธิ์ใหม่ที่ร้านค้าแต้มได้");
      });
      room.onMessage("train-result", ({ ok, message }: { ok: boolean; message: string }) => { setTrainMessage(message); if (!ok) setError(message); });
      room.onMessage("vehicle-result", ({ ok, message }: { ok: boolean; message: string }) => {
        window.clearTimeout(activityTimeout.current); setActivityPending(false);
        setVehicleMessage(message);
        if (!teacher) setActivityMessage(message); else if (!ok) setError(message);
      });
      room.onMessage("wallet", ({ wallet }: { wallet?: Wallet }) => { if (wallet) setWallet(wallet); });
      room.onMessage("license-used", () => setWallet((prior) => prior && { ...prior, license: false }));
      room.onMessage("shop-result", ({ ok, wallet, prices, message }: { ok: boolean; wallet?: Wallet; prices?: ShopPrices; message?: string }) => {
        window.clearTimeout(activityTimeout.current); setActivityPending(false);
        if (wallet) setWallet(wallet);
        if (prices) { setShopPrices(prices); setQuote(null); }
        if (message && !activityPanelRef.current) setGiftMessage(message);
        setActivityMessage(message ?? (ok ? "" : "เปิดร้านค้าไม่ได้"));
      });
      room.onMessage("teleport-result", ({ message }: { message: string }) => {
        window.clearTimeout(activityTimeout.current); setActivityPending(false); setGiftMessage(message);
      });
      room.onMessage("santa-result", ({ ok, enabled, message }: { ok: boolean; enabled?: boolean; message: string }) => {
        setSantaMessage(message);
        if (ok) setSantaActive(Boolean(enabled)); else setError(message);
      });
      room.onMessage("present-result", ({ ok, message }: { ok: boolean; message: string }) => { setOpeningPresent(""); if (!ok) setGiftMessage(message); });
      room.onMessage("present-opened", ({ kind }: { kind: "bomb" | "points" }) => { setGiftMessage(kind === "bomb" ? "กับดักของขวัญ! ออกจากวงสีแดงก่อนระเบิด" : "พบแต้มโลกเสมือน 1 แต้ม!"); });
      room.onMessage("gift-result", ({ kind, balance, detonateAt }: { kind: "bomb" | "points"; balance?: number; detonateAt?: number }) => {
        setOpeningPresent("");
        if (kind === "points" && balance !== undefined) {
          setWallet((prior) => ({ spells: 0, license: false, ...prior, balance }));
          setGiftMessage("ได้รับ 1 แต้มโลกเสมือน!");
        }
        if (kind === "bomb" && detonateAt) setGiftMessage(`กับดักของขวัญ! ระเบิดใน ${Math.max(1, Math.ceil((detonateAt - Date.now()) / 1000))} วินาที`);
      });
      room.onMessage("knocked", ({ respawnAt, cause }: { respawnAt: number; cause?: string }) => { knockedRef.current = true; knockUntil.current = respawnAt; setKnockCause(cause ?? "wand"); setKnockSeconds(Math.max(1, Math.ceil((respawnAt - Date.now()) / 1000))); });
      room.onMessage("respawn", ({ movementEpoch: epoch, x, z }: { movementEpoch: number; x: number; z: number }) => { knockedRef.current = false; knockUntil.current = 0; setKnockSeconds(0); movementEpoch = epoch; local = { x, z, rotation: 0 }; unsent = { dx: 0, dz: 0 }; pending = []; lastAcknowledged = -1; visualOffset = { x: 0, z: 0 }; });
      function addEffect(mesh: THREE.Mesh, x: number, y: number, z: number, duration: number, velocity?: THREE.Vector3) {
        if (effectMeshes.current.length >= 20) {
          const old = effectMeshes.current.shift()!;
          scene.remove(old.mesh); disposeAvatarCharacter(old.mesh);
        }
        mesh.position.set(x, y, z);
        scene.add(mesh);
        effectMeshes.current.push({ mesh, duration, until: performance.now() + duration, velocity });
      }
      room.onMessage("wand-impact", ({ x, y, z }: { x: number; y: number; z: number }) => {
        addEffect(new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0x84f4ff, transparent: true, opacity: 0.9 })), x, y, z, 450);
      });
      room.onMessage("santa-explosion", ({ x, y, z }: { x: number; y: number; z: number }) => {
        addEffect(new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1),
          new THREE.MeshBasicMaterial({ color: 0xff9c43, transparent: true, opacity: 0.92 })), x, y + 0.8, z, 600);
      });
      room.onMessage("vehicle-break", ({ x, y, z, driverId }: { x: number; y: number; z: number; driverId: string }) => {
        if (driverId === room.sessionId) setGiftMessage("ยานพาหนะพัง · ใบขับขี่ถูกใช้แล้ว");
        for (let index = 0; index < 6; index++) {
          const angle = index * Math.PI / 3;
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.24, 0.3),
            new THREE.MeshBasicMaterial({ color: index % 2 ? 0x31515d : 0xf5a657, transparent: true }));
          addEffect(mesh, x, y + 0.6, z, 550, new THREE.Vector3(Math.cos(angle) * 3, 2 + (index % 3), Math.sin(angle) * 3));
        }
      });
      let requestedWallet = false;
      room.onStateChange((state: any) => {
        if (!alive) return;
        landmarks.visible = state.activities === true;
        collisionEnabled = Boolean(state.patrolBackup);
        if (state.officer) {
          jail.visible = true;
          syncPatrol("primary", state.officer);
          state.patrolBackup?.forEach((unit: OfficerView, id: string) => syncPatrol(id, unit));
          for (const [id, visual] of patrolModels) if (id !== "primary" && !state.patrolBackup?.has(id)) {
            scene.remove(visual.group); disposeAvatarCharacter(visual.group); patrolModels.delete(id);
          }
        }
        if (landmarks.visible && !teacher && !requestedWallet && state.players?.has(room.sessionId)) {
          requestedWallet = true;
          room.send("wallet-read");
        }
        if (state.santa) {
          const wire = state.santa as SantaView;
          santaActiveRef.current = wire.enabled;
          setSantaActive((current) => current === wire.enabled ? current : wire.enabled);
          santaTarget.set(wire.x, 0, wire.z); santaGroup.userData.rotationTarget = wire.rotation; santaGroup.visible = wire.enabled;
        }
        const currentPresents = new Set<string>(); presentPositions.clear();
        state.presents?.forEach((present: { id: string; x: number; z: number; expiresAt: number }, id: string) => {
          currentPresents.add(id); presentPositions.set(id, { x: present.x, z: present.z, expiresAt: present.expiresAt });
          let mesh = presentMeshes.get(id);
          if (!mesh) { mesh = createPresentModel(); scene.add(mesh); presentMeshes.set(id, mesh); }
          mesh.position.set(present.x, 0, present.z);
        });
        presentPositionsRef.current = new Map(presentPositions);
        for (const [id, mesh] of presentMeshes) if (!currentPresents.has(id)) { scene.remove(mesh); disposeSantaModel(mesh); presentMeshes.delete(id); }
        const currentBlasts = new Set<string>(); let nextBlast = 0;
        state.blasts?.forEach((blast: { id: string; x: number; y: number; z: number; detonateAt: number }, id: string) => {
          currentBlasts.add(id); if (!nextBlast || blast.detonateAt < nextBlast) nextBlast = blast.detonateAt;
          let mesh = blastMeshes.get(id);
          if (!mesh) { mesh = createPresentBlast(); scene.add(mesh); blastMeshes.set(id, mesh); }
          mesh.position.set(blast.x, 0, blast.z);
        });
        setBlastDeadline((current) => current === nextBlast ? current : nextBlast);
        for (const [id, mesh] of blastMeshes) if (!currentBlasts.has(id)) { scene.remove(mesh); disposeSantaModel(mesh); blastMeshes.delete(id); }
        if (state.vehicles) {
          const availability: VehicleAvailability[] = [];
          const currentVehicles = new Set<string>();
          state.vehicles.forEach((vehicle: VehicleState, id: string) => {
            const kind = vehicle.kind;
            if (!vehicleKinds.includes(kind)) return;
            const wire = { id, kind, rental: Boolean(vehicle.rental), x: vehicle.x, y: vehicle.y, z: vehicle.z, rotation: vehicle.rotation, revision: vehicle.revision, driverId: vehicle.driverId,
              hitLimit: vehicle.hitLimit, hitsRemaining: vehicle.hitsRemaining, fuelCapacity: vehicle.fuelCapacity, fuelRemaining: vehicle.fuelRemaining, landing: vehicle.landing };
            currentVehicles.add(id);
            availability.push({ id, kind, rental: wire.rental, revision: wire.revision, driverId: wire.driverId, driverName: state.players?.get(wire.driverId)?.displayName,
              hitLimit: wire.hitLimit, hitsRemaining: wire.hitsRemaining, fuelCapacity: wire.fuelCapacity, fuelRemaining: wire.fuelRemaining, landing: wire.landing });
            let visual = vehicleMeshes.get(id);
            if (!visual) {
              const group = vehicleModel(kind);
              scene.add(group);
              visual = { group, state: wire, position: new THREE.Vector3() };
              vehicleMeshes.set(id, visual);
            }
            visual.position.set(wire.x, wire.y, wire.z);
            if (visual.state === wire || visual.state.revision !== wire.revision) {
              visual.group.position.copy(visual.position);
              visual.group.rotation.y = wire.rotation;
            }
            visual.state = wire;
          });
          for (const [id, { group }] of vehicleMeshes) {
            if (!currentVehicles.has(id)) { scene.remove(group); disposeAvatarCharacter(group); vehicleMeshes.delete(id); }
          }
          setVehicles((current) => current?.length === availability.length && current.every((vehicle, index) => {
            const next = availability[index]!;
            return vehicle.id === next.id && vehicle.revision === next.revision && vehicle.driverName === next.driverName && vehicle.hitsRemaining === next.hitsRemaining
              && vehicle.fuelRemaining === next.fuelRemaining && vehicle.landing === next.landing;
          }) ? current : availability);
        }
        if (state.train) {
          const wire = state.train as TrainView;
          const priorTrain = trainRef.current;
          const priorLayout = priorTrain?.layoutRoster;
          if (wire.revision !== trainSampleRevision || wire.layoutRoster !== priorLayout) { trainSamples.length = 0; trainSampleRevision = wire.revision; }
          trainRef.current = { ...wire };
          trainSamples.push({ at: performance.now(), x: wire.x, z: wire.z, rotation: wire.rotation });
          if (trainSamples.length > 4) trainSamples.shift();
          trainGroup.visible = wire.active;
          if (wire.layoutRoster !== priorLayout || wire.exhibitionAssignmentId !== priorTrain?.exhibitionAssignmentId) { syncBlocks(); syncExhibits(); syncVoteVisuals(); }
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
        const wantedEntries: WantedEntry[] = [];
        state.players.forEach((player: Avatar, id: string) => {
          if (player.wantedCount && player.wantedSince) wantedEntries.push({ id, name: player.displayName, count: player.wantedCount, since: player.wantedSince });
          present.add(id); let avatar = avatarMeshes.get(id);
          if (!avatar) {
            avatar = new THREE.Group(); avatar.position.set(player.x, 0, player.z); avatar.rotation.y = player.rotation;
            avatar.userData.walkPhase = 0; avatar.userData.walking = 0; avatar.userData.jumpTime = -Infinity;
            const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(player.role === "teacher" || player.role === "owner" ? `ครู ${player.displayName}` : player.displayName), transparent: true })); label.scale.set(2.6, 0.5, 1); label.position.y = avatarNameLabelY; avatar.add(label); scene.add(avatar); avatarMeshes.set(id, avatar);
          }
          syncAppearance(avatar, id === room.sessionId ? appearanceRef.current : player, id === room.sessionId);
          avatar.userData.target = { x: player.x, z: player.z, rotation: player.rotation };
          avatar.userData.role = player.role;
          avatar.userData.trainSeat = player.trainSeat ?? -1;
          avatar.userData.vehicleId = player.vehicleId ?? "";
          const priorEpoch = avatar.userData.epoch;
          avatar.userData.epoch = player.movementEpoch;
          if (priorEpoch !== player.movementEpoch && (collisionEnabled || Math.hypot(avatar.position.x - player.x, avatar.position.z - player.z) > 6)) {
            avatar.position.set(player.x, 0, player.z);
            avatar.rotation.y = player.rotation;
            avatar.userData.jumpTime = -Infinity;
          }
          const character=avatar.userData.character as THREE.Group|undefined;
          if (character) { character.rotation.z = player.knocked ? -Math.PI/2 : 0; character.position.y = player.knocked ? 0.35 : 0; }
          avatar.userData.knocked = player.knocked;
          if (id === room.sessionId) {
            const nextSeat = player.trainSeat ?? -1;
            trainSeatRef.current = nextSeat; setTrainSeat((current) => current === nextSeat ? current : nextSeat);
            const mounted = player.vehicleId ?? "";
            if (drivingRef.current !== mounted) {
              onBlur();
              if (mounted) {
                yaw = 0;
                setWandMode(false);
                setActivityPanel("");
              }
              drivingRef.current = mounted;
              drivingKindRef.current = (mounted && vehicleMeshes.get(mounted)?.state.kind) || "";
              setDriving(drivingKindRef.current);
            }
            if (trainSeatRef.current >= 0 || mounted) local = { x: player.x, z: player.z, rotation: player.rotation };
            const deadline = player.jailedUntil || (player.knocked ? player.respawnAt ?? 0 : 0);
            if (Boolean(deadline) !== knockedRef.current) onBlur();
            knockedRef.current = Boolean(deadline);
            knockUntil.current = deadline;
            if (deadline) setKnockCause(player.jailedUntil ? "jail" : player.knockCause || "wand");
            const seconds = deadline ? Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) : 0;
            if (seconds!==lastKnockSecond.current) { lastKnockSecond.current=seconds; setKnockSeconds(seconds); }
            const epoch=player.movementEpoch??0;
            if (epoch!==movementEpoch) { movementEpoch=epoch; local={x:player.x,z:player.z,rotation:player.rotation}; pending=[]; unsent={dx:0,dz:0}; visualOffset={x:0,z:0}; lastAcknowledged=player.sequence??-1; jumpTime = -Infinity; }
          }
          if ((player.protectedUntil ?? 0)>Date.now() && !avatar.userData.shield) {
            const shield=new THREE.Mesh(new THREE.TorusGeometry(0.68,0.035,5,20),new THREE.MeshBasicMaterial({color:0x64dbef,transparent:true,opacity:0.65})); shield.rotation.x=Math.PI/2; shield.position.y=0.06; avatar.add(shield); avatar.userData.shield=shield;
            avatar.userData.shieldExpires = player.protectedUntil;
          } else if ((player.protectedUntil ?? 0)<=Date.now() && avatar.userData.shield) { avatar.remove(avatar.userData.shield); avatar.userData.shield.geometry.dispose(); (avatar.userData.shield.material as THREE.Material).dispose(); avatar.userData.shield=null; }
          if (priorEpoch === player.movementEpoch && avatar.userData.jump !== undefined && avatar.userData.jump < (player.jump ?? 0)) avatar.userData.jumpTime = performance.now();
          avatar.userData.jump = player.jump;
          if (id === room.sessionId) {
            if (!initialized) { local = { x: player.x, z: player.z, rotation: player.rotation }; initialized = true; }
            // Replay movement not yet acknowledged instead of snapping to a delayed server position.
            if (player.sequence !== undefined && player.sequence > lastAcknowledged) {
              const corrected = reconcilePosition(player, player.sequence, pending, unsent, collisionEnabled
                ? (from, to) => slidePastProps(props, from, to, avatarHeight + (performance.now() - jumpTime < 750 ? jumpApex : 0)) : undefined);
              visualOffset = correctionOffset(local, corrected, visualOffset);
              Object.assign(local, corrected);
              pending = pending.filter((move) => move.sequence > player.sequence!); lastAcknowledged = player.sequence;
            }
          }
        });
        if (state.officer) {
          wantedEntries.sort(rankWanted);
          const targetId: string = state.officer.targetId;
          setWanted((current) => current?.targetId === targetId && current.entries.length === wantedEntries.length &&
            current.entries.every((entry, index) => entry.id === wantedEntries[index]!.id && entry.count === wantedEntries[index]!.count && entry.name === wantedEntries[index]!.name)
            ? current : { entries: wantedEntries, targetId });
        }
        for (const [id, avatar] of avatarMeshes) if (!present.has(id)) { scene.remove(avatar); disposeAvatarCharacter(avatar); avatar.traverse((object) => { if (object instanceof THREE.Sprite) object.material.map?.dispose(); }); avatarMeshes.delete(id); }
      });
    }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "เชื่อมต่อโลกเสมือนไม่สำเร็จ"); });
    const render = (time: number) => {
      if (!alive || document.hidden) { frame = 0; return; } frame = requestAnimationFrame(render); const dt = Math.min((time - lastFrame) / 1000, 0.05); lastFrame = time;
      for (const visual of boltMeshes.current.values()) visual.group.position.lerp(visual.target, 1 - Math.exp(-45 * dt));
      santaGroup.position.lerp(santaTarget, 1 - Math.exp(-12 * dt));
      const santaAngle = (santaGroup.userData.rotationTarget as number | undefined) ?? 0;
      santaGroup.rotation.y += Math.atan2(Math.sin(santaAngle - santaGroup.rotation.y), Math.cos(santaAngle - santaGroup.rotation.y)) * (1 - Math.exp(-10 * dt));
      santaGroup.position.y = Math.sin(time * 0.003) * 0.035;
      for (const visual of patrolModels.values()) {
        const { group, state, target } = visual;
        group.position.lerp(target, 1 - Math.exp(-22 * dt));
        const angle = state.rotation - group.rotation.y;
        group.rotation.y += Math.atan2(Math.sin(angle), Math.cos(angle)) * (1 - Math.exp(-14 * dt));
        if (state.kind !== "car") {
          if (state.walking) visual.phase += dt * 12;
          animateAvatarCharacter(group, visual.phase, state.walking ? 1 : 0, false, false, false);
        }
      }
      for (const [id, gift] of presentMeshes) { gift.rotation.y += dt * 0.45; gift.position.y = 0.035 + Math.sin(time * 0.004 + id.length) * 0.035; }
      for (const [id, blast] of blastMeshes) blast.scale.setScalar(5 * (1 + Math.sin(time * 0.012 + id.length) * 0.035));
      for (const { group, state, position } of vehicleMeshes.values()) {
        const blend = 1 - Math.exp(-20 * dt);
        group.position.lerp(position, blend);
        const angle = state.rotation - group.rotation.y;
        group.rotation.y += Math.atan2(Math.sin(angle), Math.cos(angle)) * blend;
        if (group.userData.rotor && state.driverId) group.userData.rotor.rotation.y += dt * 23;
      }
      for (let i = effectMeshes.current.length - 1; i >= 0; i--) {
        const effect = effectMeshes.current[i]!;
        const left = (effect.until - time) / effect.duration;
        if (left <= 0) {
          scene.remove(effect.mesh); disposeAvatarCharacter(effect.mesh); effectMeshes.current.splice(i, 1);
        } else {
          if (effect.velocity) {
            effect.mesh.position.addScaledVector(effect.velocity, dt);
            effect.velocity.y -= 8 * dt;
            effect.mesh.rotation.y += 7 * dt;
          } else effect.mesh.scale.setScalar(1 + (1 - left) * 2);
          (effect.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, left);
        }
      }
      if (time - lastModelScan > 500) { lastModelScan = time; updateNearbyModels(); }
      if (syncedManifest !== manifestRef.current) { syncedManifest = manifestRef.current; syncBlocks(); syncExhibits(); syncVoteVisuals(); }
      if (syncedModels !== modelsRef.current || syncedPages !== displayPagesRef.current) { syncedModels = modelsRef.current; syncedPages = displayPagesRef.current; groupSpaceModels(); syncExhibits(); syncVoteVisuals(); }
      if (syncedVotes !== voteSummaryRef.current) { syncedVotes = voteSummaryRef.current; syncVoteVisuals(); }
      const forward = Number(keys.has("w") || keys.has("arrowup") || touchRef.current.z < -0.15) - Number(keys.has("s") || keys.has("arrowdown") || touchRef.current.z > 0.15);
      const side = Number(keys.has("d") || keys.has("arrowright") || touchRef.current.x > 0.15) - Number(keys.has("a") || keys.has("arrowleft") || touchRef.current.x < -0.15);
      const bufferedTrain = interpolateTrain(trainSamples, time);
      if (bufferedTrain) { trainTarget.x = bufferedTrain.x; trainTarget.z = bufferedTrain.z; trainTarget.rotation = bufferedTrain.rotation; }
      const active = initialized && room?.connection?.isOpen && !menuOpenRef.current && !customizerOpenRef.current && !activityPanelRef.current && !document.hidden && !landscapeRequiredRef.current && (touchDevice || document.hasFocus()) && !knockedRef.current && trainSeatRef.current < 0;
      if (!active) onBlur();
      const ownVehicle = drivingRef.current ? vehicleMeshes.get(drivingRef.current) : undefined;
      const walking = active && !drivingRef.current;
      let step = walking ? walkingStep(forward, side, yaw, dt) : { dx: 0, dz: 0 };
      const headHeight = avatarHeight + (time - jumpTime < 750 ? jumpApex : 0);
      if (collisionEnabled && (step.dx || step.dz)) {
        const next = slidePastProps(props, local, { x: local.x + step.dx, z: local.z + step.dz }, headHeight);
        step = { dx: next.x - local.x, dz: next.z - local.z };
      }
      local.x += step.dx; local.z += step.dz; unsent.dx += step.dx; unsent.dz += step.dz;
      if (step.dx || step.dz) local.rotation = facingRotation(step.dx, step.dz);
      if (walking && jumpRef.current) {
        jumpRef.current = false;
        if (time - jumpTime >= 900 && (!collisionEnabled || !blockingProp(props, local, local, avatarRadius, avatarHeight + jumpApex))) { jumpTime = time; room.send("jump"); }
      }
      if (ownVehicle && room?.connection?.isOpen && time - lastVehicleSend >= 75) {
        const acceptsInput = active && !ownVehicle.state.landing && !(ownVehicle.state.fuelCapacity && !ownVehicle.state.fuelRemaining);
        const lift = liftRef.current || Number(keys.has("q")) - Number(keys.has("e"));
        room.send("vehicle-input", {
          revision: ownVehicle.state.revision, epoch: movementEpoch,
          throttle: acceptsInput ? forward : 0, turn: acceptsInput ? side : 0, lift: acceptsInput ? lift : 0,
        });
        lastVehicleSend = time;
      }
      const decay = Math.exp(-12 * dt);
      visualOffset.x *= decay; visualOffset.z *= decay;
      const seated = trainSeatRef.current >= 0 ? trainSeatPosition(trainSeatRef.current) : null;
      const offsetPosition = { x: local.x + visualOffset.x, z: local.z + visualOffset.z };
      const walkingVisual = collisionEnabled && (Math.abs(visualOffset.x) + Math.abs(visualOffset.z) > 0.001)
        ? slidePastProps(props, local, offsetPosition, headHeight) : offsetPosition;
      const visual = ownVehicle ? { x: ownVehicle.group.position.x, z: ownVehicle.group.position.z, rotation: ownVehicle.group.rotation.y }
        : seated ?? { ...walkingVisual, rotation: local.rotation };
      trainGroup.position.set(trainTarget.x, 0, trainTarget.z);
      trainGroup.rotation.y = trainTarget.rotation;
      if (time - lastTrainActionScan > 250) {
        lastTrainActionScan = time;
        const train = trainRef.current;
        const stopped = Boolean(train && ["waiting", "boarding", "dwell"].includes(train.phase));
        const free = initialized && room?.connection?.isOpen && !knockedRef.current && !drivingRef.current && trainSeatRef.current < 0;
        const ownAvatar = room?.state?.players?.get(room.sessionId);
        const nearbyActivity: Activity = !free || !landmarks.visible || !ownAvatar ? "" : nearPlace(ownAvatar, portal) ? "portal"
          : teacher ? "" : nearPlace(ownAvatar, shop) ? "shop" : nearPlace(ownAvatar, depot) ? "depot" : "";
        setActivity((current) => current === nearbyActivity ? current : nearbyActivity);
        const action = initialized && trainSeatRef.current >= 0 && stopped ? "leave" : free && train && canBoardTrain({ active: train.active, phase: train.phase, seats: train.seats, distance: Math.hypot(local.x - train.x, local.z - train.z) }) ? "board" : null;
        setTrainAction((current) => current === action ? current : action);
        let giftId = "", giftDistance = 2;
        if (user.role === "student" && santaActiveRef.current && free) for (const [id, gift] of presentPositionsRef.current) {
          const distance = Math.hypot(local.x - gift.x, local.z - gift.z);
          if (gift.expiresAt > Date.now() && distance <= giftDistance) { giftId = id; giftDistance = distance; }
        }
        setNearestPresent((current) => current === giftId ? current : giftId);
        let nearby = "";
        let nearest = VEHICLE_ENTER_DISTANCE;
        if (free && teacher) for (const { state } of vehicleMeshes.values()) {
          if (state.rental || state.driverId || state.y > LANDING_HEIGHT) continue;
          const distance = Math.hypot(local.x - state.x, local.z - state.z);
          if (distance <= nearest) { nearby = state.id; nearest = distance; }
        }
        setVehicleNearby((current) => current === nearby ? current : nearby);
        const landed = !ownVehicle || (!ownVehicle.state.landing && ownVehicle.state.y <= LANDING_HEIGHT);
        setCanExitVehicle((current) => current === landed ? current : landed);
      }
      for (const [id, avatar] of avatarMeshes) {
        const self = id === room?.sessionId, seat = avatar.userData.trainSeat as number;
        const driven = vehicleMeshes.get(avatar.userData.vehicleId);
        const target = driven ? { x: driven.group.position.x, z: driven.group.position.z, rotation: driven.group.rotation.y }
          : seat >= 0 ? trainSeatPosition(seat) : self ? visual : avatar.userData.target;
        const previousX = avatar.position.x, previousZ = avatar.position.z;
        const blend = driven || seat >= 0 || self ? 1 : 1 - Math.exp(-16 * dt);
        avatar.position.x += (target.x - avatar.position.x) * blend; avatar.position.z += (target.z - avatar.position.z) * blend;
        avatar.rotation.y += Math.atan2(Math.sin(target.rotation - avatar.rotation.y), Math.cos(target.rotation - avatar.rotation.y)) * blend;
        const height = driven ? 0 : jumpHeight((time - (self ? jumpTime : avatar.userData.jumpTime)) / 1000);
        if (driven) {
          const riderOffset = driven.state.kind === "broom" ? broomSeatHeight - avatarHipHeight : 0.58;
          avatar.position.y = driven.group.position.y + riderOffset;
        } else {
          avatar.position.y = avatar.userData.knocked ? 0 : height;
        }
        const speed = driven || seat >= 0 ? 0 : (self ? Math.hypot(step.dx, step.dz) : Math.hypot(avatar.position.x - previousX, avatar.position.z - previousZ)) / Math.max(dt, 0.001);
        avatar.userData.walking += (Math.min(1, speed / 4) - avatar.userData.walking) * (1 - Math.exp(-15 * dt));
        avatar.userData.walkPhase += Math.min(speed, 5) * dt * 2.4;
        const character = avatar.userData.character as THREE.Group | undefined;
        if (character) animateAvatarCharacter(character, avatar.userData.walkPhase, avatar.userData.knocked ? 0 : avatar.userData.walking, height > 0, avatar.userData.knocked, self && wandRef.current && !driven, driven?.state.kind);
        if (avatar.userData.shield && avatar.userData.shieldExpires <= Date.now()) { avatar.remove(avatar.userData.shield); avatar.userData.shield.geometry.dispose(); (avatar.userData.shield.material as THREE.Material).dispose(); avatar.userData.shield = null; }
      }
      if (active && !drivingRef.current && time - lastSend > 100) {
        if (lastAcknowledged < 0) room.send("move", { ...local, movementEpoch });
        else if (unsent.dx || unsent.dz) {
          const move = { ...unsent, sequence: ++sequence }; pending.push(move); room.send("move", { ...move, rotation: local.rotation, movementEpoch });
        }
        unsent = { dx: 0, dz: 0 }; lastSend = time;
      }
      const distance = 8 + cameraPitch * 10;
      const cameraYaw = ownVehicle ? yaw + ownVehicle.group.rotation.y + Math.PI : yaw;
      const viewHeight = ownVehicle?.group.position.y ?? 0;
      camera.position.set(visual.x + Math.sin(cameraYaw) * distance, viewHeight + 2 + cameraPitch * 10, visual.z + Math.cos(cameraYaw) * distance);
      camera.lookAt(visual.x, viewHeight + 1.2, visual.z);
      if (time - lastAimCheck >= 100) {
        lastAimCheck = time;
        const valid = Boolean(currentAim());
        setAimValid((current) => current === valid ? current : valid);
      }
      const nextPivot = selectedRef.current ? loadedModels.get(selectedRef.current.id)?.pivot : undefined;
      const view = adjustmentRef.current;
      if (viewedPivot !== nextPivot) {
        viewedPivot?.rotation.set(0, 0, 0); viewedPivot?.scale.setScalar(1);
        viewedPivot = nextPivot; appliedAdjustment = initialModelAdjustment;
      }
      if (viewedPivot && view !== appliedAdjustment) {
        viewedPivot.rotation.set(THREE.MathUtils.degToRad(view.tilt), THREE.MathUtils.degToRad(view.yaw), 0, "YXZ");
        viewedPivot.scale.setScalar(view.size / 100);
        appliedAdjustment = view;
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
    const route = trainTrack(manifest?.blocks.length ?? 0);
    const stationWaitSeconds = Object.fromEntries(route.filter(({ id }) => id && trainForm.stationWaitSeconds?.[id] !== undefined)
      .map(({ id }) => [id, trainForm.stationWaitSeconds![id]!]));
    if (Object.values(stationWaitSeconds).some((seconds) => !Number.isInteger(seconds) || seconds < 3 || seconds > 120)) {
      setError("กรุณาระบุเวลาจอดเป็นจำนวนเต็ม 3–120 วินาที"); return;
    }
    const settings = { ...trainForm, stationWaitSeconds };
    setLoading(true); setError("");
    try {
      await api(apiPath(classroomId, "/train"), { method: "PUT", body: JSON.stringify(settings) });
      lastSavedTrainSettings.current = settings;
      setTrainForm(settings);
      setTrainMessage("บันทึกตารางรถไฟแล้ว · จะใช้ในการออกเที่ยวถัดไป"); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกตารางรถไฟไม่สำเร็จ"); }
    finally { setLoading(false); }
  }
  async function saveExhibition(assignmentId: string) {
    setLoading(true); setError("");
    try {
      await api(apiPath(classroomId, "/exhibition"), { method: "PUT", body: JSON.stringify({ assignmentId: assignmentId || null }) });
      setExhibitionDraft(null);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกพื้นที่จัดแสดงไม่สำเร็จ"); }
    finally { setLoading(false); }
  }
  function trainCommand(type: "train-start" | "train-board" | "train-leave") {
    const train = trainRef.current;
    if (!train || !roomRef.current?.connection?.isOpen) return;
    roomRef.current.send(type, { revision: train.revision });
  }
  function santaCommand() {
    const room = roomRef.current;
    if (!room?.connection?.isOpen) return;
    const enabled = !santaActive;
    if (!enabled && !window.confirm("หยุดกิจกรรมซานต้า? ของขวัญและระเบิดที่ยังทำงานทั้งหมดจะถูกเก็บ")) return;
    setSantaMessage("");
    room.send("santa-toggle", { enabled });
  }
  async function saveSantaSettings() {
    setLoading(true); setError("");
    try {
      const settings = { ...santaForm };
      await api(apiPath(classroomId, "/santa"), { method: "PUT", body: JSON.stringify(settings) });
      lastSavedSantaSettings.current = settings;
      setSantaForm(settings);
      setSantaMessage("บันทึกแล้ว · ใช้กับของขวัญระเบิดลูกใหม่"); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกการตั้งค่าระเบิดไม่สำเร็จ"); }
    finally { setLoading(false); }
  }
  function openNearestPresent() {
    if (!nearestPresent || !roomRef.current?.connection?.isOpen || openingPresent) return;
    setOpeningPresent(nearestPresent); roomRef.current.send("open-present", { id: nearestPresent });
  }
  function sendActivity(command: string, message?: object) {
    const room = roomRef.current;
    if (!room?.connection?.isOpen || activityPending) return false;
    setActivityPending(true);
    setActivityMessage("");
    activityTimeout.current = window.setTimeout(() => {
      setActivityPending(false);
      setActivityMessage("ไม่ได้รับการตอบกลับ กรุณาลองใหม่");
      if (!activityPanelRef.current) setGiftMessage("ไม่ได้รับการตอบกลับ กรุณาลองใหม่");
    }, 6000);
    room.send(command, message);
    return true;
  }
  function useNearbyActivity() {
    if (activity === "portal") { if (sendActivity("teleport")) setActiveMenu(null); return; }
    if (activity !== "shop" && activity !== "depot") return;
    if (activity === "shop" && !sendActivity("shop-open")) return;
    if (activity === "depot") setActivityMessage("");
    setSelected(null); setActiveMenu(null); setActivityPanel(activity);
  }
  async function saveShopPrices(prices: ShopPrices) {
    const saved = await api<ShopPrices>(apiPath(classroomId, "/shop"), { method: "PUT", body: JSON.stringify(prices) });
    setManifest((current) => current?.classroomId === classroomId ? { ...current, shop: saved } : current);
  }
  async function savePatrolSettings(settings: PatrolSettings) {
    const patrol = await api<PatrolSettings>(apiPath(classroomId, "/patrol"), { method: "PUT", body: JSON.stringify(settings) });
    setManifest((current) => current?.classroomId === classroomId ? { ...current, patrol } : current);
  }
  function toggleWand() {
    if (!wandMode && (knockSeconds || driving || (!teacher && trainSeatRef.current >= 0) || !canEquipWand)) return;
    setWandMode((value) => !value);
    setSelected(null);
    setActiveMenu(null);
  }
  function vehicleCommand(action: "reset" | "enter" | "exit", id: string) {
    const room = roomRef.current;
    if (!room?.connection?.isOpen || !vehicles) return;
    const vehicle = vehicles.find((item) => item.id === id);
    if (action === "reset" && vehicle?.driverId && !window.confirm("ย้ายคนขับและยานพาหนะกลับไปที่จุดจอดหรือไม่?")) return;
    setError("");
    setVehicleMessage("");
    if (action !== "reset") { setSelected(null); setActiveMenu(null); canvasRef.current?.focus({ preventScroll: true }); }
    room.send("vehicle-" + action, { id, kind: vehicle?.kind ?? id, revision: vehicle?.revision ?? 0, confirmedDriverId: vehicle?.driverId ?? "" });
  }
  async function setHidden(model: GalleryModel) {
    try { await api(apiPath(classroomId, `/files/${model.id}/visibility`), { method: "PUT", body: JSON.stringify({ hidden: !model.hidden }) }); setModels((all) => all.map((item) => item.id === model.id ? { ...item, hidden: !item.hidden } : item)); setSelected(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "เปลี่ยนการแสดงโมเดลไม่สำเร็จ"); }
  }
  async function toggleVote(fileId: string, undo: boolean) {
    if (voteInFlight.current) return;
    const controller = new AbortController();
    voteInFlight.current = controller;
    const { signal } = controller;
    setVotePending(true); setVoteNotice(null); setError("");
    try {
      const result = await api<{ likes: number; likedByMe: boolean; pointsDelta?: number; balance?: number }>(apiPath(classroomId, `/files/${fileId}/like`), { method: undo ? "DELETE" : "PUT", signal });
      if (signal.aborted) return;
      setModels((all) => all.map((item) => item.id === fileId ? { ...item, likes: result.likes, likedByMe: result.likedByMe } : item));
      setSelected((item) => item?.id === fileId ? { ...item, likes: result.likes, likedByMe: result.likedByMe } : item);
      const { balance, pointsDelta } = result;
      if (typeof balance === "number") setWallet((wallet) => ({ spells: 0, license: false, ...wallet, balance }));
      const message = undo ? "ยกเลิกโหวตแล้ว" : "บันทึกโหวตแล้ว";
      setVoteNotice({ fileId, text: pointsDelta ? `${message} · ${pointsDelta > 0 ? "+" : "−"}${Math.abs(pointsDelta)} แต้มโลกเสมือน` : message });
      try {
        const summary = await api<VoteSummary>(apiPath(classroomId, "/votes"), { signal });
        if (!signal.aborted) setVoteSummary(summary);
      } catch { if (!signal.aborted) setError("บันทึกโหวตแล้ว แต่โหลดยอดล่าสุดไม่สำเร็จ"); }
    } catch (reason) { if (!signal.aborted) setError(reason instanceof Error ? reason.message : "บันทึกการถูกใจไม่สำเร็จ"); }
    finally {
      if (voteInFlight.current === controller) { voteInFlight.current = null; setVotePending(false); }
    }
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
  const trainBlocks = manifest?.blocks ?? [];
  const exhibition = manifest?.exhibition;
  const exhibitionSelection = exhibitionDraft ?? exhibition?.requested ?? "";
  const exhibitionPending = Boolean(exhibition && exhibition.requested !== exhibition.displayed);
  const startStation = trainStartStation(exhibition?.displayed ? null : trainBlocks.find((block) => block.spaceId === trainForm.startStudentId)?.layoutIndex ?? null, trainBlocks.length);
  const stations = trainTrack(trainBlocks.length).filter(({ id }) => id);
  const trainStatus = !trainView ? "กำลังเชื่อมต่อรถไฟ…" : !trainView.active ? "ยังไม่มีพื้นที่จัดแสดงสำหรับเส้นทางรถไฟ" : trainView.phase === "moving"
    ? `กำลังไป${stationLabel(trainView.nextStopId, manifest?.blocks ?? [])} · ถึงประมาณ ${countdown(trainView.arrivalAt, trainClock)}`
    : trainView.phase === "dwell" ? `จอดที่${stationLabel(trainView.stopId, manifest?.blocks ?? [])} · ออกใน ${countdown(trainView.departureAt, trainClock)}`
    : trainView.phase === "boarding" ? `จอดที่${stationLabel(trainView.stopId, manifest?.blocks ?? [])} · รอบถัดไปออกใน ${countdown(trainView.departureAt, trainClock)}`
    : `จอดที่${stationLabel(trainView.stopId, manifest?.blocks ?? [])} · ${trainView.mode === "manual" ? "รอครูเริ่มเที่ยวรถ" : "รอรอบถัดไป"}`;
  const selectedSpaceWork = selected ? models.filter((item) => item.spaceId === selected.spaceId && !item.hidden) : [];
  const selectedPageCount = Math.ceil(selectedSpaceWork.length / pageSize);
  const selectedPage = selected ? Math.min(displayPages[selected.spaceId] ?? 0, Math.max(0, selectedPageCount - 1)) : 0;
  function changeDisplayPage(page: number) {
    if (!selected) return;
    const next = selectedSpaceWork[page * pageSize];
    if (!next) return;
    setDisplayPages((pages) => ({ ...pages, [selected.spaceId]: page }));
    setSelected(next);
  }
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

  function closeMenu() {
    setActiveMenu(null);
    if (activeMenu) menuButtons.current[activeMenu]?.focus({ preventScroll: true });
  }
  const nearbyAction = activity === "portal" ? "วาร์ปไปพื้นที่สุ่ม" : activity === "shop" ? "เปิดร้านค้าแต้ม" : "เลือกยานพาหนะ";
  const activeRide = driving ? vehicles?.find((vehicle) => vehicle.id === drivingRef.current) : undefined;

  if (enabled === false && !teacher) return <main className="public-lesson-page"><section className="panel"><h2>โลกเสมือนยังไม่พร้อม</h2><p>{error || "กรุณากลับไปยังห้องเรียนแล้วลองอีกครั้ง."}</p><a href="/">กลับไปห้องเรียน</a></section></main>;
  return <>
    <section className="gallery-shell">
      <header className={`gallery-toolbar${menuOpen ? " menu-open" : ""}`}>
        <div className="gallery-toolbar-room"><span className="gallery-room-mark" aria-hidden="true">✦</span><div><strong>{manifest?.classroomName ?? "โลกเสมือน"}</strong><small><span className="gallery-online-dot" aria-hidden="true" />{online} คนออนไลน์ · {exhibition?.displayed ? "นิทรรศการกลุ่ม" : "พื้นที่ส่วนตัว"}</small>{exhibitionPending && <small role="status">รอรถไฟจบรอบเพื่อเปลี่ยนพื้นที่</small>}</div></div>
        <div className="gallery-toolbar-actions">
          {([["menu", "☰", "เมนู"], ["tools", "✦", "เครื่องมือ"], ["settings", "⚙", "ตั้งค่าเกม"]] as const)
            .filter(([id]) => id !== "settings" || teacher).map(([id, icon, title]) => <button key={id}
              ref={(button) => { if (button) menuButtons.current[id] = button; }}
              className="button button-quiet gallery-menu-toggle" aria-expanded={activeMenu === id} aria-controls={`gallery-${id}`}
              onClick={() => setActiveMenu((current) => current === id ? null : id)}><span aria-hidden="true">{icon}</span>{title}</button>)}
          <button className="button button-quiet gallery-fullscreen-toggle" onClick={immersive ? exitFullscreenView : toggleFullscreen}><span aria-hidden="true">⛶</span>{immersive ? "ออกจากเต็มจอ" : "เต็มจอ"}</button>
        </div>
      </header>
      <div id="gallery-menu" className="gallery-menu" hidden={activeMenu !== "menu"}>
        <div className="gallery-menu-header"><strong>เมนูโลกเสมือน</strong><div><button className="button button-quiet" onClick={closeMenu}>ปิดเมนู</button>{close && <button className="button button-quiet" onClick={close}>กลับห้องเรียน</button>}</div></div>
        <div className="gallery-menu-room"><strong>{manifest?.classroomName ?? "โลกเสมือน"}</strong><small>{online} คนออนไลน์ · WASD/ลูกศร เดิน · Space กระโดด · ลากเพื่อหมุนมุมมอง</small></div>
        {user.role === "student" && <div className="gallery-attendance"><StudentAttendance /></div>}
        {user.role === "student" && <section className="gallery-management gallery-vote-list"><strong>โหวตผลงานของเพื่อน · ไม่เกิน 10 ครั้งต่องาน</strong>
          <small>โหวตใหม่ได้ 2 แต้ม สูงสุด 20 แต้มต่องาน · ยกเลิกโหวตจะหักแต้มที่ได้รับจากโหวตนั้น</small>
          {voteNotice && <p className="muted" role="status">{voteNotice.text}</p>}
          {voteSummary?.usage.map((item) => <small key={item.assignmentId}>{item.assignmentTitle}: ใช้แล้ว {item.used}/{voteSummary.limit} · เหลือ {Math.max(0, voteSummary.limit - item.used)}</small>)}
          {voteSummary?.myVotes.length ? voteSummary.myVotes.map((vote) => <div className="gallery-vote-entry" key={vote.fileId}>
            <span><strong>{vote.studentNumber ?? "—"}. {vote.displayName}</strong><small>{vote.assignmentTitle} · {vote.originalName}{vote.hidden ? " · ครูซ่อนผลงาน" : vote.unavailable ? " · งาน/พื้นที่นี้ไม่แสดงแล้ว" : ""}</small></span>
            <button className="text-button" disabled={votePending} onClick={() => void toggleVote(vote.fileId, true)}>ยกเลิก</button>
          </div>) : <small>{voteSummary ? "ยังไม่ได้โหวต · ยกเลิกโหวตแล้วจะได้สิทธิ์คืน" : "กำลังโหลดโหวต…"}</small>}
        </section>}
        {manifest?.nextOffset != null && <button className="button button-quiet" onClick={() => { void load(manifest.nextOffset!).catch(() => load()).catch((reason) => setError(reason instanceof Error ? reason.message : "โหลดผลงานเพิ่มไม่สำเร็จ")); }}>โหลดผลงานเพิ่ม</button>}
        {teacher && models.some((item) => item.hidden) && <aside className="gallery-hidden-tray"><strong>ผลงานที่ซ่อน</strong>{models.filter((item) => item.hidden).map((item) => <div key={item.id}><span>{item.displayName} · {item.originalName}</span><button className="text-button" onClick={() => void setHidden(item)}>แสดง</button></div>)}</aside>}
        {logout && <button className="button button-quiet" onClick={logout}>ออกจากระบบ</button>}
        {error && <div className="notice" role="alert">{error}</div>}{!config && <p className="gallery-service-note">ยังไม่ได้ตั้งค่า Colyseus ใน Coolify</p>}
      </div>
      <div id="gallery-tools" className="gallery-menu" hidden={activeMenu !== "tools"}>
        <div className="gallery-menu-header"><strong>เครื่องมือ</strong><button className="button button-quiet" onClick={closeMenu}>ปิดเครื่องมือ</button></div>
        <section className="gallery-management gallery-point-balance">
          <strong>อุปกรณ์และตัวละคร</strong>
          {!teacher && <><span>{wallet ? `${wallet.balance} แต้ม` : "กำลังโหลดแต้ม…"}</span>
            {wallet && wallet.balance < 0 && <small>แต้มติดลบจากการยกเลิกโหวต สะสมแต้มเพิ่มเพื่อซื้ออุปกรณ์ใหม่</small>}
            {wallet && <small>เหลือ {wallet.spells} คาถา · {wallet.license ? "มีใบขับขี่สำหรับ 1 เที่ยว" : "ไม่มีใบขับขี่"}</small>}</>}
          <div className="gallery-management-actions">
            <button className="button button-quiet" onClick={toggleWand} aria-pressed={wandMode}
              disabled={!wandMode && (!canEquipWand || Boolean(driving || knockSeconds) || (!teacher && trainSeat >= 0))}>{wandMode ? "เก็บไม้กายสิทธิ์" : "ถือไม้กายสิทธิ์"}</button>
            <button className="button button-quiet" onClick={() => { setError(""); setDraftAppearance({ ...appearance }); setCustomizerOpen(true); setActiveMenu(null); }}>ปรับแต่งตัวละคร</button>
          </div>
        </section>
        <section className="gallery-management">
          <strong>ยานพาหนะและจุดใกล้เคียง</strong>
          <div className="gallery-management-actions">
            {vehicleNearby && !driving && !knockSeconds && <button className="button button-quiet" onClick={() => vehicleCommand("enter", vehicleNearby)}>ขับ{vehicleNames[vehicleNearby as VehicleKind]}</button>}
            {activity && !knockSeconds && <button className="button button-quiet" disabled={activityPending} onClick={useNearbyActivity}>{nearbyAction}</button>}
          </div>
          {!activity && !vehicleNearby && <small>{driving ? "ใช้ปุ่มบนหน้าจอเพื่อควบคุมหรือออกจากยานพาหนะ" : "เดินเข้าใกล้ยานพาหนะหรือจุดกิจกรรมเพื่อใช้งาน"}</small>}
        </section>
        <aside className="gallery-train-panel" aria-label="รถไฟเที่ยวชมโลกเสมือน">
          <div className="gallery-train-status"><strong>🚂 รถไฟเที่ยวชม</strong><span>{trainStatus}</span><small>{trainView?.active ? `${trainView.seats}/12 ที่นั่ง · ${trainView.mode === "auto" ? "อัตโนมัติ" : "เริ่มโดยครู"}` : ""}</small></div>
          <div className="gallery-train-actions">
            {teacher && trainView?.active && trainView.mode === "manual" && trainView.phase === "waiting" && <button className="button button-quiet" onClick={() => trainCommand("train-start")}>เริ่มนับถอยหลังออกจากสถานี</button>}
            {!knockSeconds && trainAction && <button className="button button-quiet" onClick={() => { trainCommand(trainAction === "board" ? "train-board" : "train-leave"); setActiveMenu(null); }}>{trainAction === "board" ? "ขึ้นรถไฟ" : "ลงจากรถไฟ"}</button>}
          </div>
          {trainMessage && <small role="status">{trainMessage}</small>}
        </aside>
        {wanted && <MostWanted entries={wanted.entries} targetId={wanted.targetId} />}
        {error && <div className="notice" role="alert">{error}</div>}
      </div>
      {teacher && <div id="gallery-settings" className="gallery-menu" hidden={activeMenu !== "settings"}>
        <div className="gallery-menu-header"><strong>ตั้งค่าเกม</strong><button className="button button-quiet" onClick={closeMenu}>ปิดการตั้งค่า</button></div>
        <section className="gallery-management"><strong>จัดการโลกเสมือน</strong><p>{enabled ? "เปิดสำหรับนักเรียน" : "หยุดสำหรับนักเรียน · ครูเข้าชมได้"}</p><div className="gallery-management-actions"><button className="button button-quiet" disabled={loading} onClick={() => void setWorld(!enabled)}>{enabled ? "หยุดโลกสำหรับนักเรียน" : "เปิดโลกสำหรับนักเรียน"}</button></div></section>
        {exhibition && <section className="gallery-management">
          <strong>พื้นที่จัดแสดง</strong>
          <div className="gallery-train-settings">
            <label>รูปแบบพื้นที่<select value={exhibitionSelection ? "group" : "personal"} onChange={(event) => setExhibitionDraft(event.target.value === "group" ? exhibition.options[0]?.id ?? "" : "")}>
              <option value="personal">พื้นที่ส่วนตัว</option>
              <option value="group" disabled={!exhibition.options.length}>นิทรรศการกลุ่ม</option>
            </select></label>
            {exhibitionSelection && <label>งานที่จัดแสดง<select value={exhibitionSelection} onChange={(event) => setExhibitionDraft(event.target.value)}>
              {exhibition.options.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
            </select></label>}
            {!exhibition.options.length && <small>เชื่อมงานที่เปิดอยู่กับชุดกลุ่มในหน้างานและไฟล์ก่อน</small>}
            <button className="button button-quiet" disabled={loading || (exhibition.requested ?? "") === exhibitionSelection ||
              Boolean(exhibitionSelection && !exhibition.options.some((item) => item.id === exhibitionSelection))} onClick={() => void saveExhibition(exhibitionSelection)}>บันทึกพื้นที่จัดแสดง</button>
          </div>
        </section>}
        <section className="gallery-management"><strong>ตารางรถไฟและสถานี</strong><div className="gallery-train-settings">
            <label>ตารางรถ<select value={trainForm.mode} onChange={(event) => setTrainForm({ ...trainForm, mode: event.target.value as TrainSettings["mode"] })}><option value="auto">อัตโนมัติ</option><option value="manual">ครูเริ่มเอง</option></select></label>
            {trainForm.mode === "auto" && <label>ช่วงเวลา<select value={trainForm.intervalSeconds} onChange={(event) => setTrainForm({ ...trainForm, intervalSeconds: Number(event.target.value) as 60 | 120 })}><option value={60}>ทุก 1 นาที</option><option value={120}>ทุก 2 นาที</option></select></label>}
            <label>เริ่มจาก<select disabled={Boolean(exhibition?.displayed)} value={exhibition?.displayed ? "" : trainForm.startStudentId ?? ""} onChange={(event) => setTrainForm({ ...trainForm, startStudentId: event.target.value || null })}><option value="">สถานีทางเข้า</option>{manifest?.trainStudents.map((student) => <option key={student.id} value={student.id}>เลขที่ {student.studentNumber} · {student.displayName}</option>)}</select></label>
            {stations.length > 0 && <fieldset className="gallery-station-waits">
              <legend>เวลาจอดแต่ละสถานี (วินาที)</legend>
              <small>เว้นว่างเพื่อใช้ค่าเริ่มต้น</small>
              {stations.map(({ id }) => <label key={id}>{stationLabel(id, trainBlocks)}
                <input type="number" inputMode="numeric" min={3} max={120} step={1} placeholder={String(stationWaitMs(undefined, id, id === startStation) / 1000)}
                  value={trainForm.stationWaitSeconds?.[id] ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setTrainForm((form) => {
                      const waits = { ...form.stationWaitSeconds };
                      if (value === "") delete waits[id]; else waits[id] = Number(value);
                      return { ...form, stationWaitSeconds: waits };
                    });
                  }} />
              </label>)}
            </fieldset>}
            <button className="button button-quiet" disabled={loading} onClick={() => void saveTrainSettings()}>บันทึกตาราง</button>
            <small>{exhibition?.displayed ? "นิทรรศการกลุ่มเริ่มที่สถานีทางเข้า" : "ใช้การตั้งค่าเมื่อรถว่างก่อนออกเที่ยวถัดไป · เลขที่ที่เลือกเริ่มที่สถานีประจำกลุ่มแถว"}</small>
            {trainMessage && <small role="status">{trainMessage}</small>}
        </div></section>
        {user.role === "owner" && vehicles && <section className="gallery-management">
          <strong>จุดจอดยานพาหนะ</strong>
          <div className="gallery-management-actions">{vehicleKinds.map((kind) => {
            const vehicle = vehicles.find(({ id }) => id === kind);
            return <button key={kind} className="button button-quiet" onClick={() => vehicleCommand("reset", kind)}>
              {vehicle ? "รีเซ็ต" : "เรียก"}{vehicleNames[kind]}{vehicle?.driverId ? " · มีคนขับ" : ""}
            </button>;
          })}</div>
          {vehicles.filter(({ rental }) => rental).map((vehicle) => <button key={vehicle.id} className="button button-quiet" onClick={() => vehicleCommand("reset", vehicle.id)}>
            จบเที่ยว{vehicleNames[vehicle.kind]}{vehicle.driverName && ` · ${vehicle.driverName}`}
          </button>)}
          {vehicleMessage && <small role="status">{vehicleMessage}</small>}
        </section>}
        {manifest?.patrol && <PatrolSettingsForm key={`patrol-${classroomId}`} settings={manifest.patrol} save={savePatrolSettings} />}
        {manifest?.shop && <ShopPriceForm key={classroomId} prices={manifest.shop} save={saveShopPrices} />}
        <section className="gallery-management"><strong>🎅 ซานต้าตัวแสบ</strong><p>{santaActive ? "กำลังกวาดตาดูทางเดิน · ของขวัญใหม่ทุก 8 วินาที" : "กิจกรรมปิดอยู่"}</p><div className="gallery-management-actions"><button className="button button-quiet" onClick={santaCommand}>{santaActive ? "หยุดกิจกรรมและเก็บของขวัญ" : "เริ่มกิจกรรมคริสต์มาส"}</button></div><div className="gallery-access-mode"><label>นับถอยหลังก่อนระเบิด (วินาที)<input type="number" min={1} max={15} step={1} value={santaForm.fuseSeconds} onChange={(event) => setSantaForm({ ...santaForm, fuseSeconds: Number(event.target.value) })} /></label><label>เวลาคูลดาวน์ก่อนเกิดใหม่ (วินาที)<input type="number" min={3} max={60} step={1} value={santaForm.respawnSeconds} onChange={(event) => setSantaForm({ ...santaForm, respawnSeconds: Number(event.target.value) })} /></label><button className="button button-quiet" disabled={loading || !Number.isInteger(santaForm.fuseSeconds) || santaForm.fuseSeconds < 1 || santaForm.fuseSeconds > 15 || !Number.isInteger(santaForm.respawnSeconds) || santaForm.respawnSeconds < 3 || santaForm.respawnSeconds > 60} onClick={() => void saveSantaSettings()}>บันทึกการตั้งค่าระเบิด</button></div><small>นับถอยหลังปรับได้ 1–15 วินาที · คูลดาวน์เกิดใหม่ 3–60 วินาที</small>{santaMessage && <small role="status">{santaMessage}</small>}</section>
        <section className="gallery-management gallery-access">
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
        </section>
        {error && <div className="notice" role="alert">{error}</div>}
      </div>}
      {error && !menuOpen && <div className="notice" role="alert">{error}</div>}
      <canvas ref={canvasRef} className="gallery-canvas" tabIndex={0} aria-label="โลกเสมือนห้องเรียน กด WASD เพื่อเดิน Space เพื่อกระโดด และลากเพื่อหมุนมุมมอง" />
      {landscapeRequired && <div className="gallery-rotate-prompt" role="alert"><strong>หมุนโทรศัพท์เป็นแนวนอนเพื่อเล่น</strong><span>หมุนอุปกรณ์เพื่อให้ปุ่มควบคุมแสดงครบ</span>{close && <button className="button button-quiet" onClick={close}>กลับห้องเรียน</button>}</div>}
      {user.role === "student" && nearestPresent && !knockSeconds && <button className="gallery-present-open button button-primary" disabled={Boolean(openingPresent)} onClick={openNearestPresent}>{openingPresent ? "กำลังเปิดของขวัญ…" : "🎁 เปิดของขวัญ"}</button>}
      {blastSeconds > 0 && <div className="gallery-blast-countdown" role="alert">🎁 ระเบิดของขวัญใน {blastSeconds} วินาที · ออกจากวงสีแดง</div>}
      {giftMessage && <div className="gallery-gift-message" role="status">{giftMessage}</div>}
      {activity && !activityPanel && !menuOpen && !customizerOpen && !knockSeconds && <button className="gallery-activity-button button button-primary" disabled={activityPending} onClick={useNearbyActivity}>
        {nearbyAction}
      </button>}
      {activityPanel && !menuOpen && !customizerOpen && !knockSeconds && <section className="gallery-activity-panel" aria-label={activityPanel === "shop" ? "ร้านค้าแต้ม" : "จุดรับรถ"}>
        <header><strong>{activityPanel === "shop" ? "ร้านค้าแต้ม" : "จุดรับรถ"}</strong><button className="button button-quiet" aria-label="ปิด" onClick={() => { setActivityPanel(""); setShopPrices(null); setQuote(null); }}>ปิด</button></header>
        {activityPanel === "shop" ? <>
          {wallet && <span>แต้มที่ใช้ได้ {wallet.balance} · เหลือ {wallet.spells} คาถา</span>}
          {shopPrices && wallet && (quote ? <div className="gallery-management-actions">
            <span>{itemNames[quote.item]} · {quote.price} แต้ม</span>
            <button className="button button-primary" disabled={activityPending} onClick={() => sendActivity("shop-buy", quote)}>ยืนยันซื้อ</button>
            <button className="button button-quiet" disabled={activityPending} onClick={() => setQuote(null)}>ยกเลิก</button>
          </div> : <div className="gallery-management-actions">{shopItems.map((item) => {
            const owned = item === "wand" ? wallet.spells > 0 : wallet.license;
            return <button key={item} className="button button-quiet" disabled={activityPending || owned || wallet.balance < shopPrices[item]} onClick={() => setQuote({ item, price: shopPrices[item], requestId: crypto.randomUUID() })}>
              {itemNames[item]} {item === "wand" ? "15 คาถา" : "1 เที่ยว"} · {owned ? "มีแล้ว" : `${shopPrices[item]} แต้ม`}
            </button>;
          })}</div>)}
        </> : wallet?.license ? <div className="gallery-management-actions">{vehicleKinds.map((kind) => <button key={kind} className="button button-quiet" disabled={activityPending} onClick={() => sendActivity("ride-start", { kind, requestId: crypto.randomUUID() })}>{vehicleNames[kind]}</button>)}</div>
          : <span>{wallet ? "ซื้อใบขับขี่ที่ร้านค้าแต้มก่อนเริ่มขับ" : "กำลังโหลดใบขับขี่…"}</span>}
        {(activityMessage || activityPending) && <small role="status">{activityPending ? "กำลังดำเนินการ…" : activityMessage}</small>}
      </section>}
      {wandMode && !menuOpen && !activityPanel && !customizerOpen && !driving && !knockSeconds && <>
        <div ref={crosshairRef} className={`gallery-crosshair${aimValid ? "" : " unavailable"}`} style={{ left: `${(aimPoint.current.x + 1) * 50}%`, top: `${(1 - aimPoint.current.y) * 50}%` }} aria-hidden="true">{aimValid ? "＋" : "×"}</div>
        <p className="gallery-aim-hint">เลื่อนเมาส์หรือแตะเพื่อเล็ง · ลากเพื่อหมุนกล้อง · กด F หรือปุ่มยิง{!aimValid && <span>จุดนี้ยิงไม่ได้ — เลือกจุดเล็งใหม่</span>}</p>
        <button className="gallery-fire button button-primary" disabled={!castReady || !aimValid || knockSeconds > 0} onClick={() => fireWandRef.current()}>{castReady ? "ยิงเวทมนตร์ · F" : "กำลังชาร์จ…"}{!teacher && wallet && ` · ${wallet.spells} คาถา`}</button>
      </>}
      {knockSeconds > 0 ? <div className="gallery-knockdown" role="status">{knockCause === "jail"
        ? `ถูกจับเข้าเรือนจำ · ปล่อยตัวใน ${knockSeconds} วินาที`
        : `${knockMessages[knockCause] ?? "ตัวละครล้ม"} · ฟื้นใน ${knockSeconds} วินาที`}</div>
        : wanted?.targetId && wanted.targetId === roomRef.current?.sessionId ? <div className="gallery-knockdown" role="status">สายตรวจกำลังตามจับคุณ</div> : null}
      {!menuOpen && !activityPanel && !customizerOpen && !knockSeconds && trainAction && <button className="gallery-train-quick-action button button-primary" onClick={() => trainCommand(trainAction === "board" ? "train-board" : "train-leave")}>{trainAction === "board" ? "ขึ้นรถไฟ" : "ลงจากรถไฟ"}</button>}
      {!menuOpen && !customizerOpen && !knockSeconds && (driving || vehicleNearby) && <div className={`gallery-vehicle-controls${driving ? " driving" : ""}`}>
        {driving ? <>
          {Boolean(activeRide?.hitLimit) && <span className="gallery-drive-hint gallery-hits" role="status">ชนได้อีก {activeRide?.hitsRemaining}/{activeRide?.hitLimit}</span>}
          {Boolean(activeRide?.fuelCapacity) && <span className={`gallery-drive-hint gallery-fuel${(activeRide?.fuelRemaining ?? 0) <= 5 ? " low" : ""}`}>
            {activeRide?.landing ? "เชื้อเพลิงหมด · กำลังลงจอด" : activeRide?.fuelRemaining
              ? `${activeRide.fuelRemaining <= 5 ? "เชื้อเพลิงใกล้หมด" : "เชื้อเพลิง"} ${activeRide.fuelRemaining}/${activeRide.fuelCapacity} วินาที` : "เชื้อเพลิงหมด"}
          </span>}
          <span className="gallery-drive-hint">{vehicleNames[driving]} · WASD{vehicleSpecs[driving].flying ? " · Q ขึ้น / E ลง" : ""}</span>
          {vehicleSpecs[driving].flying && <div className="gallery-flight-buttons" aria-label="ควบคุมระดับความสูง">
            {([1, -1] as const).map((direction) => <button key={direction} className="button button-quiet" disabled={Boolean(activeRide?.fuelCapacity && !activeRide.fuelRemaining)}
              onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); liftRef.current = direction; }}
              onPointerUp={() => { if (liftRef.current === direction) liftRef.current = 0; }}
              onPointerCancel={() => { if (liftRef.current === direction) liftRef.current = 0; }}
              onLostPointerCapture={() => { if (liftRef.current === direction) liftRef.current = 0; }}>
              {direction > 0 ? "บินขึ้น ↑" : "ลดระดับ ↓"}
            </button>)}
          </div>}
          <button className="button button-primary" disabled={!canExitVehicle} onClick={() => vehicleCommand("exit", drivingRef.current)}>{canExitVehicle ? "ออกจากยานพาหนะ" : "ลงจอดก่อนออก"}</button>
        </> : vehicleNearby && <button className="button button-primary" onClick={() => vehicleCommand("enter", vehicleNearby)}>ขับ{vehicleNames[vehicleNearby as VehicleKind]}</button>}
      </div>}
      {!menuOpen && !activityPanel && !customizerOpen && !knockSeconds && <div className="gallery-touch" role="group" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); moveTouchJoystick(event, touchKnobRef.current, touchRef.current); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTouchJoystick(event, touchKnobRef.current, touchRef.current); }} onPointerUp={() => resetTouchJoystick(touchKnobRef.current, touchRef.current)} onPointerCancel={() => resetTouchJoystick(touchKnobRef.current, touchRef.current)} onLostPointerCapture={() => resetTouchJoystick(touchKnobRef.current, touchRef.current)} aria-label="ลากจอยสติ๊กเพื่อเดิน"><span ref={touchKnobRef} className="gallery-touch-knob" aria-hidden="true" /></div>}
      {!menuOpen && !activityPanel && !driving && <button className="gallery-jump button button-quiet" disabled={customizerOpen || knockSeconds > 0} onPointerDown={(event) => { event.preventDefault(); jumpRef.current = true; }} onClick={(event) => { if (event.detail === 0) jumpRef.current = true; }}>กระโดด ↑</button>}
      {selected && !menuOpen && !activityPanel && !customizerOpen && <aside className="gallery-inspect" aria-label="ตรวจดูผลงาน">
        <button className="icon-button" onClick={() => setSelected(null)} aria-label="ปิด">×</button>
        <p className="eyebrow">{selected.displayName} · เลขที่ {selected.studentNumber ?? "—"}</p>
        <h3>{selected.originalName}</h3>
        <p className="muted">{selected.assignmentTitle}{exhibition?.displayed && ` · ${manifest?.blocks.find((space) => space.spaceId === selected.spaceId)?.displayName ?? ""}`}</p>
        <div className="gallery-model-controls">
          <div role="group" aria-label="หมุนโมเดล">
            <button className="button button-quiet" onClick={() => setAdjustment((view) => ({ ...view, yaw: (view.yaw + 330) % 360 }))}>หมุนซ้าย</button>
            <button className="button button-quiet" onClick={() => setAdjustment((view) => ({ ...view, yaw: (view.yaw + 30) % 360 }))}>หมุนขวา</button>
            <button className="button button-quiet" disabled={adjustment.tilt >= 60} onClick={() => setAdjustment((view) => ({ ...view, tilt: Math.min(60, view.tilt + 15) }))}>เงยขึ้น</button>
            <button className="button button-quiet" disabled={adjustment.tilt <= -60} onClick={() => setAdjustment((view) => ({ ...view, tilt: Math.max(-60, view.tilt - 15) }))}>ก้มลง</button>
          </div>
          <label>ขนาดโมเดล {adjustment.size}%<input type="range" min={80} max={120} step={5} value={adjustment.size}
            onChange={(event) => setAdjustment({ ...adjustment, size: Number(event.target.value) })}/></label>
          <button className="text-button" onClick={() => setAdjustment(initialModelAdjustment)}>รีเซ็ตมุมมอง</button>
        </div>
        {selectedPageCount > 1 && <div className="gallery-display-pages">
          <span>ผลงานในพื้นที่ {selectedPage * pageSize + 1}–{Math.min((selectedPage + 1) * pageSize, selectedSpaceWork.length)} จาก {selectedSpaceWork.length}</span>
          <button className="text-button" disabled={selectedPage === 0} onClick={() => changeDisplayPage(selectedPage - 1)}>ก่อนหน้า</button>
          <button className="text-button" disabled={selectedPage + 1 >= selectedPageCount} onClick={() => changeDisplayPage(selectedPage + 1)}>ถัดไป</button>
        </div>}
        <p>{selected.likes} ถูกใจ{selected.likes >= 6 ? " · ระดับทอง" : selected.likes >= 3 ? " · ระดับเงิน" : selected.likes > 0 ? " · ระดับทองแดง" : ""}</p>
        {user.role === "student" && selected.studentId !== manifest?.viewerStudentId && <>
          <small>เหลือ {selectedVotesRemaining}/{voteSummary?.limit ?? 10} โหวตสำหรับงานนี้</small>
          <button className="button button-quiet" disabled={votePending || (!selected.likedByMe && selectedVotesRemaining <= 0)} onClick={() => void like(selected)}>{selected.likedByMe ? "ยกเลิกโหวต · ได้สิทธิ์คืน" : selectedVotesRemaining <= 0 ? "โหวตครบแล้ว" : "โหวตผลงานนี้"}</button>
          {voteNotice?.fileId === selected.id && <p className="muted" role="status">{voteNotice.text}</p>}
        </>}
        {teacher && <button className="button button-quiet" onClick={() => void setHidden(selected)}>ซ่อนผลงาน</button>}
        <button className="button button-primary" onClick={() => setPreview(selected)}>เปิดดูโมเดล</button>
      </aside>}
      {customizerOpen && <CharacterCustomizer appearance={draftAppearance} onChange={setDraftAppearance} onCancel={() => setCustomizerOpen(false)} onSave={() => void saveAppearance()} saving={loading} error={error} />}
    </section>
    {preview && <ModelPreview file={preview} contentPath={galleryFileUrl(classroomId, preview.id, "content")} materialPath={preview.materialAvailable ? galleryFileUrl(classroomId, preview.id, "material") : undefined} close={() => setPreview(null)} />}
  </>;
}

function ShopPriceForm({ prices, save }: { prices: ShopPrices; save: (prices: ShopPrices) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  return <form className="gallery-management" onSubmit={async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true); setMessage("");
    try {
      await save({ wand: Number(data.get("wand")), license: Number(data.get("license")) });
      setMessage("บันทึกราคาแล้ว");
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "บันทึกราคาไม่สำเร็จ"); }
    finally { setSaving(false); }
  }}>
    <strong>ราคาสินค้าร้านค้าแต้ม</strong>
    <div className="gallery-access-mode gallery-shop-prices">
      {shopItems.map((item) => <label key={item}>{itemNames[item]} (แต้ม)
        <input name={item} type="number" inputMode="numeric" min={1} max={1000} step={1} required defaultValue={prices[item]} />
      </label>)}
      <button className="button button-quiet" disabled={saving}>บันทึกราคา</button>
    </div>
    {message && <small role="status">{message}</small>}
  </form>;
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
