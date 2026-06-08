/**
 * Feature-tour content — a short, beautiful slideshow shown the FIRST time a
 * user opens each top-level feature tab (Chat / Workflows / Code / Delegate).
 *
 * Voice: plain English, non-developer first. Every tour opens with a one-line
 * "what is this", then concrete numbered steps, then a "try this" payoff. Keep
 * each slide to a glance — 1 short paragraph or ≤5 steps.
 *
 * Tracked per-tab via the store's `seenGuides` Set under the key `tour:<tab>`,
 * so each tour auto-launches exactly once. The TabBar "?" replays the current
 * tab's tour on demand.
 */
import {
  Sparkles, Workflow, Code2, Send,
  MessageSquare, Paperclip, Search,
  Save, CalendarClock, Activity,
  FolderTree, FilePen, GitCompare,
  Target, ListChecks, CheckCircle2,
  type LucideIcon,
} from 'lucide-react';
import type { ActiveTab } from '../../stores/chat';

export interface TourSlide {
  icon: LucideIcon;
  /** Small label above the title (e.g. "Getting started", "Step by step"). */
  kicker: string;
  title: string;
  /** A short paragraph. Use for intro/payoff slides. */
  body?: string;
  /** Numbered steps. Use for the "how to" slide. */
  steps?: string[];
}

export interface FeatureTour {
  id: ActiveTab;
  title: string;
  /** One-line positioning shown under the title on the first slide. */
  tagline: string;
  /** Accent hex for the tour chrome (matches the tab's colour-coding). */
  accent: string;
  icon: LucideIcon;
  slides: TourSlide[];
}

export const TOURS: Record<ActiveTab, FeatureTour> = {
  chat: {
    id: 'chat',
    title: 'Chat',
    tagline: 'Think with Artha — a private AI that runs entirely on your Mac.',
    accent: '#818CF8', // indigo
    icon: Sparkles,
    slides: [
      {
        icon: Sparkles,
        kicker: 'Getting started',
        title: 'Your private AI, on your machine',
        body: 'Ask anything — draft an email, explain a document, brainstorm, summarise. Nothing you type or attach ever leaves your computer. No account, no cloud, no telemetry.',
      },
      {
        icon: MessageSquare,
        kicker: 'Step by step',
        title: 'Send your first message',
        steps: [
          'Type your question in the box at the bottom.',
          'Press Enter to send — Artha streams its thinking, then the answer.',
          'Keep chatting; it remembers the conversation.',
        ],
      },
      {
        icon: Paperclip,
        kicker: 'Step by step',
        title: 'Ground answers in your files',
        steps: [
          'Click the paperclip to attach a file or folder to the chat.',
          'Ask about it — “summarise this contract”, “what changed?”.',
          'Artha reads it locally and answers with the exact sources.',
        ],
      },
      {
        icon: Search,
        kicker: 'Try this',
        title: 'Tips that feel like magic',
        body: 'Paste a URL and Artha will read the page. Type “/” to use a skill (like /ask to search an indexed folder). Everything runs offline on your hardware.',
      },
    ],
  },

  workflows: {
    id: 'workflows',
    title: 'Workflows',
    tagline: 'Automate the work you do over and over — on demand or on a schedule.',
    accent: '#A78BFA', // violet
    icon: Workflow,
    slides: [
      {
        icon: Workflow,
        kicker: 'Getting started',
        title: 'Save a task once, run it forever',
        body: 'A Workflow is a task Artha can repeat — a weekly report, a research sweep, a file cleanup. Build it once, then run it with a click or let it run on a schedule.',
      },
      {
        icon: Save,
        kicker: 'Step by step',
        title: 'Turn any run into a Workflow',
        steps: [
          'Run a task in Chat or Delegate that you’d want to repeat.',
          'Open the run’s menu and choose “Save as Workflow”.',
          'Give it a name — it now lives here in the Workflows hub.',
        ],
      },
      {
        icon: CalendarClock,
        kicker: 'Step by step',
        title: 'Run it — now or on a schedule',
        steps: [
          'Click a Workflow to run it instantly.',
          'Or set a schedule (e.g. every weekday at 8am) and walk away.',
          'Artha runs it in the background and saves the result.',
        ],
      },
      {
        icon: Activity,
        kicker: 'Try this',
        title: 'Watch everything in the Activity feed',
        body: 'Every run — manual or scheduled — is logged with its result, so you always know what Artha did and when. Nothing happens behind your back.',
      },
    ],
  },

  code: {
    id: 'code',
    title: 'Code',
    tagline: 'Build with Artha — point it at a folder and it becomes file-aware.',
    accent: '#34D399', // emerald
    icon: Code2,
    slides: [
      {
        icon: Code2,
        kicker: 'Getting started',
        title: 'An AI that works inside your project',
        body: 'Anchor a folder and Artha can read, edit, and create real files in it — like a developer pairing with you. Great for code, but also docs, notes, or any folder of files.',
      },
      {
        icon: FolderTree,
        kicker: 'Step by step',
        title: 'Open a project folder',
        steps: [
          'Pick a folder from the project selector (top-left).',
          'Browse its files in the tree on the left.',
          'Artha is now scoped to that folder — it can’t touch anything outside it.',
        ],
      },
      {
        icon: FilePen,
        kicker: 'Step by step',
        title: 'Ask it to build or change something',
        steps: [
          'Describe the change — “add a contact form”, “fix this bug”, “explain this file”.',
          'Artha reads the relevant files and proposes edits.',
          'It writes directly into your project files.',
        ],
      },
      {
        icon: GitCompare,
        kicker: 'Try this',
        title: 'Review before you keep it',
        body: 'Every edit shows a clear before/after diff. Keep what you like, discard the rest — you’re always in control of your files.',
      },
    ],
  },

  delegate: {
    id: 'delegate',
    title: 'Delegate',
    tagline: 'Hand over a goal — Artha plans it, runs the steps, and reports back.',
    accent: '#E2BF5C', // gold
    icon: Send,
    slides: [
      {
        icon: Send,
        kicker: 'Getting started',
        title: 'Give Artha a goal, not instructions',
        body: 'Delegate is for bigger jobs. Describe the outcome you want and Artha figures out the steps, runs them, and brings you a finished result — checking in when it needs you.',
      },
      {
        icon: Target,
        kicker: 'Step by step',
        title: 'Describe what you want done',
        steps: [
          'Type a goal — e.g. “Research 20 competitors and summarise their pricing”.',
          'Click Delegate.',
          'Artha breaks it into a plan you can see.',
        ],
      },
      {
        icon: ListChecks,
        kicker: 'Step by step',
        title: 'Watch it work',
        steps: [
          'Each step shows live as Artha runs it.',
          'It pauses to ask when an action needs your approval.',
          'You can step in and take over at any point.',
        ],
      },
      {
        icon: CheckCircle2,
        kicker: 'Try this',
        title: 'Get a finished result',
        body: 'When it’s done, you get the output — a document, a summary, a set of files — ready to save, share, or refine with a follow-up.',
      },
    ],
  },
};
