import type { VehicleKind } from "./vehicles.mjs";
export type PatrolSettings = Record<VehicleKind, number> & { baseSeconds: number; extraSeconds: number; maxSeconds: number; helicopterFuelSeconds: number; broomFuelSeconds: number };
export type WantedRank = { id: string; count: number; since: number };
export const defaultPatrolSettings: PatrolSettings;
export const jailCell: { x: number; z: number };
export const jailGate: { x: number; z: number };
export function rankWanted(a: WantedRank, b: WantedRank): number;
