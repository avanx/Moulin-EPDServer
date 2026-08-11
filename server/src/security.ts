import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import argon2 from "argon2";
import fernet from "fernet";

import { config, getMasterKey } from "./config.js";

const passwordOptions = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
} as const;

function tokenUrlSafe(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function fernetSecret(masterKey = getMasterKey()): fernet.Secret {
  const key = createHash("sha256")
    .update(masterKey, "utf8")
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return new fernet.Secret(key);
}

export async function hashPassword(value: string): Promise<string> {
  return argon2.hash(value, passwordOptions);
}

export async function verifyPassword(
  hashed: string,
  value: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hashed, value);
  } catch {
    return false;
  }
}

export function encryptSecret(value: string): string {
  const token = new fernet.Token({
    secret: fernetSecret(),
  });
  return token.encode(value);
}

export function decryptSecret(value: string): string {
  try {
    const token = new fernet.Token({
      secret: fernetSecret(),
      token: value,
      ttl: 0,
    });
    return token.decode();
  } catch (error) {
    throw new Error("Secret cannot be decrypted with EPD_MASTER_KEY", {
      cause: error,
    });
  }
}

export function generateEd25519KeyPairPem(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function publicKeyPemFromPrivateKeyPem(privateKeyPem: string): string {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Expected an Ed25519 private key");
    }
    return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  } catch (error) {
    throw new Error("Invalid Ed25519 private key PEM", { cause: error });
  }
}

export interface ApiKey {
  raw: string;
  prefix: string;
  digest: string;
}

export function makeApiKey(): ApiKey {
  const raw = `epd_${tokenUrlSafe(32)}`;
  return {
    raw,
    prefix: raw.slice(0, 12),
    digest: createHash("sha256").update(raw, "utf8").digest("hex"),
  };
}

export function verifyApiKey(raw: string, expectedDigest: string): boolean {
  const digest = createHash("sha256").update(raw, "utf8").digest("hex");
  return constantTimeEqual(digest, expectedDigest);
}

export function apiKeyPrefix(raw: string): string {
  return raw.slice(0, 12);
}

export interface AdminSessionValues {
  id: string;
  userId: string;
  csrfToken: string;
  expiresAt: string;
}

function pythonSqliteDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "000");
}

export function makeAdminSession(
  userId: string,
  sessionHours = config.sessionHours,
  now = new Date(),
): AdminSessionValues {
  return {
    id: tokenUrlSafe(32),
    userId,
    csrfToken: tokenUrlSafe(24),
    expiresAt: pythonSqliteDateTime(
      new Date(now.getTime() + sessionHours * 60 * 60 * 1000),
    ),
  };
}

export function isSessionExpired(expiresAt: string, now = new Date()): boolean {
  return databaseTimestampMillis(expiresAt) <= now.getTime();
}

/** SQLAlchemy stored timezone-aware UTC datetimes as naive SQLite text. */
export function databaseTimestampMillis(value: string): number {
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/u.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  return Date.parse(normalized);
}

export function verifyCsrfToken(
  method: string,
  supplied: string | undefined,
  expected: string,
): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return true;
  return constantTimeEqual(supplied ?? "", expected);
}
