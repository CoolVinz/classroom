import { expect, test } from "bun:test";
import { findImageSource, lessonImageTag } from "./lesson-image-source";

test("image tags escape alt text and use a lesson image reference", () => {
  expect(lessonImageTag("image-id", 'ภาพ "สาธิต" < A & B')).toBe(
    '<img src="lesson-image://image-id" alt="ภาพ &quot;สาธิต&quot; &lt; A &amp; B">',
  );
});

test("replacing an image edits only the src value", () => {
  const html = `<div><IMG class='hero' alt="a > b" SRC = 'old.png' width=120></div>`;
  const caret = html.indexOf("hero");
  const range = findImageSource(html, { start: caret, end: caret });
  expect(range && typeof range !== "string" && html.slice(0, range.start) + "new.png" + html.slice(range.end)).toBe(html.replace("old.png", "new.png"));
  const unquoted = "<img data-src='fake.png' src=real.png>";
  const unquotedRange = findImageSource(unquoted, { start: 0, end: unquoted.length });
  expect(unquotedRange && typeof unquotedRange !== "string" && unquoted.slice(unquotedRange.start, unquotedRange.end)).toBe("real.png");
});

test("replacement declines responsive, ambiguous, and non-markup targets", () => {
  for (const html of ['<picture><img src="old.png"></picture>', '<img srcset="old.png 2x" src="old.png">']) {
    const start = html.indexOf("<img");
    expect(findImageSource(html, { start, end: start })).toBe("responsive");
  }
  for (const html of ['<!-- <img src="old.png"> -->', `<script>const template = '<img src="old.png">'</script>`, '<img src="old.png" src="another.png">', '<span data-src="old.png">']) {
    const start = html.indexOf("old.png");
    expect(findImageSource(html, { start, end: start })).toBeNull();
  }
});
