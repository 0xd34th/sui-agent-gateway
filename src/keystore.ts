import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { AppConfig } from "./config.js";
import { writeJsonFile } from "./storage.js";

type EncryptedWallet = {
  version: 1;
  address: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export class Keystore {
  constructor(private readonly config: AppConfig) {}

  exists(): boolean {
    return existsSync(this.config.keystorePath);
  }

  create(overwrite = false): { address: string; created: boolean } {
    if (this.exists() && !overwrite) {
      return { address: this.load().toSuiAddress(), created: false };
    }

    const keypair = Ed25519Keypair.generate();
    this.saveSecretKey(keypair.getSecretKey(), keypair.toSuiAddress());
    return { address: keypair.toSuiAddress(), created: true };
  }

  clear(): void {
    if (this.exists()) unlinkSync(this.config.keystorePath);
  }

  load(): Ed25519Keypair {
    if (!this.exists()) {
      throw new Error("No agent wallet exists. Call create_agent_wallet first.");
    }

    const encrypted = JSON.parse(readFileSync(this.config.keystorePath, "utf8")) as EncryptedWallet;
    const key = this.deriveKey(encrypted.salt);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    const secret = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return Ed25519Keypair.fromSecretKey(secret);
  }

  getAddress(): string | null {
    if (!this.exists()) return null;
    const encrypted = JSON.parse(readFileSync(this.config.keystorePath, "utf8")) as EncryptedWallet;
    return encrypted.address;
  }

  private saveSecretKey(secretKey: string, address: string): void {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = this.deriveKey(salt.toString("base64"));
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(secretKey, "utf8"), cipher.final()]);

    writeJsonFile(this.config.keystorePath, {
      version: 1,
      address,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    } satisfies EncryptedWallet);
  }

  private deriveKey(salt: string): Buffer {
    return pbkdf2Sync(this.config.keystoreSecret, Buffer.from(salt, "base64"), 210_000, 32, "sha256");
  }
}

