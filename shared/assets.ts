import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { listenLoopback } from './loopback';

// WASM runs in this isolated loopback page, never by relaxing the host sandbox.
export async function serveEditor(directory: string) {
  const route = `/${randomBytes(24).toString('hex')}/editor`;
  const html = readFileSync(join(directory, 'app.html'));
  const integrity = JSON.parse(readFileSync(join(directory, 'integrity.json'), 'utf8')) as {
    assets: Record<string, string>;
  };
  for (const file of ['server.cjs', 'app.html'])
    if (!Object.hasOwn(integrity.assets, file))
      throw new Error('Missing application asset fingerprint.');
  for (const file of Object.keys(integrity.assets)) {
    if (isAbsolute(file) || !resolve(directory, file).startsWith(resolve(directory) + sep))
      throw new Error('Invalid application asset path.');
    const hash = createHash('sha256')
      .update(file === 'app.html' ? html : readFileSync(join(directory, file)))
      .digest('hex');
    if (hash !== integrity.assets[file])
      throw new Error('Application asset integrity check failed. Reinstall the complete package.');
  }
  const http = createServer((request, response) => {
    if (
      request.headers.host !== new URL(origin).host ||
      request.url !== route ||
      !['GET', 'HEAD'].includes(request.method ?? '')
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src blob:; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : html);
  });
  let origin = '';
  origin = await listenLoopback(http);
  http.unref();
  const wrapper = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:560px;display:block}
    @media(min-height:650px){iframe{height:100vh}}
    </style></head><body><iframe title="Local editor" sandbox="allow-scripts allow-same-origin" src="${origin}${route}"></iframe><script>
    const editor=document.querySelector('iframe');
    addEventListener('message',event=>{
      if(!event.data||event.data.jsonrpc!=='2.0')return;
      if(event.source===editor.contentWindow&&(event.origin==='null'||event.origin===${JSON.stringify(origin)})){
        parent.postMessage(event.data,'*');
      }else if(event.source===parent){
        // Native MCP Apps keeps the content ancestor opaque. That sandbox flag
        // is inherited by this editor even though its URL is loopback. An opaque
        // receiver requires '*'; the exact WindowProxy above binds this relay.
        editor.contentWindow.postMessage(event.data,'*');
      }
    });
    </script></body></html>`;
  return { origin, wrapper, close: () => http.close() };
}
