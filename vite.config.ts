import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * pdf.js loads CMaps, standard fonts, ICC profiles and wasm decoders at
 * runtime. Serve them from node_modules in dev and copy them into the build.
 */
function pdfjsAssets(): Plugin {
  const root = fileURLToPath(new URL("./node_modules/pdfjs-dist/", import.meta.url));
  const dirs = ["cmaps", "standard_fonts", "wasm", "iccs"];
  const types: Record<string, string> = {
    ".wasm": "application/wasm",
    ".ttf": "font/ttf",
    ".js": "text/javascript",
  };
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]);
        const file = normalize(join(root, url));
        const allowed = dirs.some((d) => file.startsWith(join(root, d) + sep));
        if (!allowed || !existsSync(file) || !statSync(file).isFile()) return next();
        const ext = file.slice(file.lastIndexOf("."));
        res.setHeader("Content-Type", types[ext] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        for (const name of readdirSync(join(root, dir))) {
          // PDF JavaScript (QuickJS sandbox) is never run by this app.
          if (name.startsWith("quickjs")) continue;
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${dir}/${name}`,
            source: readFileSync(join(root, dir, name)),
          });
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), pdfjsAssets()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri's webviews are modern; pdf.js's legacy build covers older WebKit.
    target: ["es2022", "safari15"],
    chunkSizeWarningLimit: 3000,
  },
}));
