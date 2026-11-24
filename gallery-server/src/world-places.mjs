export const portal = { x: -14, z: 14 };
export const shop = { x: -9, z: 18 };
export const depot = { x: 12, z: 18 };
export const interactionDistance = 3;
export const rentalPads = [11, 18, 25, 32, 39, 46].map((x) => ({ x, z: 22 }));

export function nearPlace(player, place) {
  return Math.hypot(player.x - place.x, player.z - place.z) <= interactionDistance;
}
