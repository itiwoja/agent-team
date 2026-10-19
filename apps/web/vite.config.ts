import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
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
        },
      },
    },
  },
});
