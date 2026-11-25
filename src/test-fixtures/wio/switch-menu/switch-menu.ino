#include <TFT_eSPI.h>

TFT_eSPI tft;
int option = 0;
int previousOption = -1;
bool selected = false;
bool previousSelected = false;
bool wasUp = false;
bool wasDown = false;
bool wasConfirm = false;
bool wasLeft = false;

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
  bool up = digitalRead(WIO_5S_UP) == LOW;
  bool down = digitalRead(WIO_5S_DOWN) == LOW;
  bool confirm = digitalRead(WIO_5S_RIGHT) == LOW || digitalRead(WIO_5S_PRESS) == LOW;
  bool left = digitalRead(WIO_5S_LEFT) == LOW;

  if (selected) {
    if (left && !wasLeft) selected = false;
  } else {
    if (up && !wasUp) option = (option + 2) % 3;
    if (down && !wasDown) option = (option + 1) % 3;
    if (confirm && !wasConfirm) selected = true;
  }
  wasUp = up;
  wasDown = down;
  wasConfirm = confirm;
  wasLeft = left;

  if (option != previousOption || selected != previousSelected) {
    tft.fillScreen(TFT_BLACK);
    tft.setCursor(24, 24);
    if (selected) tft.print("Selected: ");
    else tft.print("Menu: ");
    if (option == 0) tft.println("LED");
    if (option == 1) tft.println("Light");
    if (option == 2) tft.println("Buzzer");
    previousOption = option;
    previousSelected = selected;
  }
  delay(25);
}
