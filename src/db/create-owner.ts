import { sql } from "./client";

const username = process.env.OWNER_USERNAME?.trim().toLowerCase();
const displayName = process.env.OWNER_DISPLAY_NAME?.trim();
const password = process.env.OWNER_PASSWORD;

if (!username || !/^[a-z0-9._-]{3,40}$/.test(username) || !displayName || !password) {
  console.error("Set a valid OWNER_USERNAME (3–40 lowercase letters, digits, dots, dashes, or underscores), OWNER_DISPLAY_NAME, and OWNER_PASSWORD.");
  process.exitCode = 1;
} else if (password.length < 12) {
  console.error("OWNER_PASSWORD must contain at least 12 characters.");
  process.exitCode = 1;
} else {
  try {
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM classroom.teachers WHERE role = 'owner' LIMIT 1
    `;
    if (existing) throw new Error("An owner account already exists.");
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    await sql`
      INSERT INTO classroom.teachers (username, display_name, password_hash, role)
      VALUES (${username}, ${displayName}, ${passwordHash}, 'owner')
    `;
    console.log(`Created owner account ${username}. Remove OWNER_PASSWORD from the environment now.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not create owner account.");
    process.exitCode = 1;
  }
}

await sql.end();
