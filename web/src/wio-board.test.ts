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
  expect(board.snapshot().draws.map((item) => item.kind === "glyph" ? item.char : "").join("")).toBe("Hello Wio");
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

test("counter ignores held inputs, stops at zero, and requires an exact visible count", () => {
  const source = solution("counter");
  expect(checkSketch("counter", source.replace("a && !wasA", "a")).passed).toBe(false);
  expect(checkSketch("counter", source.replace(" && count > 0", "")).passed).toBe(false);
  expect(checkSketch("counter", source.replace("tft.println(count)", "tft.println(count * 10)")).passed).toBe(false);
});

test("light meter follows both the sensor value and the bar after falling light", () => {
  const source = solution("light-meter");
  expect(checkSketch("light-meter", source.replace("reading * 200 / 1023", "200")).passed).toBe(false);
  expect(checkSketch("light-meter", source.replace("tft.fillScreen(TFT_BLACK);", "")).passed).toBe(false);
  const board = createBoard(source);
  board.advance(50, { light: 1023, buttons: {} });
  expect(board.snapshot().draws).toContainEqual({ kind: "rect", color: 0x07e0, x: 24, y: 56, width: 200, height: 16 });
  board.advance(50, { light: 0, buttons: {} });
  expect(board.snapshot().draws.some((item) => item.kind === "rect")).toBe(false);
});

test("clips LCD rectangles and checks the visible result in drawing order", () => {
  const source = solution("lcd").replace('tft.println("Hello Wio");', 'tft.println("Hello Wio"); tft.fillRect(-10, 40, 200, 40, TFT_BLACK);');
  expect(checkSketch("lcd", source).passed).toBe(false);
  const board = createBoard(source);
  board.advance(0);
  expect(board.snapshot().draws.at(-1)).toEqual({ kind: "rect", color: 0, x: 0, y: 40, width: 190, height: 40 });
});

test("five-way menu requires both select inputs, a back action, and held-input handling", () => {
  const source = solution("switch-menu");
  expect(checkSketch("switch-menu", source.replace("up && !wasUp", "up")).passed).toBe(false);
  expect(checkSketch("switch-menu", source.replace("WIO_5S_RIGHT) == LOW || ", "WIO_5S_RIGHT) == LOW && ")).passed).toBe(false);
  expect(checkSketch("switch-menu", source.replace("if (left && !wasLeft) selected = false;", "")).passed).toBe(false);
});

test("buzzer sounds for exactly 200 ms per press and enforces its pin and PWM range", () => {
  const source = solution("buzzer");
  expect(checkSketch("buzzer", source.replace("delay(200)", "delay(100)")).passed).toBe(false);
  expect(checkSketch("buzzer", source.replace("a && !wasA", "a")).passed).toBe(false);
  expect(() => createBoard(source.replace("128", "256")).advance(0, { light: 512, buttons: { A: true } })).toThrow("0 ถึง 255");
  expect(() => createBoard(source.replace("pinMode(WIO_BUZZER, OUTPUT);", "")).advance(0, { light: 512, buttons: { A: true } })).toThrow("OUTPUT");
});
