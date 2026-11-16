export const defaultAppearance = Object.freeze({ skinColor: "#f3c8a6", hairColor: "#3e2d27", shirtColor: "#4f9b86", trousersColor: "#435875", hairStyle: "short" });

export function applyAppearance(player, appearance = defaultAppearance) {
  for (const key of Object.keys(defaultAppearance)) player[key] = appearance[key] ?? defaultAppearance[key];
}
