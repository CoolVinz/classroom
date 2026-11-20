import type { Object3D } from "three";

export function galleryModelIdForHit(object: Object3D, roots: WeakMap<Object3D, string>) {
  for (let current: Object3D | null = object; current; current = current.parent) {
    const id = roots.get(current);
    if (id !== undefined) return id;
  }
  return null;
}
