import { describe, it, expect } from "vitest";
import { validatePassword, DEFAULT_POLICY } from "@/lib/auth/password-policy";

describe("validatePassword", () => {
  it("accepts a password meeting the default policy", () => {
    const result = validatePassword("Str0ngPass");
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects passwords shorter than the minimum length", () => {
    const result = validatePassword("Ab1");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `Password must be at least ${DEFAULT_POLICY.minLength} characters long.`
    );
  });

  it("rejects passwords missing an uppercase letter", () => {
    const result = validatePassword("lowercase1");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Password must contain at least one uppercase letter.");
  });

  it("rejects passwords missing a number", () => {
    const result = validatePassword("NoNumbersHere");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Password must contain at least one number.");
  });

  it("flags known weak passwords even when they satisfy character rules", () => {
    const result = validatePassword("admin", {
      minLength: 3,
      requireUppercase: false,
      requireLowercase: false,
      requireNumbers: false,
      requireSymbols: false,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("This password is too common. Choose a more unique one.");
  });
});
