/**
 * The Artha wordmark — typeset to match the landing site's brand lockup
 * (landing/app/globals.css `.wordmark`): "ARTHA" in Marcellus (thin, wide-tracked
 * Roman caps), a slim rule with a center dot, and an "AI Coworker OS" tagline.
 * Kept in sync with the marketing site so the app and landing share one identity.
 *
 * `size` is the ARTHA cap size in px; the rule and tagline scale from it. Set
 * `showRule`/`tagline` to false to render just the name in tight spots.
 */
export function BrandWordmark({
  size = 16,
  tagline = 'AI Coworker OS',
  showRule = true,
  className = '',
}: {
  size?: number;
  tagline?: string | false;
  showRule?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex flex-col items-center leading-none ${className}`}>
      <span
        className="text-artha-text"
        style={{
          fontFamily: "'Marcellus', Georgia, serif",
          fontWeight: 400,
          fontSize: size,
          letterSpacing: '0.36em',
          paddingLeft: '0.36em', // letter-spacing pushes the block right; recenter
        }}
      >
        ARTHA
      </span>
      {showRule && (
        <span
          aria-hidden="true"
          className="relative w-full bg-artha-border-strong"
          style={{ height: 1, margin: `${Math.round(size * 0.3)}px 0` }}
        >
          <span
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-artha-muted"
            style={{ width: 3, height: 3 }}
          />
        </span>
      )}
      {tagline && (
        <span
          className="uppercase text-artha-subtle"
          style={{
            fontFamily: "'Marcellus', Georgia, serif",
            fontSize: Math.max(8, size * 0.52),
            letterSpacing: '0.22em',
            paddingLeft: '0.22em',
          }}
        >
          {tagline}
        </span>
      )}
    </span>
  );
}
