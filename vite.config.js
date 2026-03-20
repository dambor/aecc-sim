import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            '/astra': {
                target: 'https://148de6e6-2507-4088-9c3a-1ddead9e4a90-us-east-2.apps.astra.datastax.com',
                changeOrigin: true,
                secure: true,
                rewrite: path => path.replace(/^\/astra/, ''),
                configure: (proxy) => {
                    proxy.on('error', (err) => console.log('proxy error', err))
                    proxy.on('proxyReq', (_, req) => console.log('→ AstraDB:', req.method, req.url))
                    proxy.on('proxyRes', (res) => console.log('← AstraDB:', res.statusCode))
                }
            }
        }
    }
})