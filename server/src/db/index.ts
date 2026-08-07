import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { config } from "../config.js";
import * as schema from "./schema.js";

if (config.databasePath !== ":memory:" && !config.databasePath.startsWith("file:")) {
  mkdirSync(dirname(config.databasePath), { recursive: true });
}

export const sqlite: Database.Database = new Database(config.databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export function checkDatabase(): void {
  sqlite.prepare("SELECT 1").get();
}

export function closeDatabase(): void {
  if (sqlite.open) sqlite.close();
}

export * from "./schema.js";
