export const activityWidth: number;
export const activityHeight: number;
export const activitySpawn: { x: number; y: number };
export const choiceColors: string[];
export function choiceZones(count: number): { index: number; x: number; y: number; width: number; height: number }[];
export function zoneChoice(count: number, x: number, y: number): number;
export function zoneCenter(count: number, index: number): { x: number; y: number };
