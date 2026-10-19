import { defineConfig } from 'tsup';
import pkg from './package.json';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'plugins/adk': 'src/plugins/adk.ts',
    'plugins/langchain': 'src/plugins/langchain.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: true,
  target: 'node18',
  external: ['openai', '@anthropic-ai/sdk', '@google/genai', '@langchain/openai', '@langchain/anthropic', '@langchain/google-genai', '@google/adk', 'dotenv'],
  define: {
    __SWITCH_TRUST_VERSION__: JSON.stringify(pkg.version),
  },
});
