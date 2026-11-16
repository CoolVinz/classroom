export function galleryTicketRequest(classroomId: string) {
  return { path: `/classrooms/${classroomId}/gallery/ticket`, options: { method: "POST" } };
}

export function galleryFileUrl(classroomId: string, fileId: string, kind: "content" | "thumbnail" | "material") {
  return `/api/classrooms/${classroomId}/gallery/files/${fileId}/${kind}`;
}
