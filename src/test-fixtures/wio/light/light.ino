void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(WIO_LIGHT, INPUT);
  Serial.begin(115200);
}

void loop() {
  int brightness = analogRead(WIO_LIGHT);
  digitalWrite(LED_BUILTIN, brightness < 300);
  Serial.println(brightness);
  delay(50);
}
