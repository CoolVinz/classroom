export function allocateGroups(studentIds: string[], groupCount: number, studentLimit: number | null) {
  const shuffled = [...studentIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const groups = Array.from({ length: groupCount }, () => [] as string[]);
  for (let i = 0; i < shuffled.length; i++) {
    const groupIndex = i % groupCount;
    if (studentLimit !== null && groups[groupIndex]!.length >= studentLimit) continue;
    groups[groupIndex]!.push(shuffled[i]!);
  }
  return { groups, unassigned: shuffled.filter((studentId) => !groups.some((group) => group.includes(studentId))) };
}
