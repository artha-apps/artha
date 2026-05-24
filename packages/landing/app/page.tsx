'use client';

import { useEffect, useState } from 'react';
import DownloadButton from '../components/DownloadButton';
import FeatureCard from '../components/FeatureCard';
import NavBar from '../components/NavBar';

const GITHUB_OWNER = 'Noopurtrivedi';
const GITHUB_REPO = 'artha';

const FEATURES = [
  {
    icon: '🔒',
    title: 'Runs 100% locally',
    description:
      'Your data never leaves your machine. No cloud servers, no usage tracking, no subscription. Bring your own API key or connect local Ollama models.',
  },
  {
    icon: '🤖',
    title: 'True ReAct agent',
    description:
      'Artha reasons, plans, and executes multi-step workflows using a proper Reason-Act loop — not just a chat wrapper. Watch the thinking process live.',
  },
  {
    icon: '🧠',
    title: 'Persistent memory',
    description:
      'The agent builds a structured knowledge graph across sessions. People, projects, decisions, and preferences are recalled automatically.',
  },
  {
    icon: '🔌',
    title: 'MCP-native',
    description:
      'Connect any Model Context Protocol server — filesystem, databases, GitHub, Slack, and hundreds more. One-click installs from the built-in marketplace.',
  },
  {
    icon: '🗓️',
    title: 'Scheduled tasks',
    description:
      'Set cron or one-shot schedules. Artha wakes up at the right time, runs the workflow, and sends a native notification when done.',
  },
  {
    icon: '👁️',
    title: 'Multimodal + PDF vision',
    description:
      'Drop in images or PDFs. The agent reads them with vision models and reasons over visual content just like text.',
  },
  {
    icon: '🎙️',
    title: 'Voice input',
    description:
      'Click the mic and speak your task. Powered by Chromium\'s built-in speech recognition — no extra service needed.',
  },
  {
    icon: '💻',
    title: 'IDE integration',
    description:
      'Generate an MCP config for VS Code or Cursor in one click. The agent becomes available as a tool directly in your editor.',
  },
];

const STEPS = [
  { n: '1', title: 'Download & install', body: 'One DMG / EXE / DEB — no dependencies. Double-click and Artha is running.' },
  { n: '2', title: 'Add an API key or Ollama', body: 'Paste an OpenAI-compatible API key, or point at local Ollama. Switch models any time.' },
  { n: '3', title: 'Give it a task', body: 'Type (or speak) a goal. The agent plans, asks clarifying questions if needed, and executes.' },
];

export default function Home() {
  const [releaseUrl, setReleaseUrl] = useState<string>(
    `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
  );

  // Fetch latest release tag so the version badge is accurate
  useEffect(() => {
    fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.html_url) setReleaseUrl(data.html_url);
      })
      .catch(() => {});
  }, []);

  return (
    <>
      <NavBar releaseUrl={releaseUrl} />

      {/* ── Hero ── */}
      <section className="relative pt-32 pb-24 px-4 text-center overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-[700px] h-[400px] bg-artha-600/20 rounded-full blur-3xl" />
        </div>

        <div className="relative max-w-4xl mx-auto">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-artha-500/40 bg-artha-500/10 text-artha-300 text-sm mb-8">
            <span className="w-2 h-2 rounded-full bg-artha-400 animate-pulse" />
            Open source · Local-first · Free forever
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-tight mb-6">
            Your AI agent,{' '}
            <span className="gradient-text">on your machine</span>
          </h1>

          <p className="text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Artha is an Electron-based AI productivity agent that runs entirely offline.
            Document workflows, MCP tools, persistent memory — zero cloud, zero subscription.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <DownloadButton releaseUrl={releaseUrl} size="lg" />
            <a
              href={`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 py-3 rounded-xl border border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white transition-colors text-base font-medium"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
              View on GitHub
            </a>
          </div>

          {/* Platform badges */}
          <div className="mt-8 flex items-center justify-center gap-6 text-sm text-gray-500">
            <span className="flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98l-.09.06c-.22.14-2.19 1.28-2.17 3.82.03 3.02 2.65 4.03 2.68 4.04l-.06.16zM13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
              </svg>
              macOS
            </span>
            <span className="flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
              </svg>
              Windows
            </span>
            <span className="flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
              </svg>
              Linux
            </span>
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how" className="py-20 px-4 border-t border-gray-800/60">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-3">Up in 60 seconds</h2>
          <p className="text-gray-400 text-center mb-14">No accounts. No API quotas. No waiting.</p>
          <div className="grid sm:grid-cols-3 gap-6">
            {STEPS.map((s) => (
              <div key={s.n} className="relative p-6 rounded-2xl border border-gray-800 bg-gray-900/50">
                <div className="w-10 h-10 rounded-full bg-artha-600/20 border border-artha-500/40 flex items-center justify-center text-artha-400 font-bold text-lg mb-4">
                  {s.n}
                </div>
                <h3 className="font-semibold text-white mb-2">{s.title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features grid ── */}
      <section id="features" className="py-20 px-4 border-t border-gray-800/60">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-3">Everything you need, nothing you don't</h2>
          <p className="text-gray-400 text-center mb-14">
            Built for developers and power users who want a real agent — not a glorified chatbot.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {FEATURES.map((f) => (
              <FeatureCard key={f.title} {...f} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Privacy callout ── */}
      <section className="py-20 px-4 border-t border-gray-800/60">
        <div className="max-w-3xl mx-auto text-center">
          <div className="text-5xl mb-6">🔐</div>
          <h2 className="text-3xl font-bold mb-4">Privacy isn't a feature. It's the architecture.</h2>
          <p className="text-gray-400 text-lg leading-relaxed mb-8">
            Artha never phones home. There are no telemetry calls, no analytics, no account system.
            Your conversations, files, and memory graph stay on your disk — encrypted at rest by your OS.
            The only network traffic is the LLM API call you explicitly configure.
          </p>
          <div className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-400 text-sm font-medium">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Zero telemetry by default — always
          </div>
        </div>
      </section>

      {/* ── Download CTA ── */}
      <section id="download" className="py-24 px-4 border-t border-gray-800/60">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-4xl font-bold mb-4">
            Ready to run your own agent?
          </h2>
          <p className="text-gray-400 text-lg mb-10">
            Free, open source, and yours forever. No sign-up required.
          </p>
          <DownloadButton releaseUrl={releaseUrl} size="xl" />
          <p className="mt-6 text-sm text-gray-500">
            Or{' '}
            <a
              href={`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`}
              className="underline underline-offset-2 hover:text-gray-300 transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              build from source
            </a>{' '}
            · MIT licensed
          </p>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-gray-800/60 py-10 px-4 text-center text-sm text-gray-500">
        <p>
          © {new Date().getFullYear()} Artha · Built by{' '}
          <a
            href="https://github.com/Noopurtrivedi"
            className="hover:text-gray-300 transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            Noopur Trivedi
          </a>{' '}
          ·{' '}
          <a
            href={`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/blob/main/LICENSE`}
            className="hover:text-gray-300 transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            MIT License
          </a>
        </p>
      </footer>
    </>
  );
}
