type RpcRequest = {
  kind: "rpc";
  id: string;
  method: "request" | "getSecret" | "bambuPrinterStatus" | "klipperPrinterStatus" | "cacheRead" | "cacheSuccess" | "cacheFailure";
  args: unknown[];
};

type RpcResult = {
  kind: "rpc-result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

type RunRequest = {
  kind: "run";
  code: string;
  operation: "all" | "adapt";
  config: Record<string, unknown>;
  source?: unknown;
  locale: string;
};

const channel = process;
let sequence = 0;
const pending = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>();

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function rpc(method: RpcRequest["method"], ...args: unknown[]): Promise<unknown> {
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    channel.send?.({ kind: "rpc", id, method, args } satisfies RpcRequest);
  });
}

channel.on("message", (message: RpcResult | RunRequest) => {
  if (message.kind === "rpc-result") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(message.error ?? "Data service RPC failed"));
    return;
  }
  if (message.kind === "run") void execute(message);
});

async function execute(message: RunRequest): Promise<void> {
  try {
    Object.defineProperties(globalThis, {
      fetch: { value: undefined, configurable: false, writable: false },
      WebSocket: { value: undefined, configurable: false, writable: false },
      process: { value: undefined, configurable: false, writable: false },
    });
    const services = {
      async request(input: string, init: RequestInit & { secretCookies?: Record<string, string> } = {}) {
        const result = await rpc("request", input, init) as {
          body: string;
          status: number;
          statusText: string;
          headers: Record<string, string>;
        };
        return new Response(Uint8Array.from(atob(result.body), (character) => character.charCodeAt(0)), {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
        });
      },
      async getSecret(idOrName: string) {
        return await rpc("getSecret", idOrName) as string;
      },
      async bambuPrinterStatus(options: { host: string; serial: string; accessSecretId: string }) {
        return await rpc("bambuPrinterStatus", options) as {
          status: string;
          percentage: number;
          remainingMinutes: number;
          currentLayer: number;
          totalLayers: number;
          taskName: string;
        };
      },
      async klipperPrinterStatus(options: {
        host: string;
        port?: number;
        compatibility: "general" | "snapmaker_u1";
        apiSecretId?: string;
      }) {
        return await rpc("klipperPrinterStatus", options) as {
          status: string;
          percentage: number;
          remainingMinutes: number;
          currentLayer: number;
          totalLayers: number;
          taskName: string;
        };
      },
      async cachedProvider<T>(
        key: string,
        options: { ttlSeconds: number; staleSeconds?: number },
        fetcher: () => Promise<T>,
      ): Promise<T> {
        const cached = await rpc("cacheRead", key) as
          | { status: "fresh"; value: T }
          | { status: "miss"; stale?: T };
        if (cached.status === "fresh") return cached.value;
        try {
          const value = await fetcher();
          return await rpc("cacheSuccess", key, options, value) as T;
        } catch (error) {
          const fallback = await rpc("cacheFailure", key, String(error), cached.stale) as {
            available: boolean;
            value?: T;
          };
          if (fallback.available) return fallback.value as T;
          throw error;
        }
      },
    };
    const moduleUrl = `data:text/javascript;base64,${base64(message.code)}#${crypto.randomUUID()}`;
    const dataModule = await import(moduleUrl) as {
      fetchData?: (
        context: { services: typeof services; locale: string },
        config: Record<string, unknown>,
      ) => Promise<unknown>;
      adaptData?: (source: unknown, config: Record<string, unknown>) => unknown;
    };
    const source = message.operation === "all"
      ? dataModule.fetchData
        ? await dataModule.fetchData({ services, locale: message.locale }, message.config)
        : {}
      : message.source;
    const value = dataModule.adaptData
      ? await dataModule.adaptData(source, message.config)
      : source;
    channel.send?.({ kind: "done", ok: true, value });
  } catch (error) {
    channel.send?.({
      kind: "done",
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}
