export type VehicleKind = "car" | "bike" | "helicopter";
export const vehicleSpecs: Record<VehicleKind, { speed: number; bayX: number; halfWidth: number; halfLength: number; height: number }>;
export const vehicleKinds: VehicleKind[];
export const VEHICLE_BAY_Z: number;
export const MAX_FLIGHT_HEIGHT: number;
export const VEHICLE_ENTER_DISTANCE: number;
export const LANDING_HEIGHT: number;
export const vehicleRespawn: { x: number; z: number };
