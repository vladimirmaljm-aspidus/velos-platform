/**
 * Parse User-Agent string into device info.
 *
 * Used by the public document verification endpoint
 * (src/app/api/verify/[code]/route.ts) to record, alongside every
 * verification, what kind of device/browser/OS the verifier used.
 *
 * The parser is intentionally lightweight — no external deps — and
 * degrades gracefully to "unknown" rather than throwing. The output
 * is persisted to `document_verification_logs` for fraud-prevention
 * analysis by super-admins.
 *
 * Regexes cover the realistic modern UA space (Chrome, Edge, Firefox,
 * Safari, iOS Safari, Android Chrome, plus bot detection). Exotic
 * browsers fall through to the most-recent major-family match.
 */

export interface DeviceInfo {
  deviceType: string; // desktop | mobile | tablet | bot | unknown
  browser: string; // Chrome, Firefox, Safari, Edge, …
  browserVersion: string;
  os: string; // Windows, macOS, Linux, Android, iOS, …
  osVersion: string;
  deviceName: string; // e.g. "iPhone 15 Pro" or "Windows PC"
}

const UNKNOWN_DEVICE: DeviceInfo = {
  deviceType: "unknown",
  browser: "unknown",
  browserVersion: "",
  os: "unknown",
  osVersion: "",
  deviceName: "unknown",
};

export function parseUserAgent(ua: string | null): DeviceInfo {
  if (!ua) return { ...UNKNOWN_DEVICE };

  const lower = ua.toLowerCase();

  // ── Device type ──────────────────────────────────────────────────────
  let deviceType = "desktop";
  if (/bot|crawler|spider|scrap|headless/i.test(lower)) deviceType = "bot";
  else if (/mobile|android.*mobile|iphone|ipod/i.test(ua)) deviceType = "mobile";
  else if (/ipad|tablet|android(?!.*mobile)/i.test(ua)) deviceType = "tablet";

  // ── Browser (order matters — Edge before Chrome, Chrome before Safari) ─
  let browser = "Unknown";
  let browserVersion = "";
  if (/edg/i.test(ua)) {
    browser = "Edge";
    browserVersion = (ua.match(/edg\/([\d.]+)/i) || [])[1] || "";
  } else if (/chrome|crios|cr/i.test(ua) && !/edg/i.test(ua)) {
    browser = "Chrome";
    browserVersion = (ua.match(/chrome\/([\d.]+)/i) || [])[1] || "";
  } else if (/firefox|fxios/i.test(ua)) {
    browser = "Firefox";
    browserVersion = (ua.match(/firefox\/([\d.]+)/i) || [])[1] || "";
  } else if (/safari/i.test(ua) && !/chrome/i.test(ua)) {
    browser = "Safari";
    browserVersion = (ua.match(/version\/([\d.]+)/i) || [])[1] || "";
  }

  // ── OS ──────────────────────────────────────────────────────────────
  let os = "Unknown";
  let osVersion = "";
  if (/windows nt 10/i.test(ua)) {
    os = "Windows";
    osVersion = "10/11";
  } else if (/windows nt 6\.3/i.test(ua)) {
    os = "Windows";
    osVersion = "8.1";
  } else if (/windows/i.test(ua)) {
    os = "Windows";
  } else if (/mac os x/i.test(ua)) {
    os = "macOS";
    osVersion =
      (ua.match(/mac os x (\d+[._]\d+)/i) || [])[1]?.replace("_", ".") || "";
  } else if (/android/i.test(ua)) {
    os = "Android";
    osVersion = (ua.match(/android ([\d.]+)/i) || [])[1] || "";
  } else if (/iphone|ipad|ipod/i.test(ua)) {
    os = "iOS";
    osVersion =
      (ua.match(/os (\d+[._]\d+)/i) || [])[1]?.replace("_", ".") || "";
  } else if (/linux/i.test(lower)) {
    os = "Linux";
  }

  // ── Device name ──────────────────────────────────────────────────────
  let deviceName = deviceType;
  if (os === "iOS") {
    const match = ua.match(/(iphone|ipad|ipod)[^;]*/i);
    deviceName = match ? match[0] : "iOS Device";
  } else if (os === "Android") {
    // UA pattern: "...; Android 13; <model>)" — extract the model.
    const match = ua.match(/android.*?;\s*([^)]+)\)/i);
    deviceName = match ? match[1].trim() : "Android Device";
  } else {
    deviceName = `${os} ${deviceType}`.trim();
  }

  return { deviceType, browser, browserVersion, os, osVersion, deviceName };
}
