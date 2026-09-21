import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const nodeServer = `http://localhost:${env.PORT || 3001}`;

  return {
    root: "client",
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      // The browser talks only to this origin. These paths are forwarded to the Node OAuth client.
      proxy: { "/api": nodeServer, "/auth": nodeServer, "/demo": nodeServer, "/launch": nodeServer, "/lab": nodeServer },
      // The wire log imports the shared redaction helper from server/src.
      fs: { allow: [".."] },
    },
    build: { outDir: "../dist/client", emptyOutDir: true },
  };
});
