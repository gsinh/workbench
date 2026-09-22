import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The harness only exists so the experiments can be run and developed without
// a host application. The package itself ships source, not a bundle.
export default defineConfig({
  plugins: [react()],
  // onnxruntime-web resolves its own WebAssembly at runtime; pre-bundling it
  // rewrites those paths and the glue module fails to load.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
