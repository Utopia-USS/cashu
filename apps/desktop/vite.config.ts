import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "renderer",
  base: "/assets/desktop/",
  plugins: [
    react({
      // Match the architecture guard's React files. Pure domain TypeScript needs no Babel pass.
      include: [/\.[jt]sx$/, /[/\\]use[A-Z][^/\\]*\.ts$/],
      babel: { plugins: [["babel-plugin-react-compiler", { target: "19" }]] },
    }),
    tailwindcss(),
  ],
  resolve: { extensions: [".mjs", ".js", ".ts", ".tsx", ".json"] },
  build: {
    target: "esnext",
    // The native renderer is a desktop artifact, independent of Python's retired SPA output.
    outDir: "../dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
  },
});
