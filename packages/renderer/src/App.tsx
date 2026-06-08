/**
 * App root — wires IPC event listeners and renders the shell layout.
 *
 * Layout after the IA reshuffle:
 *   [Sidebar | TabBar + per-tab canvas]
 *                          ↳ Chat  → ChatWindow + (BrowserPane | ExecutionLog)
 *                          ↳ Workflows → WorkflowsTab
 *                          ↳ Code → CodeTab (file tree + ChatWindow)
 *                          ↳ Delegate → DelegateTab (goal-driven execution)
 *
 * The 17 settings panels live inside the WorkspaceSettings modal (⌘,). Legacy
 * `activeView` values other than 'chat' deep-link into that modal scrolled to
 * the matching section, so old call-sites keep working without refactor.
 */
import { useEffect, useState } from 'react';
import { useChatStore, type Session } from './stores/chat';
import Onboarding from './components/Onboarding/Onboarding';
import ModelStatusBanner from './components/ModelStatusBanner';
import WorkingIndicator from './components/WorkingIndicator';
import Sidebar from './components/Sidebar/Sidebar';
import ChatWindow from './components/Chat/ChatWindow';
import ExecutionLog from './components/ExecutionLog/ExecutionLog';
import PlanApproval from './components/Chat/PlanApproval';
import ClarificationModal from './components/Chat/ClarificationModal';
import ToolApprovalModal from './components/Chat/ToolApprovalModal';
import ChatHeader from './components/Chat/ChatHeader';
import RunInspector from './components/Chat/RunInspector';
import BrowserPane from './components/Browser/BrowserPane';
import BrowserResizer from './components/Browser/BrowserResizer';
import { useBrowserStore } from './stores/browser';
import TabBar from './components/TabBar/TabBar';
import WorkflowsTab from './components/Workflows/WorkflowsTab';
import CodeTab from './components/Code/CodeTab';
import DelegateTab from './components/Delegate/DelegateTab';
import ProjectHome from './components/ProjectHome/ProjectHome';
import WorkspaceSettings from './components/WorkspaceSettings/WorkspaceSettings';
import Toaster from './components/ui/Toaster';
import ShortcutsOverlay from './components/ui/ShortcutsOverlay';
import CommandPalette from './components/ui/CommandPalette';
import { FeatureTour } from './components/ui/FeatureTour';
import UndoAfterRun from './components/UndoAfterRun';
import Briefing from './components/Briefing';
import { TooltipProvider } from './components/ui/Tooltip';
import { tabTheme } from './lib/tabTheme';

// Expose the type-safe ArthaAPI that the preload script injects onto `window`.
// All IPC calls go through `window.artha.*` — there is no direct Node.js access
// from the renderer.
declare global {
  interface Window {
    artha: import('../../app/src/preload').ArthaAPI;
  }
}

/**
 * App — root component. Registers all IPC→store bridges in a single long-lived
 * effect and renders the shell. The real layout logic lives in the individual
 * panel components; App is responsible only for wiring and top-level routing.
 */
