export const wioLabIds = ["blink", "buttons", "lcd", "light", "counter", "light-meter", "switch-menu", "buzzer"] as const;
export type WioLabId = typeof wioLabIds[number];
export type WioLabSettings = { preset: WioLabId; title: string; instructions: string; maxScore: number };
export const wioMaxScore = 9_999_999_999.99;

export function isWioLabId(value: unknown): value is WioLabId {
  return wioLabIds.some((id) => id === value);
}

export function validWioMaxScore(value: unknown): value is number {
  return typeof value === "number" && value >= 0.01 && value <= wioMaxScore && Math.round(value * 100) / 100 === value;
}

export const wioSketchMaxBytes = 16 * 1024;
export const wioSketchMediaType = "text/plain; charset=utf-8";

export const wioSupportedCode = [
  { label: "โครงสร้าง Arduino", commands: "void setup(), void loop(), ฟังก์ชันช่วยแบบ void หรือคืนค่าจำนวนเต็ม/บูลีนพร้อมพารามิเตอร์, return, int, long, unsigned long, bool, byte, uint8_t, uint16_t, uint32_t, const" },
  { label: "เงื่อนไขและลูป", commands: "if/else, for, while, break, continue, ++, --, +=, -=, +, -, *, /, %, การเปรียบเทียบ, &&, ||, !" },
  { label: "เวลาและข้อมูล", commands: "delay(ms), millis(), map(), constrain(), Serial.begin(), Serial.print(), Serial.println()" },
  { label: "อุปกรณ์บนบอร์ด", commands: "pinMode(), digitalWrite(LED_BUILTIN, value), digitalRead() กับ WIO_KEY_A/B/C และ WIO_5S_*, analogRead(WIO_LIGHT), analogWrite(WIO_BUZZER, value)" },
  { label: "จอ LCD", commands: "#include <TFT_eSPI.h>, TFT_eSPI tft;, begin(), init(), setRotation(), fillScreen(), fillRect(), drawPixel(), drawLine(), drawRect(), drawCircle(), fillCircle(), setCursor(), setTextSize(), setTextColor(), print(), println(), drawString(text, x, y), drawNumber(number, x, y), color565(), width(), height()" },
  { label: "ขอบเขตตัวจำลอง", commands: "ใช้ Arduino.h และ TFT_eSPI.h ได้ รองรับข้อความในเครื่องหมายคำพูด ตัวแปรจำนวนเต็มและบูลีน คลาสที่เขียนเอง อาร์เรย์ float และไลบรารีอื่นต้องเปิดด้วย Arduino IDE" },
] as const;

