# Contributing to Artha

Artha is **proprietary software** owned by Shree Labs Inc. The source is not
open-source licensed, and the project is **not currently accepting outside code
contributions**.

## How you can help

- **Report bugs** — open a GitHub issue with steps to reproduce, your OS, and
  the app version.
- **Request features** — open an issue describing the problem you're trying to
  solve.
- **Feedback** — open a GitHub Discussion.

## If you have been invited to contribute code

Code contributions are accepted only from people who have signed a written
Contributor Agreement with Shree Labs Inc. in advance. That agreement assigns
(or exclusively licenses) the copyright in your contribution to the Company so
it can be shipped as part of this proprietary product. Do not submit code
without one — unsolicited pull requests containing code cannot be merged.

If you'd like to contribute under such an agreement, contact
**support@artha.space**.

## Internal development notes

- TypeScript strict mode throughout; no `any` without an explanatory comment.
- All IPC channels are registered in `preload.ts` — never expose raw
  `ipcRenderer`.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`.
