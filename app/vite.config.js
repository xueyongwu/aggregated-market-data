import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages 部署在 /<仓库名>/ 子路径下，资源引用必须带这个前缀。
  // 若改用根域名托管（Cloudflare Pages / 自定义域名），改回 '/'。
  base: '/aggregated-market-data/',
})
