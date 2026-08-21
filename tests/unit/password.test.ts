import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("hashPassword / verifyPassword", () => {
  it("hashes a password and successfully verifies the same plaintext", async () => {
    const hash = await hashPassword("CorrectHorse1");
    expect(hash).not.toBe("CorrectHorse1");
    expect(await verifyPassword("CorrectHorse1", hash)).toBe(true);
  });

  it("rejects an incorrect plaintext against a real bcrypt hash", async () => {
    const hash = await hashPassword("CorrectHorse1");
    expect(await verifyPassword("WrongPassword", hash)).toBe(false);
  });

  it("supports the mock$ hash format used by the mock data backend", async () => {
    const mockHash = "mock$" + Buffer.from("plaintext").toString("base64");
    expect(await verifyPassword("plaintext", mockHash)).toBe(true);
    expect(await verifyPassword("wrong", mockHash)).toBe(false);
  });

  it("does not throw on a malformed hash", async () => {
    await expect(verifyPassword("anything", "not-a-real-hash")).resolves.toBe(false);
  });
});
