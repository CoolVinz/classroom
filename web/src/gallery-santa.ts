import * as THREE from "three";

function part(parent: THREE.Group, geometry: THREE.BufferGeometry, color: number, position: [number, number, number], scale?: [number, number, number]) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.78, flatShading: true }));
  mesh.position.set(...position);
  if (scale) mesh.scale.set(...scale);
  parent.add(mesh);
  return mesh;
}

export function createSantaModel() {
  const santa = new THREE.Group();
  part(santa, new THREE.CylinderGeometry(0.36, 0.52, 0.94, 7), 0xa6282c, [0, 0.82, 0]);
  part(santa, new THREE.SphereGeometry(0.29, 8, 6), 0xf0c9a3, [0, 1.52, 0.08]);
  part(santa, new THREE.SphereGeometry(0.26, 8, 5), 0xf4eee2, [0, 1.28, 0.23], [1, 0.78, 0.72]);
  part(santa, new THREE.CylinderGeometry(0.29, 0.32, 0.09, 7), 0xf0eee4, [0, 1.73, 0]);
  part(santa, new THREE.ConeGeometry(0.23, 0.47, 7), 0xb3292d, [0, 1.98, 0]);
  part(santa, new THREE.SphereGeometry(0.1, 6, 4), 0xf5efe4, [0, 2.22, 0]);
  part(santa, new THREE.BoxGeometry(0.73, 0.14, 0.1), 0x292c2b, [0, 0.66, 0.39]);
  part(santa, new THREE.BoxGeometry(0.17, 0.17, 0.12), 0xe1b955, [0, 0.66, 0.45]);
  for (const x of [-0.13, 0.13]) part(santa, new THREE.SphereGeometry(0.035, 5, 4), 0x323332, [x, 1.56, 0.34]);
  part(santa, new THREE.BoxGeometry(0.56, 0.58, 0.25), 0x60432f, [0.38, 1.12, -0.18]);
  for (const x of [-0.22, 0.22]) part(santa, new THREE.CylinderGeometry(0.13, 0.16, 0.38, 6), 0x292c2b, [x, 0.23, 0.06]);
  return santa;
}

export function createPresentModel() {
  const gift = new THREE.Group();
  part(gift, new THREE.BoxGeometry(0.62, 0.48, 0.62), 0xd04a3e, [0, 0.25, 0]);
  part(gift, new THREE.BoxGeometry(0.66, 0.12, 0.66), 0xf0c75f, [0, 0.52, 0]);
  part(gift, new THREE.BoxGeometry(0.12, 0.55, 0.64), 0xf0c75f, [0, 0.28, 0]);
  part(gift, new THREE.TorusGeometry(0.15, 0.035, 5, 8, Math.PI), 0xffe393, [-0.08, 0.62, 0], [1, 1, 0.55]).rotation.z = Math.PI;
  part(gift, new THREE.TorusGeometry(0.15, 0.035, 5, 8, Math.PI), 0xffe393, [0.08, 0.62, 0], [1, 1, 0.55]);
  return gift;
}

export function createPresentBlast() {
  const blast = new THREE.Group();
  const ring = part(blast, new THREE.TorusGeometry(1, 0.075, 5, 36), 0xff6d3d, [0, 0.12, 0]);
  ring.rotation.x = -Math.PI / 2;
  blast.scale.setScalar(5);
  part(blast, new THREE.SphereGeometry(0.32, 7, 5), 0xffbc42, [0, 0.35, 0]);
  return blast;
}

export function disposeSantaModel(group: THREE.Object3D) {
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
  });
}
