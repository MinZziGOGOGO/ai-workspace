# Setup (Windows)

1. Install Node.js 22+ and Git.
2. Install Ollama for Windows, then pull models:
   ollama pull gemma3:12b        # or whatever chat model you run
   ollama pull nomic-embed-text  # required for vector memory
3. In this folder:
   npm install
   npm run dev
4. The app opens with the project picker. Import a real project folder.

Notes
- If "No local models found" appears in Chat, Ollama isn't running or has no models.
- The database lives in %APPDATA%/ai-workspace/workspace.db.
- WSL2 is only needed from Milestone 6 (Hermes). Claude Code CLI is only needed
  from Milestone 5.
