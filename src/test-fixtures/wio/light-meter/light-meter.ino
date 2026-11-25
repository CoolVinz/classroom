#include <TFT_eSPI.h>

TFT_eSPI tft;
int previous = -1;

void setup() {
  pinMode(WIO_LIGHT, INPUT);
  tft.begin();
  tft.setRotation(3);
  tft.setTextSize(2);
}

void loop() {
  int reading = analogRead(WIO_LIGHT);
  if (reading != previous) {
    tft.fillScreen(TFT_BLACK);
    tft.setCursor(24, 24);
    tft.print("Light: ");
    tft.println(reading);
    tft.fillRect(24, 56, reading * 200 / 1023, 16, TFT_GREEN);
    previous = reading;
  }
  delay(50);
}
