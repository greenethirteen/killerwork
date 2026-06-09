import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(process.cwd(), 'pixel-editor-app'),
  plugins: [react()],
  base: '/pixel-editor-app/',
  build: {
    outDir: path.resolve(process.cwd(), 'public/pixel-editor-app'),
    emptyOutDir: true
  }
});
