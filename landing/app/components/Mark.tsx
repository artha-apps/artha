import Image from 'next/image';

/** Brand mark — Devanagari अ inside a sacred-geometry mandala.
 *  Source artwork is gold on near-black, so the mark reads as a dark
 *  medallion on the cream page background. Shared by the landing page and
 *  the /subscribe page so the header/footer lockup is identical everywhere. */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <Image
      src="/logo-mark.png"
      alt=""
      width={size}
      height={size}
      className="brand-mark"
      priority
    />
  );
}
