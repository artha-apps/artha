# Contributing to Artha

Thank you for your interest in contributing! Artha is open-core: the source is
MIT-licensed, and a separate commercial tier is offered by Shree Labs Inc.

## Contributor License Agreement (CLA)

Before a contribution can be merged, you must agree to the following. By
submitting a pull request, patch, or other contribution to this project, you
represent and agree that:

1. **You wrote it / have the right to submit it.** The contribution is your
   original work, or you otherwise have the necessary rights to submit it, and
   submitting it does not violate any third party's rights.
2. **License grant.** You license your contribution to the project and its
   users under the project's MIT License.
3. **Relicensing grant (important).** You additionally grant Shree Labs Inc. a
   perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to
   use, reproduce, modify, sublicense, and **relicense** your contribution,
   including under different terms (e.g. as part of Artha's proprietary
   commercial tier). You retain copyright in your contribution.

This lets the project ship your work in both the open-source core and the
commercial edition without having to track down every contributor later.

> Mechanism: small PRs are accepted with a Conventional Commit sign-off
> (`git commit -s`, adding a `Signed-off-by` line — the
> [Developer Certificate of Origin](https://developercertificate.org/)). For the
> relicensing grant above we recommend wiring up a CLA bot (e.g. CLA Assistant)
> so first-time contributors accept these terms on their first PR. Until then,
> a contributor confirming "I agree to the CLA" in the PR is sufficient.

## Getting Started

1. Fork the repo and clone locally
2. Install prerequisites: Node.js 22+, Ollama, Docker Desktop
3. `npm install` from the root
4. `npm run dev` to start the dev build
5. Make your changes, test locally, open a PR

## Areas We Most Need Help With

- **MCP server integrations** — GitHub, Notion, Calendar, Slack connectors
- **Document templates** — Better DOCX/PPTX styling and default layouts  
- **Hardware detection** — GPU VRAM detection on Windows/Linux for model recommendations
- **Testing** — Unit tests for the agent orchestrator and document generators
- **Windows/Linux compatibility** — Most dev happens on macOS; parity testing welcome

## Code Style

- TypeScript strict mode throughout
- No `any` types without a comment explaining why
- All IPC channels must be registered in `preload.ts` — never expose raw `ipcRenderer`
- New features touching the agent loop should include a description in `docs/architecture.md`

## Commit Convention

We use Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`

## Questions?

Open a GitHub Discussion or file an issue.