export const wioLabs: Record<WioLabId, { title: string; instructions: string; starter: string }> = {
  blink: {
    title: "ไฟ LED กะพริบ",
    instructions: "ให้ LED_BUILTIN ติด 500 มิลลิวินาที แล้วดับ 500 มิลลิวินาที วนซ้ำใน loop()",
    starter: `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  // TODO: Turn the LED on and off, waiting 500 ms each time.
  delay(500);
}
`,
  },
  buttons: {
    title: "ควบคุม LED ด้วยปุ่ม A/B",
    instructions: "กด A ให้ LED ติด กด B ให้ LED ดับ และปล่อยปุ่มแล้วให้ LED คงสถานะเดิม ปุ่มที่ตั้งเป็น INPUT_PULLUP จะอ่านค่า LOW เมื่อกด",
    starter: `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(WIO_KEY_A, INPUT_PULLUP);
  pinMode(WIO_KEY_B, INPUT_PULLUP);
}

void loop() {
  // TODO: Read both buttons with digitalRead() and update the LED.
}
`,
  },
  lcd: {
    title: "แสดงข้อความบนจอ LCD",
    instructions: "แสดงข้อความ Hello Wio บน LCD ให้มองเห็นได้ครบทั้งข้อความ",
    starter: `#include <TFT_eSPI.h>
TFT_eSPI tft;

void setup() {
  tft.begin();
  tft.setRotation(3);
  tft.fillScreen(TFT_BLACK);
  // TODO: Set the cursor and print Hello Wio.
}

void loop() {
}
`,
  },
  light: {
    title: "เซ็นเซอร์แสง",
    instructions: "อ่าน WIO_LIGHT และให้ LED ติดเฉพาะเมื่อค่าต่ำกว่า 300 ลองปรับแถบแสงที่ 299 และ 300",
    starter: `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(WIO_LIGHT, INPUT);
  Serial.begin(115200);
}

void loop() {
  int brightness = analogRead(WIO_LIGHT);
  // TODO: Compare brightness with 300, then set the LED.
  Serial.println(brightness);
  delay(50);
}
`,
  },
  counter: {
    title: "ตัวนับบนจอ LCD",
    instructions: "เริ่มที่ Count: 0 กด A เพื่อเพิ่ม 1 กด B เพื่อลด 1 (ต่ำสุด 0) และกด C เพื่อรีเซ็ต กดค้างให้นับครั้งเดียว จอแสดง Count: ตามด้วยตัวเลข",
    starter: `#include <TFT_eSPI.h>
TFT_eSPI tft;
int count = 0;
bool wasA = false;
bool wasB = false;
bool wasC = false;

void setup() {
  pinMode(WIO_KEY_A, INPUT_PULLUP);
  pinMode(WIO_KEY_B, INPUT_PULLUP);
  pinMode(WIO_KEY_C, INPUT_PULLUP);
  tft.begin();
  tft.setRotation(3);
  tft.setTextSize(2);
}

void loop() {
  // TODO: Compare each button with its previous state.
  // TODO: Update count and print "Count: " followed by the number.
  delay(25);
}
`,
  },
  "light-meter": {
    title: "มาตรวัดแสงบนจอ LCD",
    instructions: "แสดง Light: ตามด้วยค่าจาก WIO_LIGHT (0–1023) และใช้ tft.fillRect() วาดแถบสีเขียวที่ (24, 56) สูง 16 พิกเซล ความกว้างคือค่าแสง × 200 ÷ 1023 ล้างแถบเดิมเมื่อค่าแสงเปลี่ยน",
    starter: `#include <TFT_eSPI.h>
TFT_eSPI tft;

void setup() {
  pinMode(WIO_LIGHT, INPUT);
  tft.begin();
  tft.setRotation(3);
  tft.setTextSize(2);
}

void loop() {
  int reading = analogRead(WIO_LIGHT);
  // TODO: Clear the screen and print "Light: " followed by reading.
  // TODO: Draw the green bar in proportion to reading.
  delay(50);
}
`,
  },
  "switch-menu": {
    title: "เมนูด้วยสวิตช์ห้าทิศทาง",
    instructions: "เริ่มที่ Menu: LED ใช้ขึ้น/ลงวนระหว่าง LED, Light และ Buzzer กดขวาหรือตรงกลางเพื่อแสดง Selected: ตามด้วยชื่อรายการ กดซ้ายกลับไปที่รายการเดิม กดค้างให้เลื่อนครั้งเดียว",
    starter: `#include <TFT_eSPI.h>
TFT_eSPI tft;
int option = 0;
bool selected = false;

void setup() {
  pinMode(WIO_5S_UP, INPUT_PULLUP);
  pinMode(WIO_5S_DOWN, INPUT_PULLUP);
  pinMode(WIO_5S_LEFT, INPUT_PULLUP);
  pinMode(WIO_5S_RIGHT, INPUT_PULLUP);
  pinMode(WIO_5S_PRESS, INPUT_PULLUP);
  tft.begin();
  tft.setRotation(3);
  tft.setTextSize(2);
}

void loop() {
  // TODO: Track switch presses and update the menu.
  // TODO: Print "Menu: " or "Selected: " followed by the item.
  delay(25);
}
`,
  },
  buzzer: {
    title: "กดปุ่มให้บัซเซอร์ดัง",
    instructions: "กด A ให้ WIO_BUZZER ดัง 200 มิลลิวินาทีด้วย analogWrite(WIO_BUZZER, 128) แล้วปิดด้วยค่า 0 กดค้างให้ดังครั้งเดียว ปล่อยแล้วกดใหม่เพื่อให้ดังอีกครั้ง",
    starter: `bool wasA = false;

void setup() {
  pinMode(WIO_KEY_A, INPUT_PULLUP);
  pinMode(WIO_BUZZER, OUTPUT);
}

void loop() {
  // TODO: Detect a new A press and play one short beep.
  delay(25);
}
`,
  },
};
