/**
 * A single card in the Features grid section of the landing page.
 *
 * Renders an emoji icon, a short feature title, and a one-sentence description.
 * Hover state subtly brightens the border and background to give the grid life
 * without distracting from the copy.
 */

/** Props for FeatureCard. */
interface FeatureCardProps {
  /** Emoji used as the card's visual icon (e.g. '🔒'). */
  icon: string;
  /** Short feature name displayed as the card heading. */
  title: string;
  /** One-sentence description of the feature. */
  description: string;
}

/** @see FeatureCardProps */
export default function FeatureCard({
  icon,
  title,
  description,
}: FeatureCardProps) {
  return (
    <div className="p-5 rounded-2xl border border-gray-800 bg-gray-900/40 hover:border-artha-500/40 hover:bg-gray-900/70 transition-all duration-200">
      <div className="text-2xl mb-3">{icon}</div>
      <h3 className="font-semibold text-white text-sm mb-1.5">{title}</h3>
      <p className="text-gray-400 text-xs leading-relaxed">{description}</p>
    </div>
  );
}
