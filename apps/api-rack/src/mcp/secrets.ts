import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

/**
 * Encrypts resource secrets (API tokens) at rest with AES-256-GCM. The key is
 * derived from the rack secret, so a database dump alone never reveals them.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (!secret) throw new Error("SecretBox needs a non-empty secret");
    this.key = createHash("sha256").update(secret).digest();
  }

  seal(plain: string): string {
    if (!plain) return "";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
  }

  open(value: string): string {
    if (!value.startsWith(PREFIX)) return value;
    const [iv, tag, data] = value.slice(PREFIX.length).split(":");
    if (!iv || !tag || !data) throw new Error("Malformed encrypted value");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  static isSealed(value: string) {
    return value.startsWith(PREFIX);
  }
}
