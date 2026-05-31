/**
 * Guide — "How to use Artha" feature walkthrough. A full-screen modal of cards,
 * one per core capability, each with a one-line what-it-does + numbered
 * step-by-step + an example prompt. Opened from the Help (?) button and shown
 * once after onboarding. Written for first-time, non-technical users.
 */
import { X, MessageSquare, FolderCog, FileText, Search, Cpu, ShieldCheck } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

interface Feature {
  icon: typeof MessageSquare;
  title: string;
  blurb: string;
  steps: string[];
  example?: string;
}

const FEATURES: Feature[] = [
  {
    icon: MessageSquare,
    title: 'Chat with local AI',
    blurb: 'Talk to Artha in plain English. It runs entirely on your Mac — no cloud, no account.',
    steps: [
      'Check the model chip at the top shows a model (e.g. qwen3.5).',
      'Type what you want in the box at the bottom.',
      'Press Enter. Watch it think and reply.',
    ],
    example: 'Explain what an MCP server is in simple terms.',
  },
  {
    icon: FolderCog,
    title: 'Get things done with your files',
    blurb: 'Ask Artha to move, organise, rename, or find files. It actually does it — you watch each step.',
    steps: [
      'Ask in plain English what you want done.',
      'Artha looks through the folder, then performs the changes.',
      'It confirms what it moved or created when finished.',
    ],
    example: 'Move today’s screenshots on my Desktop into a folder called ss26.',
  },
  {
    icon: FileText,
    title: 'Create documents',
    blurb: 'Generate Word, Excel, PowerPoint, and PDF files from a description — saved on your machine.',
    steps: [
      'Describe the document you want.',
      'Artha writes it and saves the file locally.',
      'Open it from the folder it tells you.',
    ],
    example: 'Make a one-page PDF proposal for a small coffee shop.',
  },
  {
    icon: Search,
    title: 'Chat with your own files',
    blurb: 'Point Artha at a folder and ask questions about its contents — it answers and cites the files.',
    steps: [
      'Click the Folder button next to the message box to attach a folder.',
      'Ask a question about what’s in it.',
      'Artha answers and shows which files it used.',
    ],
    example: 'What did I decide in my meeting notes from last week?',
  },
  {
    icon: Cpu,
    title: 'Pick your AI model',
    blurb: 'Choose which local model powers Artha. Smaller models are faster; bigger ones are smarter.',
    steps: [
      'Click the model chip at the top of the window.',
      'In Settings → Models, pick a model or download a new one.',
      'The chip always shows which model is active.',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Private by design',
    blurb: 'Everything happens on your device. You can also limit a chat to just the folders you choose.',
    steps: [
      'Use the Folder / File buttons by the message box to scope a chat.',
      'Artha can only read or change what you’ve attached.',
      'Nothing is sent to any server — zero telemetry.',
    ],
  },
];

export default function Guide() {
  const { guideOpen, closeGuide } = useChatStore();
  if (!guideOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-artha-bg/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-8 py-5 border-b border-artha-border shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-artha-text">How to use Artha</h1>
          <p className="text-sm text-artha-muted mt-0.5">
            Your local AI agent. Here’s what it can do — just ask in plain English.
          </p>
        </div>
        <button
          onClick={closeGuide}
          className="p-2 rounded-lg border border-artha-border text-artha-muted hover:text-artha-text hover:border-artha-accent transition-colors"
          aria-label="Close guide"
        >
          <X size={16} />
        </button>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 max-w-5xl mx-auto">
          {FEATURES.map(({ icon: Icon, title, blurb, steps, example }) => (
            <div
              key={title}
              className="flex flex-col p-5 rounded-2xl bg-artha-surface border border-artha-border shadow-soft"
            >
              <div className="w-10 h-10 rounded-xl bg-artha-accent/10 border border-artha-accent/30 flex items-center justify-center mb-3">
                <Icon size={18} className="text-artha-accent" />
              </div>
              <h2 className="text-base font-semibold text-artha-text mb-1">{title}</h2>
              <p className="text-sm text-artha-muted leading-relaxed mb-4">{blurb}</p>
              <ol className="space-y-2 mb-4 flex-1">
                {steps.map((s, i) => (
                  <li key={i} className="flex gap-2.5 text-sm text-artha-text">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-artha-surface2 border border-artha-border text-[11px] font-medium flex items-center justify-center text-artha-muted">
                      {i + 1}
                    </span>
                    <span className="leading-snug">{s}</span>
                  </li>
                ))}
              </ol>
              {example && (
                <div className="rounded-lg bg-artha-surface2 border border-artha-border px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-artha-subtle mb-0.5">Try saying</div>
                  <div className="text-[13px] text-artha-text leading-snug">“{example}”</div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="text-center mt-8">
          <button
            onClick={closeGuide}
            className="px-5 py-2.5 rounded-xl bg-artha-accent hover:bg-artha-accent-hover text-white text-sm font-medium transition-colors"
          >
            Got it — let’s go
          </button>
          <p className="text-xs text-artha-subtle mt-3">
            You can reopen this anytime from the <strong>?</strong> button.
          </p>
        </div>
      </div>
    </div>
  );
}
