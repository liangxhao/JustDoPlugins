import { build } from 'esbuild';

// Test hosts must obey the same browser port restrictions as packaged resources.
const bundle = await build({
  entryPoints: ['shared/loopback.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
export const { listenLoopback } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
