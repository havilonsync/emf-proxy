import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationFile = process.argv[2] || "0001_create_donations_table.sql";
const migrationPath = path.join(__dirname, "..", "db", "migrations", migrationFile);

const connectionString = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error("POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is not set");
}

const sql = await readFile(migrationPath, "utf8");

const client = new pg.Client({ connectionString });
await client.connect();

try {
  console.log(`Running ${migrationFile}...`);
  await client.query(sql);
  console.log("Migration applied.");

  const { rows } = await client.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'donations'
     ORDER BY ordinal_position`
  );
  console.log("donations table columns:");
  console.table(rows);
} finally {
  await client.end();
}
