// Encrypts a real Orbio key at rest so a leaked disk snapshot never exposes
// it in plaintext. AES-256-GCM, key derived from a server-side secret that
// never leaves the process. The plaintext key is never logged and never
// returned in any API response after the moment it's first validated.
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";

function deriveKey() {
  const secret = process.env.MESH_ENC_SECRET;
  if (!secret) {
    // Fail loud in a real deployment; a missing secret must never silently
    // fall back to something guessable when real user keys are at stake.
    if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT)
      throw new Error("MESH_ENC_SECRET is required to store connected accounts in production");
    console.error("[crypto] MESH_ENC_SECRET not set — using an insecure dev-only key. Do not use in production.");
  }
  return scryptSync(secret || "dev-only-insecure-secret", "orbio-mesh-accounts", 32);
}

export function encryptSecret(plain) {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("hex"), tag: tag.toString("hex"), data: enc.toString("hex") };
}

export function decryptSecret(blob) {
  const key = deriveKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(blob.data, "hex")), decipher.final()]);
  return dec.toString("utf8");
}
