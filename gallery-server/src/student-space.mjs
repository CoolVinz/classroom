import { blockPosition, GALLERY_COLUMNS, ROW_SPACING } from "./train-layout.mjs";

export const avatarRadius = 0.35;
export const avatarHeight = 2.18;
export const jumpApex = 1.125;
export const aisleTreeTrunk = { x: 5.25, y: 1.03, width: 0.42, height: 0.82 };
const rowStart = blockPosition(0).z;

export function studentSpaceCollision(count) {
  const tree = aisleTreeTrunk;
  return Array.from({ length: Math.ceil(count / GALLERY_COLUMNS) }, (_, row) => [-tree.x, tree.x].map((x) => ({
    x, z: blockPosition(row * GALLERY_COLUMNS).z, halfWidth: tree.width / 2, halfDepth: tree.width / 2,
    bottom: tree.y - tree.height / 2,
  })));
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
