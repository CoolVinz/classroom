export const activityWidth = 100;
export const activityHeight = 60;
export const activitySpawn = { x: 50, y: 41 };
export const choiceColors = ["#b84948", "#3563ad", "#926414", "#207660", "#7b4baa", "#196883", "#a4477b", "#4a616c"];

export function choiceZones(count) {
  const columns = Math.min(count, 4);
  const width = 92 / columns;
  return Array.from({ length: count }, (_item, index) => ({
    index, x: 4 + (index % columns) * width, y: 4 + Math.floor(index / columns) * 16, width: width - 2, height: 13,
  }));
}

export function zoneChoice(count, x, y) {
  return choiceZones(count).find((zone) => x >= zone.x && x < zone.x + zone.width && y >= zone.y && y < zone.y + zone.height)?.index ?? -1;
}

export function zoneCenter(count, index) {
  const zone = choiceZones(count)[index];
  return zone ? { x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 } : activitySpawn;
}
