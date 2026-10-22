import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { z } from 'zod';

const frame = document.querySelector<HTMLIFrameElement>('iframe')!;
const hostContext = await (await fetch('/context')).json();
const bridge = new AppBridge(
  null,
  { name: 'Offline test host', version: '1.0.0' },
  {
    serverTools: {},
    serverResources: {},
    updateModelContext: { text: {} },
    downloadFile: {},
    experimental: { 'ui/shared-header': { version: 1 } },
  },
  {
    hostContext: {
      theme: 'light',
      locale: 'zh-CN',
      displayMode: 'inline',
      containerDimensions: { width: 1200, height: 700 },
      ...hostContext,
    },
  },
);
const fixture = window as unknown as { businessCalls: number };
fixture.businessCalls = 0;
bridge.oncalltool = async params => {
  fixture.businessCalls++;
  const response = await fetch('/tool', { method: 'POST', body: JSON.stringify(params) });
  return response.json();
};
bridge.onreadresource = async params => {
  const response = await fetch('/resource', { method: 'POST', body: JSON.stringify(params) });
  if (!response.ok) throw new Error('Unknown fixture file');
  return response.json();
};
bridge.setRequestHandler(
  z.object({
    method: z.literal('openai/resources/write'),
    params: z.object({ uri: z.string(), ifMatch: z.string(), blob: z.string() }),
  }),
  async ({ params }) => {
    fixture.businessCalls++;
    const response = await fetch('/write', { method: 'POST', body: JSON.stringify(params) });
    if (!response.ok) throw new Error('Source write result is unknown.');
    return response.json();
  },
);
bridge.onupdatemodelcontext = async params => {
  (window as unknown as { context: unknown }).context = params;
  return {};
};
bridge.ondownloadfile = async params => {
  fixture.businessCalls++;
  (window as unknown as { download: unknown }).download = params;
  return {};
};
bridge.oninitialized = async () => {
  const result = await (await fetch('/initial')).json();
  await bridge.sendToolInput({ arguments: {} });
  await bridge.sendToolResult(result);
};
(window as unknown as { bridge: AppBridge }).bridge = bridge;
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = '/wrapper';
