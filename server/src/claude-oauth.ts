import { createHash, randomBytes } from "node:crypto";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REDIRECT_URI = "http://localhost:18924/callback";
const SCOPES = "user:inference user:profile";
const USER_AGENT = "claude-code/2.0.32";
const REFRESH_BUFFER_MS = 600_000;
const PENDING_TTL_MS = 600_000;

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface ClaudeCodeUsage {
  fiveHourPercent: number;
  sevenDayPercent: number;
  fiveHourResetsAt: string | null;
  sevenDayResetsAt: string | null;
}

export class ClaudeAuthError extends Error {
  constructor(message = "TOKEN_EXPIRED") {
    super(message);
    this.name = "ClaudeAuthError";
  }
}

interface PendingAuthorization {
  verifier: string;
  expiresAt: number;
}

const pendingAuthorizations = new Map<string, PendingAuthorization>();

function prunePendingAuthorizations(now = Date.now()): void {
  for (const [state, pending] of pendingAuthorizations) {
    if (pending.expiresAt <= now) pendingAuthorizations.delete(state);
  }
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function serializeClaudeOAuthCredentials(credentials: ClaudeOAuthCredentials): string {
  return JSON.stringify({
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
  });
}

export function parseClaudeOAuthCredentials(value: string): ClaudeOAuthCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Claude credentials must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude credentials must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const refreshToken = String(record.refreshToken ?? record.refresh_token ?? "").trim();
  const accessToken = String(record.accessToken ?? record.access_token ?? "").trim();
  const expiresAt = Number(record.expiresAt ?? record.expires_at ?? 0);
  if (!refreshToken) throw new Error("Claude credentials must include refreshToken");
  return {
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

export function claudeTokenNeedsRefresh(credentials: ClaudeOAuthCredentials, now = Date.now()): boolean {
  return !credentials.accessToken || now >= credentials.expiresAt - REFRESH_BUFFER_MS;
}

export function createClaudeAuthorization(): { authorizationUrl: string; state: string } {
  prunePendingAuthorizations();
  const verifier = randomBytes(64).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  pendingAuthorizations.set(state, { verifier, expiresAt: Date.now() + PENDING_TTL_MS });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  return { authorizationUrl: `${AUTHORIZE_URL}?${params.toString()}`, state };
}

function authorizationCodeFromCallback(callbackUrl: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(callbackUrl.trim());
  } catch {
    throw new Error("Callback URL is invalid");
  }
  const returnedState = url.searchParams.get("state");
  if (returnedState && returnedState !== expectedState) {
    throw new Error("Authorization state does not match. Start again.");
  }
  const queryCode = url.searchParams.get("code")?.trim();
  if (queryCode) return queryCode;
  const fragment = url.hash.replace(/^#/, "");
  if (fragment) {
    const fragmentCode = new URLSearchParams(fragment).get("code")?.trim();
    if (fragmentCode) return fragmentCode;
    const bare = fragment.split("&")[0]?.trim();
    if (bare && !bare.includes("=")) return bare;
  }
  throw new Error("Authorization code is missing from the callback URL");
}

async function readTokenResponse(response: Response, failureLabel: string): Promise<Record<string, unknown>> {
  if (response.status === 401 || response.status === 403) throw new ClaudeAuthError();
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 400 && text.includes("invalid_grant")) throw new ClaudeAuthError();
    throw new Error(`${failureLabel} (${response.status})`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${failureLabel} returned an invalid response`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ClaudeAuthError || (error instanceof Error && error.message.startsWith(failureLabel))) {
      throw error;
    }
    throw new Error(`${failureLabel} returned an invalid response`);
  }
}

function credentialsFromToken(data: Record<string, unknown>, previous?: ClaudeOAuthCredentials): ClaudeOAuthCredentials {
  const accessToken = String(data.access_token ?? "").trim();
  const refreshToken = String(data.refresh_token ?? previous?.refreshToken ?? "").trim();
  const expiresIn = Number(data.expires_in ?? 28800);
  if (!accessToken || !refreshToken) throw new Error("Claude token response is missing credentials");
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 28800) * 1000,
  };
}

export async function exchangeClaudeAuthorization(callbackUrl: string, state: string): Promise<string> {
  prunePendingAuthorizations();
  const pending = pendingAuthorizations.get(state);
  if (!pending) throw new Error("Claude authorization expired. Start again.");
  const code = authorizationCodeFromCallback(callbackUrl, state);
  pendingAuthorizations.delete(state);
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: pending.verifier,
        state,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await readTokenResponse(response, "Claude token exchange failed");
    return serializeClaudeOAuthCredentials(credentialsFromToken(data));
  } catch (error) {
    if (error instanceof ClaudeAuthError) throw new Error("Claude authorization was rejected. Start again.");
    throw error;
  }
}

export async function refreshClaudeAccessToken(credentials: ClaudeOAuthCredentials): Promise<ClaudeOAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await readTokenResponse(response, "Claude token refresh failed");
  return credentialsFromToken(data, credentials);
}

function usageWindow(value: unknown): { percent: number; resetsAt: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { percent: 0, resetsAt: null };
  const record = value as Record<string, unknown>;
  const utilization = Number(record.utilization ?? 0);
  const resetsAt = record.resets_at;
  return {
    percent: Number.isFinite(utilization) ? utilization : 0,
    resetsAt: typeof resetsAt === "string" && resetsAt ? resetsAt : null,
  };
}

export async function fetchClaudeUsage(accessToken: string): Promise<ClaudeCodeUsage> {
  if (!accessToken) throw new Error("Claude access token is missing");
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new ClaudeAuthError();
  if (!response.ok) throw new Error(`Claude usage request failed (${response.status})`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Claude usage response is not JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Claude usage response is invalid");
  }
  const record = payload as Record<string, unknown>;
  const fiveHour = usageWindow(record.five_hour);
  const sevenDay = usageWindow(record.seven_day);
  return {
    fiveHourPercent: fiveHour.percent,
    sevenDayPercent: sevenDay.percent,
    fiveHourResetsAt: fiveHour.resetsAt,
    sevenDayResetsAt: sevenDay.resetsAt,
  };
}
