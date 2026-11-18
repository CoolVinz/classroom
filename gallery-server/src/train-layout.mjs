export const GALLERY_COLUMNS = 4;
export const BLOCK_WIDTH = 12;
export const BLOCK_DEPTH = 10;
export const ROW_SPACING = 17;
export const TRAIN_SPEED = 22;
export const TRAIN_DWELL_MS = 6000;
export const TRAIN_BOARDING_MS = 10000;
export const TRAIN_SEATS = 12;

export function blockPosition(index) {
  const column = index % GALLERY_COLUMNS;
  return {
    x: column < 2 ? (column === 0 ? -30 : -12) : (column === 2 ? 12 : 30),
    z: -14 - Math.floor(index / GALLERY_COLUMNS) * ROW_SPACING,
  };
}

export function exhibitPosition(index) {
  const slot = index % 40;
  return { x: -3.8 + (slot % 5) * 1.9, z: 3.55 - Math.floor(slot / 5) };
}

export function trainTrack(studentCount, startStudentIndex = null) {
  const rows = Math.ceil(studentCount / GALLERY_COLUMNS);
  if (!rows) return [];
  const stations = [{ id: "entrance", x: 0, z: 2 }];
  const stationRows = [];
  for (let row = 2; row < rows; row += 3) stationRows.push(row);
  if (stationRows.at(-1) !== rows - 1) stationRows.push(rows - 1);
  for (const row of stationRows) stations.push({ id: `row-${row + 1}`, x: 0, z: blockPosition(row * GALLERY_COLUMNS).z });
  const lastZ = blockPosition((rows - 1) * GALLERY_COLUMNS).z;
  const points = [...stations, { id: "", x: 50, z: lastZ }, { id: "", x: 50, z: 2 }];
  const startId = trainStartStation(startStudentIndex, studentCount);
  const start = points.findIndex((point) => point.id === startId);
  return [...points.slice(start), ...points.slice(0, start)];
}

export function trainStartStation(studentIndex, studentCount) {
  if (!Number.isInteger(studentIndex) || studentIndex < 0 || !studentCount) return "entrance";
  const rows = Math.ceil(studentCount / GALLERY_COLUMNS);
  const row = Math.floor(studentIndex / GALLERY_COLUMNS);
  return `row-${Math.min(rows - 1, Math.floor(row / 3) * 3 + 2) + 1}`;
}

export function distanceToNextStation(route, legIndex, x, z) {
  if (!route.length) return 0;
  let distance = 0;
  let from = { x, z };
  for (let step = 1; step <= route.length; step++) {
    const index = (legIndex + step) % route.length;
    const point = route[index];
    distance += Math.hypot(point.x - from.x, point.z - from.z);
    if (point.id) return distance;
    from = point;
  }
  return distance;
}
