# REQ-002 — Wio Terminal Labs

Teachers open a classroom, go to **งานและไฟล์ → สร้างงาน**, and select a Wio Terminal preset under **รูปแบบงาน**. The preset fills the title and instructions when those fields are empty. Teachers can edit them and set the maximum score before saving.

| Lab | Practice check |
| --- | --- |
| ไฟ LED กะพริบ | Switches LED on and off every 500 ms |
| ควบคุม LED ด้วยปุ่ม A/B | A switches LED on, release keeps it on, B switches it off |
| แสดงข้อความบนจอ LCD | Shows the complete, visible text `Hello Wio` |
| เซ็นเซอร์แสง | Switches LED on below 300 and off from 300, including the 299/300 boundary |

Students open the assignment to edit the Arduino starter, run the simulated board, and try the practice check. The board has an LED, three active-low buttons, a 320 × 240 LCD in landscape, a 0–1023 light slider, and a Serial Monitor. The draft is local to that account and assignment in the current browser. Students can download the sketch or submit it even if the practice check fails. Each submission is a new private `.ino` file. Teachers download and grade it from the normal assignment review. Published marks appear in the gradebook.

## Supported code

- `setup()`, `loop()`, `int`, `bool`, `const`, assignment, basic arithmetic/comparison/logical operators, `if/else`, and `while`.
- `pinMode`, `delay`, LED `digitalWrite`, A/B/C `digitalRead`, `analogRead(WIO_LIGHT)`, `Serial.begin/print/println`.
- `#include <TFT_eSPI.h>`, `TFT_eSPI tft;`, and `tft.begin/setRotation/fillScreen/setCursor/setTextColor/setTextSize/print/println` with common `TFT_*` colors or 16-bit colors.

The worker interprets these commands against a virtual board and enforces source and execution limits. It reports supported-syntax and runtime errors by line. Use the Wio Terminal target in Arduino IDE for hardware testing and for Arduino features outside this subset. Reference sketches are in [the test fixtures](../src/test-fixtures/wio/). [Seeed Wio Terminal setup](https://wiki.seeedstudio.com/Wio-Terminal-Getting-Started/)
