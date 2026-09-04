/**
 * Engraved meridian globe — a hand-drawn trade-house mark.
 *
 * Thin strokes, a dotted inner ring, meridian/latitude lines and two dashed
 * trade routes with port dots. Everything inherits `currentColor`, so the
 * parent controls colour and opacity. Used as a quiet watermark on the
 * auth screens (login, register, client portal) — deliberately NOT a
 * gradient, blob or glow: it reads as stationery engraving.
 */
export function GlobeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 200"
      fill="none"
      stroke="currentColor"
      aria-hidden
      className={className}
    >
      {/* Rim + dotted inner ring */}
      <circle cx="100" cy="100" r="98" strokeWidth="0.8" />
      <circle cx="100" cy="100" r="90" strokeWidth="0.5" strokeDasharray="0.5 3.5" />

      {/* Meridians */}
      <ellipse cx="100" cy="100" rx="66" ry="98" strokeWidth="0.6" />
      <ellipse cx="100" cy="100" rx="33" ry="98" strokeWidth="0.6" />
      <ellipse cx="100" cy="100" rx="98" ry="38" strokeWidth="0.6" />
      <ellipse cx="100" cy="100" rx="98" ry="74" strokeWidth="0.5" />

      {/* Equator + latitudes */}
      <path d="M2 100h196" strokeWidth="0.6" />
      <path d="M15 61.5h170" strokeWidth="0.5" />
      <path d="M15 138.5h170" strokeWidth="0.5" />
      <path d="M41 26h118" strokeWidth="0.45" />
      <path d="M41 174h118" strokeWidth="0.45" />

      {/* Rim ticks — cardinal + diagonal */}
      <path d="M100 1v7M100 192v7M1 100h7M192 100h7" strokeWidth="0.7" />
      <path
        d="M169.4 30.6l5-5M30.6 30.6l-5-5M169.4 169.4l5 5M30.6 169.4l-5 5"
        strokeWidth="0.6"
      />

      {/* Trade routes — dashed arcs with port dots */}
      <path
        d="M28 142C62 92 98 66 124 88S150 140 178 118"
        strokeWidth="0.8"
        strokeDasharray="4 5"
        strokeLinecap="round"
      />
      <circle cx="28" cy="142" r="3" />
      <circle cx="124" cy="88" r="2.2" />
      <circle cx="178" cy="118" r="2.8" />

      <path
        d="M52 172C96 150 130 168 164 150"
        strokeWidth="0.6"
        strokeDasharray="2.5 5"
        strokeLinecap="round"
      />
      <circle cx="52" cy="172" r="2.2" />
      <circle cx="164" cy="150" r="2.2" />
    </svg>
  );
}
