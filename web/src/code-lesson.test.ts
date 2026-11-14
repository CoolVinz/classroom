import { expect, test } from "bun:test";
import { createCodeLessonDocument, imageDataUrl, lessonCodePolicy, lessonImageIds } from "./code-lesson";

test("the source document applies its policy before lesson markup and appends optional CSS and JavaScript", () => {
  const lesson = "<html><body><h1>Lesson</h1></body></html>";
  const document = createCodeLessonDocument(lesson, "body{color:#123}", "window.lessonReady = true;");
  expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf(lesson));
  expect(document.indexOf(lesson)).toBeLessThan(document.indexOf("<style>body{color:#123}</style>"));
  expect(document.endsWith("<script>window.lessonReady = true;</script>")).toBe(true);
  expect(createCodeLessonDocument("", "a{content:'</style>'}")).toContain("<\\/style>");
  expect(createCodeLessonDocument("", "", "const end = '</script>';")).toContain("<\\/script>");
  expect(lessonCodePolicy).toContain("connect-src https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com");
  expect(lessonCodePolicy).not.toContain("'unsafe-eval'");
  expect(lessonCodePolicy).not.toContain("https://classroom.example");
  expect(lessonCodePolicy).toContain("img-src data:");
});

test("uploaded preview images use data URLs that work in an opaque sandbox", async () => {
  expect(await imageDataUrl(new Blob(["png"], { type: "image/png" }))).toBe("data:image/png;base64,cG5n");
});

test("uploaded image markers resolve to unique UUIDs", () => {
  const first = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const second = "a3bb189e-8bf9-3888-9912-ace4e6543002";
  expect(lessonImageIds(`<img src="lesson-image://${first}">`, `url(lesson-image://${first}) lesson-image://${second}`)).toEqual([first, second]);
  expect(lessonImageIds("lesson-image://not-a-uuid")).toEqual([]);
});
