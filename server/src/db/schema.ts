import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const uuid = (name: string) => text(name, { length: 36 });
const dateTime = (name: string) => text(name);
const timestampColumns = {
  createdAt: dateTime("created_at").notNull(),
  updatedAt: dateTime("updated_at").notNull(),
};

export const adminUsers = sqliteTable(
  "admin_users",
  {
    id: uuid("id").primaryKey(),
    username: text("username", { length: 80 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { length: 16 })
      .$type<"admin" | "user">()
      .notNull()
      .default("user"),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("ix_admin_users_username").on(table.username),
  ],
);

export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    id: text("id", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token", { length: 64 }).notNull(),
    expiresAt: dateTime("expires_at").notNull(),
  },
  (table) => [index("ix_admin_sessions_expires_at").on(table.expiresAt)],
);

export const screens = sqliteTable("screens", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => adminUsers.id, { onDelete: "cascade" }),
  name: text("name", { length: 120 }).notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  colorMode: text("color_mode", { length: 8 }).notNull().default("bw"),
  panelLayout: text("panel_layout", { length: 32 })
    .$type<"linear" | "dual-panel-left-right">()
    .notNull()
    .default("linear"),
  refreshSeconds: integer("refresh_seconds").notNull().default(900),
  timezone: text("timezone", { length: 64 })
    .notNull()
    .default("Asia/Shanghai"),
  silentEnabled: integer("silent_enabled", { mode: "boolean" }).notNull().default(false),
  silentStart: text("silent_start", { length: 5 }).notNull().default("22:00"),
  silentEnd: text("silent_end", { length: 5 }).notNull().default("07:00"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  currentSnapshotId: uuid("current_snapshot_id"),
  ...timestampColumns,
}, (table) => [index("ix_screens_owner_id").on(table.ownerId)]);

export const deviceCredentials = sqliteTable(
  "device_credentials",
  {
    id: uuid("id").primaryKey(),
    screenId: uuid("screen_id")
      .notNull()
      .references(() => screens.id, { onDelete: "cascade" }),
    keyPrefix: text("key_prefix", { length: 16 }).notNull(),
    keyHash: text("key_hash", { length: 64 }).notNull(),
    createdAt: dateTime("created_at").notNull(),
    revokedAt: dateTime("revoked_at"),
  },
  (table) => [
    index("ix_device_credentials_key_prefix").on(table.keyPrefix),
  ],
);

export const widgetInstances = sqliteTable("widget_instances", {
  id: uuid("id").primaryKey(),
  screenId: uuid("screen_id")
    .notNull()
    .references(() => screens.id, { onDelete: "cascade" }),
  widgetType: text("widget_type", { length: 80 }).notNull(),
  x: integer("x").notNull().default(0),
  y: integer("y").notNull().default(0),
  width: integer("width").notNull().default(240),
  height: integer("height").notNull().default(120),
  zIndex: integer("z_index").notNull().default(0),
  alignmentMargin: text("alignment_margin", { mode: "json" })
    .$type<Record<string, number>>()
    .notNull()
    .default({ top: 0, right: 0, bottom: 0, left: 0 }),
  config: text("config", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  configVersion: integer("config_version").notNull().default(1),
  ...timestampColumns,
});

export const pluginPackages = sqliteTable("plugin_packages", {
  typeName: text("type_name", { length: 80 }).primaryKey(),
  packageName: text("package_name", { length: 160 }).notNull(),
  version: text("version", { length: 80 }).notNull().default("unknown"),
  sourceType: text("source_type", { length: 24 })
    .notNull()
    .default("entry_point"),
  sourceUrl: text("source_url"),
  sourceRef: text("source_ref", { length: 160 }),
  status: text("status", { length: 24 }).notNull().default("available"),
  loadError: text("load_error"),
  pluginMetadata: text("plugin_metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  ...timestampColumns,
});

export const screenPlugins = sqliteTable(
  "screen_plugins",
  {
    screenId: uuid("screen_id")
      .notNull()
      .references(() => screens.id, { onDelete: "cascade" }),
    pluginType: text("plugin_type", { length: 80 })
      .notNull()
      .references(() => pluginPackages.typeName, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.screenId, table.pluginType] }),
  ],
);

export const secrets = sqliteTable(
  "secrets",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    name: text("name", { length: 120 }).notNull(),
    purpose: text("purpose", { length: 80 }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("ix_secrets_owner_name").on(table.ownerId, table.name),
  ],
);

export const snapshots = sqliteTable("snapshots", {
  id: uuid("id").primaryKey(),
  screenId: uuid("screen_id")
    .notNull()
    .references(() => screens.id, { onDelete: "cascade" }),
  baseSnapshotId: uuid("base_snapshot_id"),
  encoding: text("encoding", { length: 40 }).notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  sha256: text("sha256", { length: 64 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  framePath: text("frame_path").notNull(),
  sourcePath: text("source_path").notNull(),
  previewPath: text("preview_path").notNull(),
  createdAt: dateTime("created_at").notNull(),
});

export const snapshotRegions = sqliteTable("snapshot_regions", {
  id: uuid("id").primaryKey(),
  snapshotId: uuid("snapshot_id")
    .notNull()
    .references(() => snapshots.id, { onDelete: "cascade" }),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  stride: integer("stride").notNull(),
  sha256: text("sha256", { length: 64 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  path: text("path").notNull(),
});

export const providerStates = sqliteTable(
  "provider_states",
  {
    id: uuid("id").primaryKey(),
    cacheKey: text("cache_key", { length: 180 }).notNull(),
    payload: text("payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    lastError: text("last_error"),
    lastSuccessAt: dateTime("last_success_at"),
    expiresAt: dateTime("expires_at"),
    staleUntil: dateTime("stale_until"),
  },
  (table) => [
    uniqueIndex("ix_provider_states_cache_key").on(table.cacheKey),
  ],
);

export const renderMetrics = sqliteTable(
  "render_metrics",
  {
    id: uuid("id").primaryKey(),
    screenId: uuid("screen_id").notNull(),
    durationMs: real("duration_ms").notNull(),
    createdAt: dateTime("created_at").notNull(),
  },
  (table) => [index("ix_render_metrics_screen_id").on(table.screenId)],
);

export const allTables = [
  adminUsers,
  adminSessions,
  screens,
  deviceCredentials,
  widgetInstances,
  pluginPackages,
  screenPlugins,
  secrets,
  snapshots,
  snapshotRegions,
  providerStates,
  renderMetrics,
] as const;

export const databaseNow = sql`CURRENT_TIMESTAMP`;
