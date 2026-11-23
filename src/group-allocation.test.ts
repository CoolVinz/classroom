import { describe, expect, test } from "bun:test";
import { allocateGroups } from "./group-allocation";

describe("allocateGroups", () => {
  test("balances a bounded 12-by-3 split and leaves overflow unassigned", () => {
    const result = allocateGroups(Array.from({ length: 37 }, (_, i) => String(i)), 12, 3);
    expect(result.groups).toHaveLength(12);
    expect(result.groups.flat()).toHaveLength(36);
    expect(result.groups.every((group) => group.length === 3)).toBe(true);
    expect(result.unassigned).toHaveLength(1);
  });

  test("balances when only a group limit is configured", () => {
    const result = allocateGroups(Array.from({ length: 10 }, (_, i) => String(i)), 3, null);
    expect(result.groups.map((group) => group.length).sort()).toEqual([3, 3, 4]);
    expect(result.unassigned).toHaveLength(0);
  });
});
