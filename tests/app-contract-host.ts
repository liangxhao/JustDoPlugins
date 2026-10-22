import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const frame = document.querySelector<HTMLIFrameElement>('iframe')!;
const version = new URLSearchParams(location.search).get('hostVersion') ?? '1';
let context: Record<string, unknown> = { theme: 'light', locale: 'en', displayMode: 'inline' };
const fixture = window as unknown as {
  appCapabilities: unknown;
  businessCalls: number;
  updateContext: (changes: Record<string, unknown>) => void;
};
fixture.businessCalls = 0;
const bridge = new AppBridge(
  null,
  { name: 'App contract fixture', version: '1' },
  {
    serverTools: {},
    serverResources: {},
    downloadFile: {},
    updateModelContext: { text: {} },
    ...(version === 'none'
      ? {}
      : { experimental: { 'ui/shared-header': { version: Number(version) } } }),
  },
  { hostContext: context },
);
bridge.oninitialized = () => {
  fixture.appCapabilities = bridge.getAppCapabilities();
};
bridge.oncalltool = async () => {
  fixture.businessCalls++;
  return { content: [], structuredContent: { documents: [] } };
};
bridge.ondownloadfile = async () => {
  fixture.businessCalls++;
  return {};
};
bridge.onupdatemodelcontext = async () => ({});
fixture.updateContext = changes => {
  context = { ...context, ...changes };
  bridge.setHostContext(context);
};
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = '/wrapper' + location.search;
