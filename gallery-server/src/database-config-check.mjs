import assert from "node:assert/strict";
import { databaseConfig } from "./database-config.mjs";

const config = databaseConfig({ DATABASE_URL: "postgres://user:pass@db.example/classroom?sslmode=require&application_name=gallery", DATABASE_SSL: "require" });
const url = new URL(config.connectionString);
assert.equal(url.searchParams.has("sslmode"), false);
assert.equal(url.searchParams.get("application_name"), "gallery");
assert.deepEqual(config.ssl, { rejectUnauthorized: false });
assert.equal(databaseConfig({ DATABASE_URL: "postgres://db.example/classroom", DATABASE_SSL: "disable" }).ssl, false);
