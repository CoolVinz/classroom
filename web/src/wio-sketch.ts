import { wioSketchMaxBytes } from "../../src/wio-labs";

export type Value = number | string | { unsigned: number };
export type ScalarType = "int" | "bool" | "u32" | "u16" | "u8";
type Token = { text: string; line: number };
export type Expression =
  | { kind: "value"; value: Value }
  | { kind: "name"; token: Token }
  | { kind: "call"; token: Token; args: Expression[] }
  | { kind: "unary"; token: Token; operand: Expression }
  | { kind: "binary"; token: Token; left: Expression; right: Expression }
  | { kind: "assign"; token: Token; target: Token; value: Expression }
  | { kind: "increment"; token: Token; target: Token; post: boolean };
export type Statement =
  | { kind: "declare"; token: Token; type: ScalarType; constant: boolean; value: Expression }
  | { kind: "expression"; expression: Expression }
  | { kind: "if"; condition: Expression; yes: Statement; no?: Statement }
  | { kind: "loop"; initial?: Statement; condition?: Expression; update?: Expression; body: Statement; line: number }
  | { kind: "return"; value?: Expression; line: number }
  | { kind: "break" | "continue" }
  | { kind: "block"; body: Statement[] };
type Parameter = { token: Token; type: ScalarType; constant: boolean };
export type SketchFunction = { name: Token; type: ScalarType | "void"; parameters: Parameter[]; body: Statement };
export type Sketch = { globals: Statement[]; tft: string | null; functions: Map<string, SketchFunction> };

export function sketchError(line: number, message: string): never {
  throw new Error(`บรรทัด ${line} · ${message}`);
}

