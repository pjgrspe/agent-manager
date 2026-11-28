export function MeridianLogo({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="meridian-logo-svg"
    >
      <defs>
        <linearGradient id="m-tile" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#16203a" />
          <stop offset="100%" stopColor="#090d18" />
        </linearGradient>
        <linearGradient id="m-arc" x1="16" y1="14" x2="48" y2="52" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="55%" stopColor="#7dd3fc" />
          <stop offset="100%" stopColor="#818cf8" />
        </linearGradient>
        <linearGradient id="m-star" x1="32" y1="9" x2="32" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <rect
        x="2"
        y="2"
        width="60"
        height="60"
        rx="15"
        fill="url(#m-tile)"
        stroke="rgba(148, 163, 184, 0.28)"
        strokeWidth="1.5"
      />
      <circle cx="32" cy="34" r="16.5" stroke="url(#m-arc)" strokeWidth="2.4" />
      <path d="M32 17.5V50.5" stroke="url(#m-arc)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M32 17.5C25.5 22.5 25.5 45.5 32 50.5" stroke="url(#m-arc)" strokeWidth="1.5" strokeOpacity="0.55" />
      <path d="M32 17.5C38.5 22.5 38.5 45.5 32 50.5" stroke="url(#m-arc)" strokeWidth="1.5" strokeOpacity="0.55" />
      <path
        d="M32 9.5L34.1 15.4L40 17.5L34.1 19.6L32 25.5L29.9 19.6L24 17.5L29.9 15.4L32 9.5Z"
        fill="url(#m-star)"
      />
    </svg>
  );
}
