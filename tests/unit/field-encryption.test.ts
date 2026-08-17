import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptField,
  decryptField,
  isEncrypted,
  encryptSensitiveFields,
  decryptSensitiveFields,
  COMMS_SENSITIVE_KEYS,
} from "@/lib/crypto/field-encryption";

// Field-encryption unit tests.
//
// Covers the wire-format round trip, the `enc:` prefix marker, the
// non-deterministic IV (two encryptions of the same plaintext must NOT
// produce the same ciphertext — defeats equality leakage), the legacy
// plaintext pass-through (rollback safety), the wrong-key failure mode
// (tamper detection), and the multi-key encrypt/decrypt helpers used
// by the settings + email routes.

describe("field-encryption — round trip", () => {
  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = "test-field-key-0123456789-abcdefghijklmnopqrstuvwxyz";
  });
  afterEach(() => {
    delete process.env.FIELD_ENCRYPTION_KEY;
  });

  it("encrypts and decrypts a value back to the original plaintext", () => {
    const original = "super-secret-smtp-password-12345";
    const encrypted = encryptField(original);
    expect(encrypted).not.toBe(original);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptField(encrypted)).toBe(original);
  });

  it("returns the empty string unchanged", () => {
    expect(encryptField("")).toBe("");
    expect(decryptField("")).toBe("");
  });

  it("produces the `enc:` prefix marker", () => {
    const encrypted = encryptField("hello");
    expect(encrypted.startsWith("enc:")).toBe(true);
  });

  it("produces DIFFERENT ciphertexts for the same plaintext (random IV)", () => {
    // AES-256-GCM with a per-value random IV → non-deterministic.
    // This is the right default for security (no equality leakage),
    // but it BREAKS equality search — see the field-encryption module
    // docs for the searchability caveat.
    const a = encryptField("same-value");
    const b = encryptField("same-value");
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe("same-value");
    expect(decryptField(b)).toBe("same-value");
  });

  it("handles unicode plaintext", () => {
    const original = "Straße — café — 日本語 — \\\"&<>";
    const encrypted = encryptField(original);
    expect(decryptField(encrypted)).toBe(original);
  });

  it("handles long plaintext (10 KB)", () => {
    const original = "x".repeat(10_000);
    const encrypted = encryptField(original);
    expect(decryptField(encrypted)).toBe(original);
  });
});

describe("field-encryption — legacy + failure modes", () => {
  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = "test-field-key-0123456789-abcdefghijklmnopqrstuvwxyz";
  });
  afterEach(() => {
    delete process.env.FIELD_ENCRYPTION_KEY;
  });

  it("passes legacy plaintext through untouched on decrypt", () => {
    // A value that was never encrypted — e.g. a row written before
    // the field-encryption rollout. decryptField MUST return it as-is
    // so the table stays readable during the migration window.
    expect(decryptField("legacy@example.com")).toBe("legacy@example.com");
    expect(decryptField("not-an-enc-prefixed-value")).toBe("not-an-enc-prefixed-value");
  });

  it("returns the raw blob (not a guessed plaintext) on decrypt failure", () => {
    // Simulate a tampered ciphertext — flip the last byte of the data
    // segment. GCM's auth tag MUST reject this, and decryptField MUST
    // return the raw input (fail-closed for security — no silent
    // downgrade to a guessed plaintext).
    const original = "secret-password";
    const encrypted = encryptField(original);
    const parts = encrypted.split(":");
    // Tamper with the data segment (last part).
    const dataB64 = parts[4];
    const tampered = dataB64.slice(0, -2) + (dataB64.slice(-2) === "AA" ? "BB" : "AA");
    parts[4] = tampered;
    const tamperedEncrypted = parts.join(":");
    // On tamper, decryptField returns the raw input (the tampered blob),
    // NOT the original plaintext.
    expect(decryptField(tamperedEncrypted)).toBe(tamperedEncrypted);
  });

  it("returns the raw blob when the key has rotated away", () => {
    // Encrypt with key A, then change the env var to key B, then decrypt.
    // decryptField MUST return the raw blob (key mismatch → auth tag
    // verification fails), NOT a decrypted-with-the-wrong-key value.
    process.env.FIELD_ENCRYPTION_KEY = "key-A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const encrypted = encryptField("secret-with-key-a");
    process.env.FIELD_ENCRYPTION_KEY = "key-B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(decryptField(encrypted)).toBe(encrypted); // raw blob, not plaintext
  });

  it("returns the raw blob when the wire format is malformed", () => {
    expect(decryptField("enc:only-three-segments-here")).toBe("enc:only-three-segments-here");
    // Missing segments — decryptField bails out, returns as-is.
    expect(decryptField("enc::::")).toBe("enc::::");
  });

  it("isEncrypted identifies only `enc:`-prefixed strings", () => {
    expect(isEncrypted(encryptField("x"))).toBe(true);
    expect(isEncrypted("plain@x.com")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted(42)).toBe(false);
  });
});