function tokenize(source: string) {
  if (new TextEncoder().encode(source).length > wioSketchMaxBytes) throw new Error("โค้ดต้องมีขนาดไม่เกิน 16 KiB");
  source = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const pattern = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:[^"\\\n]|\\[^\n])*"|(?:0[xX][0-9a-fA-F]+|\d+)(?:[uU][lL]?|[lL][uU]?)?\b|[A-Za-z_]\w*|==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|[{}();,.=+*/%<>!-]/y;
  const tokens: Token[] = [];
  let line = 1;
  while (pattern.lastIndex < source.length) {
    const start = pattern.lastIndex;
    if (source.startsWith("/*", start) && source.indexOf("*/", start + 2) === -1) sketchError(line, "คอมเมนต์ยังไม่ปิด");
    const match = pattern.exec(source);
    if (!match) sketchError(line, "พบอักขระหรือไวยากรณ์ที่ตัวจำลองไม่รองรับ");
    const text = match[0];
    if (!/^\s/.test(text) && !text.startsWith("//") && !text.startsWith("/*")) {
      tokens.push({ text, line });
      if (tokens.length > 4096) sketchError(line, "โค้ดซับซ้อนเกินขีดจำกัดของตัวจำลอง");
    }
    line += text.split("\n").length - 1;
  }
  return [...tokens, { text: "", line }];
}

const precedence = [
  ["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"],
];
const scalarTypes = new Map<string, ScalarType>([
  ["int", "int"], ["long", "int"], ["bool", "bool"],
  ["uint32_t", "u32"], ["uint16_t", "u16"], ["uint8_t", "u8"], ["byte", "u8"],
]);
const reserved = new Set(["if", "else", "for", "while", "return", "break", "continue", "class", "struct", "switch", "case",
  "const", "void", "unsigned", "true", "false", "TFT_eSPI", ...scalarTypes.keys()]);

export function parseSketch(source: string): Sketch {
  const tokens = tokenize(source);
  let index = 0;
  let depth = 0;
  let loopDepth = 0;
  let functionType: SketchFunction["type"] | undefined;
  const peek = () => tokens[index];
  function take(text?: string) {
    const token = peek();
    if (!token.text || (text !== undefined && token.text !== text)) sketchError(token.line, text ? `ต้องมี '${text}'` : "โค้ดจบก่อนกำหนด");
    index++;
    return token;
  }
  function match(text: string) {
    if (peek().text !== text) return false;
    take(text);
    return true;
  }
  function name() {
    const token = take();
    if (!/^[A-Za-z_]\w*$/.test(token.text) || reserved.has(token.text)) sketchError(token.line, `ตัวจำลองใช้ '${token.text}' เป็นชื่อในตำแหน่งนี้ไม่ได้`);
    return token;
  }
  function nested<T>(parse: () => T) {
    if (++depth > 32) sketchError(peek().line, "โค้ดซ้อนกันลึกเกินขีดจำกัด");
    const result = parse();
    depth--;
    return result;
  }
  function args() {
    const values: Expression[] = [];
    take("(");
    if (peek().text !== ")") {
      do { values.push(nested(() => expression())); } while (match(","));
    }
    take(")");
    return values;
  }
  function target(expr: Expression, line: number) {
    if (expr.kind !== "name" || expr.token.text.includes(".")) sketchError(line, "ต้องใช้ชื่อตัวแปรทางซ้ายของคำสั่งนี้");
    return expr.token;
  }
  function primary(): Expression {
    const token = peek();
    if (match("(")) {
      const result = nested(() => expression());
      take(")");
      return result;
    }
    if (match("!") || match("-") || match("+")) return { kind: "unary", token, operand: nested(primary) };
    if (match("++") || match("--")) return { kind: "increment", token, target: name(), post: false };
    if (match("true") || match("false")) return { kind: "value", value: Number(token.text === "true") };
    if (/^\d/.test(token.text)) {
      const raw = take().text;
      const digits = raw.replace(/[uUlL]+$/, "");
      const value = /^0\d/.test(digits) ? (/^[0-7]+$/.test(digits) ? parseInt(digits, 8) : NaN) : Number(digits);
      if (!Number.isInteger(value) || value > 0xffffffff) sketchError(token.line, "ใช้จำนวนเต็ม 32 บิตที่ถูกต้อง");
      const unsigned = /u/i.test(raw) || /^0x/i.test(raw) && value > 0x7fffffff;
      if (!unsigned && value > 0x7fffffff) sketchError(token.line, "จำนวนเต็มนี้เกินขอบเขต int ให้ใช้ U หรือ UL");
      return { kind: "value", value: unsigned ? { unsigned: value } : value };
    }
    if (token.text.startsWith('"')) {
      take();
      try { return { kind: "value", value: JSON.parse(token.text) as string }; }
      catch { sketchError(token.line, "ข้อความในเครื่องหมายคำพูดไม่ถูกต้อง"); }
    }
    const identifier = name();
    if (match(".")) identifier.text += "." + name().text;
    if (peek().text === "(") return { kind: "call", token: identifier, args: args() };
    const op = peek();
    if (match("++") || match("--")) return { kind: "increment", token: op, target: target({ kind: "name", token: identifier }, op.line), post: true };
    return { kind: "name", token: identifier };
  }
  function binary(level = 0): Expression {
    if (level === precedence.length) return primary();
    let left = binary(level + 1);
    let count = 0;
    while (precedence[level].includes(peek().text)) {
      const token = take();
      if (++count > 32) sketchError(token.line, "นิพจน์ซับซ้อนเกินขีดจำกัด");
      left = { kind: "binary", token, left, right: binary(level + 1) };
    }
    return left;
  }
  function expression(): Expression {
    const left = binary();
    const token = peek();
    if (!match("=") && !match("+=") && !match("-=")) return left;
    return { kind: "assign", token, target: target(left, token.line), value: nested(expression) };
  }
  function scalar(): ScalarType {
    const type = take();
    if (type.text === "unsigned") {
      take("long");
      return "u32";
    }
    const result = scalarTypes.get(type.text);
    if (!result) sketchError(type.line, `ไม่รองรับชนิดข้อมูล '${type.text}' ในตัวจำลอง`);
    return result;
  }
  function startsDeclaration() {
    return peek().text === "const" || peek().text === "unsigned" || scalarTypes.has(peek().text);
  }
  function declaration(parameter: Parameter): Statement {
    const value = match("=") ? expression() : { kind: "value", value: 0 } as const;
    return { kind: "declare", ...parameter, value };
  }
  function simpleStatement(): Statement {
    if (!startsDeclaration()) return { kind: "expression", expression: expression() };
    const constant = match("const");
    const type = scalar();
    return declaration({ constant, type, token: name() });
  }
  function block(): Statement {
    take("{");
    const body: Statement[] = [];
    while (peek().text !== "}") body.push(statement());
    take("}");
    return { kind: "block", body };
  }
  function loopBody() {
    loopDepth++;
    const body = statement();
    loopDepth--;
    return body;
  }
  function statement(): Statement {
    return nested(() => {
      const first = peek();
      if (first.text === "{") return block();
      if (match(";")) return { kind: "block", body: [] };
      if (match("if") || match("while")) {
        take("(");
        const condition = expression();
        take(")");
        if (first.text === "while") return { kind: "loop", condition, body: loopBody(), line: first.line };
        const yes = statement();
        return { kind: "if", condition, yes, no: match("else") ? statement() : undefined };
      }
      if (match("for")) {
        take("(");
        const initial = peek().text === ";" ? undefined : simpleStatement();
        take(";");
        const condition = peek().text === ";" ? undefined : expression();
        take(";");
        const update = peek().text === ")" ? undefined : expression();
        take(")");
        return { kind: "loop", initial, condition, update, body: loopBody(), line: first.line };
      }
      if (match("break") || match("continue")) {
        if (!loopDepth) sketchError(first.line, `${first.text} ใช้ได้ในลูปเท่านั้น`);
        take(";");
        return { kind: first.text === "break" ? "break" : "continue" };
      }
      if (match("return")) {
        const value = peek().text === ";" ? undefined : expression();
        if (!!value !== (functionType !== "void")) sketchError(first.line, "ค่า return ต้องตรงกับชนิดของฟังก์ชัน");
        take(";");
        return { kind: "return", value, line: first.line };
      }
      const result = simpleStatement();
      take(";");
      return result;
    });
  }

  const globals: Statement[] = [];
  const functions = new Map<string, SketchFunction>();
  let include = false;
  let tft: string | null = null;
  while (peek().text) {
    const token = peek();
    if (/^#\s*include\s*(?:<TFT_eSPI\.h>|"TFT_eSPI\.h")\s*(?:\/\/.*)?$/.test(token.text)) {
      take();
      include = true;
    } else if (/^#\s*include\s*(?:<Arduino\.h>|"Arduino\.h")\s*(?:\/\/.*)?$/.test(token.text)) {
      take();
    } else if (match("TFT_eSPI")) {
      const object = name();
      if (match("=")) { take("TFT_eSPI"); take("("); take(")"); }
      take(";");
      if (tft || !include) sketchError(token.line, "ประกาศจอ TFT_eSPI หนึ่งตัวหลัง #include <TFT_eSPI.h>");
      tft = object.text;
    } else if (token.text === "void" || startsDeclaration()) {
      const constant = match("const");
      const type = match("void") ? "void" : scalar();
      const identifier = name();
      if (!match("(")) {
        if (type === "void") sketchError(identifier.line, "ตัวแปรใช้ชนิด void ไม่ได้");
        globals.push(declaration({ token: identifier, type, constant }));
        take(";");
        continue;
      }
      if (constant || functions.has(identifier.text)) sketchError(identifier.line, `การประกาศฟังก์ชัน ${identifier.text} ไม่ถูกต้องหรือซ้ำกัน`);
      const parameters: Parameter[] = [];
      const seen = new Set<string>();
      if (!match("void") && peek().text !== ")") {
        do {
          const constant = match("const");
          const paramType = scalar();
          const parameter = name();
          if (seen.has(parameter.text)) sketchError(parameter.line, "ชื่อพารามิเตอร์ซ้ำกัน");
          seen.add(parameter.text);
          parameters.push({ token: parameter, type: paramType, constant });
        } while (match(","));
      }
      take(")");
      if (["setup", "loop"].includes(identifier.text) && (type !== "void" || parameters.length)) sketchError(identifier.line, `${identifier.text} ต้องเป็น void และไม่มีพารามิเตอร์`);
      functionType = type;
      functions.set(identifier.text, { name: identifier, type, parameters, body: block() });
      functionType = undefined;
    } else if (token.text.startsWith("#")) sketchError(token.line, "ตัวจำลองรองรับเฉพาะ #include <Arduino.h> และ #include <TFT_eSPI.h>");
    else sketchError(token.line, `ตัวจำลองไม่รองรับ '${token.text}' ในการประกาศนี้`);
  }
  if (!functions.has("setup") || !functions.has("loop")) sketchError(peek().line, "ต้องมี void setup() และ void loop()");
  return { globals, functions, tft };
}
