import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

export const sql = postgres(databaseUrl, {
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  ssl: process.env.DATABASE_SSL === "disable" ? false : "require",
  connect_timeout: 10,
  idle_timeout: 20,
  onnotice: () => {},
});
