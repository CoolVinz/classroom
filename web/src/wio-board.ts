import type { WioLabId } from "../../src/wio-labs";
import { parseSketch, sketchError, type Expression, type ScalarType, type SketchFunction, type Statement, type Value } from "./wio-sketch";

const pins = {
  LED_BUILTIN: 1, WIO_KEY_A: 2, WIO_KEY_B: 3, WIO_KEY_C: 4, WIO_LIGHT: 5,
  WIO_5S_UP: 6, WIO_5S_DOWN: 7, WIO_5S_LEFT: 8, WIO_5S_RIGHT: 9, WIO_5S_PRESS: 10, WIO_BUZZER: 11,
};
const modes = { INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2 };
const colors = { TFT_BLACK: 0x0000, TFT_WHITE: 0xffff, TFT_RED: 0xf800, TFT_GREEN: 0x07e0, TFT_BLUE: 0x001f, TFT_YELLOW: 0xffe0, TFT_CYAN: 0x07ff, TFT_MAGENTA: 0xf81f, TFT_ORANGE: 0xfda0 };
const constants = new Map(Object.entries({ ...pins, ...modes, ...colors, HIGH: 1, LOW: 0 }));
export type BoardButton = "A" | "B" | "C" | "up" | "down" | "left" | "right" | "center";
const buttonPins = new Map<number, BoardButton>([
  [pins.WIO_KEY_A, "A"], [pins.WIO_KEY_B, "B"], [pins.WIO_KEY_C, "C"],
  [pins.WIO_5S_UP, "up"], [pins.WIO_5S_DOWN, "down"], [pins.WIO_5S_LEFT, "left"],
  [pins.WIO_5S_RIGHT, "right"], [pins.WIO_5S_PRESS, "center"],
]);
type Glyph = { kind: "glyph"; x: number; y: number; size: number; color: number; char: string };
type Rectangle = { kind: "rect"; x: number; y: number; width: number; height: number; color: number };
type Line = { kind: "line"; x: number; y: number; x2: number; y2: number; color: number };
type Circle = { kind: "circle"; x: number; y: number; radius: number; filled: boolean; color: number };
type Draw = Glyph | Rectangle | Line | Circle;
export type BoardSnapshot = { led: boolean; buzzer: boolean; serial: string; width: number; height: number; background: number; draws: Draw[] };
export type BoardInput = { buttons: Partial<Record<BoardButton, boolean>>; light: number };
export const defaultBoardInput: BoardInput = { buttons: {}, light: 512 };
export const blankBoard: BoardSnapshot = { led: false, buzzer: false, serial: "", width: 320, height: 240, background: 0, draws: [] };

type Variable = { value: Value; type: ScalarType; constant: boolean };
type Scope = Map<string, Variable>;
type Execution<T> = Generator<number, T, void>;
type Flow = "break" | "continue" | { value?: Value; line: number } | undefined;

function integer(value: Value | undefined, line: number) {
  if (typeof value === "object") return value.unsigned;
  if (typeof value !== "number") sketchError(line, "คำสั่งนี้ต้องใช้จำนวนเต็ม");
  return value;
}

function convert(value: Value, type: ScalarType, line: number): Value {
  const number = integer(value, line);
  switch (type) {
    case "bool": return Number(number !== 0);
    case "u32": return { unsigned: number >>> 0 };
    case "u16": return number & 0xffff;
    case "u8": return number & 0xff;
    case "int": return number | 0;
  }
}

function isTrue(value: Value, line: number) {
  return integer(value, line) !== 0;
}

function binaryOperation(operator: string, left: Value, right: Value, line: number): Value {
  const unsigned = typeof left === "object" || typeof right === "object";
  const a = integer(left, line);
  const b = integer(right, line);
  const x = unsigned ? a >>> 0 : a;
  const y = unsigned ? b >>> 0 : b;
  const result = (value: number) => unsigned ? { unsigned: value >>> 0 } : value | 0;
  switch (operator) {
    case "+": return result(x + y);
    case "-": return result(x - y);
    case "*": return result(Math.imul(x, y));
    case "/":
    case "%":
      if (!y) sketchError(line, "หารด้วยศูนย์ไม่ได้");
      return result(operator === "/" ? x / y : x % y);
    case "==": return Number(x === y);
    case "!=": return Number(x !== y);
    case "<": return Number(x < y);
    case "<=": return Number(x <= y);
    case ">": return Number(x > y);
    case ">=": return Number(x >= y);
    default: return Number(y !== 0);
  }
}

