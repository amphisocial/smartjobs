import "dotenv/config";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Pg from "pg";

const connectionString = process.env.SMARTJOBS_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set SMARTJOBS_DATABASE_URL or DATABASE_URL first.");
const ssl = String(process.env.PGSSL || "false").toLowerCase() === "true" ? { rejectUnauthorized: false } : undefined;
const pool = new Pg.Pool({ connectionString, ssl });
try {
  const schemaPath = fileURLToPath(new URL("../db/job_agent_schema.sql", import.meta.url));
  await pool.query(await fs.readFile(schemaPath, "utf8"));
  console.log("SmartJobs job-agent schema initialized.");
} finally {
  await pool.end();
}
