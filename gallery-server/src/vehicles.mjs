export const vehicleSpecs = {
  car: { speed: 12, bayX: 12, halfWidth: 1.05, halfLength: 1.85, height: 1.4 },
  bike: { speed: 15, bayX: 19, halfWidth: 0.45, halfLength: 1.15, height: 1.2 },
  helicopter: { speed: 14, bayX: 27, halfWidth: 1.1, halfLength: 2.1, height: 1.6, flying: true },
  broom: { speed: 16, bayX: 34, halfWidth: 0.45, halfLength: 1.3, height: 1.15, flying: true },
};
export const vehicleKinds = Object.keys(vehicleSpecs);
export const VEHICLE_BAY_Z = 11;
export const MAX_FLIGHT_HEIGHT = 12;
export const VEHICLE_ENTER_DISTANCE = 4;
export const LANDING_HEIGHT = 0.3;
export const vehicleRespawn = { x: -8, z: 11 };
export const trainBodies = [
  { offset: 2.3, halfWidth: 1, halfLength: 1.3, height: 2.3 },
  { offset: -1.8, halfWidth: 1.1, halfLength: 2, height: 1.25 },
  { offset: -6.2, halfWidth: 1.1, halfLength: 2, height: 1.25 },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function validVehicleInput(message) {
  return message && [message.throttle, message.turn, message.lift].every((value) => Number.isFinite(value) && Math.abs(value) <= 1);
}

export function advanceVehicle(vehicle, input, dt, bounds) {
  const spec = vehicleSpecs[vehicle.kind];
  const rotation = vehicle.rotation - input.turn * dt * 1.9;
  const distance = input.throttle * dt * spec.speed;
  return {
    x: clamp(vehicle.x + Math.sin(rotation) * distance, -55, 55),
    y: spec.flying ? clamp(vehicle.y + input.lift * dt * 4, 0, MAX_FLIGHT_HEIGHT) : 0,
    z: clamp(vehicle.z + Math.cos(rotation) * distance, bounds.minZ, 25),
    rotation: Math.atan2(Math.sin(rotation), Math.cos(rotation)),
  };
}

export function hitsMovingBody(from, to, body, avatar, avatarHeight) {
  if (Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) < 0.001) return false;
  const sine = Math.sin(to.rotation), cosine = Math.cos(to.rotation);
  const offset = body.offset ?? 0;
  const local = (point) => ({
    x: (avatar.x - point.x) * cosine - (avatar.z - point.z) * sine,
    z: (avatar.x - point.x) * sine + (avatar.z - point.z) * cosine - offset,
    y: avatarHeight - point.y + 0.9 - body.height / 2,
  });
  const start = local(from), end = local(to);
  const extents = { x: body.halfWidth + 0.35, z: body.halfLength + 0.35, y: body.height / 2 + 0.9 };
  let enter = 0, leave = 1;
  for (const axis of ["x", "y", "z"]) {
    const change = end[axis] - start[axis], extent = extents[axis];
    if (Math.abs(change) < 0.00001) {
      if (Math.abs(start[axis]) > extent) return false;
      continue;
    }
    const near = (-extent - start[axis]) / change, far = (extent - start[axis]) / change;
    enter = Math.max(enter, Math.min(near, far));
    leave = Math.min(leave, Math.max(near, far));
    if (enter > leave) return false;
  }
  return true;
}
