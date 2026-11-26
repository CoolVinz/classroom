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

Students open the assignment to edit the Arduino starter, run the simulated board, and try the practice check. The board has an LED, three active-low buttons, a 320 × 240 LCD in landscape, a 0–1023 light slider, a five-way switch, a buzzer, and a Serial Monitor. Use touch or focus the five-way switch to use the arrow keys. Press Enter or Space to activate the focused switch button. The buzzer starts muted. **เปิดเสียง** enables a simulated tone, with a visual indicator available throughout the run. The draft is local to that account and assignment in the current browser. Students can download the sketch or submit it even if the practice check fails. Each submission is a new private `.ino` file. Teachers expand the student’s row under **งานและไฟล์ → ตรวจงานและให้คะแนน** and choose **ดูโค้ด** to read a sketch in the browser or **ดาวน์โหลด** to open it in Arduino IDE. Published marks appear in the gradebook.

## Demonstrate a lab

Teachers can open **ทดลองตัวจำลอง** on a Wio assignment under **งานและไฟล์** or in the lesson editor. Paste a sketch and choose **รันโค้ด** to test it or demonstrate it to the class. Each demo draft is local to the teacher's browser and separate from student work.

## Labs inside lessons

Publish a lesson and open **ห้องเรียนที่ได้รับบทเรียน**. In each assigned classroom, create a Wio lab or attach an active Wio assignment from that classroom. The lesson shows the simulator and the student's submitted sketches under the reading content. The assignment and lesson share the same browser draft and marking workflow. When an active lab is linked, use **คัดลอกลิงก์สำหรับนักเรียน** beside the classroom name to share its lesson. Students sign in with their school account. To send students to all work for that classroom, choose **แสดง QR เข้าห้องเรียน** in the classroom header and project the code. When students scan it, Classroom checks their roster membership and selects that classroom on their dashboard.

For an AI-generated lesson, open **สร้างชุดบทเรียนด้วย AI**, select **Lesson + Wio Lab**, and use **Copy AI template**. Paste the AI response through **Import from AI**, review the lesson and lab, and create the private draft. Edit the preset, title, instructions, or maximum score before publishing. **มอบหมายและสร้างงาน Wio** creates a lab in the selected classroom. Pick an existing lab in the classroom row to reuse it when assigning. Arduino examples in lesson text can be copied into **ทดลองตัวจำลอง** for review, then copied by students into their lab editor.

The `classroom-lesson-pack` version 1 JSON uses a `lab` object with `preset` (`blink`, `buttons`, `lcd`, `light`, `counter`, `light-meter`, `switch-menu`, or `buzzer`), `title`, `instructions`, and optional `maxScore` (default 100). Wio packs may also include a quiz and/or worksheet in their existing formats. Pastes can be plain JSON or one JSON code fence, up to 1 MiB.

Archiving an assignment hides its simulator in the lesson until restored. Detaching the lab or unassigning the lesson keeps the classroom assignment, submissions, and grades.

## Supported code

- `setup()`, `loop()`, integer and boolean variables, `unsigned long`, scalar helper parameters and return values, `if/else`, `for`, `while`, `break`, `continue`, and `++`, `--`, `+=`, `-=`.
- `delay()`, `millis()`, `map()`, `constrain()`, LED and button GPIO, `analogRead(WIO_LIGHT)`, `analogWrite(WIO_BUZZER, value)`, and `Serial.begin/print/println`.
- `TFT_eSPI` initialization, text, `drawString`, `drawNumber`, pixel, line, rectangle and circle drawing, `color565`, `width`, and `height`. Named fonts beyond the default and separate Arduino libraries require Arduino IDE.
- The simulator’s **คำสั่งที่รองรับ** panel and AI lesson prompt use the same command list. Unsupported features produce a line-specific diagnostic when running the sketch.

The worker interprets these commands against a virtual board and enforces source and execution limits. It reports supported-syntax and runtime errors by line. Use the Wio Terminal target in Arduino IDE for hardware testing and for Arduino features outside this subset. Reference sketches are in [the test fixtures](../src/test-fixtures/wio/). [Seeed Wio Terminal setup](https://wiki.seeedstudio.com/Wio-Terminal-Getting-Started/), [five-way switch](https://wiki.seeedstudio.com/Wio-Terminal-Switch/), [buzzer](https://wiki.seeedstudio.com/Wio-Terminal-Buzzer/), [LCD graphics](https://wiki.seeedstudio.com/Wio-Terminal-LCD-Graphics/)
