import * as THREE from "three";
import { directionFromCamera } from "./gallery-motion";

export function canvasAimPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }) {
  return {
    x: THREE.MathUtils.clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * 2 - 1,
    y: 1 - THREE.MathUtils.clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1) * 2,
  };
}

export function wandAim(raycaster: THREE.Raycaster, camera: THREE.Camera, pointer: THREE.Vector2, origin: THREE.Vector3, studentBodies: THREE.Object3D[]) {
  camera.updateMatrixWorld();
  raycaster.setFromCamera(pointer, camera);
  for (const body of studentBodies) body.updateWorldMatrix(true, true);
  const hit = raycaster.intersectObjects(studentBodies, true)[0];
  const aim = directionFromCamera(raycaster.ray.direction, origin, raycaster.ray.origin, hit?.distance);
  return Math.hypot(aim.dx, aim.dy, aim.dz) >= 0.99 && Math.abs(aim.dy) <= 0.75 ? aim : null;
}
