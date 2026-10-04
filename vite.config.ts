import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  // Absolute base: the SPA is served for deep paths such as
  // /cloud/workflow/<id>, and a relative "./assets/…" would resolve under that
  // path (→ the HTML fallback, i.e. a blank page on reload / shared links).
  base: "/",
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/webhook": "http://localhost:3001",
      // legal pages (AGB / Impressum / Datenschutz) live at root paths on the
      // server; /legal/* stays as an alias
      "/agb": "http://localhost:3001",
      "/impressum": "http://localhost:3001",
      "/datenschutz": "http://localhost:3001",
      "/legal": "http://localhost:3001",
      // workflow reference + JSON Schema for AI agents, and the MCP endpoint
      "/docs/workflow-reference.md": "http://localhost:3001",
      "/schema": "http://localhost:3001",
      "/mcp": "http://localhost:3001",
    },
  },
});
