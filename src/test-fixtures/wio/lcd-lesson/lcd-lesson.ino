#include <TFT_eSPI.h>

TFT_eSPI display = TFT_eSPI();

void setup() {
  pinMode(WIO_LIGHT, INPUT);
  display.init();
  display.setRotation(3);
  display.fillScreen(TFT_BLACK);
  display.setTextColor(TFT_WHITE, TFT_BLACK);
  display.drawString("Light:", 12, 12);
  display.drawPixel(3, 4, TFT_YELLOW);
  display.drawLine(12, 36, display.width() - 12, 36, TFT_WHITE);
  display.drawRect(12, 47, 202, 13, TFT_WHITE);
  display.drawCircle(262, 53, 10, TFT_CYAN);
  display.fillCircle(262, 53, 4, TFT_CYAN);
}

void loop() {
  int value = analogRead(WIO_LIGHT);
  int width = meterWidth(value);
  display.fillRect(55, 12, 40, 8, TFT_BLACK);
  display.drawNumber(value, 55, 12);
  display.fillRect(13, 48, 200, 11, TFT_BLACK);
  display.fillRect(13, 48, width, 11, display.color565(0, 255, 0));
  delay(50);
}

int meterWidth(int value) {
  return constrain(map(value, 0, 1023, 0, 200), 0, 200);
}
