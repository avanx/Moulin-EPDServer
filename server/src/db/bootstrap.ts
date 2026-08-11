import { eq } from "drizzle-orm";

import { config } from "../config.js";
import { hashPassword } from "../security.js";
import { registry } from "../widgets/registry.js";
import { db, sqlite } from "./index.js";
import { adminUsers, pluginPackages } from "./schema.js";

const ddl = `
CREATE TABLE IF NOT EXISTS admin_users(id VARCHAR(36) PRIMARY KEY,username VARCHAR(80) NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions(id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(36) NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,csrf_token VARCHAR(64) NOT NULL,expires_at DATETIME NOT NULL);
CREATE INDEX IF NOT EXISTS ix_admin_sessions_expires_at ON admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS screens(id VARCHAR(36) PRIMARY KEY,name VARCHAR(120) NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,color_mode VARCHAR(8) NOT NULL DEFAULT 'bw',panel_layout VARCHAR(32) NOT NULL DEFAULT 'linear',refresh_seconds INTEGER NOT NULL DEFAULT 900,timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',enabled BOOLEAN NOT NULL DEFAULT 1,current_snapshot_id VARCHAR(36),created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL);
CREATE TABLE IF NOT EXISTS device_credentials(id VARCHAR(36) PRIMARY KEY,screen_id VARCHAR(36) NOT NULL REFERENCES screens(id) ON DELETE CASCADE,key_prefix VARCHAR(16) NOT NULL,key_hash VARCHAR(64) NOT NULL,created_at DATETIME NOT NULL,revoked_at DATETIME);
CREATE INDEX IF NOT EXISTS ix_device_credentials_key_prefix ON device_credentials(key_prefix);
CREATE TABLE IF NOT EXISTS widget_instances(id VARCHAR(36) PRIMARY KEY,screen_id VARCHAR(36) NOT NULL REFERENCES screens(id) ON DELETE CASCADE,widget_type VARCHAR(80) NOT NULL,x INTEGER NOT NULL DEFAULT 0,y INTEGER NOT NULL DEFAULT 0,width INTEGER NOT NULL DEFAULT 240,height INTEGER NOT NULL DEFAULT 120,z_index INTEGER NOT NULL DEFAULT 0,alignment_margin JSON NOT NULL,config JSON NOT NULL,config_version INTEGER NOT NULL DEFAULT 1,created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_packages(type_name VARCHAR(80) PRIMARY KEY,package_name VARCHAR(160) NOT NULL,version VARCHAR(80) NOT NULL DEFAULT 'unknown',source_type VARCHAR(24) NOT NULL,source_url TEXT,source_ref VARCHAR(160),status VARCHAR(24) NOT NULL,load_error TEXT,plugin_metadata JSON NOT NULL,created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL);
CREATE TABLE IF NOT EXISTS screen_plugins(screen_id VARCHAR(36) NOT NULL REFERENCES screens(id) ON DELETE CASCADE,plugin_type VARCHAR(80) NOT NULL REFERENCES plugin_packages(type_name) ON DELETE CASCADE,enabled BOOLEAN NOT NULL DEFAULT 1,created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL,PRIMARY KEY(screen_id,plugin_type));
CREATE TABLE IF NOT EXISTS secrets(id VARCHAR(36) PRIMARY KEY,name VARCHAR(120) NOT NULL UNIQUE,purpose VARCHAR(80) NOT NULL,encrypted_value TEXT NOT NULL,created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots(id VARCHAR(36) PRIMARY KEY,screen_id VARCHAR(36) NOT NULL REFERENCES screens(id) ON DELETE CASCADE,base_snapshot_id VARCHAR(36),encoding VARCHAR(40) NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,sha256 VARCHAR(64) NOT NULL,byte_size INTEGER NOT NULL,frame_path TEXT NOT NULL,source_path TEXT NOT NULL,preview_path TEXT NOT NULL,created_at DATETIME NOT NULL);
CREATE TABLE IF NOT EXISTS snapshot_regions(id VARCHAR(36) PRIMARY KEY,snapshot_id VARCHAR(36) NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,x INTEGER NOT NULL,y INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,stride INTEGER NOT NULL,sha256 VARCHAR(64) NOT NULL,byte_size INTEGER NOT NULL,path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provider_states(id VARCHAR(36) PRIMARY KEY,cache_key VARCHAR(180) NOT NULL UNIQUE,payload JSON NOT NULL,last_error TEXT,last_success_at DATETIME,expires_at DATETIME,stale_until DATETIME);
CREATE TABLE IF NOT EXISTS render_metrics(id VARCHAR(36) PRIMARY KEY,screen_id VARCHAR(36) NOT NULL,duration_ms FLOAT NOT NULL,created_at DATETIME NOT NULL);
CREATE INDEX IF NOT EXISTS ix_render_metrics_screen_id ON render_metrics(screen_id);
`;

export async function bootstrapDatabase(): Promise<void> {
  sqlite.exec(ddl);
  const screenColumns = sqlite.prepare("PRAGMA table_info(screens)").all() as Array<{ name: string }>;
  if (!screenColumns.some((column) => column.name === "panel_layout")) {
    sqlite.transaction(() => {
      sqlite.exec("ALTER TABLE screens ADD COLUMN panel_layout VARCHAR(32) NOT NULL DEFAULT 'linear'");
      sqlite.prepare(
        "UPDATE screens SET panel_layout = 'dual-panel-left-right' WHERE width = 1360 AND height = 480",
      ).run();
    })();
  }
  sqlite.prepare(
    "UPDATE secrets SET purpose = 'general_key' WHERE purpose NOT IN ('general_key', 'cursor_session', 'qweather_jwt')",
  ).run();
  sqlite.prepare(
    "UPDATE snapshots SET encoding = 'edp-bwry-v1' WHERE encoding = 'image2lcd-bwry-v1'",
  ).run();
  const now = new Date().toISOString();
  const existingAdmins = db.select().from(adminUsers).all();
  if (existingAdmins.length === 0) {
    db.insert(adminUsers).values({
      id: crypto.randomUUID(), username: config.adminUsername,
      passwordHash: await hashPassword(config.adminPassword), createdAt: now, updatedAt: now,
    }).run();
  }
  const discovered = new Set<string>();
  for (const record of registry.records()) {
    discovered.add(record.type);
    const existing = db.select().from(pluginPackages).where(eq(pluginPackages.typeName, record.type)).get();
    const values = {
      packageName: record.packageName, version: record.version, sourceType: record.sourceType,
      sourceUrl: record.sourceUrl, sourceRef: record.sourceRef, status: record.status,
      loadError: record.loadError, pluginMetadata: record.metadata, updatedAt: now,
    };
    if (existing) db.update(pluginPackages).set(values).where(eq(pluginPackages.typeName, record.type)).run();
    else db.insert(pluginPackages).values({ typeName: record.type, createdAt: now, ...values }).run();
  }
  for (const item of db.select().from(pluginPackages).all()) {
    if (!discovered.has(item.typeName)) {
      db.update(pluginPackages).set({ status: "missing", loadError: "Plugin package was not discovered at startup", updatedAt: now })
        .where(eq(pluginPackages.typeName, item.typeName)).run();
    }
  }
}
