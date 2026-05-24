export default function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="p-5 rounded-2xl border border-gray-800 bg-gray-900/40 hover:border-artha-500/40 hover:bg-gray-900/70 transition-all duration-200">
      <div className="text-2xl mb-3">{icon}</div>
      <h3 className="font-semibold text-white text-sm mb-1.5">{title}</h3>
      <p className="text-gray-400 text-xs leading-relaxed">{description}</p>
    </div>
  );
}
