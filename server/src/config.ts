import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { loadEnvFile } from "node:process";

if (existsSync(".env")) loadEnvFile();

function readPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return (pkg.version ?? "").trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function env(name: string, fallback: string): string {
  return process.env[`EPD_${name}`] ?? fallback;
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`EPD_${name} must be a boolean`);
}

function parseInteger(value: string, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`EPD_${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

export function sqlitePathFromUrl(databaseUrl: string): string {
  const prefix = "sqlite+aiosqlite:///";
  const sqlitePrefix = "sqlite:///";
  let filename: string;

  if (databaseUrl.startsWith(prefix)) {
    filename = databaseUrl.slice(prefix.length);
  } else if (databaseUrl.startsWith(sqlitePrefix)) {
    filename = databaseUrl.slice(sqlitePrefix.length);
  } else {
    throw new Error(
      "EPD_DATABASE_URL must use sqlite+aiosqlite:/// or sqlite:///",
    );
  }

  filename = decodeURIComponent(filename.split("?", 1)[0] ?? filename);
  if (filename === ":memory:" || filename.startsWith("file:")) return filename;
  return resolve(filename);
}

const databaseUrl = env(
  "DATABASE_URL",
  "sqlite+aiosqlite:///./data/epdserver.db",
);
const debug = parseBoolean(env("DEBUG", "false"), "DEBUG");
/** Explicit env value only; empty means auto-generate at initMasterKey(). */
const envMasterKey = (process.env.EPD_MASTER_KEY ?? "").trim();

const pathSeparator = process.platform === "win32" ? ";" : ":";

export const config = Object.freeze({
  appName: env("APP_NAME", "EPD Server"),
  /** App semver; override with EPD_VERSION. */
  version: (process.env.EPD_VERSION ?? "").trim() || readPackageVersion(),
  /** Short git SHA from build; optional. */
  gitSha: (process.env.EPD_GIT_SHA ?? "").trim(),
  /** UTC build timestamp from build; optional. */
  buildTime: (process.env.EPD_BUILD_TIME ?? "").trim(),
  debug,
  cookieSecure: parseBoolean(
    env("COOKIE_SECURE", debug ? "false" : "true"),
    "COOKIE_SECURE",
  ),
  databaseUrl,
  databasePath: sqlitePathFromUrl(databaseUrl),
  dataDir: resolve(env("DATA_DIR", "./data")),
  snapshotDir: resolve(env("SNAPSHOT_DIR", "./data/snapshots")),
  /** True when EPD_MASTER_KEY was provided via environment. */
  masterKeyFromEnv: envMasterKey.length > 0,
  adminUsername: env("ADMIN_USERNAME", "admin"),
  adminPassword: env("ADMIN_PASSWORD", "change-me-now"),
  sessionHours: parseInteger(env("SESSION_HOURS", "24"), "SESSION_HOURS", 1),
  allowedOrigins: env("ALLOWED_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  snapshotKeep: parseInteger(env("SNAPSHOT_KEEP", "3"), "SNAPSHOT_KEEP", 2),
  widgetDirs: env("WIDGET_DIRS", "")
    .split(pathSeparator)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item)),
  /** Absolute path to built frontend assets; empty disables static hosting. */
  frontendDir: (() => {
    const value = env("FRONTEND_DIR", "").trim();
    return value ? resolve(value) : "";
  })(),
  host: process.env.HOST ?? "0.0.0.0",
  port: parseInteger(process.env.PORT ?? "8000", "PORT", 1),
});

export type Config = typeof config;

const AUTO_MASTER_KEY_FILE = ".auto-master-key";

let activeMasterKey = "";

function assertMasterKeyLength(value: string): void {
  if (value.length < 32) {
    throw new Error("EPD_MASTER_KEY must contain at least 32 characters");
  }
}

/** Resolve master key after dataDir exists: env if set, else load/create internal file. */
export function initMasterKey(): void {
  if (envMasterKey) {
    assertMasterKeyLength(envMasterKey);
    activeMasterKey = envMasterKey;
    return;
  }

  const filePath = join(config.dataDir, AUTO_MASTER_KEY_FILE);
  if (existsSync(filePath)) {
    const stored = readFileSync(filePath, "utf8").trim();
    assertMasterKeyLength(stored);
    activeMasterKey = stored;
    return;
  }

  const generated = randomBytes(32).toString("base64url");
  assertMasterKeyLength(generated);
  try {
    writeFileSync(filePath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    writeFileSync(filePath, generated, { encoding: "utf8" });
  }
  activeMasterKey = generated;
}

export function getMasterKey(): string {
  if (!activeMasterKey) {
    throw new Error("Master key has not been initialized");
  }
  return activeMasterKey;
}
