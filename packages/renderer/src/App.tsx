/**
 * App root — wires IPC event listeners and renders the shell layout.
 * Layout: [Sidebar | ChatWindow | (BrowserPane OR ExecutionLog)]
 */
import { useEffect } from 'react';
import { useChatStore } from './stores/chat';
import Sidebar from './components/Sidebar/Sidebar';
import ChatWindow from './components/Chat/ChatWindow';
import ExecutionLog from './components/ExecutionLog/ExecutionLog';
import PlanApproval from './components/Chat/PlanApproval';
import ModelsPanel from './components/Settings/ModelsPanel';
import MCPToolsPanel from './components/Settings/MCPToolsPanel';
import WebPanel from './components/Settings/WebPanel';
import BrowserPane from './components/Browser/BrowserPane';
import { useBrowserStore } from './stores/browser';

declare global {
  interface Window {
    artha: import('../../app/src/preload').ArthaAPI;
  }
}

export default function App() {
  const { appendToken, finaliseStream, addToolEvent, setPendingPlan, setSessions, activeView } = useChatStore();
  const { isOpen: isBrowserOpen, setOpen: setBrowserOpen } = useBrowserStore();

  useEffect(() => {
    // Wire IPC → store
    const offToken    = window.artha.agent.onToken(appendToken);
    const offTool     = window.artha.agent.onToolCall(addToolEvent);
    const offPlan     = window.artha.agent.onPlanReady((plan) => {
      setPendingPlan(plan as never);
      finaliseStream();
    });

    // Detect end of stream: 200ms silence after last token
    let timer: ReturnType<typeof setTimeout>;
    const offTokenFS = window.artha.agent.onToken(() => {
      clearTimeout(timer);
      timer = setTimeout(finaliseStream, 200);
    });

    // Auto-open the browser pane when the agent calls a browser tool — keeps
    // the user in the loop without forcing them to find a toggle.
    const offAutoOpen = window.artha.browser.onAutoOpen(() => setBrowserOpen(true));

    // Load sessions
    window.artha.sessions.list().then(setSessions);

    return () => { offToken(); offTool(); offPlan(); offTokenFS(); offAutoOpen(); clearTimeout(timer); };
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
        {activeView === 'mcp' && <MCPToolsPanel />}
        {activeView === 'web' && <WebPanel />}
        {activeView === 'rag' && (
          <div className="flex-1 flex items-center justify-center text-artha-muted text-sm">
            RAG Index — coming soon
          </div>
        )}
        {activeView === 'settings' && (
          <div className="flex-1 flex items-center justify-center text-artha-muted text-sm">
            Settings — coming soon
          </div>
        )}
      </main>

      <PlanApproval />
    </div>
  );
}
