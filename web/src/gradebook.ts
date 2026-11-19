export type GradebookScore = { studentId: string; itemId: string; score: number; maxScore: number };
export type GradebookExportStudent = { studentId: string; studentCode: string | null; studentNumber: number | null; displayName: string };
export type GradebookExportItem = { id: string; name: string; maxScore: number; kind?: "assignment" | "quiz" | "manual" };

export function gradebookTotalForStudent(
  studentId: string,
  scores: GradebookScore[],
  includedItemIds: Set<string>,
) {
  const recorded = scores.filter((score) => score.studentId === studentId && includedItemIds.has(score.itemId));
  const earned = recorded.reduce((sum, score) => sum + score.score, 0);
  const possible = recorded.reduce((sum, score) => sum + score.maxScore, 0);
  return {
    earned: Math.round(earned * 100) / 100,
    possible: Math.round(possible * 100) / 100,
    percent: possible ? Math.round((earned / possible) * 10000) / 100 : null,
    scoredItems: recorded.length,
  };
}

export function formatGradebookPoints(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function gradebookExportRows(
  students: GradebookExportStudent[],
  items: GradebookExportItem[],
  scores: GradebookScore[],
  includedItemIds: Set<string>,
) {
  const selected = items.filter((item) => includedItemIds.has(item.id));
  const scoreMap = new Map(scores.map((score) => [`${score.studentId}:${score.itemId}`, score]));
  return [
    ["เลขที่", "รหัสนักเรียน", "ชื่อ-สกุล", ...selected.map((item) => item.kind === "manual" ? `${item.name} (${formatGradebookPoints(item.maxScore)})` : item.name), "รวมคะแนน", "ร้อยละ", "ให้คะแนนแล้ว"],
    ...students.map((student) => {
      const total = gradebookTotalForStudent(student.studentId, scores, includedItemIds);
      return [student.studentNumber ?? "", student.studentCode ?? "", student.displayName,
        ...selected.map((item) => {
          const score = scoreMap.get(`${student.studentId}:${item.id}`);
          return score ? `${formatGradebookPoints(score.score)} / ${formatGradebookPoints(score.maxScore)}` : "";
        }),
        total.scoredItems ? `${formatGradebookPoints(total.earned)} / ${formatGradebookPoints(total.possible)}` : "",
        total.percent === null ? "" : total.percent,
        total.scoredItems ? `${total.scoredItems} รายการ` : ""];
    }),
  ];
}
