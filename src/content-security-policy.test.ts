import { expect, test } from "bun:test";
import { appFramePolicy } from "./content-security-policy";

test("the app frame policy permits Google sign-in and YouTube embeds only", () => {
  expect(appFramePolicy).toContain("frame-src https://accounts.google.com https://www.youtube-nocookie.com");
  expect(appFramePolicy).toContain("https://accounts.google.com");
  expect(appFramePolicy).toContain("https://www.youtube-nocookie.com");
  expect(appFramePolicy).toContain("object-src 'none'");
  expect(appFramePolicy).not.toContain("'self'");
  expect(appFramePolicy).not.toContain("blob:");
});
