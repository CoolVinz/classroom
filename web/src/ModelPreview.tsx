import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createModelView, loadModel } from "./model-view";

type FileItem = { id: string; originalName: string };

export default function ModelPreview({ file, contentPath, close }: { file: FileItem; contentPath?: string; close: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const materialsRef = useRef<THREE.MeshStandardMaterial[]>([]);
  const [wireframe, setWireframe] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [triangles, setTriangles] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let renderer: THREE.WebGLRenderer | undefined;
    let view: ReturnType<typeof createModelView> | undefined;
    let controls: OrbitControls | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let frame = 0;
    const canvasElement = canvas.current;
    setLoading(true); setError(""); setTriangles(0);

    async function load() {
      try {
        const model = await loadModel(file, contentPath ?? "/api/files/" + file.id + "/content", controller.signal);
        if (controller.signal.aborted || !canvasElement) return;
        try { renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true, alpha: true }); }
        catch { throw new Error("WebGL ไม่พร้อมใช้งานในเบราว์เซอร์นี้"); }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        view = createModelView(model.parts);
        const { camera, scene, materials } = view;
        materials.forEach((material) => { material.wireframe = wireframe; });
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
        const render = () => { if (!renderer || controller.signal.aborted) return; frame = requestAnimationFrame(render); controls?.update(); renderer.render(scene, camera); };
        render(); setLoading(false);
        setTriangles(model.triangles);
      } catch (reason) {
        if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "แสดงโมเดลไม่สำเร็จ"); setLoading(false); }
      }
    }
    void load();
    return () => {
      controller.abort(); cancelAnimationFrame(frame); resizeObserver?.disconnect(); controls?.dispose();
      view?.dispose(); renderer?.dispose(); renderer?.forceContextLoss();
      controlsRef.current = null; materialsRef.current = [];
    };
  }, [file.id, file.originalName, contentPath]);

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
