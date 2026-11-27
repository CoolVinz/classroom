import type postgres from "postgres";

export async function revokeTestStudentSessions(db: postgres.ISql, accountId: string) {
  await db`DELETE FROM classroom.student_sessions WHERE account_id = ${accountId}`;
  await db`UPDATE classroom.attendance_presence SET active_view = NULL
    WHERE student_id IN (SELECT id FROM classroom.students WHERE account_id = ${accountId})`;
}

export async function revokeTestStudentAccess(db: postgres.ISql, accountId: string) {
  await db`DELETE FROM classroom.test_student_links WHERE account_id = ${accountId}`;
  await revokeTestStudentSessions(db, accountId);
}

export async function revokeClassroomTesters(db: postgres.ISql, classroomId: string) {
  await db`DELETE FROM classroom.test_student_links
    WHERE account_id IN (SELECT id FROM classroom.student_accounts WHERE test_classroom_id = ${classroomId})`;
  await db`DELETE FROM classroom.student_sessions
    WHERE account_id IN (SELECT id FROM classroom.student_accounts WHERE test_classroom_id = ${classroomId})`;
}
