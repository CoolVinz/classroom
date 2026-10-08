import { bootstrapDatabase } from "./bootstrap";
import { sql } from "./client";

try {
  await bootstrapDatabase();
  console.log("Database schema is current.");
} finally {
  await sql.end();
}
