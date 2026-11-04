import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileThumbnail } from "./FileThumbnail";

test("loads saved teacher and student previews from the API without using the original", () => {
  const file = { id: "file-1", originalName: "model.stl", kind: "model" as const, mediaType: "model/stl", thumbnailAvailable: true };
  const teacher = renderToStaticMarkup(<FileThumbnail file={file} onPreview={() => {}}/>);
  const student = renderToStaticMarkup(<FileThumbnail file={file} onPreview={() => {}} student/>);
  expect(teacher).toContain('src="/api/files/file-1/thumbnail"');
  expect(student).toContain('src="/api/student/files/file-1/thumbnail"');
  expect(teacher).not.toContain("/content");
  expect(student).not.toContain("/content");
});
