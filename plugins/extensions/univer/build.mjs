import { builtinModules } from 'node:module';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

export async function buildAdditionalAssets(root, output) {
  const bundle = await build({ absWorkingDir: root, entryPoints: ['plugins/extensions/univer/operations-worker.ts'],
    outfile: join(output, 'operations-worker.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24',
    banner: { js: "import { createRequire as requireFrom } from 'node:module'; const require = requireFrom(import.meta.url);" },
    metafile: true,
  });
  for (const artifact of Object.values(bundle.metafile.outputs))
    for (const imported of artifact.imports)
      assert.ok(!imported.external || builtinModules.includes(imported.path.replace(/^node:/, '')), `Unexpected runtime dependency: ${imported.path}`);
  return { assets: ['operations-worker.mjs'], inputs: Object.keys(bundle.metafile.inputs) };
}
