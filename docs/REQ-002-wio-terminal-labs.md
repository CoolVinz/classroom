# REQ-002 — Wio Terminal Labs

Teachers open a classroom, go to **งานและไฟล์ → สร้างงาน**, and select a Wio Terminal preset under **รูปแบบงาน**. The preset fills the title and instructions when those fields are empty. Teachers can edit them and set the maximum score before saving.

| Lab | Practice check |
| --- | --- |
| ไฟ LED กะพริบ | Switches LED on and off every 500 ms |
| ควบคุม LED ด้วยปุ่ม A/B | A switches LED on, release keeps it on, B switches it off |
| แสดงข้อความบนจอ LCD | Shows the complete, visible text `Hello Wio` |
| เซ็นเซอร์แสง | Switches LED on below 300 and off from 300, including the 299/300 boundary |
| ตัวนับบนจอ LCD | A counts up, B counts down to zero, and C resets. Each press counts once. |
| มาตรวัดแสงบนจอ LCD | Shows the sensor value and updates a proportional green bar from 0 to 200 pixels as light changes. |
| เมนูด้วยสวิตช์ห้าทิศทาง | Up and Down cycle the LCD menu. Right or Center selects and Left returns. |
| กดปุ่มให้บัซเซอร์ดัง | A generates a single 200 ms beep per press, including when held. |

Students open the assignment to edit the Arduino starter, run the simulated board, and try the practice check. The board has an LED, three active-low buttons, a 320 × 240 LCD in landscape, a 0–1023 light slider, a five-way switch, a buzzer, and a Serial Monitor. Use touch or focus the five-way switch to use the arrow keys. Press Enter or Space to activate the focused switch button. The buzzer starts muted. **เปิดเสียง** enables a simulated tone, with a visual indicator available throughout the run. The draft is local to that account and assignment in the current browser. Students can download the sketch or submit it even if the practice check fails. Each submission is a new private `.ino` file. Teachers download and grade it from the normal assignment review. Published marks appear in the gradebook.

## Labs inside lessons

Publish a lesson and open **ห้องเรียนที่ได้รับบทเรียน**. In each assigned classroom, create a Wio lab or attach an active Wio assignment from that classroom. The lesson shows the simulator and the student's submitted sketches under the reading content. The assignment and lesson share the same browser draft and marking workflow.

For an AI-generated lesson, open **สร้างชุดบทเรียนด้วย AI**, select **Lesson + Wio Lab**, and use **Copy AI template**. Paste the AI response through **Import from AI**, review the lesson and lab, and create the private draft. Edit the preset, title, instructions, or maximum score before publishing. **มอบหมายและสร้างงาน Wio** creates a lab in the selected classroom. Pick an existing lab in the classroom row to reuse it when assigning.

The `classroom-lesson-pack` version 1 JSON uses a `lab` object with `preset` (`blink`, `buttons`, `lcd`, `light`, `counter`, `light-meter`, `switch-menu`, or `buzzer`), `title`, `instructions`, and optional `maxScore` (default 100). Wio packs may also include a quiz and/or worksheet in their existing formats. Pastes can be plain JSON or one JSON code fence, up to 1 MiB.

Archiving an assignment hides its simulator in the lesson until restored. Detaching the lab or unassigning the lesson keeps the classroom assignment, submissions, and grades.

## Supported code

- `setup()`, `loop()`, `int`, `bool`, `const`, assignment, basic arithmetic/comparison/logical operators, `if/else`, and `while`.
- `pinMode`, `delay`, LED `digitalWrite`, A/B/C and `WIO_5S_*` with active-low `digitalRead`, `analogRead(WIO_LIGHT)`, `analogWrite(WIO_BUZZER, value)` (0–255, with a fixed simulated tone for nonzero values), `Serial.begin/print/println`.
- `#include <TFT_eSPI.h>`, `TFT_eSPI tft;`, and `tft.begin/setRotation/fillScreen/fillRect/setCursor/setTextColor/setTextSize/print/println` with common `TFT_*` colors or 16-bit colors.

The worker interprets these commands against a virtual board and enforces source and execution limits. It reports supported-syntax and runtime errors by line. Use the Wio Terminal target in Arduino IDE for hardware testing and for Arduino features outside this subset. Reference sketches are in [the test fixtures](../src/test-fixtures/wio/). [Seeed Wio Terminal setup](https://wiki.seeedstudio.com/Wio-Terminal-Getting-Started/), [five-way switch](https://wiki.seeedstudio.com/Wio-Terminal-Switch/), [buzzer](https://wiki.seeedstudio.com/Wio-Terminal-Buzzer/), [LCD graphics](https://wiki.seeedstudio.com/Wio-Terminal-LCD-Graphics/)
