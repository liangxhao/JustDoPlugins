import './ui.css';

import type { App } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

import { type AppDocument, type Kind, validateData } from './contracts';
import { applySharedHeader, createApp } from './app-presentation';
import { registerLiveTools, contextText, type LiveEditor } from './live-app';
import {
  FILE_DEEP_LINK_PREFIX,
  FILE_RESOURCE_PREFIX,
  FILE_TOKEN_PATTERN,
  OPEN_FILE_TOOL,
} from './file-contracts';

export interface Editor extends LiveEditor {
  load(document: AppDocument): Promise<void>;
  commitEdit?(): Promise<void>;
  snapshot(): Promise<Record<string, unknown>>;
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
    saveCopy: '保存副本',
    copiedWithEdits: '副本已保存，当前新增修改仍未保存',
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
    saveCopy: 'Save copy',
    copiedWithEdits: 'Copy saved. New edits remain unsaved in this document.',
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
    requestContext?: () => void,
  ) => Promise<Editor>,
  options: {
    kind: Kind;
    importFile(file: File): Promise<Record<string, unknown>>;
    applySchema: z.ZodObject;
    querySchema?: z.ZodObject;
    accept?: string;
    spreadsheet?: boolean;
    maxDocumentBytes?: number;
  },
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
  let disposed = false;
  let idle = Promise.resolve();
  let finishIdle: (() => void) | undefined;
  let incoming = Promise.resolve();
  let contextTimer: ReturnType<typeof setTimeout> | undefined;
  const events = new AbortController();
  const app = createApp({ name: `${label} Offline`, version: '0.1.0' }, { tools: {} });
  const t = (key: keyof typeof strings.zh) => strings[locale][key];
  document.body.innerHTML = `<header data-app-toolbar><div class="toolbar-row"><button data-action="library"></button><input data-app-title class="title" maxlength="120" aria-label="Title"/><span id="status" role="status"></span><span class="toolbar-actions"><button data-action="rename"></button><button data-action="new"></button><button data-action="import"></button><button data-action="export"></button><button data-action="reload"></button><button data-action="saveCopy"></button><button class="primary" data-action="save"></button></span></div></header><div data-app-content><main id="editor" hidden></main><main id="library"></main></div><input type="file" id="file" accept=".csv,.tsv,.json"/>`;
  const container = document.querySelector<HTMLElement>('#editor')!;
  async function withInputLocked<T>(operation: () => Promise<T>) {
    const stages = Array.from(container.children, child => ({
      element: child as HTMLElement,
      inert: (child as HTMLElement).inert,
    }));
    for (const stage of stages) stage.element.inert = true;
    try {
      return await operation();
    } finally {
      for (const stage of stages) stage.element.inert = stage.inert;
    }
  }
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
        (action === 'saveCopy' && !current?.sourceFile) ||
        (action === 'rename' && (!current || title.readOnly));
      button.setAttribute('aria-label', caption);
      button.innerHTML = icons[action]
        ? `<svg viewBox="0 0 16 16">${icons[action]}</svg>`
        : caption;
    }
  }
  labels();
  document.addEventListener(
    'keydown',
    event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        const save = document.querySelector<HTMLButtonElement>('button[data-action="save"]');
        if (save && !save.hidden && !save.disabled) save.click();
      }
    },
    { signal: events.signal },
  );
  function notice(text: string, error = false) {
    const readOnly = Boolean(current?.sourceFile && !current.sourceFile.writable);
    const message =
      readOnly && text && text !== t('readOnly') && !error ? `${text} · ${t('readOnly')}` : text;
    status.textContent = message;
    status.title = message;
    status.classList.toggle('error', error);
    status.classList.toggle('important', error || readOnly);
  }
  function changed() {
    if (disposed) return;
    editVersion++;
    dirty = true;
    notice(t('dirty'));
    requestContext();
  }
  function requestContext() {
    clearTimeout(contextTimer);
    contextTimer = setTimeout(() => void shareContext(), 350);
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
    if (disposed) throw new Error('App is closed.');
    const response = await app.callServerTool({ name, arguments: args });
    if (disposed) throw new Error('App is closed.');
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
  async function shareContext() {
    if (disposed || !current || !editor || !app.getHostCapabilities()?.updateModelContext?.text)
      return;
    const original = current,
      originalEditor = editor,
      own = generation,
      version = editVersion;
    const description = await originalEditor.describe().catch(() => ({}));
    if (
      disposed ||
      current !== original ||
      editor !== originalEditor ||
      own !== generation ||
      version !== editVersion
    )
      return;
    // Sharing is optional. A background or inactive view may be denied by the
    // host after a successful load/save; it must not change document status.
    void app
      .updateModelContext({
        content: [
          {
            type: 'text',
            text: contextText({
              app: label,
              ...(current.sourceFile
                ? {
                    file: { name: current.sourceFile.name },
                    readOnly: current.sourceFile.writable !== true,
                  }
                : { documentId: current.id }),
              title: title.value,
              ...(!current.sourceFile ? { revision: current.revision } : {}),
              dirty,
              ...description,
            }),
          },
        ],
      })
      .catch(() => undefined);
  }
  async function load(value: AppDocument) {
    if (disposed) throw new Error('App is closed.');
    if (value.kind !== options.kind) throw new Error('Wrong document kind.');
    value.data = validateData(options.kind, value.data);
    const own = ++generation;
    const previous = editor;
    const previousHidden = container.hidden;
    for (const child of container.children) (child as HTMLElement).inert = true;
    const stage = document.createElement('div');
    stage.className = 'editor-stage';
    stage.style.visibility = 'hidden';
    container.append(stage);
    container.hidden = false;
    let next: Editor | undefined;
    let baseline: Record<string, unknown> | undefined;
    try {
      next = await factory(
        stage,
        () => {
          if (editor === next) changed();
        },
        app,
        value,
        () => {
          if (editor === next) requestContext();
        },
      );
      await next.load(value);
      // Capture the source baseline before exposing the new canvas. Toggling
      // inert on a newly displayed Univer canvas disrupts its input activation.
      if (value.sourceFile && options.spreadsheet) baseline = await next.snapshot();
      if (own !== generation || disposed) throw new Error('Editor load was cancelled.');
    } catch (error) {
      await next?.dispose().catch(() => undefined);
      stage.remove();
      for (const child of container.children) (child as HTMLElement).inert = false;
      container.hidden = previousHidden;
      throw error;
    }
    editor = next;
    await previous?.dispose().catch(() => undefined);
    if (disposed || own !== generation) {
      await next.dispose();
      return;
    }
    container.replaceChildren(stage);
    stage.style.visibility = '';
    library.hidden = true;
    current = value;
    live.clear();
    sourceBytes = undefined;
    sourceData = baseline;
    saveUncertain = false;
    dirty = false;
    title.value = value.title;
    title.readOnly = Boolean(value.sourceFile);
    labels();
    notice(value.sourceFile && !value.sourceFile.writable ? t('readOnly') : t('saved'));
    void shareContext();
  }
  async function loadSourceFile(target: NonNullable<AppDocument['sourceFile']>) {
    const own = generation;
    if (
      !(options.accept ?? '')
        .split(',')
        .some(extension => target.name.toLowerCase().endsWith(extension)) ||
      !(
        /^openclaw-file:\/\//.test(target.resourceUri) ||
        (options.spreadsheet &&
          target.resourceUri.startsWith(FILE_RESOURCE_PREFIX) &&
          FILE_TOKEN_PATTERN.test(target.resourceUri.slice(FILE_RESOURCE_PREFIX.length)))
      )
    )
      throw new Error('Invalid host file resource.');
    const resource = await app.readServerResource({
      uri: target.resourceUri,
      _meta: { 'openai/resource': { representation: 'blob' } },
    });
    if (disposed || generation !== own) throw new Error('File load was cancelled.');
    const content = resource.contents.find(item => item.uri === target.resourceUri);
    if (!content) throw new Error('File resource unavailable or too large.');
    const maxFileBytes = options.spreadsheet ? 10 * 1024 * 1024 : 2 * 1024 * 1024;
    let bytes: Uint8Array;
    if (
      'blob' in content &&
      typeof content.blob === 'string' &&
      content.blob.length <= Math.ceil(maxFileBytes / 3) * 4
    ) {
      const binary = atob(content.blob);
      if (btoa(binary) !== content.blob) throw new Error('Invalid file encoding.');
      bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    } else if ('text' in content && typeof content.text === 'string') {
      bytes = new TextEncoder().encode(content.text);
    } else throw new Error('File resource unavailable or too large.');
    if (bytes.byteLength > maxFileBytes) throw new Error('File resource is too large.');
    const meta = (content._meta?.['openai/resource'] ?? {}) as {
      writable?: boolean;
      etag?: string;
    };
    const sourceFile = {
      ...target,
      writable:
        options.spreadsheet === true && meta.writable === true && typeof meta.etag === 'string',
      etag: meta.etag,
    };
    const data = await options.importFile(new File([Uint8Array.from(bytes)], target.name));
    if (disposed || generation !== own) throw new Error('File load was cancelled.');
    const maxBytes = options.maxDocumentBytes ?? 2 * 1024 * 1024;
    if (new TextEncoder().encode(JSON.stringify(data)).byteLength > maxBytes)
      throw new Error(`Document exceeds ${maxBytes / 1024 / 1024} MiB.`);
    await load({
      id: `file:${crypto.randomUUID()}`,
      kind: options.kind,
      title: target.name,
      revision: 0,
      updatedAt: '',
      data,
      sourceFile,
    });
    sourceBytes = bytes;
    saveUncertain = false;
  }
  async function showLibrary() {
    const result = await call('list_documents');
    const previous = editor;
    editor = undefined;
    generation++;
    live.clear();
    await previous?.dispose().catch(() => undefined);
    if (disposed) return;
    container.replaceChildren();
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
  async function exclusive<T>(operation: () => Promise<T>) {
    if (disposed) throw new Error('App is closed.');
    if (busy) throw new Error('BUSY: Wait for the current editor operation to finish.');
    busy = true;
    idle = new Promise(resolve => {
      finishIdle = resolve;
    });
    title.disabled = true;
    document
      .querySelectorAll<HTMLButtonElement>('body > header button')
      .forEach(button => (button.disabled = true));
    try {
      return await operation();
    } finally {
      busy = false;
      finishIdle?.();
      if (!disposed) {
        title.disabled = false;
        document
          .querySelectorAll<HTMLButtonElement>('body > header button')
          .forEach(button => (button.disabled = false));
      }
    }
  }
  async function run(operation: () => Promise<void>, lockInput = true) {
    if (busy || disposed) return;
    try {
      await exclusive(() => (lockInput ? withInputLocked(operation) : operation()));
    } catch (error) {
      if (!disposed) notice(error instanceof Error ? error.message : t('error'), true);
    }
  }
  const live = registerLiveTools(app, {
    kind: options.kind,
    applySchema: options.applySchema,
    querySchema: options.querySchema,
    // Prevent a new, uncommitted cell edit during asynchronous calculation or
    // context synchronization. The toolbar lock alone does not cover the canvas.
    exclusive: operation => exclusive(() => withInputLocked(operation)),
    state() {
      if (disposed || !current || !editor || container.hidden)
        throw new Error('No active document.');
      return { document: current, editor, title: title.value, dirty, generation, editVersion };
    },
    async commit() {
      clearTimeout(contextTimer);
      await editor?.commitEdit?.();
      clearTimeout(contextTimer);
    },
    changed,
    notice,
  });
  document.querySelector('header')!.addEventListener('click', event => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('button')?.dataset.action;
    if (!action) return;
    if (action === 'rename') {
      rename();
      return;
    }
    if (action === 'import') {
      if (!busy && !disposed) file.click();
      return;
    }
    void run(
      async () => {
        if (action === 'new' && (await canLeave()))
          await load(await call('new_document', { title: t('title') }));
        if (action === 'library' && (await canLeave())) await showLibrary();
        if (action === 'reload' && current && (await canLeave())) {
          if (current.sourceFile) await loadSourceFile(current.sourceFile);
          else await load(await call('read_document', { id: current.id }));
        }
        if (action === 'save' && current && editor) {
          notice(t('saving'));
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
            const originalEditor = editor;
            const originalSource = current.sourceFile;
            const bytes = sourceBytes,
              before = sourceData;
            const { serialized, savingEditVersion } = await withInputLocked(async () => {
              await originalEditor.commitEdit?.();
              const serialized = await originalEditor.serializeSource!({
                bytes,
                data: before,
                name: originalSource.name,
              });
              return { serialized, savingEditVersion: editVersion };
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
            await withInputLocked(async () => {
              await originalEditor.commitEdit?.();
              dirty =
                editVersion !== savingEditVersion ||
                JSON.stringify(await originalEditor.snapshot()) !== JSON.stringify(serialized.data);
            });
            notice(t(dirty ? 'dirty' : 'saved'));
            void shareContext();
            return;
          }
          const revision = current.revision;
          const originalEditor = editor;
          const { data, savingEditVersion } = await withInputLocked(async () => {
            await originalEditor.commitEdit?.();
            const data = await originalEditor.snapshot();
            return { data, savingEditVersion: editVersion };
          });
          const saved = await call('save_document', {
            id: current.id,
            expectedRevision: revision,
            title: title.value.trim() || t('title'),
            data,
          });
          current = saved;
          await withInputLocked(async () => {
            await originalEditor.commitEdit?.();
            dirty =
              editVersion !== savingEditVersion ||
              JSON.stringify(await originalEditor.snapshot()) !== JSON.stringify(data);
          });
          notice(t(dirty ? 'dirty' : 'saved'));
          void shareContext();
        }
        if (action === 'saveCopy' && current && editor) {
          const originalEditor = editor,
            own = generation;
          const { data, version } = await withInputLocked(async () => {
            await originalEditor.commitEdit?.();
            const data = await originalEditor.snapshot();
            return { data, version: editVersion };
          });
          const serialized = JSON.stringify(data);
          const copy = await call('import_document', {
            title: title.value.replace(/\.[^.]+$/, '').slice(0, 120) || t('title'),
            data,
          });
          // A user can continue editing the canvas while the copy is being saved.
          // Commit that input before deciding whether it is safe to switch documents.
          await withInputLocked(async () => {
            await originalEditor.commitEdit?.();
            if (disposed || own !== generation || editor !== originalEditor) return;
            const latest = await originalEditor.snapshot();
            if (version !== editVersion || serialized !== JSON.stringify(latest)) {
              dirty = true;
              notice(t('copiedWithEdits'));
              return;
            }
            await load(copy);
          });
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
      },
      action !== 'save' && action !== 'saveCopy',
    );
  });
  file.addEventListener('change', () => {
    const selected = file.files?.[0];
    file.value = '';
    if (!selected) return;
    void run(async () => {
      if (selected.size > 10 * 1024 * 1024) throw new Error('File exceeds 10 MiB.');
      const data = await options.importFile(selected);
      validateData(options.kind, data);
      if (!(await canLeave()) || disposed) return;
      const saved = await call('import_document', {
        title: selected.name.replace(/\.[^.]+$/, '').slice(0, 120),
        data,
      });
      await load(saved);
    });
  });
  app.ontoolresult = result => {
    if (disposed) return;
    if (result.isError) {
      notice(
        result.content
          ?.filter(item => item.type === 'text')
          .map(item => item.text)
          .join('\n') || t('error'),
        true,
      );
      return;
    }
    const value = result.structuredContent as unknown as AppDocument & {
      library?: boolean;
      file?: { name: string; resourceUri: string };
    };
    if (!value) return;
    // Notifications arriving during save/load are serialized rather than dropped.
    incoming = incoming
      .then(async () => {
        while (busy && !disposed) await idle;
        if (disposed) return;
        await exclusive(() =>
          withInputLocked(async () => {
            if (value.file && current?.sourceFile?.resourceUri === value.file.resourceUri) return;
            if (
              current &&
              !current.sourceFile &&
              value.id === current.id &&
              value.revision <= current.revision
            )
              return;
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
          }),
        );
      })
      .catch(error => {
        if (!disposed) notice(String(error), true);
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
    disposed = true;
    generation++;
    events.abort();
    clearTimeout(contextTimer);
    live.clear();
    document
      .querySelectorAll('dialog')
      .forEach(dialog => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
    await editor?.dispose();
    return {};
  };
  void app
    .connect()
    .then(applyContext)
    .catch(error => notice(String(error), true));
}
