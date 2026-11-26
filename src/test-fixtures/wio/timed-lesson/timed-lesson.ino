#include <Arduino.h>

const unsigned long interval = 100UL;
unsigned long previous = 0;
int cycles = 0;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  unsigned long now = millis();
  if (now - previous >= interval) {
    previous = now;
    ++cycles;
    showCycle(cycles);
  }
}

void showCycle(int value) {
  digitalWrite(LED_BUILTIN, value % 2);
  Serial.println(sumOddBelow(value + 1));
}

int sumOddBelow(int limit) {
  int total = 0;
  for (int i = 0; i < limit; i++) {
    if (i % 2 == 0) continue;
    if (i > 5) break;
    total += i;
  }
  return total;
}