function printable(value: Value | undefined) {
  return typeof value === "object" ? String(value.unsigned) : String(value ?? "");
}

export function createBoard(source: string) {
  const program = parseSketch(source);
  const board: BoardSnapshot = { ...blankBoard, draws: [] };
  const pinModes = new Map<number, number>();
  const transitions: { at: number; on: boolean }[] = [];
  const buzzerTransitions: typeof transitions = [];
  const globals: Scope = new Map();
  const lcd = { begun: false, x: 0, y: 0, size: 1, color: colors.TFT_WHITE, textBackground: null as number | null };
  let inputs = defaultBoardInput;
  let now = 0;
  let wake = 0;
  let steps = 0;
  let revision = 0;
  let callDepth = 0;

  function step(line: number) {
    if (++steps > 20_000) sketchError(line, "โปรแกรมทำงานนานเกินไป ลองเพิ่ม delay() หรือตรวจสอบเงื่อนไขของลูป");
  }
  function variable(name: string, scope: Scope[]) {
    for (let index = scope.length - 1; index >= 0; index--) {
      const item = scope[index].get(name);
      if (item) return item;
    }
  }
  function setOutput(output: "led" | "buzzer", on: boolean) {
    if (board[output] === on) return;
    board[output] = on;
    revision++;
    const events = output === "led" ? transitions : buzzerTransitions;
    events.push({ at: now, on });
    if (events.length > 64) events.shift();
  }
  function draw(item: Draw) {
    if (board.draws.length === 1024) board.draws.shift();
    board.draws.push(item);
    revision++;
  }
  function fillRectangle(x: number, y: number, width: number, height: number, color: number) {
    if (width <= 0 || height <= 0) return;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(board.width, x + width);
    const bottom = Math.min(board.height, y + height);
    if (right <= left || bottom <= top) return;
    if (left === 0 && top === 0 && right === board.width && bottom === board.height) {
      board.background = color;
      board.draws = [];
      revision++;
      return;
    }
    draw({ kind: "rect", x: left, y: top, width: right - left, height: bottom - top, color });
  }
  function drawLine(x: number, y: number, x2: number, y2: number, color: number) {
    const dx = x2 - x, dy = y2 - y;
    let entry = 0, exit = 1;
    for (const [travel, distance] of [[-dx, x], [dx, board.width - 1 - x], [-dy, y], [dy, board.height - 1 - y]]) {
      if (travel === 0) {
        if (distance < 0) return;
        continue;
      }
      const edge = distance / travel;
      if (travel < 0) entry = Math.max(entry, edge);
      else exit = Math.min(exit, edge);
      if (entry > exit) return;
    }
    const startX = Math.round(x + dx * entry), startY = Math.round(y + dy * entry);
    const endX = Math.round(x + dx * exit), endY = Math.round(y + dy * exit);
    if (startX === endX && startY === endY) fillRectangle(startX, startY, 1, 1, color);
    else draw({ kind: "line", x: startX, y: startY, x2: endX, y2: endY, color });
  }
  function drawCircle(x: number, y: number, radius: number, color: number, filled: boolean) {
    if (radius < 0 || x + radius < 0 || y + radius < 0 || x - radius >= board.width || y - radius >= board.height) return;
    if (radius === 0) { fillRectangle(x, y, 1, 1, color); return; }
    const farthest = Math.hypot(Math.max(Math.abs(x), Math.abs(x - board.width)), Math.max(Math.abs(y), Math.abs(y - board.height)));
    if (radius > farthest + 1) {
      if (filled) fillRectangle(0, 0, board.width, board.height, color);
      return;
    }
    draw({ kind: "circle", x, y, radius, color, filled });
  }
  function printLcd(text: string) {
    for (const char of text.slice(0, 1024)) {
      if (char === "\r") continue;
      if (char === "\n" || lcd.x + 6 * lcd.size > board.width) {
        lcd.x = 0;
        lcd.y += 8 * lcd.size;
      }
      if (char === "\n") continue;
      if (lcd.x >= 0 && lcd.y >= 0 && lcd.y + 8 * lcd.size <= board.height) {
        if (lcd.textBackground !== null) fillRectangle(lcd.x, lcd.y, 6 * lcd.size, 8 * lcd.size, lcd.textBackground);
        draw({ kind: "glyph", x: lcd.x, y: lcd.y, color: lcd.color, size: lcd.size, char });
      }
      lcd.x += 6 * lcd.size;
    }
  }
  function call(name: string, args: Value[], line: number): Value {
    if (program.tft && name.startsWith(program.tft + ".")) name = "tft" + name.slice(program.tft.length);
    else if (name.includes(".") && !name.startsWith("Serial.")) sketchError(line, `ไม่รู้จักออบเจ็กต์ ${name.split(".")[0]}`);
    const n = (index: number) => integer(args[index], line);
    const arity = (count: number) => {
      if (args.length !== count) sketchError(line, `${name} ต้องมี ${count} อาร์กิวเมนต์`);
    };
    if (name.startsWith("tft.")) {
      if (!lcd.begun && name !== "tft.begin" && name !== "tft.init" && name !== "tft.color565") sketchError(line, "เรียก tft.begin() หรือ tft.init() ก่อนใช้ LCD");
    }
    switch (name) {
      case "millis":
        arity(0);
        return { unsigned: now >>> 0 };
      case "map": {
        arity(5);
        const span = (n(2) - n(1)) | 0;
        if (!span) sketchError(line, "map() ต้องใช้ช่วงอินพุตที่กว้างกว่าศูนย์");
        return (Math.trunc(Math.imul(n(0) - n(1), n(4) - n(3)) / span) + n(3)) | 0;
      }
      case "constrain":
        arity(3);
        return Math.min(Math.max(n(0), n(1)), n(2));
      case "pinMode": {
        arity(2);
        if (!Object.values(pins).includes(n(0))) sketchError(line, "พินนี้ไม่อยู่บนแผงจำลอง");
        if (!Object.values(modes).includes(n(1))) sketchError(line, "ใช้ INPUT, OUTPUT หรือ INPUT_PULLUP");
        pinModes.set(n(0), n(1));
        break;
      }
      case "digitalWrite":
        arity(2);
        if (n(0) !== pins.LED_BUILTIN || pinModes.get(n(0)) !== modes.OUTPUT) sketchError(line, "กำหนด LED_BUILTIN เป็น OUTPUT ด้วย pinMode() ก่อน");
        setOutput("led", n(1) !== 0);
        break;
      case "digitalRead": {
        arity(1);
        const button = buttonPins.get(n(0));
        if (!button) sketchError(line, "digitalRead() รองรับปุ่ม WIO_KEY_A/B/C และ WIO_5S_*");
        if (pinModes.get(n(0)) !== modes.INPUT_PULLUP && pinModes.get(n(0)) !== modes.INPUT) sketchError(line, "กำหนดโหมดของปุ่มด้วย pinMode() ก่อน");
        return inputs.buttons[button] ? 0 : 1;
      }
      case "analogRead":
        arity(1);
        if (n(0) !== pins.WIO_LIGHT) sketchError(line, "analogRead() รองรับ WIO_LIGHT");
        return inputs.light;
      case "analogWrite":
        arity(2);
        if (n(0) !== pins.WIO_BUZZER || pinModes.get(n(0)) !== modes.OUTPUT) sketchError(line, "กำหนด WIO_BUZZER เป็น OUTPUT ด้วย pinMode() ก่อน");
        if (n(1) < 0 || n(1) > 255) sketchError(line, "analogWrite() ใช้ค่าระหว่าง 0 ถึง 255");
        setOutput("buzzer", n(1) > 0);
        break;
      case "Serial.begin":
        arity(1);
        n(0);
        break;
      case "Serial.print":
      case "Serial.println":
        if (name === "Serial.print" || args.length !== 0) arity(1);
        board.serial = (board.serial + printable(args[0]) + (name === "Serial.println" ? "\n" : "")).slice(-4096);
        revision++;
        break;
      case "tft.begin":
      case "tft.init":
        arity(0);
        lcd.begun = true;
        board.width = 240;
        board.height = 320;
        revision++;
        break;
      case "tft.setRotation":
        arity(1);
        if (n(0) < 0 || n(0) > 3) sketchError(line, "มุมจอใช้ค่า 0 ถึง 3");
        board.width = n(0) % 2 ? 320 : 240;
        board.height = n(0) % 2 ? 240 : 320;
        board.draws = [];
        revision++;
        break;
      case "tft.fillScreen":
        arity(1);
        board.background = n(0) & 0xffff;
        board.draws = [];
        revision++;
        break;
      case "tft.fillRect":
        arity(5);
        fillRectangle(n(0), n(1), n(2), n(3), n(4) & 0xffff);
        break;
      case "tft.drawPixel":
        arity(3);
        fillRectangle(n(0), n(1), 1, 1, n(2) & 0xffff);
        break;
      case "tft.drawLine":
        arity(5);
        drawLine(n(0), n(1), n(2), n(3), n(4) & 0xffff);
        break;
      case "tft.drawRect": {
        arity(5);
        const x = n(0), y = n(1), width = n(2), height = n(3), color = n(4) & 0xffff;
        if (width <= 0 || height <= 0) break;
        fillRectangle(x, y, width, 1, color);
        fillRectangle(x, y + height - 1, width, 1, color);
        fillRectangle(x, y, 1, height, color);
        fillRectangle(x + width - 1, y, 1, height, color);
        break;
      }
      case "tft.drawCircle":
      case "tft.fillCircle":
        arity(4);
        drawCircle(n(0), n(1), n(2), n(3) & 0xffff, name === "tft.fillCircle");
        break;
      case "tft.width":
      case "tft.height":
        arity(0);
        return name === "tft.width" ? board.width : board.height;
      case "tft.color565":
        arity(3);
        return ((n(0) & 0xf8) << 8) | ((n(1) & 0xfc) << 3) | ((n(2) & 0xf8) >> 3);
      case "tft.drawString":
      case "tft.drawNumber": {
        if (args.length !== 3 && (args.length !== 4 || n(3) !== 1)) sketchError(line, `${name} ใช้ข้อความ/ตัวเลข พิกัด x, y และเลือกใช้ฟอนต์ 1 ได้`);
        if (name === "tft.drawString" && typeof args[0] !== "string") sketchError(line, "drawString() ต้องใช้ข้อความ");
        const text = name === "tft.drawNumber" ? String(n(0) | 0) : printable(args[0]);
        const { x, y } = lcd;
        lcd.x = n(1);
        lcd.y = n(2);
        printLcd(text);
        lcd.x = x;
        lcd.y = y;
        return text.length * 6 * lcd.size;
      }
      case "tft.setCursor":
        arity(2);
        lcd.x = n(0);
        lcd.y = n(1);
        break;
      case "tft.setTextSize":
        arity(1);
        if (n(0) < 1 || n(0) > 8) sketchError(line, "ขนาดตัวอักษรบนจอต้องอยู่ระหว่าง 1 ถึง 8");
        lcd.size = n(0);
        break;
      case "tft.setTextColor":
        if (args.length !== 2) arity(1);
        lcd.color = n(0) & 0xffff;
        lcd.textBackground = args.length === 2 ? n(1) & 0xffff : null;
        break;
      case "tft.print":
      case "tft.println":
        if (name === "tft.print" || args.length !== 0) arity(1);
        printLcd(printable(args[0]) + (name === "tft.println" ? "\n" : ""));
        break;
      default:
        sketchError(line, `ตัวจำลองไม่รองรับคำสั่ง ${name}() ดูรายการคำสั่งที่รองรับด้านล่าง`);
    }
    return 0;
  }

  function writable(name: string, line: number, scope: Scope[]) {
    const item = variable(name, scope);
    if (!item || item.constant) sketchError(line, `แก้ไขตัวแปร ${name} ไม่ได้`);
    return item;
  }

  function* runFunction(fn: SketchFunction, args: Value[], line: number): Execution<Value | undefined> {
    if (fn.parameters.length !== args.length) sketchError(line, `${fn.name.text} ต้องมี ${fn.parameters.length} อาร์กิวเมนต์`);
    if (++callDepth > 32) sketchError(line, "เรียกฟังก์ชันซ้อนกันเกินขีดจำกัด");
    const locals: Scope = new Map(fn.parameters.map(({ token, type, constant }, index) => [
      token.text, { type, constant, value: convert(args[index], type, line) },
    ]));
    try {
      const scope = [globals, locals];
      const flow = fn.body.kind === "block" ? yield* executeAll(fn.body.body, scope) : yield* execute(fn.body, scope);
      if (fn.type === "void") return;
      if (!flow || typeof flow === "string" || flow.value === undefined) sketchError(fn.name.line, `ฟังก์ชัน ${fn.name.text} ต้องคืนค่า`);
      return convert(flow.value, fn.type, flow.line);
    } finally {
      callDepth--;
    }
  }

  function* evaluate(expr: Expression, scope: Scope[], allowVoid = false): Execution<Value> {
    if ("token" in expr) step(expr.token.line);
    switch (expr.kind) {
      case "value": return expr.value;
      case "name": {
        const value = variable(expr.token.text, scope)?.value ?? constants.get(expr.token.text);
        if (value === undefined) sketchError(expr.token.line, `ไม่รู้จัก ${expr.token.text}`);
        return value;
      }
      case "call": {
        const { text, line } = expr.token;
        const args: Value[] = [];
        for (const arg of expr.args) args.push(yield* evaluate(arg, scope));
        if (text === "delay") {
          if (!allowVoid || args.length !== 1) sketchError(line, "เรียก delay() เป็นคำสั่งพร้อมเวลา 1 ค่า");
          const ms = integer(args[0], line);
          if (ms < 0) sketchError(line, "delay() ห้ามติดลบ");
          if (ms) yield ms;
          return 0;
        }
        const fn = program.functions.get(text);
        if (!fn) return call(text, args, line);
        if (fn.type === "void" && !allowVoid) sketchError(line, `${text}() เป็นฟังก์ชัน void และไม่มีค่าคืน`);
        return (yield* runFunction(fn, args, line)) ?? 0;
      }
      case "unary": {
        const value = yield* evaluate(expr.operand, scope);
        const line = expr.token.line;
        if (expr.token.text === "!") return Number(!isTrue(value, line));
        if (expr.token.text === "+") { integer(value, line); return value; }
        return binaryOperation("-", 0, value, line);
      }
      case "binary": {
        const { text, line } = expr.token;
        const left = yield* evaluate(expr.left, scope);
        if (text === "&&" && !isTrue(left, line)) return 0;
        if (text === "||" && isTrue(left, line)) return 1;
        return binaryOperation(text, left, yield* evaluate(expr.right, scope), line);
      }
      case "assign": {
        const { line, text } = expr.token;
        const item = writable(expr.target.text, line, scope);
        const right = yield* evaluate(expr.value, scope);
        item.value = convert(text === "=" ? right : binaryOperation(text[0], item.value, right, line), item.type, line);
        return item.value;
      }
      case "increment": {
        const { text, line } = expr.token;
        const item = writable(expr.target.text, line, scope);
        if (item.type === "bool") sketchError(line, "ใช้ ++ หรือ -- กับ bool ไม่ได้");
        const previous = item.value;
        item.value = convert(binaryOperation(text[0], previous, 1, line), item.type, line);
        return expr.post ? previous : item.value;
      }
    }
  }

  function* executeAll(statements: Statement[], scope: Scope[]): Execution<Flow> {
    for (const statement of statements) {
      const flow = yield* execute(statement, scope);
      if (flow) return flow;
    }
  }

  function* execute(stmt: Statement, scope: Scope[]): Execution<Flow> {
    switch (stmt.kind) {
      case "declare": {
        const { text, line } = stmt.token;
        const currentScope = scope[scope.length - 1];
        if (constants.has(text) || currentScope.has(text)) sketchError(line, `ตัวแปร ${text} ถูกประกาศแล้ว`);
        const value = convert(yield* evaluate(stmt.value, scope), stmt.type, line);
        currentScope.set(text, { value, type: stmt.type, constant: stmt.constant });
        break;
      }
      case "expression": yield* evaluate(stmt.expression, scope, true); break;
      case "block": return yield* executeAll(stmt.body, [...scope, new Map()]);
      case "if": {
        const condition = yield* evaluate(stmt.condition, scope);
        const branch = isTrue(condition, "token" in stmt.condition ? stmt.condition.token.line : 1) ? stmt.yes : stmt.no;
        if (branch) return yield* execute(branch, [...scope, new Map()]);
        break;
      }
      case "loop": {
        const inside = [...scope, new Map()];
        if (stmt.initial) yield* execute(stmt.initial, inside);
        while (!stmt.condition || isTrue(yield* evaluate(stmt.condition, inside), stmt.line)) {
          step(stmt.line);
          const flow = yield* execute(stmt.body, [...inside, new Map()]);
          if (flow === "break") break;
          if (flow && flow !== "continue") return flow;
          if (stmt.update) yield* evaluate(stmt.update, inside, true);
        }
        break;
      }
      case "return": return { line: stmt.line, value: stmt.value ? yield* evaluate(stmt.value, scope) : undefined };
      case "break":
      case "continue": return stmt.kind;
    }
  }

  function* run() {
    yield* executeAll(program.globals, [globals]);
    const setup = program.functions.get("setup")!;
    const loop = program.functions.get("loop")!;
    yield* runFunction(setup, [], setup.name.line);
    while (true) {
      const started = now;
      yield* runFunction(loop, [], loop.name.line);
      if (now === started) yield 1;
    }
  }
  const runtime = run();
  return {
    advance(milliseconds: number, nextInputs = inputs) {
      inputs = nextInputs;
      const target = now + milliseconds;
      steps = 0;
      while (wake <= target) {
        now = wake;
        const next = runtime.next();
        if (next.done) break;
        wake += next.value;
      }
      now = target;
    },
    snapshot: () => board,
    revision: () => revision,
    transitions,
    buzzerTransitions,
  };
}

