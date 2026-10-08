import nodemailer from "nodemailer";

function mailSettings() {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Student email requires SMTP_HOST, SMTP_PORT, and EMAIL_FROM.");
  }
  if (Boolean(user) !== Boolean(pass)) throw new Error("Set both SMTP_USER and SMTP_PASSWORD, or leave both empty.");
  return { host, from, port, secure: process.env.SMTP_SECURE === "true" || port === 465, auth: user && pass ? { user, pass } : undefined };
}

export async function sendStudentAccessEmail(email: string, url: string, kind: "invite" | "password_reset") {
  const { from, ...options } = mailSettings();
  const subject = kind === "invite" ? "เข้าร่วม Classroom" : "ตั้งรหัสผ่าน Classroom ใหม่";
  const action = kind === "invite" ? "เปิดลิงก์นี้เพื่อเปิดบัญชีนักเรียนและตั้งรหัสผ่าน" : "เปิดลิงก์นี้เพื่อตั้งรหัสผ่านใหม่";
  const transporter = nodemailer.createTransport(options);
  try {
    await transporter.sendMail({
      from,
      to: email,
      subject,
      text: `${action}\n\n${url}\n\nลิงก์นี้ใช้งานได้ครั้งเดียวและหมดอายุภายใน ${kind === "invite" ? "24 ชั่วโมง" : "1 ชั่วโมง"} หากคุณไม่ได้ร้องขออีเมลนี้ ให้ละเว้นข้อความนี้`,
    });
  } finally { transporter.close(); }
}
