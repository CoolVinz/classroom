import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

type FileItem = { id: string; originalName: string };
type Part = { positions: Float32Array; normals: Float32Array; indices?: Uint32Array };
type WorkerReply = { parts?: Part[]; triangles?: number; error?: string };

export default function ModelPreview({ file, close }: { file: FileItem; close: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const materialsRef = useRef<THREE.MeshStandardMaterial[]>([]);
  const [wireframe, setWireframe] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [triangles, setTriangles] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    let renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let frame = 0;
    const materials: THREE.MeshStandardMaterial[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    const worker = new Worker(new URL("./model-preview.worker.ts", import.meta.url), { type: "module" });
    const canvasElement = canvas.current;

    async function load() {
      try {
        const response = await fetch("/api/files/" + file.id + "/content", { credentials: "same-origin" });
        if (!response.ok) throw new Error("โมเดลนี้ไม่พร้อมแสดงตัวอย่าง");
        const extension = file.originalName.split(".").pop()?.toLowerCase();
        if (extension !== "stl" && extension !== "obj") throw new Error("รองรับไฟล์ STL และ OBJ เท่านั้น");
        const buffer = await response.arrayBuffer();
        timer = window.setTimeout(() => {
          worker.terminate();
          if (!disposed) { setError("ใช้เวลาอ่านโมเดลนานเกินไป กรุณาดาวน์โหลดไฟล์เพื่อตรวจสอบ"); setLoading(false); }
        }, 10_000);
        worker.postMessage({ extension, buffer }, [buffer]);
      } catch (reason) {
        if (!disposed) { setError(reason instanceof Error ? reason.message : "โหลดโมเดลไม่สำเร็จ"); setLoading(false); }
      }
    }

    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      window.clearTimeout(timer);
      if (disposed) return;
      if (event.data.error || !event.data.parts?.length || !canvasElement) {
        setError(event.data.error ?? "อ่านโมเดลไม่สำเร็จ"); setLoading(false); return;
      }
      try {
        renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        const scene = new THREE.Scene();
        scene.background = new THREE.Color("#f7faf8");
        scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8d87, 2));
        const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
        keyLight.position.set(4, 7, 6); scene.add(keyLight);
        const object = new THREE.Group();
        for (const part of event.data.parts) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
          geometry.setAttribute("normal", new THREE.BufferAttribute(part.normals, 3));
          if (part.indices) geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
          const material = new THREE.MeshStandardMaterial({ color: 0x4b9a80, metalness: 0.05, roughness: 0.7, wireframe });
          geometries.push(geometry); materials.push(material); object.add(new THREE.Mesh(geometry, material));
        }
        scene.add(object);
        const bounds = new THREE.Box3().setFromObject(object);
        const center = bounds.getCenter(new THREE.Vector3());
        object.position.sub(center);
        const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.1);
        const camera = new THREE.PerspectiveCamera(38, 1, radius / 1000, radius * 100);
        camera.position.set(radius * 2.6, radius * 2.1, radius * 2.6);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 0, 0); controls.enableDamping = true; controls.saveState();
        controlsRef.current = controls; materialsRef.current = materials;
        const resize = () => {
          if (!renderer || !canvasElement) return;
          const width = Math.max(canvasElement.clientWidth, 1);
          const height = Math.max(canvasElement.clientHeight, 1);
          renderer.setSize(width, height, false); camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(canvasElement); resize();
        const render = () => { if (!renderer || disposed) return; frame = requestAnimationFrame(render); controls?.update(); renderer.render(scene, camera); };
        render(); setLoading(false);
        setTriangles(event.data.triangles ?? 0);
      } catch (reason) {
        setError(reason instanceof Error ? "WebGL ไม่พร้อมใช้งานในเบราว์เซอร์นี้" : "แสดงโมเดลไม่สำเร็จ");
        setLoading(false);
      }
    };
    worker.onerror = () => { window.clearTimeout(timer); if (!disposed) { setError("อ่านโมเดลไม่สำเร็จ"); setLoading(false); } };
    void load();
    return () => {
      disposed = true; window.clearTimeout(timer); cancelAnimationFrame(frame); worker.terminate(); resizeObserver?.disconnect(); controls?.dispose();
      geometries.forEach((geometry) => geometry.dispose()); materials.forEach((material) => material.dispose()); renderer?.dispose();
      controlsRef.current = null; materialsRef.current = [];
    };
  }, [file.id, file.originalName]);

  useEffect(() => {
    materialsRef.current.forEach((material) => { material.wireframe = wireframe; material.needsUpdate = true; });
  }, [wireframe]);

  return <div className="modal-scrim model-scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="model-dialog" role="dialog" aria-modal="true" aria-label={"ตัวอย่างโมเดล " + file.originalName}>
    <header><div><p className="eyebrow">ตัวอย่างโมเดล 3 มิติ</p><h2>{file.originalName}</h2></div><button className="icon-button" onClick={close} aria-label="ปิด">×</button></header>
    <div className="model-canvas-wrap"><canvas ref={canvas} aria-label="หมุนและซูมโมเดลด้วยเมาส์หรือสัมผัส" />{loading && <p className="inline-loading"><i className="spinner"/>กำลังอ่านโมเดล…</p>}{error && <p className="model-error" role="alert">{error}</p>}</div>
    <footer><span className="muted">ลากเพื่อหมุน · เลื่อนเพื่อซูม{triangles ? " · " + triangles.toLocaleString() + " รูปสามเหลี่ยม" : ""}</span><div><Button type="button" tone="quiet" onClick={() => setWireframe((value) => !value)} aria-pressed={wireframe}>เส้นลวด</Button><Button type="button" tone="quiet" onClick={() => controlsRef.current?.reset()}>มุมมองเริ่มต้น</Button><Button type="button" onClick={close}>ปิด</Button></div></footer>
  </section></div>;
}

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "quiet" }) {
  const { tone = "primary", className = "", ...rest } = props;
  return <button className={"button button-" + tone + " " + className} {...rest} />;
}