type Shape = Exclude<Draw, Glyph>;

function covers(shape: Shape, x: number, y: number) {
  if (shape.kind === "rect") return x >= shape.x && x < shape.x + shape.width && y >= shape.y && y < shape.y + shape.height;
  if (shape.kind === "circle") {
    const distance = Math.hypot(x - shape.x, y - shape.y);
    return shape.filled ? distance <= shape.radius : Math.abs(distance - shape.radius) <= 0.5;
  }
  const dx = shape.x2 - shape.x, dy = shape.y2 - shape.y;
  const t = ((x - shape.x) * dx + (y - shape.y) * dy) / (dx * dx + dy * dy);
  return t >= 0 && t <= 1 && Math.hypot(x - shape.x - t * dx, y - shape.y - t * dy) <= 0.5;
}

function lcdShowsMessage(board: BoardSnapshot, text: string, completeLine = false) {
  const glyphs = new Map<string, { glyph: Glyph; index: number }>();
  const shapes: { shape: Shape; index: number }[] = [];
  for (const [index, item] of board.draws.entries()) {
    if (item.kind === "glyph") glyphs.set(`${item.x},${item.y},${item.size}`, { glyph: item, index });
    else shapes.push({ shape: item, index });
  }
  shapes.reverse();
  return [...glyphs.values()].some(({ glyph: { x, y, size, char } }) => {
    if (char !== text[0]) return false;
    const last = glyphs.get(`${x + text.length * 6 * size},${y},${size}`);
    if (completeLine && last?.glyph.char.trim()) return false;
    return [...text].every((letter, offset) => {
      const cell = glyphs.get(`${x + offset * 6 * size},${y},${size}`);
      if (cell?.glyph.char !== letter) return false;
      const backdrop = shapes.find(({ shape }) => covers(shape, cell.glyph.x + 3 * size, y + 4 * size));
      return (!backdrop || backdrop.index < cell.index) && cell.glyph.color !== (backdrop?.shape.color ?? board.background);
    });
  });
}

