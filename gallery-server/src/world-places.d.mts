type Place = { x: number; z: number };
export const portal: Place;
export const shop: Place;
export const depot: Place;
export const rentalPads: Place[];
export function nearPlace(player: Place, place: Place): boolean;
