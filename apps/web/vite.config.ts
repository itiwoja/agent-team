import { connect } from "node:net";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const target = "http://localhost:8080";
/** app の起動を待つ上限（/mnt/c の上では node --watch の app が受け付けるまで数十秒かかる） */
const API_WAIT_MS = 120_000;

/** app が接続を受け付けると分かっているか。中継に失敗したら（app の再起動など）false に戻し、次の要求でまた待つ */
let apiReady = false;

function apiListening(url: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(Number(url.port), url.hostname);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * pnpm dev では vite が app より先に立ち上がる。その間に画面を開くと GET /api/v1/session が 502 になり、
 * 画面は「つながらない」（または入口のトークン）のまま止まる。app が受け付けるまで /api の要求を待たせてから中継する
 */
function waitForApi(): Plugin {
  const api = new URL(target);
  return {
    name: "open-team:wait-for-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, _res, next) => {
        if (!apiReady && req.url?.startsWith("/api")) {
          const until = Date.now() + API_WAIT_MS;
          while (!(apiReady = await apiListening(api)) && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), waitForApi()],
  server: {
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        // 元の接続の相手を X-Forwarded-For で app に渡す（トークンなしの入口を、このマシンの中からだけに絞るため）
        xfwd: true,
        // app は Origin のホストと Host が一致しない要求を断る（SO §3.8）。開発サーバー越しでも通るよう Origin を中継先に合わせる
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", target);
          });
          proxy.on("error", () => {
            apiReady = false;
          });
        },
      },
    },
  },
});
