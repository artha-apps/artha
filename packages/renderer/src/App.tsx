/**
 * App root — wires IPC event listeners and renders the shell layout.
 * Layout: [Sidebar | ChatWindow | (BrowserPane OR ExecutionLog)]
 */
import { useEffect, useState } from 'react';
import { useChatStore } from './stores/chat';
import Onboarding from './components/Onboarding/Onboarding';
import Sidebar from './components/Sidebar/Sidebar';
import ChatWindow from './components/Chat/ChatWindow';
import ExecutionLog from './components/ExecutionLog/ExecutionLog';
import PlanApproval from './components/Chat/PlanApproval';
import ClarificationModal from './components/Chat/ClarificationModal';
import ModelsPanel from './components/Settings/ModelsPanel';
import MCPToolsPanel from './components/Settings/MCPToolsPanel';
import SkillsPanel from './components/Settings/SkillsPanel';
import RAGPanel from './components/Settings/RAGPanel';
import WebPanel from './components/Settings/WebPanel';
import BrowserPane from './components/Browser/BrowserPane';
import { useBrowserStore } from './stores/browser';
import RouterPanel from './components/Settings/RouterPanel';
import TimeTravelPanel from './components/Settings/TimeTravelPanel';
import ProvenancePanel from './components/Settings/ProvenancePanel';
import BundlesPanel from './components/Settings/BundlesPanel';
import ArtifactsPanel from './components/Settings/ArtifactsPanel';
import MarketplacePanel from './components/Settings/MarketplacePanel';

declare global {
  interface Window {
    artha: import('../../app/src/preload').ArthaAPI;
  }
}

export default function App() {
  const { appendToken, resetStream, finaliseStream, addToolEvent, addCitations, setPendingPlan, setPendingClarify, setSessions, sessions, activeView, setStreaming, setActiveWorkflowId, setActiveSkill } = useChatStore();
  const { isOpen: isBrowserOpen, setOpen: setBrowserOpen } = useBrowserStore();

  // First-run onboarding gate. `null` = still loading the flag; show nothing
  // structural until we know, to avoid a flash of the empty chat behind it.
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);

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
    const offEnd = window.artha.agent.onStreamEnd(finaliseStream);
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

    // Load sessions
    window.artha.sessions.list().then(setSessions);

    return () => { offToken(); offTool(); offPlan(); offEnd(); offReset(); offWorkflow(); offCitations(); offSkill(); offClarify(); offTitle(); offAutoOpen(); };
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-artha-surface text-white">
      {/* macOS-style drag region */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />

      <Sidebar />

      <main className="flex flex-1 overflow-hidden pt-8">
        {activeView === 'chat' && (
          <>
            <ChatWindow />
            {isBrowserOpen
              ? <BrowserPane onClose={() => setBrowserOpen(false)} />
              : <ExecutionLog />}
          </>
        )}
        {activeView === 'models' && <ModelsPanel />}
        {activeView === 'skills' && <SkillsPanel />}
        {activeView === 'mcp' && <MCPToolsPanel />}
        {activeView === 'web' && <WebPanel />}
        {activeView === 'router' && <RouterPanel />}
        {activeView === 'timetravel' && <TimeTravelPanel />}
        {activeView === 'provenance' && <ProvenancePanel />}
        {activeView === 'bundles' && <BundlesPanel />}
        {activeView === 'artifacts' && <ArtifactsPanel />}
        {activeView === 'marketplace' && <MarketplacePanel />}
        {activeView === 'rag' && <RAGPanel />}
        {activeView === 'settings' && (
          <div className="flex-1 flex items-center justify-center text-artha-muted text-sm">
            Settings — coming soon
          </div>
        )}
      </main>

      <PlanApproval />
      <ClarificationModal />

      {showOnboarding && <Onboarding onDone={() => setShowOnboarding(false)} />}
    </div>
  );
}
