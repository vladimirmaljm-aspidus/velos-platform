import { createHash, randomBytes } from "crypto";
import { getSupabase } from "@/lib/supabase/client";

const RESET_TTL_MS = 60 * 60 * 1000;

export function generateResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreateResetInput {
  targetType: "user" | "portal_access";
  targetId: string;
  tenantId: string | null;
  ip?: string | null;
  userAgent?: string | null;
  ttlMs?: number;
}

export async function createPasswordReset(input: CreateResetInput): Promise<{ token: string; expiresAt: string }> {
  const { token, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + (input.ttlMs || RESET_TTL_MS)).toISOString();
  const supabase = getSupabase();

  // Invalidate outstanding tokens for this target so only the latest works.
  await supabase
    .from("password_resets")
    .update({ used_at: new Date().toISOString() })
    .eq("target_type", input.targetType)
    .eq("target_id", input.targetId)
    .is("used_at", null);

  const { error } = await supabase.from("password_resets").insert({
    target_type: input.targetType,
    target_id: input.targetId,
    tenant_id: input.tenantId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    requested_ip: input.ip || null,
    requested_ua: input.userAgent || null,
  });
  if (error) throw new Error(`password_reset insert failed: ${error.message}`);
  return { token, expiresAt };
}

export interface ConsumeResetResult {
  ok: boolean;
  reason?: "not_found" | "expired" | "already_used";
  targetType?: "user" | "portal_access";
  targetId?: string;
  tenantId?: string | null;
}

export async function consumePasswordReset(token: string): Promise<ConsumeResetResult> {
  const tokenHash = hashResetToken(token);
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("password_resets")
    .select("id, target_type, target_id, tenant_id, expires_at, used_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: "not_found" };
  if (data.used_at) return { ok: false, reason: "already_used" };
  if (new Date(data.expires_at) < new Date()) return { ok: false, reason: "expired" };

  const { data: updated, error: markError } = await supabase
    .from("password_resets")
    .update({ used_at: new Date().toISOString() })
    .eq("id", data.id)
    .is("used_at", null)
    .select();
  if (markError) return { ok: false, reason: "not_found" };
  if (!updated || updated.length === 0) {
    // Token was already used by a concurrent request.
    return { ok: false, reason: "already_used" };
  }

  return {
    ok: true,
    targetType: data.target_type as "user" | "portal_access",
    targetId: data.target_id,
    tenantId: data.tenant_id,
  };
}
