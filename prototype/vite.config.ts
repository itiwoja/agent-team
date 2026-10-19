import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /mnt/c（WSL から見た Windows のドライブ）ではファイルの変更通知が届かないので、ポーリングで監視する
export default defineConfig({ plugins: [react()], server: { port: 5173, watch: { usePolling: true, interval: 300 } } })
