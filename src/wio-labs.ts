export const wioLabIds = ["blink", "buttons", "lcd", "light"] as const;
export type WioLabId = typeof wioLabIds[number];
export const wioSketchMaxBytes = 16 * 1024;
export const wioSketchMediaType = "text/plain; charset=utf-8";

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
};
