import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { registerWorkspaceFiles } from './workspace-files';

export default {
  id: 'univer-app',
  name: 'Univer',
  register(api: OpenClawPluginApi) {
    registerWorkspaceFiles(api);
  },
};
