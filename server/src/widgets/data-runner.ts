import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

import type { WidgetManifest } from "./registry.js";
import { WidgetServices, type ServiceOptions } from "./services.js";

const COMPILED_LIMIT = 500_000;
const RESULT_LIMIT = 2_000_000;
const cache = new Map<string, string>();

export interface DataRunOptions extends ServiceOptions {
  locale?: string;
  timeoutMs?: number;
}

export interface DataRunInput {
  type: string;
  manifest: WidgetManifest;
  source: string;
  config: Record<string, unknown>;
  operation: "all" | "adapt";
  input?: unknown;
  options?: DataRunOptions;
}

function validateCode(source: string): void {
  const runtimeSource = source.replace(/\bimport\s+type\b[\s\S]*?;\s*/g, "");
  const forbidden = [
    [/\bimport\s*(?:\(|["'{*])/m, "runtime imports"],
    [/\brequire\s*\(/m, "require"],
    [/\b(?:eval|Function)\s*\(/m, "dynamic code evaluation"],
    [/\bnew\s+Function\b/m, "dynamic code evaluation"],
    [/\bnode:/m, "Node built-in modules"],
  ] as const;
  for (const [pattern, name] of forbidden) {
    if (pattern.test(runtimeSource)) throw new Error(`Data source cannot use ${name}`);
  }
}

export async function compileDataSource(source: string): Promise<string> {
  validateCode(source);
  const hash = createHash("sha256").update(source).digest("hex");
  const cached = cache.get(hash);
  if (cached) return cached;
  const result = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "node22",
    sourcemap: "inline",
  });
  if (Buffer.byteLength(result.code, "utf8") > COMPILED_LIMIT) {
    throw new Error("Compiled data source is too large");
  }
  cache.set(hash, result.code);
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return result.code;
}

function allowedHosts(manifest: WidgetManifest): Set<string> {
  return new Set((manifest.externalData?.allowedHosts ?? []).map((host) => host.toLowerCase()));
}

function assertAllowedUrl(input: string, hosts: Set<string>): URL {
  const url = new URL(input);
  if (url.protocol !== "https:" || !hosts.has(url.hostname.toLowerCase())) {
    throw new Error(`Data source network access is not allowed: ${url.hostname}`);
  }
  return url;
}

async function restrictedRequest(
  services: WidgetServices,
  hosts: Set<string>,
  input: string,
  init: RequestInit & { secretCookies?: Record<string, string> } = {},
): Promise<{ body: string; status: number; statusText: string; headers: Record<string, string> }> {
  let url = assertAllowedUrl(input, hosts);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await services.request(url.href, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) break;
    url = assertAllowedUrl(new URL(location, url).href, hosts);
  }
  if (!response) throw new Error("Data source request failed");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > RESULT_LIMIT) throw new Error("Data source response exceeds 2 MB");
  return {
    body: body.toString("base64"),
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

/** IPC send that never crashes the parent if the child already exited. */
function ipcSend(child: ChildProcess, message: unknown): boolean {
  if (!child.connected || typeof child.send !== "function") return false;
  try {
    // Passing a callback routes send failures into the callback instead of an
    // unhandled 'error' event (ERR_IPC_CHANNEL_CLOSED), which would kill the server.
    return child.send(message as never, () => undefined);
  } catch {
    return false;
  }
}

function sendResult(child: ChildProcess, id: string, action: () => unknown | Promise<unknown>): void {
  void Promise.resolve().then(action).then(
    (value) => {
      ipcSend(child, { kind: "rpc-result", id, ok: true, value });
    },
    (error) => {
      ipcSend(child, { kind: "rpc-result", id, ok: false, error: String(error) });
    },
  );
}

export async function runDataSource(input: DataRunInput): Promise<unknown> {
  const code = await compileDataSource(input.source);
  const services = new WidgetServices(input.options);
  const hosts = allowedHosts(input.manifest);
  const secretField = input.manifest.externalData?.secretConfigField;
  const allowedSecret = secretField ? input.config[secretField] : undefined;
  const child = fork(fileURLToPath(new URL("./data-child.js", import.meta.url)), [], {
    execArgv: [...process.execArgv, "--max-old-space-size=64"],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const timeoutMs = input.options?.timeoutMs ?? 25_000;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep a no-op error handler so late IPC failures cannot crash the process
      // after we detach the rest of the listeners and kill the child.
      child.removeAllListeners();
      child.on("error", () => undefined);
      if (child.connected) child.kill();
      if (error) reject(error);
      else {
        try {
          const serialized = JSON.stringify(value);
          if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > RESULT_LIMIT) {
            throw new Error("Data source output exceeds 2 MB");
          }
          resolve(value);
        } catch (reason) {
          reject(new Error(`Data source returned an invalid value: ${String(reason)}`));
        }
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`Data source timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    child.on("error", (error) => finish(error));
    child.on("exit", (codeValue) => {
      if (!settled) finish(new Error(`Data source process exited unexpectedly (${codeValue ?? "signal"})`));
    });
    child.on("message", (message: any) => {
      if (settled) return;
      if (message?.kind === "done") {
        finish(message.ok ? undefined : new Error(message.error ?? "Data source failed"), message.value);
        return;
      }
      if (message?.kind !== "rpc" || typeof message.id !== "string") return;
      const args = Array.isArray(message.args) ? message.args : [];
      if (message.method === "request") {
        sendResult(child, message.id, () => restrictedRequest(
          services,
          hosts,
          String(args[0] ?? ""),
          (args[1] ?? {}) as RequestInit & { secretCookies?: Record<string, string> },
        ));
      } else if (message.method === "getSecret") {
        sendResult(child, message.id, async () => {
          const requested = String(args[0] ?? "");
          if (typeof allowedSecret !== "string" || requested !== allowedSecret) {
            throw new Error("Data source is not allowed to access this secret");
          }
          return services.getSecret(requested);
        });
      } else if (message.method === "bambuPrinterStatus") {
        sendResult(child, message.id, async () => {
          if (input.manifest.externalData?.provider !== "bambu-lan-mqtt") {
            throw new Error("Data source is not allowed to access a Bambu printer");
          }
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const accessSecretId = String(options.accessSecretId ?? "");
          if (typeof allowedSecret !== "string" || accessSecretId !== allowedSecret) {
            throw new Error("Data source is not allowed to access this secret");
          }
          return services.bambuPrinterStatus({
            host: String(options.host ?? ""),
            serial: String(options.serial ?? ""),
            accessSecretId,
          });
        });
      } else if (message.method === "klipperPrinterStatus") {
        sendResult(child, message.id, async () => {
          if (input.manifest.externalData?.provider !== "klipper-moonraker") {
            throw new Error("Data source is not allowed to access a Klipper printer");
          }
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const apiSecretId = String(options.apiSecretId ?? "").trim();
          if (apiSecretId && (typeof allowedSecret !== "string" || apiSecretId !== allowedSecret)) {
            throw new Error("Data source is not allowed to access this secret");
          }
          const compatibility = String(options.compatibility ?? "");
          if (compatibility !== "general" && compatibility !== "snapmaker_u1") {
            throw new Error("Unsupported Klipper compatibility mode");
          }
          const rawPort = Number(options.port ?? 0);
          return services.klipperPrinterStatus({
            host: String(options.host ?? ""),
            compatibility,
            ...(rawPort ? { port: rawPort } : {}),
            ...(apiSecretId ? { apiSecretId } : {}),
          });
        });
      } else if (message.method === "cacheRead") {
        sendResult(child, message.id, () => services.readProviderCache(`widget:${input.type}:${String(args[0])}`));
      } else if (message.method === "cacheSuccess") {
        sendResult(child, message.id, () => services.writeProviderSuccess(
          `widget:${input.type}:${String(args[0])}`,
          args[1] as { ttlSeconds: number; staleSeconds?: number },
          args[2],
        ));
      } else if (message.method === "cacheFailure") {
        sendResult(child, message.id, () => {
          const value = services.writeProviderFailure(
            `widget:${input.type}:${String(args[0])}`,
            args[1],
            args[2],
          );
          return { available: value !== undefined, value };
        });
      } else {
        ipcSend(child, { kind: "rpc-result", id: message.id, ok: false, error: "Unknown RPC method" });
      }
    });
    if (!ipcSend(child, {
      kind: "run",
      code,
      operation: input.operation,
      config: input.config,
      source: input.input,
      locale: input.options?.locale ?? "zh-CN",
    })) {
      finish(new Error("Data source process IPC channel closed before run"));
    }
  });
}
