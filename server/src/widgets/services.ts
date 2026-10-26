import { and, eq, or } from "drizzle-orm";
import { isIP } from "node:net";
import { connectAsync } from "mqtt";

import { db } from "../db/index.js";
import { providerStates, secrets } from "../db/schema.js";
import {
  ClaudeAuthError,
  claudeTokenNeedsRefresh,
  fetchClaudeUsage,
  parseClaudeOAuthCredentials,
  refreshClaudeAccessToken,
  serializeClaudeOAuthCredentials,
  type ClaudeCodeUsage,
} from "../claude-oauth.js";
import { databaseTimestampMillis, decryptSecret, encryptSecret } from "../security.js";

interface BambuPrinterStatusOptions {
  host: string;
  serial: string;
  accessSecretId: string;
}

interface BambuPrinterStatus {
  status: string;
  percentage: number;
  remainingMinutes: number;
  currentLayer: number;
  totalLayers: number;
  taskName: string;
}

interface KlipperPrinterStatusOptions {
  host: string;
  port?: number;
  compatibility: "general" | "snapmaker_u1";
  apiSecretId?: string;
}

interface KlipperPrinterStatus {
  status: string;
  percentage: number;
  remainingMinutes: number;
  currentLayer: number;
  totalLayers: number;
  taskName: string;
}

export interface ServiceOptions {
  persist?: boolean;
  strict?: boolean;
  /** Account the secrets are resolved against; secrets are never shared across users. */
  ownerId?: string;
}

export type ProviderCacheRead =
  | { status: "fresh"; value: unknown }
  | { status: "miss"; stale?: unknown };

/** Secret ids whose Cursor session cookie must not be sent again until the user replaces it. */
const quarantinedCursorSecrets = new Set<string>();
/** Secret ids whose Claude OAuth grant must not be refreshed again until the user replaces it. */
const quarantinedClaudeSecrets = new Set<string>();
const claudeSecretLocks = new Map<string, Promise<void>>();

export function releaseCursorSessionQuarantine(secretId: string): void {
  quarantinedCursorSecrets.delete(secretId);
}

export function releaseClaudeSessionQuarantine(secretId: string): void {
  quarantinedClaudeSecrets.delete(secretId);
}

function withClaudeSecretLock<T>(secretId: string, action: () => Promise<T>): Promise<T> {
  const previous = claudeSecretLocks.get(secretId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate, () => gate);
  claudeSecretLocks.set(secretId, tail);
  return previous.catch(() => undefined).then(async () => {
    try {
      return await action();
    } finally {
      release();
      if (claudeSecretLocks.get(secretId) === tail) claudeSecretLocks.delete(secretId);
    }
  });
}

function timestamp(date = new Date()): string {
  return date.toISOString();
}

function future(seconds: number): string {
  return timestamp(new Date(Date.now() + seconds * 1000));
}

function assertPrivateIpv4(host: string, device = "Printer"): string {
  const value = host.trim();
  if (isIP(value) !== 4) throw new Error(`${device} host must be a private IPv4 address`);
  const [first, second] = value.split(".").map(Number);
  const privateAddress = first === 10
    || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && second === 168);
  if (!privateAddress) throw new Error(`${device} host must be on a private network`);
  return value;
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatFetchFailure(input: string, error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current != null; depth += 1) {
    if (current instanceof Error) {
      const detail = current.message.trim() || current.name;
      if (detail && !parts.includes(detail)) parts.push(detail);
      current = current.cause;
      continue;
    }
    const detail = String(current).trim();
    if (detail && !parts.includes(detail)) parts.push(detail);
    break;
  }
  let host = input;
  try {
    host = new URL(input).host;
  } catch {
    // Keep the raw input when it is not a valid URL.
  }
  return `Request to ${host} failed: ${parts.join(" ← ") || "unknown error"}`;
}

async function moonrakerJson(
  url: URL,
  apiKey?: string,
): Promise<Record<string, unknown>> {
  const headers = new Headers();
  if (apiKey) headers.set("X-Api-Key", apiKey);
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 2_000_000) {
    throw new Error("Moonraker response exceeds 2 MB");
  }
  if (!response.ok) {
    throw new Error(`Moonraker request failed (${response.status} ${response.statusText})`);
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Moonraker returned an invalid JSON response");
  }
  return value as Record<string, unknown>;
}