function lcdShowsLightBar(board: BoardSnapshot, reading: number) {
  const width = Math.floor(reading * 200 / 1023);
  const shapes = board.draws.filter((item): item is Shape => item.kind !== "glyph").reverse();
  for (let offset = 0; offset <= 200; offset++) {
    for (const y of [56, 71]) {
      const shape = shapes.find((shape) => covers(shape, 24 + offset, y));
      if (((shape?.color ?? board.background) === colors.TFT_GREEN) !== (offset < width)) return false;
    }
  }
  return true;
}

export function checkSketch(lab: WioLabId, source: string) {
  const board = createBoard(source);
  function settle(input: BoardInput, milliseconds: number) {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 25) board.advance(25, input);
  }
  function press(button: BoardButton, held = 250) {
    settle(defaultBoardInput, 100);
    settle({ light: 512, buttons: { [button]: true } }, held);
    return board.snapshot();
  }

  switch (lab) {
    case "blink": {
      for (let elapsed = 0; elapsed < 2600; elapsed += 25) board.advance(25);
      const edges = board.transitions;
      const passed = edges.length >= 5 && edges.every((edge, index) => index === 0 || edge.at - edges[index - 1].at === 500);
      return { passed, message: passed ? "LED สลับติดและดับทุก 500 มิลลิวินาที" : "LED ต้องสลับติดและดับทุก 500 มิลลิวินาที" };
    }
    case "buttons": {
      board.advance(100);
      const startsOff = !board.snapshot().led;
      board.advance(200, { light: 512, buttons: { A: true } });
      const on = board.snapshot().led;
      board.advance(200, defaultBoardInput);
      const staysOn = board.snapshot().led;
      board.advance(200, { light: 512, buttons: { B: true } });
      const off = !board.snapshot().led;
      return { passed: startsOff && on && staysOn && off, message: "ตรวจว่ากด A แล้วไฟติด ปล่อยแล้วไฟยังติด และกด B แล้วไฟดับ" };
    }
    case "lcd": {
      for (let elapsed = 0; elapsed < 500; elapsed += 25) board.advance(25);
      const passed = lcdShowsMessage(board.snapshot(), "Hello Wio");
      return { passed, message: passed ? "จอแสดงข้อความ Hello Wio" : "จอต้องแสดงข้อความ Hello Wio ให้ครบและใช้สีที่มองเห็นได้" };
    }
    case "light": {
      function sample(light: number) {
        for (let elapsed = 0; elapsed < 500; elapsed += 25) board.advance(25, { buttons: {}, light });
        return board.snapshot().led;
      }
      const levels = [900, 299, 300, 0, 301];
      const passed = levels.map(sample).every((on, index) => on === (levels[index] < 300));
      return { passed, message: passed ? "LED ติดเมื่อค่าแสงต่ำกว่า 300 และดับตั้งแต่ 300 ขึ้นไป" : "ลองที่ 299 และ 300: LED ควรติดเฉพาะเมื่อค่าแสงต่ำกว่า 300" };
    }
    case "counter": {
      settle(defaultBoardInput, 250);
      const shows = (count: number) => lcdShowsMessage(board.snapshot(), `Count: ${count}`, true);
      const sequence = [["B", 0], ["A", 1], ["A", 2], ["B", 1], ["C", 0]] as const;
      const passed = shows(0) && sequence.every(([button, count]) => {
        press(button);
        const held = shows(count);
        settle(defaultBoardInput, 100);
        return held && shows(count);
      });
      return { passed, message: "จอควรแสดงจำนวน กด A เพิ่ม B ลดได้ถึง 0 และ C รีเซ็ต กดค้างให้นับครั้งเดียว" };
    }
    case "light-meter": {
      const passed = [0, 1023, 512, 200, 0].every((light) => {
        settle({ light, buttons: {} }, 500);
        return lcdShowsMessage(board.snapshot(), `Light: ${light}`, true) && lcdShowsLightBar(board.snapshot(), light);
      });
      return { passed, message: "จอควรแสดงค่าแสงและแถบที่ยาวขึ้นหรือสั้นลงตามค่าแสง" };
    }
    case "switch-menu": {
      settle(defaultBoardInput, 250);
      const sequence = [
        ["up", "Menu: Buzzer"], ["down", "Menu: LED"], ["down", "Menu: Light"],
        ["right", "Selected: Light"], ["left", "Menu: Light"],
        ["down", "Menu: Buzzer"], ["center", "Selected: Buzzer"], ["left", "Menu: Buzzer"],
      ] as const;
      const passed = lcdShowsMessage(board.snapshot(), "Menu: LED", true) && sequence.every(([button, message]) => {
        const first = lcdShowsMessage(press(button, 125), message, true);
        settle({ light: 512, buttons: { [button]: true } }, 300);
        return first && lcdShowsMessage(board.snapshot(), message, true);
      });
      return { passed, message: "ขึ้น/ลงควรวนเมนู ขวา/ตรงกลางเลือก และซ้ายกลับไปที่รายการเดิม" };
    }
    case "buzzer": {
      settle(defaultBoardInput, 250);
      const startsSilent = board.buzzerTransitions.length === 0;
      press("A", 650);
      const oneBeep = board.buzzerTransitions.length === 2;
      press("A", 650);
      const edges = board.buzzerTransitions;
      const passed = startsSilent && oneBeep && edges.length === 4
        && edges.every((edge, index) => (index % 2 === 0 ? edge.on : !edge.on && edge.at - edges[index - 1].at === 200))
        && !board.snapshot().buzzer;
      return { passed, message: "กด A แต่ละครั้งควรมีเสียง 200 มิลลิวินาทีเพียงครั้งเดียว" };
    }
  }
}
