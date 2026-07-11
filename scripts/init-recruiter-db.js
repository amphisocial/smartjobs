import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

if (!config.databaseUrl) {
  console.error("DATABASE_URL is missing. Add it to /opt/apps/smartjobs/.env before running npm run db:init.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
});

try {
  const schemaPath = fileURLToPath(new URL("../db/recruiter_schema.sql", import.meta.url));
  const schema = await fs.readFile(schemaPath, "utf8");
  await pool.query(schema);
  const result = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'recruiter_%' ORDER BY tablename`);
  console.log("Recruiter database initialized.");
  for (const row of result.rows) console.log(` - ${row.tablename}`);
} catch (error) {
  console.error("Recruiter database initialization failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
