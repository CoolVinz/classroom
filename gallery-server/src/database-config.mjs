export function databaseConfig(env = process.env) {
  const url = new URL(env.DATABASE_URL);
  // pg's URL parser overrides the explicit SSL policy when sslmode is present.
  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    ssl: env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
    max: 8,
  };
}
