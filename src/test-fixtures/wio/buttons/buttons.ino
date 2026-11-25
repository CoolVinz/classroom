void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(WIO_KEY_A, INPUT_PULLUP);
  pinMode(WIO_KEY_B, INPUT_PULLUP);
  pinMode(WIO_KEY_C, INPUT_PULLUP);
}

void loop() {
  if (digitalRead(WIO_KEY_A) == LOW) {
    digitalWrite(LED_BUILTIN, HIGH);
  }
  if (digitalRead(WIO_KEY_B) == LOW) {
    digitalWrite(LED_BUILTIN, LOW);
  }
}
