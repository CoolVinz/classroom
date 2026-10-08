export type RosterSheet = { name: string; rows: unknown[][] };
export type RosterMapping = { code: number; fullName?: number; firstName?: number; lastName?: number; email?: number };
export type RosterRow = { studentCode: string; displayName: string; email?: string; row: number };
export type RosterPreview = { add: RosterRow[]; skipped: RosterRow[]; errors: { row: number; message: string }[] };

export async function readRosterFile(file: File): Promise<RosterSheet[]> {
  if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error("เลือกไฟล์ .xlsx หรือ .csv เท่านั้น");
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error("ไฟล์ต้องมีขนาดไม่เกิน 5 MB");
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", WTF: true });
  return workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, raw: false, defval: "", blankrows: false }),
  }));
}

export function previewRoster(rows: unknown[][], mapping: RosterMapping, existingCodes: Set<string>, existingEmails = new Set<string>()): RosterPreview {
  if (rows.length < 2) return { add: [], skipped: [], errors: [{ row: 1, message: "ไฟล์ไม่มีรายชื่อนักเรียน" }] };
  if (rows.length > 1001) return { add: [], skipped: [], errors: [{ row: 1002, message: "นำเข้าได้ไม่เกิน 1,000 คนต่อครั้ง" }] };
  const data = rows.slice(1);
  const codes = data.map((row) => cell(row[mapping.code]));
  const frequencies = new Map<string, number>();
  for (const code of codes) if (code) frequencies.set(code, (frequencies.get(code) ?? 0) + 1);
  const emails = data.map((row) => cell(row[mapping.email ?? -1]).toLowerCase());
  const emailFrequencies = new Map<string, number>();
  for (const email of emails) if (email) emailFrequencies.set(email, (emailFrequencies.get(email) ?? 0) + 1);
  const result: RosterPreview = { add: [], skipped: [], errors: [] };
  data.forEach((row, index) => {
    const rowNumber = index + 2;
    const studentCode = codes[index];
    const email = emails[index] || undefined;
    const displayName = mapping.fullName !== undefined
      ? cell(row[mapping.fullName])
      : [cell(row[mapping.firstName ?? -1]), cell(row[mapping.lastName ?? -1])].filter(Boolean).join(" ");
    if (!studentCode || !displayName) {
      result.errors.push({ row: rowNumber, message: "ต้องมีรหัสนักเรียนและชื่อ" });
    } else if (studentCode.length > 50 || displayName.length > 120) {
      result.errors.push({ row: rowNumber, message: "รหัสหรือชื่อยาวเกินกำหนด" });
    } else if ((frequencies.get(studentCode) ?? 0) > 1) {
      result.errors.push({ row: rowNumber, message: "รหัสนักเรียนซ้ำในไฟล์" });
    } else if (existingCodes.has(studentCode)) {
      result.skipped.push({ studentCode, displayName, row: rowNumber });
    } else if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) {
      result.errors.push({ row: rowNumber, message: "อีเมลไม่ถูกต้อง" });
    } else if (email && ((emailFrequencies.get(email) ?? 0) > 1 || existingEmails.has(email))) {
      result.errors.push({ row: rowNumber, message: "อีเมลซ้ำในห้องเรียน" });
    } else {
      result.add.push({ studentCode, displayName, ...(email ? { email } : {}), row: rowNumber });
    }
  });
  return result;
}

function cell(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}
