import { expect, test } from "bun:test";
import * as THREE from "three";
import { canvasAimPoint, wandAim } from "./gallery-aim";
import { createAvatarCharacter, defaultAvatarAppearance, disposeAvatarCharacter } from "./gallery-avatar";

test("canvas-relative aim survives layout offsets and resizing, with bounded edges", () => {
  expect(canvasAimPoint(210, 120, { left: 10, top: 20, width: 800, height: 400 })).toEqual({ x: -0.5, y: 0.5 });
  expect(canvasAimPoint(600, 350, { left: 200, top: 150, width: 1600, height: 800 })).toEqual({ x: -0.5, y: 0.5 });
  expect(canvasAimPoint(-10, 1000, { left: 0, top: 0, width: 800, height: 400 })).toEqual({ x: -1, y: -1 });
});

test("off-center aim converges on the nearest student from the muzzle at different camera angles", () => {
  const raycaster = new THREE.Raycaster(), origin = new THREE.Vector3(0.45, 1.45, 0);
  for (const aspect of [0.6, 2]) for (const yaw of [0, 0.8, -1.2]) for (const distance of [4, 18]) {
    const camera = new THREE.PerspectiveCamera(58, aspect, 0.1, 800);
    camera.position.set(Math.sin(yaw) * 11.4, 5.4, Math.cos(yaw) * 11.4); camera.lookAt(0, 1.2, 0); camera.updateMatrixWorld();
    const body = createAvatarCharacter(defaultAvatarAppearance);
    body.position.set(2.5, 0, -distance); body.updateMatrixWorld();
    const screen = new THREE.Vector3(2.5, 1.05, -distance).project(camera), pointer = new THREE.Vector2(screen.x, screen.y);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(body, true)[0]!;
    expect(hit).toBeDefined();
    const farther = createAvatarCharacter(defaultAvatarAppearance); farther.position.copy(body.position).addScaledVector(raycaster.ray.direction, 4); farther.updateMatrixWorld();
    const aim = wandAim(raycaster, camera, pointer, origin, [farther, body])!;
    const direction = new THREE.Vector3(aim.dx, aim.dy, aim.dz), expected = hit.point.clone().sub(origin).normalize();
    expect(direction.distanceTo(expected)).toBeLessThan(1e-6);
    disposeAvatarCharacter(body); disposeAvatarCharacter(farther);
  }
});

test("only supplied student bodies affect aim; scenery, name labels, and shields do not", () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(58, 1, 0.1, 800);
  camera.position.set(0, 1.45, 12); camera.lookAt(0, 1.45, 0);
  const avatar = new THREE.Group(), body = createAvatarCharacter(defaultAvatarAppearance); avatar.position.z = -5; avatar.add(body);
  const label = new THREE.Sprite(new THREE.SpriteMaterial()); label.scale.setScalar(10); label.position.z = 10; avatar.add(label);
  const shield = new THREE.Mesh(new THREE.SphereGeometry(4), new THREE.MeshBasicMaterial()); avatar.add(shield);
  const scenery = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 1), new THREE.MeshBasicMaterial()); scenery.position.set(0, 1, 4);
  scene.add(avatar, scenery); scene.updateMatrixWorld(true);
  const origin = new THREE.Vector3(0.45, 1.45, 0), raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const aim = wandAim(raycaster, camera, pointer, origin, [body])!;
  raycaster.setFromCamera(pointer, camera);
  const expected = raycaster.intersectObject(body, true)[0]!.point.sub(origin).normalize();
  expect(new THREE.Vector3(aim.dx, aim.dy, aim.dz).distanceTo(expected)).toBeLessThan(1e-6);
  const miss = wandAim(raycaster, camera, pointer, origin, [])!;
  expect(miss.dx).not.toBeCloseTo(aim.dx);
  disposeAvatarCharacter(scene);
});

test("steep cursor rays cannot fire and an ordinary miss still has normalized aim", () => {
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 800); camera.position.set(0, 5, 12); camera.lookAt(0, -15, 0);
  const raycaster = new THREE.Raycaster(), origin = new THREE.Vector3(0, 1.45, 0), pointer = new THREE.Vector2(0, -1);
  expect(wandAim(raycaster, camera, pointer, origin, [])).toBeNull();
  camera.lookAt(0, 1.45, -20);
  const aim = wandAim(raycaster, camera, new THREE.Vector2(0.5, 0), origin, [])!;
  expect(Math.hypot(aim.dx, aim.dy, aim.dz)).toBeCloseTo(1);
  expect(aim.dx).toBeGreaterThan(0);
});
