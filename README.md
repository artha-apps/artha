<div align="center">
  <h1>🪔 Artha</h1>
  <p><strong>Your work, done. Locally.</strong></p>
  <p>A local-first AI agent for document workflows, MCP tools, and agentic automation.<br/>No data leaves your machine. Ever.</p>
  <br/>
  <img src="https://img.shields.io/badge/status-early_dev-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/license-proprietary-lightgrey?style=flat-square" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" />
  <img src="https://img.shields.io/badge/LLM-Ollama_first-green?style=flat-square" />
</div>

---

## What is Artha?

**Artha** (Sanskrit: अर्थ — *purpose, livelihood, work*) is a local-first AI agent desktop app that lets you describe any task in plain English and have it executed, produced, and delivered entirely on your machine.

Its primary differentiator: **document workflow generation**. Say "write a project proposal for client X" and Artha produces a polished, formatted DOCX. Say "build a 12-month financial model" and it produces a working XLSX. No cloud. No subscriptions. Your data stays yours.

---

## ✨ Features

| Feature | Status |
|---|---|
| 🤖 Agentic ReAct loop (plan → execute → self-correct) | 🚧 In development |
| 📄 DOCX generation from natural language | 🚧 In development |
| 📊 PPTX presentation generation | 🚧 In development |
| 📈 XLSX spreadsheet generation | 🚧 In development |
| 📑 PDF report generation | 🚧 In development |
| 🔌 MCP-native tool system (any MCP server = a skill) | 🚧 In development |
| 🧠 Local RAG over your files (Ollama embeddings) | 🚧 In development |
| 🦙 Ollama first-class (auto-detect, pull, switch models) | 🚧 In development |
| 🔒 Zero telemetry by default | ✅ By design |
| 🐳 Docker-sandboxed tool execution | 🚧 In development |

---

## 🏗️ Built on

Artha is distributed as proprietary software, but it incorporates and builds
upon open-source work, used under the MIT License — see [`NOTICE`](./NOTICE) for
the preserved upstream copyright and license text:

- **[OpenCoworkAI/open-cowork](https://github.com/OpenCoworkAI/open-cowork)** (MIT) — source code incorporated and modified under MIT; attribution preserved in [`NOTICE`](./NOTICE).
- **[OpenHands](https://github.com/OpenHands/OpenHands)** (MIT) — ReAct/CodeAct orchestration patterns (influence).
- **[Jan AI](https://github.com/janhq/jan)** (MIT) — local LLM management UI/UX inspiration (influence).

Artha is also built with open-source npm dependencies, each under its own
license — see [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).

The original code Shree Labs Inc. added on top is **proprietary** (see
[`LICENSE`](./LICENSE)). The **"Artha" name, the अ mark, and logo are trademarks
of Shree Labs Inc.** — see [`TRADEMARK.md`](./TRADEMARK.md).

---

## 🚀 Quick Start

### Prerequisites

- [Node.js 22+](https://nodejs.org)
- [Ollama](https://ollama.ai) installed and running (`ollama serve`)
- At least one model pulled: `ollama pull llama3.2:3b-instruct-q4_K_M`
- [Docker Desktop](https://docker.com) (optional — for sandboxed tool execution)

### Development

```bash
# Clone
git clone https://github.com/artha-apps/artha.git
cd artha

# Install all workspace dependencies
npm install

# Start dev server (renderer + electron)
npm run dev
```

### Build for distribution

```bash
npm run dist
# Output: dist/Artha-0.1.0.dmg  (macOS)
#         dist/Artha Setup 0.1.0.exe  (Windows)
#         dist/artha_0.1.0_amd64.deb  (Linux)
```

---

## 📁 Project Structure

```
artha/
├── packages/
│   ├── app/                  # Electron main process (Node.js + TypeScript)
│   │   └── src/
│   │       ├── main.ts       # Electron entry point
│   │       ├── preload.ts    # Secure IPC bridge (contextBridge)
│   │       ├── agent/        # ReAct orchestration engine
│   │       ├── llm/          # Single OpenAI-compat LLM client
│   │       ├── mcp/          # MCP tool registry
│   │       ├── rag/          # Local vector store + indexer
│   │       ├── docs/         # Document generation (DOCX/PPTX/XLSX/PDF)
│   │       ├── db/           # SQLite schema + migrations
│   │       └── ipc/          # IPC handler registration
│   └── renderer/             # React 19 UI (Vite + Tailwind + shadcn)
│       └── src/
│           ├── App.tsx
│           ├── stores/       # Zustand state
│           └── components/   # Chat, Sidebar, ExecutionLog, PlanApproval
├── docs/                     # Architecture docs
├── assets/                   # App icons
└── scripts/                  # Dev helpers
```

---

## 🧠 Architecture

Artha uses a **TypeScript-first** stack for v1 — one runtime across main process and renderer, zero cross-language IPC:

```
[React UI] ←— contextBridge IPC —→ [Node.js Main Process]
                                           │
                          ┌────────────────┼────────────────┐
                          ▼                ▼                ▼
                   [Agent Orchestrator] [MCP Registry] [Doc Generator]
                   (ReAct / CoT loop)  (MCP SDK)      (docx/pptx/xlsx)
                          │
                    [LLM Client]  ←— OpenAI-compat REST
                          │
                   [Ollama / LM Studio / llama.cpp]
```

See [`docs/architecture.md`](docs/architecture.md) for full detail.

---

## 🤝 Contributing

Artha is proprietary and not currently open to outside code contributions. If
you'd like to report a bug or request a feature, please open an issue. See
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## 📄 License

Proprietary — Copyright © 2026 Shree Labs Inc. All rights reserved. See
[LICENSE](LICENSE). Third-party dependencies: see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

<div align="center">
  <sub>Artha (अर्थ) — Sanskrit for purpose, meaning, livelihood. Your AI co-worker, locally.</sub>
</div>
