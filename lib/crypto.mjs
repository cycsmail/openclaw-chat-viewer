import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { getArchiveMode, getArchiveSecret } from "./config.mjs";

export function getArchiveKeyMaterial() {
  if (getArchiveMode() !== "sensitive") {
    return null;
  }
  const secret = getArchiveSecret();
  if (!secret) {
    throw new Error("Sensitive archive mode requires OPENCLAW_ARCHIVE_SECRET");
  }
  return scryptSync(secret, "openclaw-chat-viewer-archive", 32);
}

export function encryptArchiveBlob(raw) {
  const key = getArchiveKeyMaterial();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    mode: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64")
  });
}

export function decryptArchiveBlob(stored) {
  const payload = JSON.parse(stored);
  if (!payload || payload.mode !== "aes-256-gcm") {
    throw new Error("Invalid encrypted archive payload");
  }
  const key = getArchiveKeyMaterial();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}
