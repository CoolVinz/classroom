import { TRAIN_BOARDING_MS, TRAIN_SEATS } from "./train-layout.mjs";

export function firstDepartureAt(now, mode) {
  return mode === "auto" ? now + TRAIN_BOARDING_MS : 0;
}

export function nextDepartureAt(mode, intervalSeconds, lastDeparture, returnedAt) {
  return mode === "auto" ? Math.max(lastDeparture + intervalSeconds * 1000, returnedAt + TRAIN_BOARDING_MS) : 0;
}

export function canBoardTrain({ active, phase, seats, distance }) {
  return active && ["waiting", "boarding", "dwell"].includes(phase) && seats < TRAIN_SEATS && Number.isFinite(distance) && distance <= 5;
}
