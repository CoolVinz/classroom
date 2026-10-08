import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "./client";

export async function bootstrapDatabase() {
  const [version] = await sql.unsafe("SELECT current_setting('server_version_num') AS server_version_num") as { server_version_num: string }[];
  if (Number(version.server_version_num) < 180000) throw new Error("This app requires PostgreSQL 18 or newer.");

  const [schema] = await sql.unsafe("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'classroom'") as { owner: string }[];
  if (!schema) throw new Error("Create the classroom schema and assign it to the app database role before starting the server.");
  const [currentUser] = await sql.unsafe("SELECT current_user AS name") as { name: string }[];
  if (schema.owner !== currentUser.name) {
    throw new Error("The app database role must own the classroom schema so tracked migrations can be applied safely.");
  }

  const [tracking] = await sql.unsafe("SELECT to_regclass('classroom.schema_migrations') IS NOT NULL AS exists") as { exists: boolean }[];
  if (!tracking.exists) {
    const [relations] = await sql.unsafe("SELECT COUNT(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'classroom' AND c.relkind IN ('r','p','v','m','S')") as { count: number }[];
    if (relations.count > 0) throw new Error("The classroom schema already contains objects; inspect it before initializing the app.");
    await sql.unsafe("CREATE TABLE classroom.schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  }
  const [applied] = await sql.unsafe("SELECT EXISTS (SELECT 1 FROM classroom.schema_migrations WHERE version = '001_initial') AS exists") as { exists: boolean }[];
  if (applied.exists) {
    await seedInitialOwner();
    return;
  }

  const [trackingOnly] = await sql.unsafe("SELECT COUNT(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'classroom' AND c.relkind IN ('r','p','v','m','S') AND c.relname <> 'schema_migrations'") as { count: number }[];
  if (trackingOnly.count > 0) throw new Error("The classroom schema contains untracked objects; inspect it before initialization.");

  const migration = await readFile(resolve(import.meta.dir, "migrations/001_initial.sql"), "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(migration).simple();
    await tx.unsafe("INSERT INTO classroom.schema_migrations (version) VALUES ('001_initial')");
  });
  await seedInitialOwner();
}

async function seedInitialOwner() {
  const username = process.env.OWNER_USERNAME?.trim().toLowerCase();
  const displayName = process.env.OWNER_DISPLAY_NAME?.trim();
  const password = process.env.OWNER_PASSWORD;
  if (!username && !displayName && !password) return;
  const [existingOwner] = await sql.unsafe("SELECT id FROM classroom.teachers WHERE role = 'owner' LIMIT 1") as { id: string }[];
  if (existingOwner) {
    console.warn("An owner already exists; remove OWNER_* variables from the runtime environment.");
    return;
  }
  if (!username || !/^[a-z0-9._-]{3,40}$/.test(username) || !displayName || !password || password.length < 12) {
    throw new Error("Initial owner setup requires valid OWNER_USERNAME, OWNER_DISPLAY_NAME, and an OWNER_PASSWORD of at least 12 characters.");
  }
  const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const created = await sql.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(854920106)");
    const [owner] = await tx.unsafe("SELECT id FROM classroom.teachers WHERE role = 'owner' LIMIT 1") as { id: string }[];
    if (owner) return false;
    await tx`
      INSERT INTO classroom.teachers (username, display_name, password_hash, role)
      VALUES (${username}, ${displayName}, ${passwordHash}, 'owner')
    `;
    return true;
  });
  if (created) console.log("Created the initial owner account. Remove OWNER_* variables from the runtime environment.");
}
