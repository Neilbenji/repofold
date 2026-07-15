import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SourceStore {
  put(blobSha: string, content: string): Promise<void>;
  get(blobSha: string): Promise<string | null>;
  getMany(blobShas: string[]): Promise<Map<string, string>>;
  cleanup(): Promise<void>;
}

const SHA_RE = /^[a-f0-9]{40}$/;

/**
 * Per-job encrypted storage. The random key is never persisted, and files are
 * addressed only by validated blob SHA rather than repository-controlled paths.
 */
export class EncryptedTempSourceStore implements SourceStore {
  private constructor(
    private readonly root: string,
    private readonly key: Buffer,
  ) {}

  static async create(): Promise<EncryptedTempSourceStore> {
    const root = await mkdtemp(path.join(os.tmpdir(), "repofold-source-"));
    return new EncryptedTempSourceStore(root, randomBytes(32));
  }

  private target(blobSha: string) {
    if (!SHA_RE.test(blobSha)) throw new Error("invalid blob SHA");
    return path.join(this.root, blobSha);
  }

  async put(blobSha: string, content: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
    await writeFile(
      this.target(blobSha),
      Buffer.concat([nonce, cipher.getAuthTag(), encrypted]),
      { flag: "wx" },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }

  async get(blobSha: string): Promise<string | null> {
    let payload: Buffer;
    try {
      payload = await readFile(this.target(blobSha));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (payload.length < 28) throw new Error("corrupt temporary source object");
    const decipher = createDecipheriv("aes-256-gcm", this.key, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
  }

  async getMany(blobShas: string[]) {
    const unique = [...new Set(blobShas)];
    const rows = await Promise.all(unique.map(async (sha) => [sha, await this.get(sha)] as const));
    return new Map(rows.filter((row): row is readonly [string, string] => row[1] != null));
  }

  async cleanup() {
    this.key.fill(0);
    await rm(this.root, { recursive: true, force: true });
  }
}
