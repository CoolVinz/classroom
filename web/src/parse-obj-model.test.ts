import { expect, test } from "bun:test";
import { parseOBJModel } from "./parse-obj-model";

test("preserves separate OBJ material groups as solid diffuse colors", () => {
  const obj = `o square\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nusemtl red\nf 1 2 3\nusemtl blue\nf 1 3 4`;
  const mtl = "newmtl red\nKd 1 0 0\nmap_Kd https://invalid.example/no-request.png\nnewmtl blue\nKd 0 0 1";
  const parsed = parseOBJModel(new TextEncoder().encode(obj).buffer, mtl);
  expect(parsed.triangles).toBe(2);
  expect(parsed.parts).toHaveLength(2);
  expect(parsed.parts[0].colors?.[0]).toBeCloseTo(1);
  expect(parsed.parts[0].colors?.[2]).toBe(0);
  expect(parsed.parts[1].colors?.[0]).toBe(0);
  expect(parsed.parts[1].colors?.[2]).toBeCloseTo(1);
});
