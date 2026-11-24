export function stationWaitMs(waits: Record<string, number> | undefined, stationId: string, starting: boolean): number;
export function firstDepartureAt(now: number, mode: "auto" | "manual", waitMs?: number): number;
export function nextDepartureAt(mode: "auto" | "manual", intervalSeconds: 60 | 120, lastDeparture: number, returnedAt: number, waitMs?: number): number;
export function canBoardTrain(input: { active: boolean; phase: string; seats: number; distance: number }): boolean;
