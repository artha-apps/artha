import { useId } from 'react';

/**
 * The Artha wordmark — angular gold "ARTHA" drawn as geometric strokes, with the
 * A's rendered as an inverted-V (Λ) with a high crossbar to match the brand
 * lockup (assets/brand/artha-logo-full.png). Pure inline SVG: it scales crisply
 * at any size, carries its own gold gradient, and needs no image asset (the PNG
 * wordmark broke under file:// in packaged builds). Size it via `height`.
 */
export function BrandWordmark({ height = 22, className = '' }: { height?: number; className?: string }) {
  // Unique gradient id per instance so multiple wordmarks on one screen don't
  // all resolve to the first <linearGradient> in the document.
  const gid = useId();
  return (
    <svg
      viewBox="0 0 448 120"
      height={height}
      className={className}
      role="img"
      aria-label="Artha"
      fill="none"
      stroke={`url(#${gid})`}
      strokeWidth={6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FBF1CE" />
          <stop offset="0.5" stopColor="#E8C463" />
          <stop offset="1" stopColor="#B27D2C" />
        </linearGradient>
      </defs>
      {/* A — inverted-V (Λ) + high crossbar */}
      <path d="M12,100 L41,20 L70,100 M31.6,46 L50.4,46" />
      {/* R */}
      <path d="M106,100 L106,20 L138,20 C156,20 156,52 138,52 L106,52 M122,52 L160,100" />
      {/* T */}
      <path d="M196,20 L254,20 M225,20 L225,100" />
      {/* H */}
      <path d="M292,20 L292,100 M342,20 L342,100 M292,60 L342,60" />
      {/* A — inverted-V (Λ) + high crossbar */}
      <path d="M378,100 L407,20 L436,100 M397.6,46 L416.4,46" />
    </svg>
  );
}