describe("field-encryption — multi-key helpers (settings + email)", () => {
  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = "test-field-key-0123456789-abcdefghijklmnopqrstuvwxyz";
  });
  afterEach(() => {
    delete process.env.FIELD_ENCRYPTION_KEY;
  });

  it("encrypts only the listed sensitive keys; leaves other keys untouched", () => {
    const comms = {
      email_provider: "smtp" as const,
      smtp_host: "smtp.example.com",
      smtp_port: 587,
      smtp_user: "user@example.com",
      smtp_password: "super-secret-password",
      resend_api_key: "re_abcdef",
      postmark_server_token: "pm-xyz",
      from_name: "VELOS",
      from_email: "noreply@example.com",
    };
    const encrypted = encryptSensitiveFields(comms, COMMS_SENSITIVE_KEYS);
    // Sensitive keys are encrypted.
    expect(isEncrypted(encrypted.smtp_password)).toBe(true);
    expect(isEncrypted(encrypted.resend_api_key)).toBe(true);
    expect(isEncrypted(encrypted.postmark_server_token)).toBe(true);
    // Non-sensitive keys are untouched.
    expect(encrypted.smtp_host).toBe("smtp.example.com");
    expect(encrypted.smtp_port).toBe(587);
    expect(encrypted.from_name).toBe("VELOS");
    expect(encrypted.from_email).toBe("noreply@example.com");
  });

  it("is idempotent — re-encrypting an already-encrypted blob is a no-op", () => {
    const comms = { smtp_password: "plain-pw" };
    const once = encryptSensitiveFields(comms, COMMS_SENSITIVE_KEYS);
    const twice = encryptSensitiveFields(once, COMMS_SENSITIVE_KEYS);
    expect(twice.smtp_password).toBe(once.smtp_password);
  });

  it("leaves empty-string sensitive values untouched (no `enc::::` degenerate)", () => {
    const comms = { smtp_password: "", resend_api_key: "" };
    const encrypted = encryptSensitiveFields(comms, COMMS_SENSITIVE_KEYS);
    expect(encrypted.smtp_password).toBe("");
    expect(encrypted.resend_api_key).toBe("");
  });

  it("leaves non-string sensitive values untouched", () => {
    // Defensive — a misconfigured payload where a sensitive key
    // carries a number instead of a string. Should not throw and
    // should not stringify-and-encrypt the number.
    const comms = { smtp_password: 12345 as unknown as string };
    const encrypted = encryptSensitiveFields(comms, COMMS_SENSITIVE_KEYS);
    expect(encrypted.smtp_password).toBe(12345);
  });

  it("decrypts the listed sensitive keys back to plaintext", () => {
    const comms = {
      smtp_password: "secret-pw",
      resend_api_key: "re_xyz",
      postmark_server_token: "pm-abc",
      smtp_host: "smtp.example.com",
    };
    const encrypted = encryptSensitiveFields(comms, COMMS_SENSITIVE_KEYS);
    const decrypted = decryptSensitiveFields(encrypted, COMMS_SENSITIVE_KEYS);
    expect(decrypted.smtp_password).toBe("secret-pw");
    expect(decrypted.resend_api_key).toBe("re_xyz");
    expect(decrypted.postmark_server_token).toBe("pm-abc");
    expect(decrypted.smtp_host).toBe("smtp.example.com"); // untouched
  });

  it("decryptSensitiveFields passes legacy plaintext through untouched", () => {
    // Rollout safety: a comms blob written before field-encryption has
    // plaintext smtp_password. decryptSensitiveFields MUST return it
    // as-is (so the email service can still send mail during rollout).
    const legacy = {
      smtp_password: "legacy-plaintext-pw",
      resend_api_key: "re_legacy",
      smtp_host: "smtp.example.com",
    };
    const decrypted = decryptSensitiveFields(legacy, COMMS_SENSITIVE_KEYS);
    expect(decrypted.smtp_password).toBe("legacy-plaintext-pw");
    expect(decrypted.resend_api_key).toBe("re_legacy");
    expect(decrypted.smtp_host).toBe("smtp.example.com");
  });

  it("handles null/undefined inputs without throwing", () => {
    expect(encryptSensitiveFields(null as any, COMMS_SENSITIVE_KEYS)).toBe(null);
    expect(encryptSensitiveFields(undefined as any, COMMS_SENSITIVE_KEYS)).toBe(undefined);
    expect(decryptSensitiveFields(null as any, COMMS_SENSITIVE_KEYS)).toBe(null);
    expect(decryptSensitiveFields(undefined as any, COMMS_SENSITIVE_KEYS)).toBe(undefined);
  });
});

describe("field-encryption — fallback to SECRET_KEY", () => {
  afterEach(() => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    delete process.env.SECRET_KEY;
  });

  it("falls back to SECRET_KEY when FIELD_ENCRYPTION_KEY is unset", () => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    process.env.SECRET_KEY = "fallback-secret-key-0123456789-abcd";
    const encrypted = encryptField("some-secret");
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptField(encrypted)).toBe("some-secret");
  });

  it("uses a non-secret 'fallback' string when no env is set (dev/test only)", () => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    delete process.env.SECRET_KEY;
    const encrypted = encryptField("dev-secret");
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptField(encrypted)).toBe("dev-secret");
  });
});
