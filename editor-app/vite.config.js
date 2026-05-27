import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(process.cwd(), 'editor-app'),
  plugins: [react()],
  base: '/ai-editor-app/',
  build: {
    outDir: path.resolve(process.cwd(), 'public/ai-editor-app'),
    emptyOutDir: true
  }
});
