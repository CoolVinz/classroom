import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { wioLabs, wioLabIds } from "../../src/wio-labs";
import { checkSketch, createBoard } from "./wio-board";

function solution(id: string) {
  return readFileSync(new URL(`../../src/test-fixtures/wio/${id}/${id}.ino`, import.meta.url), "utf8");
}

for (const id of wioLabIds) {
  test(`${id}: sample passes and starter stays runnable without passing`, () => {
    expect(checkSketch(id, solution(id)).passed).toBe(true);
    expect(checkSketch(id, wioLabs[id].starter).passed).toBe(false);
  });
}

test("simulates timed LED transitions even between worker ticks", () => {
  const board = createBoard(solution("blink"));
  board.advance(25);
  expect(board.snapshot().led).toBe(true);
  board.advance(474);
  expect(board.snapshot().led).toBe(true);
  board.advance(1);
  expect(board.snapshot().led).toBe(false);
  board.advance(500);
  expect(board.transitions).toEqual([{ at: 0, on: true }, { at: 500, on: false }, { at: 1000, on: true }]);
  expect(checkSketch("blink", solution("blink").replace("delay(500)", "delay(600)")).passed).toBe(false);
});

test("applies active-low buttons and keeps the LED on after release", () => {
  const board = createBoard(solution("buttons"));
  board.advance(25, { buttons: { A: true }, light: 0 });
  expect(board.snapshot().led).toBe(true);
  board.advance(25, { buttons: { C: true }, light: 0 });
  expect(board.snapshot().led).toBe(true);
  board.advance(25, { buttons: { B: true }, light: 0 });
  expect(board.snapshot().led).toBe(false);
});

test("checks visible LCD text and rejects erased, invisible and off-screen text", () => {
  const source = solution("lcd");
  expect(checkSketch("lcd", source.replace("TFT_WHITE", "TFT_BLACK")).passed).toBe(false);
  expect(checkSketch("lcd", source.replace("24, 42", "24, 240")).passed).toBe(false);
  expect(checkSketch("lcd", source.replace('tft.println("Hello Wio");', 'tft.println("Hello Wio"); tft.fillScreen(TFT_BLACK);')).passed).toBe(false);
  const board = createBoard(source);
  board.advance(0);
  expect(board.snapshot()).toMatchObject({ width: 320, height: 240 });
  expect(board.snapshot().text.map((stamp) => stamp.char).join("")).toBe("Hello Wio");
});

test("checks the light threshold at 299 and 300 and reports bounded serial output", () => {
  const source = solution("light");
  const board = createBoard(source);
  board.advance(50, { buttons: {}, light: 299 });
  expect(board.snapshot().led).toBe(true);
  board.advance(50, { buttons: {}, light: 300 });
  expect(board.snapshot().led).toBe(false);
  expect(board.snapshot().serial).toContain("299\n300\n");
  for (let i = 0; i < 1500; i++) board.advance(50, { buttons: {}, light: 1023 });
  expect(board.snapshot().serial.length).toBe(4096);
  expect(checkSketch("light", source.replace("< 300", "<= 300")).passed).toBe(false);
});

test("supports scoped variables, assignment, logical short circuit, and the third button", () => {
  const source = `const int target = 2 + 3 * 4;
int counter = 0;
void setup() { pinMode(WIO_KEY_C, INPUT_PULLUP); pinMode(LED_BUILTIN, OUTPUT); }
void loop() {
  bool active = digitalRead(WIO_KEY_C) == LOW;
  if (active && (target == 14 || 1 / 0)) {
    counter = counter + 1;
    digitalWrite(LED_BUILTIN, counter % 2);
  } else {
    digitalWrite(LED_BUILTIN, LOW);
  }
  delay(25);
}`;
  const board = createBoard(source);
  board.advance(0, { light: 512, buttons: { C: true } });
  expect(board.snapshot().led).toBe(true);
  board.advance(25);
  expect(board.snapshot().led).toBe(false);
});

test("reports source lines for unsupported syntax, hardware calls, and tight loops", () => {
  expect(() => createBoard("void setup() {\n#include <external.h>\n}\nvoid loop() {}")).toThrow("บรรทัด 2");
  expect(() => createBoard("void setup() {}\nvoid loop() { fetch(); }").advance(0)).toThrow("บรรทัด 2");
  expect(() => createBoard("void setup() {}\nvoid loop() { while (true) {} }").advance(0)).toThrow("บรรทัด 2");
  expect(() => createBoard("ก".repeat(6000))).toThrow("16 KiB");
  expect(() => createBoard("void setup(){}\nvoid loop(){ if(" + "(".repeat(50) + "1" + ")".repeat(50) + "){} }")).toThrow("บรรทัด 2");
});
