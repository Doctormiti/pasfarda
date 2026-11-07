import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function noAstralPlugin(): Plugin {
  return {
    name: 'no-astral',
    renderChunk(code: string) {
      return {
        code: code.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, (match) => {
          const cp = match.codePointAt(0);
          return cp ? '\\u{' + cp.toString(16).toUpperCase() + '}' : match;
        }),
        map: null
      };
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), noAstralPlugin()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    hmr: false,
  }
});

