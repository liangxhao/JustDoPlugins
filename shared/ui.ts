import './ui.css';

import type { App } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

import type { AppDocument } from './contracts';
import { applySharedHeader, createApp } from './app-presentation';
import {
  FILE_DEEP_LINK_PREFIX,
  FILE_RESOURCE_PREFIX,
  FILE_TOKEN_PATTERN,
  OPEN_FILE_TOOL,
} from './file-contracts';

export interface Editor {
  load(document: AppDocument): Promise<void>;
  commitEdit?(): Promise<void>;
  snapshot(): Promise<Record<string, unknown>>;
  importFile(file: File): Promise<Record<string, unknown>>;
  exportFile(): Promise<
    ({ text: string } | { blob: string }) & { extension: string; mimeType: string }
  >;
  serializeSource?(source: {
    bytes: Uint8Array;
    data: Record<string, unknown>;
    name: string;
  }): Promise<{ bytes: Uint8Array; data: Record<string, unknown> }>;
  dispose(): Promise<void>;
}
const strings = {
  zh: {
    library: '文档',
    new: '新建',
    import: '导入 CSV / JSON',
    export: '导出 CSV',
    save: '保存',
    saved: '已保存',
    dirty: '未保存',
    reload: '重新读取',
    empty: '新建或导入文件',
    saving: '正在保存',
    discard: '放弃未保存的修改？',
    cancel: '取消',
    discardAction: '放弃修改',
    title: '未命名',
    context: '已同步到对话',
    error: '操作失败',
    readOnly: '只读预览',
    conflict: '文件已被其他程序修改，请重新读取后再保存',
    saveUnknown: '保存结果未确认，请核对文件后重新打开',
    importSpreadsheet: '导入表格',
    exportSpreadsheet: '导出 XLSX',
    rename: '重命名',
    confirm: '确定',
  },
  en: {
    library: 'Documents',
    new: 'New',
    import: 'Import CSV / JSON',
    export: 'Export CSV',
    save: 'Save',
    saved: 'Saved',
    dirty: 'Unsaved',
    reload: 'Reload',
    empty: 'Create or import a file',
    saving: 'Saving',
    discard: 'Discard unsaved changes?',
    cancel: 'Cancel',
    discardAction: 'Discard',
    title: 'Untitled',
    context: 'Shared with conversation',
    error: 'Operation failed',
    readOnly: 'Read-only',
    conflict: 'The file changed outside this app. Reload before saving.',
    saveUnknown: 'Save result is unknown. Check the file and reopen it.',
    importSpreadsheet: 'Import spreadsheet',
    exportSpreadsheet: 'Export XLSX',
    rename: 'Rename',
    confirm: 'OK',
  },
};
const icons: Record<string, string> = {
  library: '<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6h12M6 6v8"/>',
  new: '<path d="M8 3v10M3 8h10"/>',
  import: '<path d="M8 2v8m-3-3 3 3 3-3M2 11v3h12v-3"/>',
  export: '<path d="M8 10V2M5 5l3-3 3 3M2 10v4h12v-4"/>',
  reload: '<path d="M13 6A5 5 0 1 0 13 10M13 2v4H9"/>',
  rename: '<path d="m3 10 7-7 3 3-7 7H3zM9 4l3 3"/>',
};
export function mountApp(
  label: string,
  factory: (
    container: HTMLElement,
    changed: () => void,
    app: App,
    initialDocument?: AppDocument,
  ) => Promise<Editor>,
  options: { accept?: string; spreadsheet?: boolean; maxDocumentBytes?: number } = {},
) {
  let locale: 'zh' | 'en' = 'zh';
  let current: AppDocument | undefined,
    editor: Editor | undefined,
    dirty = false,
    busy = false,
    generation = 0;
  let editVersion = 0;
  let sourceBytes: Uint8Array | undefined;
  let sourceData: Record<string, unknown> | undefined;
  let saveUncertain = false;
  const app = createApp({ name: `${label} Offline`, version: '0.1.0' });
  const t = (key: keyof typeof strings.zh) => strings[locale][key];
  document.body.innerHTML = `<header data-app-toolbar><div class="toolbar-row"><button data-action="library"></button><input data-app-title class="title" maxlength="120" aria-label="Title"/><span id="status" role="status"></span><span class="toolbar-actions"><button data-action="rename"></button><button data-action="new"></button><button data-action="import"></button><button data-action="export"></button><button data-action="reload"></button><button class="primary" data-action="save"></button></span></div></header><div data-app-content><main id="editor" hidden></main><main id="library"></main></div><input type="file" id="file" accept=".csv,.tsv,.json"/>`;
  const container = document.querySelector<HTMLElement>('#editor')!;
  const library = document.querySelector<HTMLElement>('#library')!;
  const title = document.querySelector<HTMLInputElement>('.title')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const file = document.querySelector<HTMLInputElement>('#file')!;
  document.querySelector('.toolbar-actions')!.addEventListener('focusin', event => {
    if (document.documentElement.hasAttribute('data-shared-header')) {
      (event.target as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });
  file.accept = options.accept ?? file.accept;
  function labels() {
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
      const action = button.dataset.action as keyof typeof strings.zh;
      const caption =
        action === 'import' && options.spreadsheet
          ? t('importSpreadsheet')
          : action === 'export' && options.spreadsheet
            ? t('exportSpreadsheet')
            : t(action);
      button.title = caption;
      button.hidden =
        (action === 'save' && Boolean(current?.sourceFile && !current.sourceFile.writable)) ||
        (action === 'rename' && (!current || title.readOnly));
      button.setAttribute('aria-label', caption);
      button.innerHTML = icons[action]
        ? `<svg viewBox="0 0 16 16">${icons[action]}</svg>`
        : caption;
    }
  }
  labels();
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      const save = document.querySelector<HTMLButtonElement>('button[data-action="save"]');
      if (save && !save.hidden && !save.disabled) save.click();
    }
  });
  function notice(text: string, error = false) {
    status.textContent = text;
    status.title = text;
    status.classList.toggle('error', error);
  }
  function changed() {
    editVersion++;
    dirty = true;
    notice(t('dirty'));
  }
  title.addEventListener('input', changed);
  function rename() {
    if (!current || title.readOnly || title.disabled) return;
    const original = current;
    const originalTitle = title.value;
    const dialog = document.createElement('dialog');
    const input = document.createElement('input');
    input.value = title.value;
    input.maxLength = 120;
    input.setAttribute('aria-label', t('rename'));
    const actions = document.createElement('footer');
    for (const accepted of [false, true]) {
      const button = document.createElement('button');
      button.textContent = t(accepted ? 'confirm' : 'cancel');
      button.onclick = () => {
        if (
          accepted &&
          current === original &&
          title.value === originalTitle &&
          !title.readOnly &&
          !title.disabled
        ) {
          title.value = input.value;
          changed();
        }
        dialog.close();
        dialog.remove();
      };
      actions.append(button);
    }
    dialog.oncancel = () => dialog.remove();
    dialog.append(input, actions);
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  }
  const canLeave = async () => {
    await editor?.commitEdit?.();
    if (!dirty) return true;
    const dialog = document.createElement('dialog');
    const message = document.createElement('p');
    message.textContent = t('discard');
    const actions = document.createElement('footer');
    const cancel = document.createElement('button');
    cancel.textContent = t('cancel');
    const discard = document.createElement('button');
    discard.textContent = t('discardAction');
    actions.append(cancel, discard);
    dialog.append(message, actions);
    document.body.append(dialog);
    return new Promise<boolean>(resolve => {
      const finish = (accepted: boolean) => {
        dialog.close();
        dialog.remove();
        resolve(accepted);
      };
      cancel.onclick = () => finish(false);
      discard.onclick = () => finish(true);
      dialog.oncancel = event => {
        event.preventDefault();
        finish(false);
      };
      dialog.showModal();
      cancel.focus();
    });
  };
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await app.callServerTool({ name, arguments: args });
    if (response.isError)
      throw new Error(
        response.content
          ?.filter(item => item.type === 'text')
          .map(item => item.text)
          .join('\n') || t('error'),
      );
    return response.structuredContent as unknown as AppDocument & {
      documents: { id: string; title: string; updatedAt: string }[];
      library?: boolean;
    };
  }
  function shareContext() {
    if (!current || !app.getHostCapabilities()?.updateModelContext?.text) return;
    // Sharing is optional. A background or inactive view may be denied by the
    // host after a successful load/save; it must not change document status.
    void app
      .updateModelContext({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              app: label,
              ...(current.sourceFile
                ? {
                    file: { name: current.sourceFile.name },
                    readOnly: current.sourceFile.writable !== true,
                  }
                : { documentId: current.id }),
              title: current.title,
              ...(!current.sourceFile ? { revision: current.revision } : {}),
            }),
          },
        ],
      })
      .catch(() => undefined);
  }
  async function load(value: AppDocument) {
    const own = ++generation;
    if (editor) {
      await editor.dispose();
      editor = undefined;
    }
    container.replaceChildren();
    container.hidden = false;
    library.hidden = true;
    const next = await factory(container, changed, app, value);
    if (own !== generation) {
      await next.dispose();
      return;
    }
    editor = next;
    await editor.load(value);
    current = value;
    dirty = false;
    title.value = value.title;
    title.readOnly = Boolean(value.sourceFile);
    labels();
    notice(value.sourceFile && !value.sourceFile.writable ? t('readOnly') : t('saved'));
    shareContext();
  }
  async function loadSourceFile(target: NonNullable<AppDocument['sourceFile']>) {
    if (
      !options.spreadsheet ||
      !(
        /^openclaw-file:\/\//.test(target.resourceUri) ||
        (target.resourceUri.startsWith(FILE_RESOURCE_PREFIX) &&
          FILE_TOKEN_PATTERN.test(target.resourceUri.slice(FILE_RESOURCE_PREFIX.length)))
      )
    )
      throw new Error('Invalid host file resource.');
    const resource = await app.readServerResource({
      uri: target.resourceUri,
      _meta: { 'openai/resource': { representation: 'blob' } },
    });
    const content = resource.contents.find(item => item.uri === target.resourceUri);
    if (
      !content ||
      !('blob' in content) ||
      typeof content.blob !== 'string' ||
      content.blob.length > 14 * 1024 * 1024
    )
      throw new Error('File resource unavailable or too large.');
    const bytes = Uint8Array.from(atob(content.blob), char => char.charCodeAt(0));
    const meta = (content._meta?.['openai/resource'] ?? {}) as {
      writable?: boolean;
      etag?: string;
    };
    const sourceFile = {
      ...target,
      writable: meta.writable === true && typeof meta.etag === 'string',
      etag: meta.etag,
    };
    if (!editor) editor = await factory(container, changed, app);
    const data = await editor.importFile(new File([bytes], target.name));
    const maxBytes = options.maxDocumentBytes ?? 2 * 1024 * 1024;
    if (new TextEncoder().encode(JSON.stringify(data)).byteLength > maxBytes)
      throw new Error(`Document exceeds ${maxBytes / 1024 / 1024} MiB.`);
    await load({
      id: 'host-file',
      kind: 'univer',
      title: target.name,
      revision: 0,
      updatedAt: '',
      data,
      sourceFile,
    });
    sourceBytes = bytes;
    sourceData = await editor!.snapshot();
    saveUncertain = false;
  }
  async function showLibrary() {
    const result = await call('list_documents');
    container.hidden = true;
    library.hidden = false;
    library.replaceChildren();
    const grid = document.createElement('div');
    grid.className = 'documents';
    for (const item of result.documents) {
      const button = document.createElement('button');
      button.className = 'document';
      const name = document.createElement('strong');
      name.textContent = item.title;
      const time = document.createElement('time');
      time.textContent = new Date(item.updatedAt).toLocaleString(
        locale === 'zh' ? 'zh-CN' : 'en-US',
      );
      button.append(name, time);
      button.addEventListener(
        'click',
        () => void run(async () => load(await call('open_document', { id: item.id }))),
      );
      grid.append(button);
    }
    if (!result.documents.length) {
      grid.className = 'empty';
      grid.textContent = t('empty');
    }
    library.append(grid);
    title.value = label;
    current = undefined;
    dirty = false;
    notice('');
    labels();
  }
  async function run(operation: () => Promise<void>) {
    if (busy) return;
    busy = true;
    title.disabled = true;
    document
      .querySelectorAll<HTMLButtonElement>('body > header button')
      .forEach(button => (button.disabled = true));
    try {
      await operation();
    } catch (error) {
      notice(error instanceof Error ? error.message : t('error'), true);
    } finally {
      busy = false;
      title.disabled = false;
      document
        .querySelectorAll<HTMLButtonElement>('body > header button')
        .forEach(button => (button.disabled = false));
    }
  }
  document.querySelector('header')!.addEventListener('click', event => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('button')?.dataset.action;
    if (!action) return;
    if (action === 'rename') {
      rename();
      return;
    }
    if (action === 'import') {
      void run(async () => {
        if (await canLeave()) file.click();
      });
      return;
    }
    void run(async () => {
      if (action === 'new' && (await canLeave()))
        await load(await call('new_document', { title: t('title') }));
      if (action === 'library' && (await canLeave())) await showLibrary();
      if (action === 'reload' && current && (await canLeave())) {
        if (current.sourceFile) await loadSourceFile(current.sourceFile);
        else await load(await call('read_document', { id: current.id }));
      }
      if (action === 'save' && current && editor) {
        notice(t('saving'));
        await editor.commitEdit?.();
        if (current.sourceFile) {
          if (saveUncertain) throw new Error(t('saveUnknown'));
          if (
            !current.sourceFile.writable ||
            !current.sourceFile.etag ||
            !sourceBytes ||
            !sourceData ||
            !editor.serializeSource
          )
            throw new Error(t('readOnly'));
          const savingEditVersion = editVersion;
          const serialized = await editor.serializeSource({
            bytes: sourceBytes,
            data: sourceData,
            name: current.sourceFile.name,
          });
          let binary = '';
          for (const byte of serialized.bytes) binary += String.fromCharCode(byte);
          let result;
          try {
            result = await app.request(
              {
                method: 'openai/resources/write',
                params: {
                  uri: current.sourceFile.resourceUri,
                  ifMatch: current.sourceFile.etag,
                  blob: btoa(binary),
                },
              },
              z.object({ outcome: z.string(), etag: z.string().optional() }),
            );
          } catch (error) {
            saveUncertain = true;
            throw error;
          }
          if (result.outcome === 'conflict') throw new Error(t('conflict'));
          if (result.outcome !== 'saved' || !result.etag) {
            saveUncertain = true;
            throw new Error(t('saveUnknown'));
          }
          current.sourceFile.etag = result.etag;
          sourceBytes = serialized.bytes;
          sourceData = structuredClone(serialized.data);
          dirty = editVersion !== savingEditVersion;
          notice(t(dirty ? 'dirty' : 'saved'));
          shareContext();
          return;
        }
        const revision = current.revision;
        const savingEditVersion = editVersion;
        const data = await editor.snapshot();
        const saved = await call('save_document', {
          id: current.id,
          expectedRevision: revision,
          title: title.value.trim() || t('title'),
          data,
        });
        current = saved;
        dirty = editVersion !== savingEditVersion;
        notice(t(dirty ? 'dirty' : 'saved'));
        shareContext();
      }
      if (action === 'export' && current && editor) {
        await editor.commitEdit?.();
        const output = await editor.exportFile();
        const name =
          title.value.replace(/\.(xlsx|csv|tsv)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') ||
          label;
        const result = await app.downloadFile({
          contents: [
            {
              type: 'resource',
              resource: {
                uri: `file:///${encodeURIComponent(name)}.${output.extension}`,
                mimeType: output.mimeType,
                ...('blob' in output ? { blob: output.blob } : { text: output.text }),
              },
            },
          ],
        });
        if (result.isError) throw new Error('Download failed.');
      }
    });
  });
  file.addEventListener('change', () => {
    const selected = file.files?.[0];
    file.value = '';
    if (!selected) return;
    void run(async () => {
      if (selected.size > 10 * 1024 * 1024) throw new Error('File exceeds 10 MiB.');
      if (!editor) editor = await factory(container, changed, app);
      const data = await editor.importFile(selected);
      const saved = await call('import_document', {
        title: selected.name.replace(/\.[^.]+$/, '').slice(0, 120),
        data,
      });
      await load(saved);
    });
  });
  app.ontoolresult = result => {
    const value = result.structuredContent as unknown as AppDocument & {
      library?: boolean;
      file?: { name: string; resourceUri: string };
    };
    if (!value) return;
    void run(async () => {
      if (!(await canLeave())) return;
      if (value.file) {
        await loadSourceFile(value.file);
      } else if (value.library) {
        const ctx = app.getHostContext() as Record<string, unknown> | undefined;
        const link = (ctx?.['openai/deepLink'] as { url?: string } | undefined)?.url;
        const token = link?.startsWith(FILE_DEEP_LINK_PREFIX)
          ? link.slice(FILE_DEEP_LINK_PREFIX.length)
          : '';
        if (options.spreadsheet && FILE_TOKEN_PATTERN.test(token)) {
          const source = (await call(OPEN_FILE_TOOL, { token })) as unknown as {
            file: NonNullable<AppDocument['sourceFile']>;
          };
          await loadSourceFile(source.file);
        } else await showLibrary();
      } else if (value.id) await load(await call('read_document', { id: value.id }));
    });
  };
  const applyContext = () => {
    applySharedHeader(app);
    const ctx = app.getHostContext();
    locale = ctx?.locale?.startsWith('zh') ? 'zh' : 'en';
    const theme = ctx?.theme ?? 'light';
    if (document.documentElement.dataset.theme !== theme)
      document.documentElement.dataset.theme = theme;
    labels();
  };
  app.onhostcontextchanged = applyContext;
  app.onteardown = async () => {
    generation++;
    await editor?.dispose();
    return {};
  };
  void app
    .connect()
    .then(applyContext)
    .catch(error => notice(String(error), true));
}
