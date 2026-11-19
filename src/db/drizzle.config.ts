import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

dotenv.config();

dotenv.config({ path: ".env.local" });

// Migrations need a direct (unpooled) connection on Neon; fall back to DATABASE_URL, then the SQL_* variables.
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

function legacyCredentials() {
  const host = process.env.SQL_HOST;
  const database = process.env.SQL_DB_NAME;
  const user = process.env.SQL_ADMIN_USER;
  const password = process.env.SQL_ADMIN_PASSWORD;
  if (!host || !database || !user || !password) {
    throw new Error("Set DATABASE_URL, or SQL_HOST, SQL_DB_NAME, SQL_ADMIN_USER and SQL_ADMIN_PASSWORD.");
  }
  return { host, database, user, password, ssl: false };
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["public"],
  dbCredentials: url ? { url } : legacyCredentials(),
  verbose: true,
});
