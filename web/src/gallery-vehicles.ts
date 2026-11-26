import * as THREE from "three";
import { vehicleSpecs, type VehicleKind } from "../../gallery-server/src/vehicles.mjs";

export type VehicleState = { id: string; kind: VehicleKind; rental: boolean; x: number; y: number; z: number; rotation: number; revision: number; driverId: string; hitLimit?: number; hitsRemaining?: number; fuelRemaining?: number; fuelCapacity?: number; landing?: boolean };
export const vehicleNames: Record<VehicleKind, string> = { car: "รถยนต์", bike: "มอเตอร์ไซค์", helicopter: "เฮลิคอปเตอร์", broom: "ไม้กวาดบิน" };
export const knockMessages: Record<string, string> = { train: "ถูกรถไฟชน", car: "ถูกรถยนต์ชน", bike: "ถูกมอเตอร์ไซค์ชน", helicopter: "ถูกเฮลิคอปเตอร์ชน", broom: "ถูกไม้กวาดบินชน", wand: "ถูกเวทมนตร์", santa: "โดนระเบิดของขวัญซานต้า" };
export const broomSeatHeight = 0.55;

export function vehicleModel(kind: VehicleKind, patrol = false) {
  const model = new THREE.Group();
  const color = new THREE.MeshStandardMaterial({ color: patrol ? 0x274e78 : { car: 0xd58238, bike: 0x49a78d, helicopter: 0x477cad, broom: 0xaa6539 }[kind], flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: 0x253e43, roughness: 0.8 });
  const light = new THREE.MeshStandardMaterial({ color: 0xffedb9, emissive: 0x473e17 });
  const spec = vehicleSpecs[kind];
  function box(material: THREE.Material, width: number, height: number, length: number, x: number, y: number, z: number, parent = model) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
  }
  function wheel(x: number, z: number, radius: number) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, kind === "bike" ? 0.17 : 0.24, 8), dark);
    mesh.position.set(x, radius, z);
    mesh.rotation.z = Math.PI / 2;
    model.add(mesh);
  }
  if (kind === "car") {
    box(color, 1.8, 0.48, spec.halfLength * 2, 0, 0.58, 0);
    box(color, 1.72, 0.32, 1.04, 0, 0.96, 1.23);
    box(dark, 1.45, 0.28, 0.14, 0, 1.17, 0.67);
    box(dark, 1.46, 0.24, 0.7, 0, 0.96, -0.16);
    for (const x of [-0.89, 0.89]) for (const z of [-1.16, 1.16]) wheel(x, z, 0.38);
    for (const x of [-0.62, 0.62]) box(light, 0.27, 0.15, 0.05, x, 0.74, 1.84);
    if (patrol) {
      box(color, 1.45, 0.12, 0.82, 0, 1.23, 0.18);
      box(new THREE.MeshStandardMaterial({ color: 0x5ad6ff, emissive: 0x1470c4 }), 0.31, 0.15, 0.23, -0.17, 1.36, 0.2);
      box(new THREE.MeshStandardMaterial({ color: 0xff6060, emissive: 0xab1212 }), 0.31, 0.15, 0.23, 0.17, 1.36, 0.2);
    }
  } else if (kind === "bike") {
    wheel(0, -0.76, 0.35); wheel(0, 0.75, 0.35);
    box(color, 0.42, 0.44, 1.4, 0, 0.68, -0.05);
    box(dark, 0.42, 0.12, 0.55, 0, 0.93, -0.3);
    box(dark, 0.88, 0.1, 0.15, 0, 1.2, 0.58);
    box(light, 0.22, 0.18, 0.16, 0, 0.98, 0.99);
  } else if (kind === "broom") {
    box(dark, 0.12, 0.12, 2.45, 0, broomSeatHeight - 0.06, 0.15);
    box(light, 0.23, 0.24, 0.16, 0, 0.49, -0.51);
    const bristles = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.4, 0.92, 7), color);
    bristles.rotation.x = Math.PI / 2;
    bristles.position.set(0, 0.42, -0.98);
    model.add(bristles);
  } else {
    box(color, 2.12, 0.55, 2.45, 0, 0.85, 0.26);
    box(dark, 1.9, 0.48, 0.31, 0, 1.18, 1.45);
    box(color, 0.42, 0.33, 1.52, 0, 0.94, -1.32);
    box(color, 0.14, 0.65, 0.43, 0, 1.25, -1.9);
    box(light, 0.25, 0.12, 0.1, 0, 0.58, 1.45);
    for (const x of [-0.75, 0.75]) {
      box(dark, 0.12, 0.36, 0.14, x, 0.35, 0.42);
      box(dark, 0.14, 0.12, 2.58, x, 0.12, 0.04);
    }
    const rotor = new THREE.Group();
    rotor.position.y = 2.35;
    box(dark, 0.16, 0.58, 0.16, 0, -0.3, 0, rotor);
    box(dark, 4.4, 0.06, 0.16, 0, 0, 0, rotor);
    box(dark, 0.16, 0.06, 4.4, 0, 0, 0, rotor);
    model.add(rotor);
    model.userData.rotor = rotor;
  }
  return model;
}
