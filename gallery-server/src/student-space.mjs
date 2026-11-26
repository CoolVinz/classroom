import { blockPosition, ROW_SPACING } from "./train-layout.mjs";

export const avatarRadius = 0.35;
export const avatarHeight = 2.18;
export const jumpApex = 1.125;
export const signBoard = { x: 0, y: 3, z: -4.58, width: 9.5, height: 1.42, depth: 0.18 };
export const signPost = { x: 4.55, y: 2.85, z: -4.58, width: 0.22, height: 1.58, depth: 0.24 };
export const studentTreeTrunk = { x: 5.08, y: 1.03, z: 3.55, width: 0.42, height: 0.82, depth: 0.42 };
const rowStart = blockPosition(0).z;

export function studentSpaceCollision(count) {
  const rows = [];
  for (let index = 0; index < count; index++) {
    const { x, z } = blockPosition(index);
    const row = Math.round((rowStart - z) / ROW_SPACING);
    const props = rows[row] ??= [];
    for (const prop of [signBoard, signPost, studentTreeTrunk]) {
      for (const offset of prop.x === 0 ? [0] : [-prop.x, prop.x]) {
        props.push({ x: x + offset, z: z + prop.z, halfWidth: prop.width / 2, halfDepth: prop.depth / 2,
          bottom: prop.y - prop.height / 2 });
      }
    }
  }
  return rows;
}

function segmentEntry(from, to, prop, radius) {
  let near = 0, far = 1;
  for (const [axis, half] of [["x", prop.halfWidth], ["z", prop.halfDepth]]) {
    const start = from[axis] - prop[axis], delta = to[axis] - from[axis], size = half + radius;
    if (Math.abs(delta) < 1e-9) {
      if (Math.abs(start) > size) return Infinity;
      continue;
    }
    const a = (-size - start) / delta, b = (size - start) / delta;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return Infinity;
  }
  return near;
}

export function blockingProp(rows, from, to, radius = avatarRadius, headHeight = avatarHeight) {
  const margin = 6 + radius;
  const first = Math.max(0, Math.ceil((rowStart - Math.max(from.z, to.z) - margin) / ROW_SPACING));
  const last = Math.min(rows.length - 1, Math.floor((rowStart - Math.min(from.z, to.z) + margin) / ROW_SPACING));
  let blocked, earliest = Infinity;
  for (let row = first; row <= last; row++) for (const prop of rows[row]) {
    if (headHeight < prop.bottom) continue;
    const entry = segmentEntry(from, to, prop, radius);
    if (entry < earliest) { blocked = prop; earliest = entry; }
  }
  return blocked;
}

export function slidePastProps(rows, from, to, headHeight = avatarHeight) {
  if (!blockingProp(rows, from, to, avatarRadius, headHeight)) return to;
  const position = { x: to.x, z: from.z };
  if (blockingProp(rows, from, position, avatarRadius, headHeight)) position.x = from.x;
  const alongZ = { x: position.x, z: to.z };
  return blockingProp(rows, position, alongZ, avatarRadius, headHeight) ? position : alongZ;
}

export function clearGround(rows, point, radius = avatarRadius, headHeight = avatarHeight) {
  if (!blockingProp(rows, point, point, radius, headHeight)) return point;
  for (let distance = 0.5; distance <= 6; distance += 0.5) {
    for (let step = 0; step < 8; step++) {
      const angle = step * Math.PI / 4;
      const candidate = { x: point.x + Math.cos(angle) * distance, z: point.z + Math.sin(angle) * distance };
      if (!blockingProp(rows, candidate, candidate, radius, headHeight)) return candidate;
    }
  }
  return { x: 0, z: point.z };
}
