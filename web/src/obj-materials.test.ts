import { expect, test } from "bun:test";
import { parseDiffuseMaterials } from "./obj-materials";

test("reads named solid Kd colors while ignoring texture paths and invalid color lines", () => {
  const colors = parseDiffuseMaterials("newmtl warm red\nKd 1 0 0\nmap_Kd https://invalid.example/texture.png\nnewmtl blue\nKd 0 0 1\nnewmtl broken\nKd 2 0 0");
  expect(colors.get("warm red")?.r).toBeCloseTo(1);
  expect(colors.get("warm red")?.g).toBe(0);
  expect(colors.get("blue")?.b).toBeCloseTo(1);
  expect(colors.has("broken")).toBe(false);
});
