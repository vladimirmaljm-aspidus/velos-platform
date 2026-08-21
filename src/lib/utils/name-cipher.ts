/**
 * Name cipher: masks a name while keeping it verifiable.
 * 
 * Format: first letter + count of middle letters + last letter
 * All lowercase, no spaces.
 * 
 * Examples:
 *   "Marko Petrovic" → "m3op6c"
 *   "VELOS" → "a5s3c"
 *   "John Smith" → "j2n4h"
 *   "AB" → "ab" (too short to mask)
 *   "" → ""
 * 
 * For multi-word names, each word is ciphered independently and joined.
 * For company names, same logic applies.
 */

export function cipherName(name: string | null | undefined): string {
  if (!name || typeof name !== "string") return "—";
  
  const trimmed = name.trim();
  if (trimmed.length === 0) return "—";
  
  // Split into words (handles spaces, multiple spaces)
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  
  const cipheredWords = words.map(word => {
    const lower = word.toLowerCase();
    // Remove non-alpha characters for counting (keep for display)
    const alphaOnly = lower.replace(/[^a-z]/g, "");
    
    if (alphaOnly.length <= 2) {
      // Too short to mask — return as-is (lowercased)
      return alphaOnly;
    }
    
    const first = alphaOnly[0];
    const last = alphaOnly[alphaOnly.length - 1];
    const middleCount = alphaOnly.length - 2; // letters between first and last
    
    return `${first}${middleCount}${last}`;
  });
  
  return cipheredWords.join("");
}

/**
 * Decode a ciphered name back to original (for admin view).
 * This is NOT reverse-engineerable — it's one-way.
 * The original name must be looked up from the partner record.
 * This function just formats the cipher for display.
 */
export function formatCipheredName(name: string | null | undefined): string {
  return cipherName(name);
}
