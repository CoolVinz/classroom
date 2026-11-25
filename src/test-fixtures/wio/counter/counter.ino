#include <TFT_eSPI.h>

TFT_eSPI tft;
int count = 0;
int lastCount = -1;
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
  bool a = digitalRead(WIO_KEY_A) == LOW;
  bool b = digitalRead(WIO_KEY_B) == LOW;
  bool c = digitalRead(WIO_KEY_C) == LOW;

  if (a && !wasA) count = count + 1;
  if (b && !wasB && count > 0) count = count - 1;
  if (c && !wasC) count = 0;
  wasA = a;
  wasB = b;
  wasC = c;

  if (count != lastCount) {
    tft.fillScreen(TFT_BLACK);
    tft.setCursor(24, 24);
    tft.print("Count: ");
    tft.println(count);
    lastCount = count;
  }
  delay(25);
}
