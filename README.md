# Meridian — Multi-Project Manager

A lightweight Windows desktop & local web project manager for tracking multiple local Git repositories and remote GitHub projects across **any coding agent** (**Claude Code, Antigravity, Codex, Cursor**).

## Zero-Config by Default

- **Works passively out of the box:** Add any local Git repo or remote GitHub `owner/repo`—no `.agents/status.md` or Bastion setup required. Meridian automatically derives project state, recent activity, planned work, and daily/weekly briefings from Git (commits, branch, WIP), GitHub (open/merged PRs, CI status, issues, milestones), and passive agent sessions (Claude Code, Antigravity).
- **Optional `.agents/status.md` override:** `.agents/status.md` is strictly opt-in. Use it (manually, via Meridian's status/notes controls, or via `/bastion recap`) only when you want to pin manual blockers, mark `Waiting on Review` without an open PR, or maintain a custom recap/plan override.

## Run Modes

- **Local Web Dashboard:**
  ```powershell
  npm run dev
  ```
  Opens API on `http://127.0.0.1:4311` and UI on `http://localhost:5173`.

- **Windows Desktop App (Electron):**
  ```powershell
  npm run desktop
  ```

- **Verify Gate (Typecheck + Tests + Build):**
  ```powershell
  npm run verify
  ```
