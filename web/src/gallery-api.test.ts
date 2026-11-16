import { expect, test } from "bun:test";
import { galleryFileUrl, galleryTicketRequest } from "./gallery-api";

test("gallery ticket uses the authenticated POST route", () => {
  expect(galleryTicketRequest("class-1")).toEqual({
    path: "/classrooms/class-1/gallery/ticket",
    options: { method: "POST" },
  });
});

test("gallery content and thumbnails use app API URLs", () => {
  expect(galleryFileUrl("class-1", "file-1", "content")).toBe("/api/classrooms/class-1/gallery/files/file-1/content");
  expect(galleryFileUrl("class-1", "file-1", "thumbnail")).toBe("/api/classrooms/class-1/gallery/files/file-1/thumbnail");
  expect(galleryFileUrl("class-1", "file-1", "material")).toBe("/api/classrooms/class-1/gallery/files/file-1/material");
});
