import type { WioLabId } from "../../src/wio-labs";
import { parseSketch, sketchError, type Sketch, type Value } from "./wio-sketch";

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
type Draw = Glyph | Rectangle;
export type BoardSnapshot = { led: boolean; buzzer: boolean; serial: string; width: number; height: number; background: number; draws: Draw[] };
export type BoardInput = { buttons: Partial<Record<BoardButton, boolean>>; light: number };
export const defaultBoardInput: BoardInput = { buttons: {}, light: 512 };
export const blankBoard: BoardSnapshot = { led: false, buzzer: false, serial: "", width: 320, height: 240, background: 0, draws: [] };

type Variable = { value: number; type: "int" | "bool"; constant: boolean };
type Scope = Map<string, Variable>;
type Statement = Sketch["setup"];
type Expression = Extract<Statement, { kind: "assign" }>["value"];
const isTrue = (value: Value) => value !== 0;

export function createBoard(source: string) {
  const program = parseSketch(source);
  const board: BoardSnapshot = { ...blankBoard, draws: [] };
  const pinModes = new Map<number, number>();
  const transitions: { at: number; on: boolean }[] = [];
  const buzzerTransitions: typeof transitions = [];
  const globals: Scope = new Map();
  const lcd = { begun: false, x: 0, y: 0, size: 1, color: colors.TFT_WHITE };
  let inputs = defaultBoardInput;
  let now = 0;
  let wake = 0;
  let steps = 0;
  let revision = 0;

  function step(line: number) {
    if (++steps > 20_000) sketchError(line, "โปรแกรมทำงานนานเกินไป ลองเพิ่ม delay() หรือตรวจสอบเงื่อนไขของลูป");
  }
  function variable(name: string, scope: Scope[]) {
    for (let index = scope.length - 1; index >= 0; index--) {
      const item = scope[index].get(name);
      if (item) return item;
    }
  }
  function integer(value: Value | undefined, line: number) {
    if (typeof value !== "number") sketchError(line, "คำสั่งนี้ต้องใช้จำนวนเต็ม");
    return value;
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
  function printLcd(text: string) {
    for (const char of text.slice(0, 1024)) {
      if (char === "\r") continue;
      if (char === "\n" || lcd.x + 6 * lcd.size > board.width) {
        lcd.x = 0;
        lcd.y += 8 * lcd.size;
      }
      if (char === "\n") continue;
      if (lcd.x >= 0 && lcd.y >= 0 && lcd.y + 8 * lcd.size <= board.height) {
        draw({ kind: "glyph", x: lcd.x, y: lcd.y, color: lcd.color, size: lcd.size, char });
      }
      lcd.x += 6 * lcd.size;
    }
  }
  function call(name: string, args: Value[], line: number): Value {
    const n = (index: number) => integer(args[index], line);
    const arity = (count: number) => {
      if (args.length !== count) sketchError(line, `${name} ต้องมี ${count} อาร์กิวเมนต์`);
    };
    if (name.startsWith("tft.")) {
      if (!program.tft) sketchError(line, "ต้องประกาศ TFT_eSPI tft;");
      if (!lcd.begun && name !== "tft.begin") sketchError(line, "ต้องเรียก tft.begin() ก่อนใช้ LCD");
    }
    switch (name) {
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
        board.serial = (board.serial + (args[0] ?? "") + (name === "Serial.println" ? "\n" : "")).slice(-4096);
        revision++;
        break;
      case "tft.begin":
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
        arity(1);
        lcd.color = n(0) & 0xffff;
        break;
      case "tft.print":
      case "tft.println":
        if (name === "tft.print" || args.length !== 0) arity(1);
        printLcd(String(args[0] ?? "") + (name === "tft.println" ? "\n" : ""));
        break;
      default:
        sketchError(line, `ไม่รองรับคำสั่ง ${name}()`);
    }
    return 0;
  }

  function evaluate(expr: Expression, scope: Scope[]): Value {
    if ("token" in expr) step(expr.token.line);
    switch (expr.kind) {
      case "value": return expr.value;
      case "name": {
        const value = variable(expr.token.text, scope)?.value ?? constants.get(expr.token.text);
        if (value === undefined) sketchError(expr.token.line, `ไม่รู้จัก ${expr.token.text}`);
        return value;
      }
      case "call": return call(expr.token.text, expr.args.map((item) => evaluate(item, scope)), expr.token.line);
      case "unary": {
        const value = integer(evaluate(expr.operand, scope), expr.token.line);
        if (expr.token.text === "!") return Number(!value);
        return (expr.token.text === "-" ? -value : value) | 0;
      }
      case "binary": {
        const line = expr.token.line;
        const left = integer(evaluate(expr.left, scope), line);
        if (expr.token.text === "&&" && !left) return 0;
        if (expr.token.text === "||" && left) return 1;
        const right = integer(evaluate(expr.right, scope), line);
        switch (expr.token.text) {
          case "+": return (left + right) | 0;
          case "-": return (left - right) | 0;
          case "*": return Math.imul(left, right);
          case "/":
          case "%":
            if (right === 0) sketchError(line, "หารด้วยศูนย์ไม่ได้");
            return (expr.token.text === "/" ? left / right : left % right) | 0;
          case "==": return Number(left === right);
          case "!=": return Number(left !== right);
          case "<": return Number(left < right);
          case "<=": return Number(left <= right);
          case ">": return Number(left > right);
          case ">=": return Number(left >= right);
          default: return Number(Boolean(right));
        }
      }
    }
  }

  function* execute(stmt: Statement, scope: Scope[]): Generator<number, void, void> {
    switch (stmt.kind) {
      case "declare": {
        const { text, line } = stmt.token;
        const currentScope = scope[scope.length - 1];
        if (constants.has(text) || currentScope.has(text)) sketchError(line, `ตัวแปร ${text} ถูกประกาศแล้ว`);
        const value = integer(evaluate(stmt.value, scope), line);
        currentScope.set(text, { value: stmt.type === "bool" ? Number(Boolean(value)) : value, type: stmt.type, constant: stmt.constant });
        break;
      }
      case "assign": {
        const { text, line } = stmt.token;
        const item = variable(text, scope);
        if (!item || item.constant) sketchError(line, `แก้ไขตัวแปร ${text} ไม่ได้`);
        const value = integer(evaluate(stmt.value, scope), line);
        item.value = item.type === "bool" ? Number(Boolean(value)) : value;
        break;
      }
      case "call": {
        const { token, args } = stmt.expression;
        if (token.text === "delay") {
          if (args.length !== 1) sketchError(token.line, "delay() ต้องมี 1 อาร์กิวเมนต์");
          const ms = integer(evaluate(args[0], scope), token.line);
          if (ms < 0) sketchError(token.line, "delay() ห้ามติดลบ");
          if (ms) yield ms;
        } else evaluate(stmt.expression, scope);
        break;
      }
      case "block": {
        const inner = [...scope, new Map<string, Variable>()];
        for (const item of stmt.body) yield* execute(item, inner);
        break;
      }
      case "if": {
        const branch = isTrue(evaluate(stmt.condition, scope)) ? stmt.yes : stmt.no;
        if (branch) yield* execute(branch, [...scope, new Map()]);
        break;
      }
      case "while":
        while (isTrue(evaluate(stmt.condition, scope))) {
          step(stmt.line);
          yield* execute(stmt.body, [...scope, new Map()]);
        }
        break;
    }
  }

  function* run() {
    for (const declaration of program.globals) yield* execute(declaration, [globals]);
    yield* execute(program.setup, [globals]);
    while (true) {
      const started = now;
      yield* execute(program.loop, [globals]);
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

function covers(rect: Rectangle, x: number, y: number) {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function lcdShowsMessage(board: BoardSnapshot, text: string, completeLine = false) {
  const glyphs = new Map<string, { glyph: Glyph; index: number }>();
  const rectangles: { rect: Rectangle; index: number }[] = [];
  for (const [index, item] of board.draws.entries()) {
    if (item.kind === "glyph") glyphs.set(`${item.x},${item.y},${item.size}`, { glyph: item, index });
    else rectangles.push({ rect: item, index });
  }
  rectangles.reverse();
  return [...glyphs.values()].some(({ glyph: { x, y, size, char } }) => {
    if (char !== text[0]) return false;
    const last = glyphs.get(`${x + text.length * 6 * size},${y},${size}`);
    if (completeLine && last?.glyph.char.trim()) return false;
    return [...text].every((letter, offset) => {
      const cell = glyphs.get(`${x + offset * 6 * size},${y},${size}`);
      if (cell?.glyph.char !== letter) return false;
      const rect = rectangles.find(({ rect }) => covers(rect, cell.glyph.x + 3 * size, y + 4 * size));
      return (!rect || rect.index < cell.index) && cell.glyph.color !== (rect?.rect.color ?? board.background);
    });
  });
}

function lcdShowsLightBar(board: BoardSnapshot, reading: number) {
  const width = Math.floor(reading * 200 / 1023);
  const rectangles = board.draws.filter((item): item is Rectangle => item.kind === "rect").reverse();
  for (let offset = 0; offset <= 200; offset++) {
    for (const y of [56, 71]) {
      const rect = rectangles.find((rect) => covers(rect, 24 + offset, y));
      if (((rect?.color ?? board.background) === colors.TFT_GREEN) !== (offset < width)) return false;
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
