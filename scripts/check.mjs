import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = process.env.OPENCLAW_SDK_ROOT
  ? [resolve(process.env.OPENCLAW_SDK_ROOT)]
  : [join(root, 'node_modules/openclaw/dist/plugin-sdk')];
const sdk = candidates.find(candidate => existsSync(join(candidate, 'core.d.ts')));
if (!sdk)
  throw new Error('Set OPENCLAW_SDK_ROOT to the matching OpenClaw dist/plugin-sdk directory.');

const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root);
const diagnostics = [...(config.error ? [config.error] : []), ...parsed.errors];
if (diagnostics.length === 0) {
  parsed.options.paths = {
    'openclaw/plugin-sdk/*': [join(sdk, '*').replaceAll('\\', '/')],
  };
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  diagnostics.push(...ts.getPreEmitDiagnostics(program));
}
if (diagnostics.length) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  );
  process.exitCode = 1;
}
