import * as THREE from "three";
import { depot, portal, shop } from "../../gallery-server/src/world-places.mjs";

export type ShopPrices = { wand: number; license: number };
export type Wallet = { balance: number; spells: number; license: boolean };
export const shopItems = ["wand", "license"] as const;
export const itemNames = { wand: "ไม้กายสิทธิ์", license: "ใบขับขี่" };

export function createActivityLandmarks(scene: THREE.Group, label: (text: string) => THREE.Texture) {
  function station(place: { x: number; z: number }, title: string) {
    const group = new THREE.Group();
    group.position.set(place.x, 0, place.z);
    const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: label(title), transparent: true }));
    sign.scale.set(4.8, 0.75, 1);
    sign.position.y = 3.1;
    group.add(sign);
    scene.add(group);
    return group;
  }
  function mesh(group: THREE.Group, geometry: THREE.BufferGeometry, color: number, y: number) {
    const model = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, flatShading: true }));
    model.position.y = y;
    group.add(model);
    return model;
  }
  const pipe = station(portal, "ท่อวาร์ป");
  mesh(pipe, new THREE.CylinderGeometry(1.18, 1.34, 1.75, 12), 0x26766e, 0.88);
  mesh(pipe, new THREE.CylinderGeometry(1, 1, 0.05, 12), 0x123534, 1.78);
  mesh(pipe, new THREE.TorusGeometry(1.1, 0.16, 5, 12), 0xe5b566, 1.8).rotation.x = Math.PI / 2;
  const npc = station(shop, "ร้านค้าแต้ม");
  mesh(npc, new THREE.CylinderGeometry(0.35, 0.74, 1.38, 7), 0x574575, 0.75);
  mesh(npc, new THREE.IcosahedronGeometry(0.42, 1), 0xeac19b, 1.62);
  mesh(npc, new THREE.CylinderGeometry(0.56, 0.56, 0.12, 8), 0x403655, 1.94);
  mesh(npc, new THREE.ConeGeometry(0.38, 0.7, 7), 0x574575, 2.32);
  const rental = station(depot, "จุดรับรถ");
  mesh(rental, new THREE.CylinderGeometry(1.6, 1.6, 0.14, 10), 0xd3a657, 0.04);
}
