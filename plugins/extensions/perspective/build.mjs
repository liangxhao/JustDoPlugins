import assert from 'node:assert/strict';
import { copyFile, readFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

/** Restrict the public distribution's auto-registration to offline renderers. */
export function browserPlugins() {
  return [{ name: 'offline-perspective-renderers', setup(builder) {
    builder.onLoad({ filter: /[\\/]viewer-charts[\\/]dist[\\/]esm[\\/]perspective-viewer-charts\.js$/ }, async args => {
      const contents = await readFile(args.path, 'utf8');
      const auto = /([\w$]+)\(\);export\{/;
      assert.ok(auto.test(contents), 'Upstream chart auto-registration changed.');
      const names = ['X Bar','Y Bar','Y Line','Y Scatter','Y Area','X/Y Scatter','X/Y Line','Density','Treemap','Sunburst','Heatmap','Candlestick','OHLC'];
      return { contents: contents.replace(auto, (_match, register) => `${register}(${names.map(name => JSON.stringify(name)).join(',')});export{`), loader: 'js', resolveDir: dirname(args.path) };
    });
  } }];
}

/** Relocate the pinned public Node distribution's WASM assets for offline use. */
export async function buildAdditionalAssets(root, output) {
  const require = createRequire(import.meta.url);
  const clientPackage = require.resolve('@perspective-dev/client/package.json');
  const client = dirname(clientPackage);
  const server = dirname(require.resolve('@perspective-dev/server/package.json'));
  for (const name of ['client', 'server', 'viewer', 'viewer-datagrid', 'viewer-charts'])
    assert.equal(
      JSON.parse(await readFile(require.resolve(`@perspective-dev/${name}/package.json`), 'utf8'))
        .version,
      '5.6.0',
      `Unsupported style/engine version: ${name}`,
    );
  const extract = join(dirname(require.resolve('pro_self_extracting_wasm')), 'extract.mjs');
  const engine = await build({
    absWorkingDir: root,
    entryPoints: ['plugins/extensions/perspective/validation-worker.ts'],
    outfile: join(output, 'validation-worker.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    loader: { '.css': 'text' },
    banner: {
      js: "import { createRequire as requireFrom } from 'node:module'; const require = requireFrom(import.meta.url);",
    },
    // Validation only extracts packaged WASM. The compressor's Node entry has
    // an unrelated runtime.wasm side effect and is not needed at runtime.
    alias: { pro_self_extracting_wasm: extract },
    define: {
      'process.env.WS_NO_BUFFER_UTIL': '"1"',
      'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    },
    plugins: [
      {
        name: 'relocate-public-perspective-wasm',
        setup(builder) {
          // These public modules only compute style schemas. Lexical stubs keep
          // their unused DOM/renderer definitions out of Node without changing
          // global feature detection used by the real WASM query engine.
          builder.onLoad(
            { filter: /[\\/]viewer-charts[\\/]src[\\/]ts[\\/]plugin[\\/]plugin\.ts$/ },
            async args => ({
              contents:
                'const HTMLElement=class {}; const CSSStyleSheet=class { replaceSync() {} };\n' +
                (await readFile(args.path, 'utf8')),
              resolveDir: dirname(args.path),
              loader: 'ts',
            }),
          );
          builder.onLoad(
            {
              filter:
                /[\\/]viewer-datagrid[\\/]src[\\/]ts[\\/]plugin[\\/]plugin_config_schema\.ts$/,
            },
            async args => ({
              contents:
                'const window={getComputedStyle:()=>({getPropertyValue:()=>""})};\n' +
                (await readFile(args.path, 'utf8')),
              resolveDir: dirname(args.path),
              loader: 'ts',
            }),
          );
          builder.onResolve({ filter: /renderer\.worker\.js$/ }, args => {
            assert.ok(
              args.importer
                .replaceAll('\\', '/')
                .endsWith('/viewer-charts/src/ts/transport/renderer-transport.ts'),
            );
            return { path: 'unused-renderer-worker', namespace: 'schema-only' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'schema-only' }, () => ({
            contents:
              'export default () => { throw new Error("Style validation cannot create a renderer."); };',
            loader: 'js',
          }));
          builder.onLoad({ filter: /perspective\.node\.js$/ }, async args => {
            let contents = await readFile(args.path, 'utf8');
            for (const [from, to] of [
              [
                'path.join(__dirname, "../../dist/wasm/perspective-js.wasm")',
                'path.join(__dirname, "perspective-js.wasm")',
              ],
              ['if (host_supports_memory64()) {', 'if (false) {'],
              [
                'resolve("@perspective-dev/server/dist/wasm/perspective-server.wasm")',
                'path.join(__dirname, "perspective-server.wasm")',
              ],
            ]) {
              assert.equal(contents.split(from).length, 2, `Upstream WASM layout changed: ${from}`);
              contents = contents.replace(from, to);
            }
            return { contents, loader: 'js', resolveDir: dirname(args.path) };
          });
        },
      },
    ],
    metafile: true,
  });
  const wasm = [
    [join(client, 'dist/wasm/perspective-js.wasm'), 'perspective-js.wasm'],
    [join(server, 'dist/wasm/perspective-server.wasm'), 'perspective-server.wasm'],
  ];
  for (const [from, to] of wasm) await copyFile(from, join(output, to));
  for (const artifact of Object.values(engine.metafile.outputs))
    for (const imported of artifact.imports)
      assert.ok(
        !imported.external || builtinModules.includes(imported.path.replace(/^node:/, '')),
        `Unexpected runtime dependency: ${imported.path}`,
      );
  return {
    assets: ['validation-worker.mjs', ...wasm.map(([, file]) => file)],
    inputs: [
      ...Object.keys(engine.metafile.inputs).filter(file => !file.startsWith('schema-only:')),
      ...wasm.map(([file]) => file),
    ],
  };
}
