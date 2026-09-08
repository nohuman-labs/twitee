import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

export type CredentialStore = {
  read(): Promise<string | null>;
  write(storageState: string): Promise<void>;
  remove(): Promise<void>;
};

type EncryptedCredential = {
  readonly version: 1;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
};

export function createCredentialStore(options: {
  readonly path: string;
  readonly encryptionKey: string;
}): CredentialStore {
  if (options.encryptionKey.length < 32) {
    throw new Error("encryption key must contain at least 32 characters");
  }
  const key = createHash("sha256").update(options.encryptionKey).digest();

  return {
    async read() {
      let serialized: string;
      try {
        serialized = await readFile(options.path, "utf8");
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }

      try {
        const record = parseRecord(serialized);
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(record.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(record.tag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(record.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("credential decrypt failed");
      }
    },

    async write(storageState) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(storageState, "utf8"),
        cipher.final(),
      ]);
      const record: EncryptedCredential = {
        version: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      const directory = dirname(options.path);
      const temporaryPath = `${options.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await mkdir(directory, { recursive: true, mode: 0o700 });

      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(temporaryPath, "wx", 0o600);
        await file.writeFile(JSON.stringify(record));
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporaryPath, options.path);
        await chmod(options.path, 0o600);
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (error) {
        await file?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },

    async remove() {
      try {
        await unlink(options.path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}

function parseRecord(value: string): EncryptedCredential {
  const parsed = JSON.parse(value) as Partial<EncryptedCredential>;
  if (
    parsed.version !== 1 ||
    typeof parsed.iv !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new Error("invalid credential envelope");
  }
  return parsed as EncryptedCredential;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
