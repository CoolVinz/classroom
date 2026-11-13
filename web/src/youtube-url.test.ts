import { expect, test } from "bun:test";
import { youtubeVideoId } from "./youtube-url";

test("accepts standard YouTube video, share, and shorts links", () => {
  expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12")).toBe("dQw4w9WgXcQ");
  expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=share")).toBe("dQw4w9WgXcQ");
  expect(youtubeVideoId("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

test("rejects unrelated hosts and invalid video IDs", () => {
  expect(youtubeVideoId("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  expect(youtubeVideoId("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toBeNull();
  expect(youtubeVideoId("https://youtu.be/short")).toBeNull();
});