export default function App() {
  const {
    appendToken, resetStream, finaliseStream, addToolEvent, addCitations,
    setPendingPlan, setPendingClarify, setPendingToolApproval, setSessions, sessions,
    setStreaming, setActiveWorkflowId, setActiveSkill,
    activeTab, setProjects, openWorkspaceSettings, closeWorkspaceSettings,
    workspaceSettingsOpen, activeProjectId, activeSessionId, setActiveSession, openGuide,
  } = useChatStore();
  // Project home shows when the user has picked a project but isn't in a
  // specific chat yet — surfaces the rolling summary, RAG status, and
  // recent chats. Otherwise the canvas is the conversation.
  const showProjectHome = activeProjectId !== null && !activeSessionId;
  const { isOpen: isBrowserOpen, setOpen: setBrowserOpen } = useBrowserStore();
  // Colour of the active room (Artha=indigo / Workflows=violet / Code=emerald),
  // driving the canvas accent line + ambient tint.
  const canvasTheme = tabTheme(activeTab);

  // First-run onboarding gate. `null` = still loading the flag; show nothing
  // structural until we know, to avoid a flash of the empty chat behind it.
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);

  // Feature tours: the first time a user lands on a tab (after onboarding), open
  // its step-by-step slideshow once. Reads `seenGuides` fresh from the store so
  // marking a tour seen never re-triggers it. Keyed `tour:<tab>`.
  useEffect(() => {
    if (showOnboarding !== false) return;
    const { seenGuides, startTour } = useChatStore.getState();
    if (!seenGuides.has(`tour:${activeTab}`)) startTour(activeTab);
  }, [activeTab, showOnboarding]);

  // In-app "update available" banner — set when the main process detects a
  // newer GitHub release. Notification-only; the button opens the download page.
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => {
    const off = window.artha.updates.onAvailable(({ version }) => setUpdateVersion(version));
    return () => { off(); };
  }, []);

  // One-time crash-reporting disclosure. Crash reports are opt-out (on by
  // default); on first launch we tell the user once and let them disable it in
  // Settings. Shown until acknowledged, then never again.
  const [showSentryDisclosure, setShowSentryDisclosure] = useState(false);
  useEffect(() => {
    window.artha.settings.getSentry()
      .then(({ disclosureAck }) => { if (!disclosureAck) setShowSentryDisclosure(true); })
      .catch(() => { /* fresh DB / no handler — skip */ });
  }, []);
  const ackSentryDisclosure = () => {
    setShowSentryDisclosure(false);
    window.artha.settings.ackSentryDisclosure().catch(() => { /* best-effort */ });
  };

  // Show the "How to use Artha" guide once, right after onboarding completes,
  // for first-time users. Reopenable anytime from the Help (?) button.
  useEffect(() => {
    if (showOnboarding !== false) return;
    if (localStorage.getItem('artha_guide_seen')) return;
    localStorage.setItem('artha_guide_seen', '1');
    openGuide();
  }, [showOnboarding, openGuide]);

  useEffect(() => {
    window.artha.settings.get().then((s: { onboardingComplete?: boolean }) => {
      setShowOnboarding(!s?.onboardingComplete);
    }).catch(() => setShowOnboarding(false));
  }, []);

  useEffect(() => {
    // Wire IPC → store
    const offToken    = window.artha.agent.onToken(appendToken);
    const offTool     = window.artha.agent.onToolCall((ev) => addToolEvent(ev as Parameters<typeof addToolEvent>[0]));
    const offPlan     = window.artha.agent.onPlanReady((plan) => {
      setPendingPlan(plan as never);
      finaliseStream();
    });

    // agent:streamEnd fires when the orchestrator is fully done — authoritative
    // signal to flush the message, even for tool-only responses with no tokens.
    // Also clear any stale tool-approval modal: if the run ended (e.g. the user
    // hit Stop while an approval was pending), the modal must not linger.
    const offEnd = window.artha.agent.onStreamEnd(() => { setPendingToolApproval(null); finaliseStream(); });
    const offReset = window.artha.agent.onStreamReset(resetStream);
    const offWorkflow = window.artha.agent.onWorkflowStart((id) => {
      setStreaming(true);
      setActiveWorkflowId(id);
    });
    const offCitations = window.artha.agent.onCitations((p) => addCitations(p.citations));

    // The orchestrator tells us which skill (if any) it loaded for this run —
    // surfaced as a badge in the composer until the stream ends.
    const offSkill = window.artha.agent.onSkillActive((s) => setActiveSkill(s));

    // Clarification request — orchestrator paused before planning; show modal.
    const offClarify = window.artha.agent.onClarifyRequest((req) => {
      setStreaming(false); // not streaming yet — waiting for user answers
      setPendingClarify(req);
    });

    // Per-tool-call approval — a policy with the "confirm" tier paused a single
    // function call. Show the approval modal; the run resumes on the answer.
    const offToolApproval = window.artha.agent.onToolApprovalRequest((req) => {
      setPendingToolApproval(req);
    });

    // Live session title updates — main auto-titles a session from its first
    // user message; this keeps the sidebar in sync without a manual reload.
    const offTitle = window.artha.sessions.onTitleUpdated(({ sessionId, title }) => {
      setSessions(sessions.map(s =>
        s.session_id === sessionId ? { ...s, title } : s
      ));
      window.artha.sessions.list().then(setSessions);
    });

    // Auto-open the browser pane when the agent calls a browser tool — keeps
    // the user in the loop without forcing them to find a toggle.
    const offAutoOpen = window.artha.browser.onAutoOpen(() => setBrowserOpen(true));

    // Hydrate sidebar session list + project list on first mount.
    window.artha.sessions.list().then(setSessions);
    window.artha.projects.list().then(setProjects).catch(() => { /* fresh DB */ });

    return () => { offToken(); offTool(); offPlan(); offEnd(); offReset(); offWorkflow(); offCitations(); offSkill(); offClarify(); offToolApproval(); offTitle(); offAutoOpen(); };
  }, []);

  // ── Always land on a ready chat ──────────────────────────────────────────
  // Without this, a user with no active session sees the empty welcome screen
  // with no composer and has to click "New Chat" before they can type. Once
  // onboarding is done and there's no active session (and no project — projects
  // show ProjectHome instead), open the most recent non-project chat, or create
  // a fresh one if there are none.
  useEffect(() => {
    if (showOnboarding !== false) return;
    if (activeSessionId || activeProjectId) return;
    let cancelled = false;
    (async () => {
      const list = await window.artha.sessions.list();
      if (cancelled) return;
      const general = list.filter((s: Session) => !s.project_id);
      if (general.length > 0) {
        setSessions(list);
        setActiveSession(general[0].session_id);
      } else {
        const session = await window.artha.sessions.create(null);
        if (cancelled) return;
        setSessions(await window.artha.sessions.list());
        setActiveSession(session.session_id);
      }
    })();
    return () => { cancelled = true; };
  }, [showOnboarding, activeSessionId, activeProjectId, setActiveSession, setSessions]);

  // ── Global keyboard shortcuts ────────────────────────────────────────────
  // ⌘, (Mac) / Ctrl+, (everywhere else) toggles Workspace Settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        if (workspaceSettingsOpen) closeWorkspaceSettings();
        else openWorkspaceSettings(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceSettingsOpen, openWorkspaceSettings, closeWorkspaceSettings]);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={150}>
      <div className="flex h-screen w-screen overflow-hidden bg-artha-bg text-artha-text">
        {/* macOS-style drag region */}
        <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />

        <Sidebar />

        <main className="flex flex-1 flex-col overflow-hidden pt-8">
          {/* Tab bar — only shows when the workspace settings modal isn't
              the active surface. activeView !== 'chat' here means a legacy
              call-site opened the modal; tabs stay visible behind the modal
              backdrop because the canvas content underneath is unchanged. */}
          <TabBar />

          {/* Per-tab accent line — a 2px bar in the active room's colour
              (indigo / violet / emerald) so each surface is instantly
              distinguishable. Sits flush under the tab bar. */}
          <div
            aria-hidden
            className="h-0.5 w-full shrink-0 transition-colors"
            style={{ backgroundColor: canvasTheme.accent }}
          />

          {/* Per-tab canvas — a whisper of the room's colour as an ambient tint
              behind the content. ----------------------------------------- */}
          <div
            className="flex flex-1 flex-col overflow-hidden"
            style={{ backgroundColor: canvasTheme.tint }}
          >
          {activeTab === 'chat' && (
            <div className="flex flex-1 overflow-hidden">
              {showProjectHome ? <ProjectHome /> : (
                // Wrap the conversation in a column so the contextual ChatHeader
                // (breadcrumb · rename · scope · run details) sits above it.
                <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
                  <ChatHeader />
                  <ChatWindow />
                </div>
              )}
              {/* Execution log / browser pane stays mounted alongside chat;
                  it's a sidekick rail, not a tab — and it's also useful when
                  Project home is showing for inspecting prior tool runs. */}
              {isBrowserOpen
                ? <><BrowserResizer /><BrowserPane onClose={() => setBrowserOpen(false)} /></>
                : <ExecutionLog />}
            </div>
          )}
          {activeTab === 'workflows' && <WorkflowsTab />}
          {activeTab === 'code'      && <CodeTab />}
          {activeTab === 'delegate' && (
            // Delegate hosts the embedded browser pane too: when a delegated
            // task drives the browser (e.g. a login-gated site), the user must
            // be able to SEE the page and complete a handoff (log in, then hand
            // control back). Without this the run stalls invisibly on the login.
            <div className="flex flex-1 overflow-hidden">
              <DelegateTab />
              {isBrowserOpen && <><BrowserResizer /><BrowserPane onClose={() => setBrowserOpen(false)} /></>}
            </div>
          )}
          </div>
        </main>

        {/* Modal layer — sits above the canvas regardless of tab. */}
        <WorkspaceSettings />
        <PlanApproval />
        <ClarificationModal />
        <ToolApprovalModal />
        <RunInspector />

        {showOnboarding && <Onboarding onDone={() => setShowOnboarding(false)} />}

        {/* First-run feature slideshow — auto-opens once per tab, replayable
            from the TabBar "?". */}
        <FeatureTour />

        {/* Local-model startup status — Artha auto-starts Ollama + warms the
            model; this is the quiet, non-blocking notice (bottom-left). */}
        <ModelStatusBanner />

        {/* "Artha is working" — window glow + pill while the agent is acting. */}
        <WorkingIndicator />

        {/* Transient notifications (errors, retries, run results) — bottom-right. */}
        <Toaster />

        {/* Keyboard cheatsheet — toggled with `?`. */}
        <ShortcutsOverlay />

        {/* Global launcher — ⌘K / Ctrl+K. */}
        <CommandPalette />

        {/* Proactive "Artha changed N files · Undo" after a run. */}
        <UndoAfterRun />

        {/* Opt-in "since you were last here" briefing (Settings → General). */}
        <Briefing />

        {/* Update-available banner — bottom-right, non-blocking. */}
        {updateVersion && (
          <div className="fixed bottom-4 right-4 z-[60] flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-accent/40 shadow-lifted text-sm">
            <span className="text-base leading-none">🎉</span>
            <span className="text-artha-text">
              Artha <strong>v{updateVersion}</strong> is available
            </span>
            <button
              onClick={() => window.artha.updates.openDownload()}
              className="px-3 py-1 rounded-lg bg-artha-accent hover:bg-artha-accent-hover text-artha-on-accent text-xs font-medium transition-colors"
            >
              Download
            </button>
            <button
              onClick={() => setUpdateVersion(null)}
              className="text-artha-muted hover:text-artha-text transition-colors"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {/* One-time crash-reporting disclosure — bottom-left, non-blocking. */}
        {showSentryDisclosure && (
          <div className="fixed bottom-4 left-4 z-[60] max-w-sm flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-border shadow-lifted text-sm">
            <span className="text-base leading-none mt-0.5">🛡️</span>
            <div className="flex-1 min-w-0">
              <p className="text-artha-text leading-snug">
                Artha sends anonymous crash reports to help fix bugs. No files or
                conversations are included. You can disable this in Settings.
              </p>
              <button
                onClick={ackSentryDisclosure}
                className="mt-2 px-3 py-1 rounded-lg bg-artha-accent hover:bg-artha-accent-hover text-artha-on-accent text-xs font-medium transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
