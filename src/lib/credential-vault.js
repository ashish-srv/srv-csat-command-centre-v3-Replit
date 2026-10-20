const crypto = require("node:crypto");

function vaultKey() {
  const encoded = process.env.CREDENTIALS_ENCRYPTION_KEY || "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("Set CREDENTIALS_ENCRYPTION_KEY to a base64-encoded 32-byte key before saving Zoho passwords");
  return key;
}

function encryptCredential(value, projectId) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", vaultKey(), iv);
  cipher.setAAD(Buffer.from(String(projectId)));
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function decryptCredential(encoded, projectId) {
  if (!encoded) return "";
  const [version, iv, tag, value] = String(encoded).split(".");
  if (version !== "v1" || !iv || !tag || !value) throw new Error("Stored credential format is invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(String(projectId)));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value, "base64")), decipher.final()]).toString("utf8");
}

module.exports = { encryptCredential, decryptCredential };
