import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertFreshAppBuild, discoverApps } from '../scripts/apps.mjs';
import { verifyAppContract } from './app-contract-checks.mjs';

const apps = await discoverApps();
const bundle = async file =>
  (
    await build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
    })
  ).outputFiles[0].text;
const host = await bundle('tests/app-contract-host.ts');
const counterexample = await bundle('tests/fixtures/header-app.ts');
let browser;
before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
  await browser?.close();
});

async function open(wrapper, search = '') {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/host.js' || path === '/counterexample.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(path === '/host.js' ? host : counterexample);
    } else if (path === '/wrapper') {
      res.setHeader('Content-Type', 'text/html');
      res.end(wrapper);
    } else if (path === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<style>html,body{height:100%;margin:0}iframe{border:0;width:100%;height:100%}</style><iframe></iframe><script type="module" src="/host.js"></script>',
      );
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const errors = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol))
      return route.continue();
    errors.push(`Unexpected public request: ${url.origin}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const close = async () => {
    await context.close();
    await new Promise(resolve => server.close(resolve));
  };
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/${search}`);
    await page.waitForFunction(() => globalThis.appCapabilities, undefined, { timeout: 45000 });
    let frame;
    for (const candidate of page.frames())
      if (await candidate.locator('[data-app-toolbar]').count()) frame = candidate;
    assert.ok(frame, 'Registered App must expose the presentation contract DOM markers');
    return { page, frame, errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}

for (const name of apps) {
  test(
    `${name}: built App satisfies the required presentation contract`,
    { timeout: 90000 },
    async () => {
      await assertFreshAppBuild(name);
      const directory = await mkdtemp(join(tmpdir(), 'app-contract-'));
      const client = new Client({ name: 'App conformance fixture', version: '1' });
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [resolve('plugins', 'extensions', name, 'dist/server.cjs')],
            env: { ...process.env, MCP_APP_DATA_DIR: directory },
            stderr: 'pipe',
          }),
        );
        const { resources } = await client.listResources();
        const uiResources = resources.filter(item => item.mimeType === 'text/html;profile=mcp-app');
        assert.ok(uiResources.length, 'Registered App must publish an actual UI resource');
        const { tools } = await client.listTools();
        const uiTools = tools.filter(tool => typeof tool._meta?.ui?.resourceUri === 'string');
        assert.ok(uiTools.length, 'Registered App must expose a tool connected to its UI');
        for (const tool of uiTools) {
          assert.ok(
            uiResources.some(resource => resource.uri === tool._meta.ui.resourceUri),
            'Every App tool must refer to a published UI resource',
          );
        }
        for (const resource of uiResources) {
          const result = await client.readResource({ uri: resource.uri });
          const content = result.contents.find(
            item =>
              item.uri === resource.uri &&
              item.mimeType === resource.mimeType &&
              typeof item.text === 'string',
          );
          assert.ok(content, 'App resource must return matching HTML content and MIME');
          const wrapper = content.text;
          const fixture = await open(wrapper);
          try {
            await verifyAppContract(fixture.page, fixture.frame);
            assert.deepEqual(fixture.errors, []);
          } finally {
            await fixture.close();
          }
          for (const hostVersion of ['none', '2']) {
            const legacy = await open(wrapper, `?hostVersion=${hostVersion}`);
            try {
              await legacy.page.evaluate(() =>
                globalThis.updateContext({
                  'ui/shared-header': { height: 44, left: 100, right: 80 },
                }),
              );
              await legacy.frame.evaluate(
                () =>
                  new Promise(resolve =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  ),
              );
              assert.equal(
                await legacy.frame.locator('[data-app-title]').isVisible(),
                true,
                'Unsupported hosts must keep a complete standalone toolbar',
              );
              assert.equal(
                await legacy.frame.evaluate(() =>
                  document.documentElement.hasAttribute('data-shared-header'),
                ),
                false,
              );
              assert.deepEqual(legacy.errors, []);
            } finally {
              await legacy.close();
            }
          }
        }
      } finally {
        await client.close();
        assert.equal(dirname(directory), tmpdir());
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

for (const [failure, reason] of [
  ['no-capability', /advertise/],
  ['declaration-only', /apply the shared layout/],
  ['no-reset', /restore the standalone title/],
  ['shrunk-content', /must not move the editor/],
]) {
  test(`App gate rejects ${failure}`, async () => {
    const fixture = await open(
      '<script type="module" src="/counterexample.js"></script>',
      `?failure=${failure}`,
    );
    try {
      await assert.rejects(() => verifyAppContract(fixture.page, fixture.frame), reason);
    } finally {
      await fixture.close();
    }
  });
}
