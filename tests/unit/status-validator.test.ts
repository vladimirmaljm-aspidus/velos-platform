import { describe, it, expect } from "vitest";
import { validateStatusTransition } from "@/lib/api/status-validator";

describe("validateStatusTransition", () => {
  it("allows a no-op transition (same status)", () => {
    expect(validateStatusTransition("invoice", "paid", "paid")).toEqual({ valid: true });
    expect(validateStatusTransition("offer", "draft", "draft")).toEqual({ valid: true });
  });

  it("allows valid forward transitions", () => {
    expect(validateStatusTransition("offer", "draft", "sent")).toEqual({ valid: true });
    expect(validateStatusTransition("offer", "sent", "accepted")).toEqual({ valid: true });
    expect(validateStatusTransition("invoice", "sent", "paid")).toEqual({ valid: true });
    expect(validateStatusTransition("invoice", "partial", "paid")).toEqual({ valid: true });
    expect(validateStatusTransition("proforma", "accepted", "paid")).toEqual({ valid: true });
    expect(validateStatusTransition("deal", "lead", "qualified")).toEqual({ valid: true });
    expect(validateStatusTransition("deal", "negotiation", "won")).toEqual({ valid: true });
  });

  it("blocks reverting a finalised status (paid→draft)", () => {
    const r = validateStatusTransition("invoice", "paid", "draft");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Cannot change invoice status from "paid" to "draft"/);
  });

  it("blocks transitions out of terminal states (won/lost/cancelled)", () => {
    expect(validateStatusTransition("deal", "won", "negotiation").valid).toBe(false);
    expect(validateStatusTransition("deal", "lost", "lead").valid).toBe(false);
    expect(validateStatusTransition("offer", "cancelled", "draft").valid).toBe(false);
    expect(validateStatusTransition("invoice", "cancelled", "sent").valid).toBe(false);
    expect(validateStatusTransition("proforma", "expired", "accepted").valid).toBe(false);
  });

  it("blocks unknown current status", () => {
    const r = validateStatusTransition("offer", "frobulating", "draft");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Allowed transitions: none/);
  });

  it("blocks unknown new status", () => {
    const r = validateStatusTransition("invoice", "draft", "frobnicated");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Cannot change invoice status from "draft" to "frobnicated"/);
  });

  it("lists the allowed transitions in the error message", () => {
    const r = validateStatusTransition("deal", "proposal", "lead");
    expect(r.valid).toBe(false);
    // proposal allows: negotiation, won, lost
    expect(r.error).toMatch(/Allowed transitions: negotiation, won, lost/);
  });

  it("allows reverting an offer from sent back to draft (per state machine)", () => {
    // sent → draft is explicitly allowed (offers may need to be reopened for editing).
    expect(validateStatusTransition("offer", "sent", "draft")).toEqual({ valid: true });
  });
});
