import { ImageResponse } from "next/og";

/**
 * Next.js dynamic favicon (32x32 PNG, served at /icon).
 *
 * Uses the EXACT path data from the Wikipedia "Symbol of Veles" SVG
 * (https://commons.wikimedia.org/wiki/File:Symbol_of_Veles.svg) so the
 * browser/phone icon is byte-for-byte identical to the portal logo.
 *
 * The Wikipedia path is a single <path> with 3 subpaths (M commands):
 *   1. Outer downward triangle (apex at bottom center)
 *   2. Inner downward triangle (smaller, with a visible gap)
 *   3. Top horizontal bar (wide trapezoid spanning the full width)
 *
 * Satori (next/og) supports SVG <path d="..."> natively, so we render
 * the original path verbatim with `fill="#FFFBF5"` (cream) on a copper
 * gradient tile. ViewBox is preserved at "0 0 560 600" to maintain the
 * exact aspect ratio of the Wikipedia original.
 */
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// Exact path data from
// https://upload.wikimedia.org/wikipedia/commons/0/07/Symbol_of_Veles.svg
const VELES_PATH =
  "m 279.3199,598.94108 c -0.9579,-1.8879 -186.5202,-399.8972 -186.5202,-400.0641 0,-0.085 84.2402,-0.1543 187.2003,-0.1543 102.9602,0 187.2003,0.07 187.2003,0.1545 0,0.3024 -186.7667,400.6736 -187.0309,400.9379 -0.162,0.1619 -0.5004,-0.1864 -0.8495,-0.874 z m 43.7781,-245.2277 42.0256,-90.128 -42.464,-0.075 c -23.3552,-0.041 -61.6608,-0.041 -85.1234,0 l -42.6594,0.075 42.5546,91.2565 42.5547,91.2564 0.5431,-1.1284 c 0.2988,-0.6207 19.4546,-41.6861 42.5688,-91.2565 z M 39.0224,83.698778 C 20.5903,44.164278 4.2811,9.191678 2.7798,5.981878 L 0.05,0.14567803 h 35.991 35.9909 l 21.1185,45.28559997 21.1183,45.2856 H 280 445.7313 l 21.1183,-45.2856 21.1186,-45.28559997 H 523.959 559.95 L 557.2203,5.981878 c -1.5014,3.2098 -17.8106,38.1824 -36.2428,77.7169 l -33.513,71.880702 H 280 72.5355 Z";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #F59E0B 0%, #D97706 30%, #B45309 65%, #7C2D12 100%)",
          borderRadius: "22%",
        }}
      >
        {/*
          Exact Wikipedia "Symbol of Veles" path. ViewBox 0 0 560 600
          preserves the original aspect ratio so the symbol renders
          identically to /logo.svg (portal) and /favicon.svg (browser).
        */}
        <svg
          width="60%"
          height="60%"
          viewBox="0 0 560 600"
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="xMidYMid meet"
        >
          <path d={VELES_PATH} fill="#FFFBF5" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
