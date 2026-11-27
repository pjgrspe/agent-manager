# Citadel — Multi-Project Control Center

A lightweight Windows desktop & local web Control Center for managing multiple repositories across **any coding agent** (**Claude Code, Antigravity, Codex, Cursor**) and [`pjgrspe/bastion`](https://github.com/pjgrspe/bastion).

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
