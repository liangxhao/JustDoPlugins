import { App } from '@modelcontextprotocol/ext-apps';
import { applySharedHeader, SHARED_HEADER } from '../../shared/app-presentation';

const failure = new URLSearchParams(location.search).get('failure');
const app = new App(
  { name: 'Contract counterexample', version: '1' },
  failure === 'no-capability' ? {} : { experimental: { [SHARED_HEADER]: { version: 1 } } },
);
document.body.innerHTML =
  '<header data-app-toolbar><input data-app-title value="Draft"><button>Export</button></header><main data-app-content>Editor</main>';
const style = document.createElement('style');
style.textContent =
  'html,body{height:100%;margin:0}body{display:flex;flex-direction:column}header{box-sizing:border-box;height:var(--app-header-height,46px);padding:4px var(--app-header-right,10px) 4px var(--app-header-left,10px);display:flex;align-items:center}main{flex:1}input{width:100px}[data-shared-header] [data-app-title]{display:none}';
document.head.append(style);
const update = () => {
  if (failure === 'declaration-only') return;
  if (failure === 'no-reset' && !app.getHostContext()?.[SHARED_HEADER]) return;
  applySharedHeader(app);
  if (failure === 'shrunk-content')
    document.querySelector<HTMLElement>('[data-app-content]')!.style.marginLeft =
      app.getHostContext()?.[SHARED_HEADER] ? '120px' : '0';
};
app.onhostcontextchanged = update;
void app.connect().then(update);
