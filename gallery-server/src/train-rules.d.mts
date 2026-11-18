export function firstDepartureAt(now: number, mode: "auto" | "manual"): number;
export function nextDepartureAt(mode: "auto" | "manual", intervalSeconds: 60 | 120, lastDeparture: number, returnedAt: number): number;
export function canBoardTrain(input: { active: boolean; phase: string; seats: number; distance: number }): boolean;