export class WidgetServices {
  constructor(private readonly options: ServiceOptions = {}) {}

  async request(
    input: string,
    init: RequestInit & { secretCookies?: Record<string, string> } = {},
  ): Promise<Response> {
    const { secretCookies, ...requestInit } = init;
    const headers = new Headers(requestInit.headers);
    if (secretCookies && Object.keys(secretCookies).length) {
      // Providers expect browser cookie values verbatim after provider-specific normalization.
      headers.set("Cookie", Object.entries(secretCookies)
        .map(([key, value]) => `${key}=${value}`)
        .join("; "));
    }
    try {
      return await fetch(input, {
        ...requestInit,
        headers,
        redirect: requestInit.redirect ?? "follow",
        signal: requestInit.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(formatFetchFailure(input, error), { cause: error });
    }
  }

  private ownedSecret(idOrName: string) {
    const ownerId = this.options.ownerId;
    if (!ownerId) return undefined;
    return db.select().from(secrets)
      .where(and(
        eq(secrets.ownerId, ownerId),
        or(eq(secrets.id, idOrName), eq(secrets.name, idOrName)),
      )).get();
  }

  async getSecret(idOrName: string): Promise<string> {
    if (!this.options.ownerId) throw new Error("Secret lookup requires an owner");
    const row = this.ownedSecret(idOrName);
    if (!row) throw new Error(`Secret is not configured: ${idOrName}`);
    return decryptSecret(row.encryptedValue);
  }

  /** True when this owner's Cursor session must not be presented to cursor.com. */
  isCursorSessionQuarantined(idOrName: string): boolean {
    const row = this.ownedSecret(idOrName);
    if (!row || row.purpose !== "cursor_session") return false;
    if (quarantinedCursorSecrets.has(row.id) || row.disabledReason === "token_expired") {
      quarantinedCursorSecrets.add(row.id);
      return true;
    }
    return false;
  }

  /** Stop further Cursor requests for this session. The in-memory set is updated before the database write. */
  quarantineCursorSession(idOrName: string): void {
    const row = this.ownedSecret(idOrName);
    if (!row || row.purpose !== "cursor_session") return;
    quarantinedCursorSecrets.add(row.id);
    if (row.disabledReason === "token_expired") return;
    db.update(secrets).set({ disabledReason: "token_expired" }).where(eq(secrets.id, row.id)).run();
  }

  /** True when this owner's Claude grant must not be presented to Anthropic. */
  isClaudeSessionQuarantined(idOrName: string): boolean {
    const row = this.ownedSecret(idOrName);
    if (!row || row.purpose !== "claude_oauth") return false;
    if (quarantinedClaudeSecrets.has(row.id) || row.disabledReason === "token_expired") {
      quarantinedClaudeSecrets.add(row.id);
      return true;
    }
    return false;
  }

  /** Stop further Claude token refreshes for this secret. The in-memory set is updated before the database write. */
  quarantineClaudeSession(idOrName: string): void {
    const row = this.ownedSecret(idOrName);
    if (!row || row.purpose !== "claude_oauth") return;
    quarantinedClaudeSecrets.add(row.id);
    if (row.disabledReason === "token_expired") return;
    db.update(secrets).set({ disabledReason: "token_expired" }).where(eq(secrets.id, row.id)).run();
  }

  async claudeCodeUsage(options: { secretId: string }): Promise<ClaudeCodeUsage> {
    const secretId = options.secretId.trim();
    if (!secretId) throw new Error("Claude secret is not configured");
    return withClaudeSecretLock(secretId, async () => {
      if (this.isClaudeSessionQuarantined(secretId)) throw new Error("TOKEN_EXPIRED");
      const row = this.ownedSecret(secretId);
      if (!row || row.purpose !== "claude_oauth") throw new Error("Claude secret is not configured");
      let credentials = parseClaudeOAuthCredentials(decryptSecret(row.encryptedValue));
      if (claudeTokenNeedsRefresh(credentials)) {
        try {
          credentials = await refreshClaudeAccessToken(credentials);
        } catch (error) {
          if (error instanceof ClaudeAuthError) {
            this.quarantineClaudeSession(secretId);
            throw new Error("TOKEN_EXPIRED");
          }
          throw error;
        }
        db.update(secrets).set({
          encryptedValue: encryptSecret(serializeClaudeOAuthCredentials(credentials)),
          disabledReason: null,
          updatedAt: timestamp(),
        }).where(eq(secrets.id, row.id)).run();
      }
      try {
        return await fetchClaudeUsage(credentials.accessToken);
      } catch (error) {
        if (error instanceof ClaudeAuthError) {
          this.quarantineClaudeSession(secretId);
          throw new Error("TOKEN_EXPIRED");
        }
        throw error;
      }
    });
  }

  async bambuPrinterStatus(options: BambuPrinterStatusOptions): Promise<BambuPrinterStatus> {
    const host = assertPrivateIpv4(options.host, "Bambu printer");
    const serial = options.serial.trim();
    if (!/^[A-Za-z0-9]{8,32}$/.test(serial)) throw new Error("Invalid Bambu printer serial number");
    const accessCode = (await this.getSecret(options.accessSecretId)).trim();
    if (!accessCode) throw new Error("Bambu printer access code is empty");

    const client = await connectAsync(`mqtts://${host}:8883`, {
      username: "bblp",
      password: accessCode,
      rejectUnauthorized: false,
      reconnectPeriod: 0,
      connectTimeout: 8_000,
      clean: true,
      clientId: `epdserver_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    });
    const reportTopic = `device/${serial}/report`;
    try {
      await client.subscribeAsync(reportTopic);
      const print = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          client.removeListener("message", onMessage);
        };
        const fail = (error: unknown) => {
          cleanup();
          reject(error);
        };
        const timer = setTimeout(() => {
          fail(new Error("Timed out waiting for Bambu printer status"));
        }, 12_000);
        const onMessage = (topic: string, payload: Buffer) => {
          if (topic !== reportTopic) return;
          try {
            const message = JSON.parse(payload.toString("utf8")) as { print?: Record<string, unknown> };
            if (!message.print || (!("gcode_state" in message.print) && !("mc_percent" in message.print))) return;
            cleanup();
            resolve(message.print);
          } catch {
            // Ignore non-JSON and unrelated reports until the timeout.
          }
        };
        client.on("message", onMessage);
        void client.publishAsync(`device/${serial}/request`, JSON.stringify({
          pushing: { command: "pushall", sequence_id: "0" },
        })).catch(fail);
      });
      return {
        status: String(print.gcode_state ?? "UNKNOWN").toUpperCase(),
        percentage: Math.min(100, Math.max(0, finiteNumber(print.mc_percent))),
        remainingMinutes: Math.max(0, finiteNumber(print.mc_remaining_time)),
        currentLayer: Math.max(0, finiteNumber(print.layer_num)),
        totalLayers: Math.max(0, finiteNumber(print.total_layer_num)),
        taskName: String(print.subtask_name ?? print.gcode_file ?? "").trim(),
      };
    } finally {
      await client.endAsync(true).catch(() => undefined);
    }
  }

  async klipperPrinterStatus(options: KlipperPrinterStatusOptions): Promise<KlipperPrinterStatus> {
    const host = assertPrivateIpv4(options.host, "Klipper printer");
    if (options.compatibility !== "general" && options.compatibility !== "snapmaker_u1") {
      throw new Error("Unsupported Klipper compatibility mode");
    }
    const defaultPort = options.compatibility === "snapmaker_u1" ? 80 : 7125;
    const port = options.port || defaultPort;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Invalid Moonraker port");
    }
    const apiKey = options.apiSecretId
      ? (await this.getSecret(options.apiSecretId)).trim()
      : undefined;
    const baseUrl = new URL(`http://${host}:${port}`);
    const statusUrl = new URL("/printer/objects/query", baseUrl);
    statusUrl.searchParams.set("print_stats", "");
    statusUrl.searchParams.set("virtual_sdcard", "");
    const payload = await moonrakerJson(statusUrl, apiKey);
    const result = payload.result as Record<string, unknown> | undefined;
    const status = result?.status as Record<string, unknown> | undefined;
    const printStats = status?.print_stats as Record<string, unknown> | undefined;
    const virtualSdcard = status?.virtual_sdcard as Record<string, unknown> | undefined;
    if (!printStats || !virtualSdcard) {
      throw new Error("Moonraker response is missing print status objects");
    }

    const filename = String(printStats.filename ?? virtualSdcard.file_path ?? "").trim();
    let metadata: Record<string, unknown> | undefined;
    if (filename) {
      const metadataUrl = new URL("/server/files/metadata", baseUrl);
      metadataUrl.searchParams.set("filename", filename);
      metadata = await moonrakerJson(metadataUrl, apiKey)
        .then((value) => value.result as Record<string, unknown> | undefined)
        .catch(() => undefined);
    }

    const progress = Math.min(1, Math.max(0, finiteNumber(virtualSdcard.progress)));
    const printDuration = Math.max(0, finiteNumber(printStats.print_duration));
    const estimatedTime = Math.max(0, finiteNumber(metadata?.estimated_time));
    const state = String(printStats.state ?? "unknown").toLowerCase();
    let remainingSeconds = estimatedTime > 0
      ? Math.max(0, estimatedTime - printDuration)
      : progress > 0
        ? Math.max(0, printDuration * (1 - progress) / progress)
        : 0;
    if (state !== "printing" && state !== "paused") remainingSeconds = 0;

    const info = printStats.info as Record<string, unknown> | undefined;
    const currentLayer = finiteNumber(info?.current_layer ?? printStats.current_layer);
    const totalLayers = finiteNumber(
      info?.total_layer ?? printStats.total_layer ?? metadata?.layer_count,
    );
    const taskName = filename
      ? filename.split(/[\\/]/).at(-1)!.replace(/\.gcode(?:\.\w+)?$/i, "")
      : "";
    return {
      status: state,
      percentage: progress * 100,
      remainingMinutes: remainingSeconds / 60,
      currentLayer: Math.max(0, currentLayer),
      totalLayers: Math.max(0, totalLayers),
      taskName,
    };
  }

  async cachedProvider<T>(
    key: string,
    options: { ttlSeconds: number; staleSeconds?: number },
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const cached = this.readProviderCache(key);
    if (cached.status === "fresh") return cached.value as T;
    try {
      const payload = await fetcher();
      return this.writeProviderSuccess(key, options, payload) as T;
    } catch (error) {
      const fallback = this.writeProviderFailure(key, error, cached.status === "miss" ? cached.stale : undefined);
      if (fallback !== undefined) return fallback as T;
      throw error;
    }
  }

  readProviderCache(key: string): ProviderCacheRead {
    const state = db.select().from(providerStates).where(eq(providerStates.cacheKey, key)).get();
    const now = Date.now();
    if (!this.options.strict && state?.expiresAt && databaseTimestampMillis(state.expiresAt) > now) {
      return { status: "fresh", value: { ...state.payload, _stale: false } };
    }
    const stale = !this.options.strict && state?.staleUntil &&
      databaseTimestampMillis(state.staleUntil) > now
      ? state.payload
      : undefined;
    return { status: "miss", ...(stale === undefined ? {} : { stale }) };
  }

  writeProviderSuccess(
    key: string,
    options: { ttlSeconds: number; staleSeconds?: number },
    payload: unknown,
  ): unknown {
    if (this.options.persist !== false) {
      const state = db.select().from(providerStates).where(eq(providerStates.cacheKey, key)).get();
      const values = {
        payload: payload as Record<string, unknown>,
        lastError: null,
        lastSuccessAt: timestamp(),
        expiresAt: future(options.ttlSeconds),
        staleUntil: future(options.staleSeconds ?? options.ttlSeconds),
      };
      if (state) db.update(providerStates).set(values).where(eq(providerStates.id, state.id)).run();
      else db.insert(providerStates).values({
        id: crypto.randomUUID(), cacheKey: key, ...values,
      }).run();
    }
    return { ...(payload as object), _stale: false };
  }

  writeProviderFailure(key: string, error: unknown, stale?: unknown): unknown | undefined {
    const state = db.select().from(providerStates).where(eq(providerStates.cacheKey, key)).get();
    if (state && this.options.persist !== false) {
      db.update(providerStates).set({
        lastError: String(error).slice(0, 500),
        ...(this.options.strict ? { expiresAt: timestamp(), staleUntil: timestamp() } : {}),
      }).where(eq(providerStates.id, state.id)).run();
    }
    return stale === undefined ? undefined : {
      ...(stale as object),
      _stale: true,
      _error: String(error),
    };
  }
}
