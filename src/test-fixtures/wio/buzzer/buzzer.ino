bool wasA = false;

void setup() {
  pinMode(WIO_KEY_A, INPUT_PULLUP);
  pinMode(WIO_BUZZER, OUTPUT);
}

void loop() {
  bool a = digitalRead(WIO_KEY_A) == LOW;
  if (a && !wasA) {
    analogWrite(WIO_BUZZER, 128);
    delay(200);
    analogWrite(WIO_BUZZER, 0);
  }
  wasA = a;
  delay(25);
}
