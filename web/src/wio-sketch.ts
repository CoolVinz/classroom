import { wioSketchMaxBytes } from "../../src/wio-labs";

export type Value = number | string;
type Token = { text: string; line: number };
type Expression =
  | { kind: "value"; value: Value }
  | { kind: "name"; token: Token }
  | { kind: "call"; token: Token; args: Expression[] }
  | { kind: "unary"; token: Token; operand: Expression }
  | { kind: "binary"; token: Token; left: Expression; right: Expression };
type Statement =
  | { kind: "declare"; token: Token; type: "int" | "bool"; constant: boolean; value: Expression }
  | { kind: "assign"; token: Token; value: Expression }
  | { kind: "call"; expression: Extract<Expression, { kind: "call" }> }
  | { kind: "if"; condition: Expression; yes: Statement; no?: Statement }
  | { kind: "while"; condition: Expression; body: Statement; line: number }
  | { kind: "block"; body: Statement[] };
export type Sketch = { globals: Statement[]; tft: boolean; setup: Statement; loop: Statement };

export function sketchError(line: number, message: string): never {
  throw new Error(`บรรทัด ${line} · ${message}`);
}

function tokenize(source: string) {
  if (new TextEncoder().encode(source).length > wioSketchMaxBytes) throw new Error("โค้ดต้องมีขนาดไม่เกิน 16 KiB");
  source = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const pattern = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:[^"\\\n]|\\[^\n])*"|0[xX][0-9a-fA-F]+|\d+|[A-Za-z_]\w*|==|!=|<=|>=|&&|\|\||[{}();,.=+*/%<>!-]/y;
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

export function parseSketch(source: string): Sketch {
  const tokens = tokenize(source);
  let index = 0;
  let depth = 0;
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
    if (!/^[A-Za-z_]\w*$/.test(token.text)) sketchError(token.line, "ต้องระบุชื่อตัวแปรหรือคำสั่ง");
    return token;
  }
  function nested<T>(parse: () => T) {
    if (++depth > 32) sketchError(peek().line, "โค้ดซ้อนกันลึกเกินขีดจำกัด");
    const result = parse();
    depth--;
    return result;
  }
  function call(token: Token): Extract<Expression, { kind: "call" }> {
    const args: Expression[] = [];
    take("(");
    if (peek().text !== ")") {
      do { args.push(nested(() => expression())); } while (match(","));
    }
    take(")");
    return { kind: "call", token, args };
  }
  function commandName(): Token {
    const token = name();
    return match(".") ? { ...token, text: token.text + "." + name().text } : token;
  }
  function primary(): Expression {
    const token = peek();
    if (match("(")) {
      const result = nested(() => expression());
      take(")");
      return result;
    }
    if (match("!") || match("-") || match("+")) return { kind: "unary", token, operand: nested(primary) };
    if (match("true") || match("false")) return { kind: "value", value: Number(token.text === "true") };
    if (/^\d/.test(token.text)) {
      const value = Number(take().text);
      if (value > 0xffffffff) sketchError(token.line, "จำนวนเต็มเกิน 32 บิต");
      return { kind: "value", value: value | 0 };
    }
    if (token.text.startsWith('"')) {
      take();
      try { return { kind: "value", value: JSON.parse(token.text) as string }; }
      catch { sketchError(token.line, "ข้อความในเครื่องหมายคำพูดไม่ถูกต้อง"); }
    }
    const identifier = commandName();
    return peek().text === "(" ? call(identifier) : { kind: "name", token: identifier };
  }
  function expression(level = 0): Expression {
    if (level === precedence.length) return primary();
    let left = expression(level + 1);
    let count = 0;
    while (precedence[level].includes(peek().text)) {
      const token = take();
      if (++count > 32) sketchError(token.line, "นิพจน์ซับซ้อนเกินขีดจำกัด");
      left = { kind: "binary", token, left, right: expression(level + 1) };
    }
    return left;
  }
  function declaration(): Statement {
    const constant = match("const");
    const type = take();
    if (type.text !== "int" && type.text !== "bool") sketchError(type.line, "รองรับตัวแปร int และ bool");
    const token = name();
    const value = match("=") ? expression() : { kind: "value", value: 0 } as const;
    take(";");
    return { kind: "declare", token, type: type.text, constant, value };
  }
  function block(): Statement {
    take("{");
    const body: Statement[] = [];
    while (peek().text !== "}") body.push(statement());
    take("}");
    return { kind: "block", body };
  }
  function statement(): Statement {
    return nested(() => {
      const first = peek();
      if (first.text === "{") return block();
      if (match("if") || match("while")) {
        take("(");
        const condition = expression();
        take(")");
        const body = statement();
        if (first.text === "while") return { kind: "while", condition, body, line: first.line };
        return { kind: "if", condition, yes: body, no: match("else") ? statement() : undefined };
      }
      if (["int", "bool", "const"].includes(first.text)) return declaration();
      const token = commandName();
      const result: Statement = match("=") ? { kind: "assign", token, value: expression() } : { kind: "call", expression: call(token) };
      take(";");
      return result;
    });
  }

  const globals: Statement[] = [];
  let setup: Statement | undefined;
  let loop: Statement | undefined;
  let include = false;
  let tft = false;
  while (peek().text) {
    const token = peek();
    if (/^#\s*include\s*(?:<TFT_eSPI\.h>|"TFT_eSPI\.h")\s*(?:\/\/.*)?$/.test(token.text)) {
      take();
      include = true;
    } else if (match("TFT_eSPI")) {
      take("tft");
      take(";");
      if (tft || !include) sketchError(token.line, "ประกาศ TFT_eSPI tft; หลัง #include <TFT_eSPI.h>");
      tft = true;
    } else if (match("void")) {
      const fn = name();
      if ((fn.text === "setup" && setup) || (fn.text === "loop" && loop)) sketchError(fn.line, `ประกาศ ${fn.text}() ซ้ำ`);
      if (fn.text !== "setup" && fn.text !== "loop") sketchError(fn.line, "รองรับฟังก์ชัน setup() และ loop()");
      take("(");
      take(")");
      const body = block();
      if (fn.text === "setup") setup = body;
      else loop = body;
    } else if (["int", "bool", "const"].includes(token.text)) globals.push(declaration());
    else sketchError(token.line, "รองรับ setup(), loop(), ตัวแปร และ #include <TFT_eSPI.h>");
  }
  if (!setup || !loop) sketchError(peek().line, "ต้องมี void setup() และ void loop()");
  return { globals, setup, loop, tft };
}
