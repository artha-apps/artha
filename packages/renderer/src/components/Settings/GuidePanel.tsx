/**
 * GuidePanel — "How to use Artha", shown inside Workspace Settings. A list of
 * features on the left; selecting one floats that feature's card in on the
 * right (one card at a time) with a plain-English what-it-does, numbered steps,
 * and an example prompt. Written for first-time, non-technical users.
 */
import { useState } from 'react';
import { MessageSquare, FolderCog, FileText, Search, Cpu, ShieldCheck, ShieldAlert, ListChecks, ReceiptText, Workflow } from 'lucide-react';

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
  {
    icon: ShieldAlert,
    title: 'Control each action with policies',
    blurb: 'Decide what happens before the agent runs a tool: let it run, ask you first, preview only, or block it — per tool.',
    steps: [
      'Open Settings → Tool Policies.',
      'Add a rule: a tool name (e.g. fs_delete_file), a prefix (browser_), or * for all.',
      'Pick a tier — Auto, Confirm, Dry run, or Forbid. “Confirm” pops up before that call runs so you can approve or deny it.',
    ],
    example: 'By default, Artha asks before deleting any file.',
  },
  {
    icon: ListChecks,
    title: 'See the impact before you approve',
    blurb: 'When a task needs approval, the plan card shows an estimate of what it will touch — deletions, moves, web access, reversibility, and rough cost.',
    steps: [
      'Ask Artha to do something that changes files.',
      'Read the “Estimated impact” chips on the approval card.',
      'Approve once you’re happy — or cancel if it looks bigger than expected.',
    ],
    example: 'Organise my Downloads folder by file type.',
  },
  {
    icon: ReceiptText,
    title: 'Proof of what the agent did',
    blurb: 'Every tool call is recorded as a verifiable receipt — what it did, a content hash, and whether a policy blocked it.',
    steps: [
      'After a task, open Settings → Receipts.',
      'Pick the run to see each action with its real effect.',
      'Blocked and preview-only calls are logged too, so the trail is complete.',
    ],
  },
  {
    icon: Workflow,
    title: 'Let skills call other skills',
    blurb: 'Complex jobs can hand a sub-task to a trusted capability (like Web Research or CRM) — which can never do more than the agent that called it.',
    steps: [
      'Just ask for the whole job in plain English.',
      'Artha delegates parts to the right capability automatically.',
      'Each hand-off shows up in Receipts, with permissions that can only narrow — never widen.',
    ],
    example: 'Research our top 3 competitors and add each as a company in my CRM.',
  },
];

export default function GuidePanel() {
  const [selected, setSelected] = useState(0);
  const f = FEATURES[selected];
  const Icon = f.icon;

  return (
    <div>
      <h2 className="text-lg font-semibold text-artha-text mb-1">How to use Artha</h2>
      <p className="text-sm text-artha-muted mb-5">
        Pick a feature to see exactly how to use it. Just ask in plain English.
      </p>

      <div className="flex gap-5">
        {/* Feature list */}
        <div className="w-56 shrink-0 flex flex-col gap-1">
          {FEATURES.map((feat, i) => {
            const FIcon = feat.icon;
            const active = i === selected;
            return (
              <button
                key={feat.title}
                onClick={() => setSelected(i)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-colors border ${
                  active
                    ? 'bg-artha-accent/10 border-artha-accent/40 text-artha-text'
                    : 'border-transparent text-artha-muted hover:bg-artha-surface2 hover:text-artha-text'
                }`}
              >
                <FIcon size={15} className={active ? 'text-artha-accent shrink-0' : 'text-artha-subtle shrink-0'} />
                <span className="leading-snug">{feat.title}</span>
              </button>
            );
          })}
        </div>

        {/* Floating card for the selected feature */}
        <div
          key={selected}
          className="flex-1 p-5 rounded-2xl bg-artha-surface border border-artha-border shadow-lifted animate-[fadeIn_140ms_ease]"
          style={{ animation: 'guideCardIn 140ms ease' }}
        >
          <div className="w-10 h-10 rounded-xl bg-artha-accent/10 border border-artha-accent/30 flex items-center justify-center mb-3">
            <Icon size={18} className="text-artha-accent" />
          </div>
          <h3 className="text-base font-semibold text-artha-text mb-1">{f.title}</h3>
          <p className="text-sm text-artha-muted leading-relaxed mb-4">{f.blurb}</p>
          <ol className="space-y-2 mb-4">
            {f.steps.map((s, i) => (
              <li key={i} className="flex gap-2.5 text-sm text-artha-text">
                <span className="shrink-0 w-5 h-5 rounded-full bg-artha-surface2 border border-artha-border text-[11px] font-medium flex items-center justify-center text-artha-muted">
                  {i + 1}
                </span>
                <span className="leading-snug">{s}</span>
              </li>
            ))}
          </ol>
          {f.example && (
            <div className="rounded-lg bg-artha-surface2 border border-artha-border px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-artha-subtle mb-0.5">Try saying</div>
              <div className="text-[13px] text-artha-text leading-snug">“{f.example}”</div>
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes guideCardIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
