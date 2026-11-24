import { TRAIN_BOARDING_MS, TRAIN_DWELL_MS, TRAIN_SEATS } from "./train-layout.mjs";

export function stationWaitMs(waits, stationId, starting) {
  const seconds = waits?.[stationId];
  return Number.isInteger(seconds) && seconds >= 3 && seconds <= 120
    ? seconds * 1000 : starting ? TRAIN_BOARDING_MS : TRAIN_DWELL_MS;
}

export function firstDepartureAt(now, mode, waitMs = TRAIN_BOARDING_MS) {
  return mode === "auto" ? now + waitMs : 0;
}

export function nextDepartureAt(mode, intervalSeconds, lastDeparture, returnedAt, waitMs = TRAIN_BOARDING_MS) {
  return mode === "auto" ? Math.max(lastDeparture + intervalSeconds * 1000, returnedAt + waitMs) : 0;
}

export function canBoardTrain({ active, phase, seats, distance }) {
  return active && ["waiting", "boarding", "dwell"].includes(phase) && seats < TRAIN_SEATS && Number.isFinite(distance) && distance <= 5;
}
