import './ui.css';

import type { App } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

import { type AppDocument, type Kind, validateData } from './contracts';
import { applySharedHeader, createApp } from './app-presentation';
import { registerLiveTools, contextText, type LiveEditor, type LiveSaveMode, type LiveSaveResult } from './live-app';
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
  exportFile(format?: string): Promise<
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
    import: '导入数据',
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
    documentTitle: '文档标题',
    welcome: '从你的数据开始',
    welcomeSpreadsheet: '新建表格，或导入 XLSX、CSV、TSV 和完整工作簿 JSON。',
    welcomeAnalysis: '导入表格数据，探索图表并点击联动。JSON 支持记录数组、列数组和完整分析文档。',
    agentHelp: '也可以让 Agent 用你的数据创建内容，再一起修改当前文档。',
    recentDocuments: '已保存的文档',
    searchDocuments: '搜索文档',
    noDocuments: '还没有已保存的文档',
    noMatches: '没有匹配的文档',
    supportedFormats: '支持格式',
    savedDraftUnchecked: '已保存，当前编辑状态未能核对；请检查后继续',
    copyDraftUnchecked: '副本已保存，当前内容仍保留；请检查后继续',
  },
  en: {
    library: 'Documents',
    new: 'New',
    import: 'Import data',
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
    documentTitle: 'Document title',
    welcome: 'Start with your data',
    welcomeSpreadsheet: 'Create a spreadsheet, or import XLSX, CSV, TSV and full workbook JSON.',
    welcomeAnalysis: 'Import tabular data to explore charts and linked views. JSON accepts records, column arrays and full analysis documents.',
    agentHelp: 'You can also ask your agent to create content from your data and refine the current document with you.',
    recentDocuments: 'Saved documents',
    searchDocuments: 'Search documents',
    noDocuments: 'No saved documents yet',
    noMatches: 'No matching documents',
    supportedFormats: 'Supported formats',
    savedDraftUnchecked: 'Saved. The current draft could not be checked; review it before continuing.',
    copyDraftUnchecked: 'Copy saved. The current draft is retained; review it before continuing.',
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
    runAction?: (operation: () => Promise<void>) => Promise<void>,
  ) => Promise<Editor>,
  options: {
    kind: Kind;
    importFile(file: File): Promise<Record<string, unknown>>;
    applySchema: z.ZodObject;
    querySchema?: z.ZodObject;
    inspectSchema?: z.ZodObject;
    exportFormats?: { value: string; zh: string; en: string }[];
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
  let contextTail: Promise<void> = Promise.resolve();
  let contextSequence = 0;
  let sharingContext = false, contextRequested = false;
  let libraryDocuments: { id: string; title: string; updatedAt: string }[] = [];
  let libraryQuery = '';
  let libraryLoaded = false;
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
  const exportFormat = options.exportFormats ? document.createElement('select') : undefined;
  if (exportFormat) {
    exportFormat.dataset.exportFormat = '';
    document.querySelector('[data-action="export"]')!.before(exportFormat);
  }
  document.querySelector('.toolbar-actions')!.addEventListener('focusin', event => {
    (event.target as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  file.accept = options.accept ?? file.accept;
  function actionStates() {
    title.disabled = busy;
    title.readOnly = !current || Boolean(current.sourceFile);
    for (const button of document.querySelectorAll<HTMLButtonElement>('body > header button[data-action]')) {
      button.disabled = busy || (!current && ['rename', 'save', 'saveCopy', 'export', 'reload'].includes(button.dataset.action!));
    }
    if (exportFormat) exportFormat.disabled = busy || !current;
    library.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy; });
  }
  function labels() {
    title.setAttribute('aria-label', t('documentTitle'));
    if (exportFormat) {
      const previous = exportFormat.value;
      exportFormat.setAttribute('aria-label', locale === 'zh' ? '导出格式' : 'Export format');
      exportFormat.replaceChildren(...options.exportFormats!.map(format => new Option(format[locale], format.value)));
      if (previous) exportFormat.value = previous;
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
      const action = button.dataset.action as keyof typeof strings.zh;
      const caption = action === 'export' && exportFormat
        ? `${locale === 'zh' ? '导出' : 'Export'} ${exportFormat.value === 'analysis' ? (locale === 'zh' ? '完整分析文档' : 'analysis document') : exportFormat.value.toUpperCase()}`
        :
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
    actionStates();
  }
  exportFormat?.addEventListener('change', labels);
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
    if (disposed || !current || !editor) return;
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
  function synchronizeContext(value: Record<string, unknown>, unchanged: () => boolean) {
    contextSequence++;
    const update = contextTail.then(async () => {
      if (disposed || !unchanged()) throw new Error('CONFLICT: Context target changed before synchronization.');
      await app.updateModelContext({ content: [{ type: 'text', text: contextText(value) }] });
      if (disposed || !unchanged()) throw new Error('CONFLICT: Context target changed during synchronization.');
    });
    contextTail = update.catch(() => undefined);
    return update;
  }
  async function shareContext() {
    if (disposed || !app.getHostCapabilities()?.updateModelContext?.text) return;
    contextRequested = true;
    if (sharingContext) return;
    sharingContext = true;
    try {
      // Coalesce background changes while a host acknowledgement is pending.
      // Explicit prepare_context uses the same channel, so a late old summary
      // cannot overwrite a prepared document or the library's cleared target.
      while (contextRequested && !disposed) {
        contextRequested = false;
        const original = current, originalEditor = editor, own = generation, version = editVersion;
        const sequence = contextSequence;
        const unchanged = () => !disposed && current === original && editor === originalEditor &&
          own === generation && version === editVersion;
        const description = original && originalEditor ? await originalEditor.describe().catch(() => ({})) : {};
        if (!unchanged() || sequence !== contextSequence) continue;
        const value = original && originalEditor ? {
          app: label,
          ...(original.sourceFile
            ? { file: { name: original.sourceFile.name }, readOnly: original.sourceFile.writable !== true }
            : { documentId: original.id, revision: original.revision }),
          title: title.value,
          dirty,
          ...description,
        } : { app: label, screen: 'library', activeDocument: null };
        // Optional sharing failures must not change a successful file status.
        await synchronizeContext(value, unchanged).catch(() => undefined);
      }
    } finally { sharingContext = false; }
  }
  async function load(value: AppDocument) {
    if (disposed) throw new Error('App is closed.');
    // View tools return small references. Resolve one current saved snapshot;
    // never replay the creation/open call to obtain the document data.
    if (value.data === undefined) value = await call('read_document', { id: value.id });
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
        run,
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
    // Keep the already mounted stage in place. Re-inserting it would fire
    // disconnectedCallback and destroy custom-element chart renderers.
    for (const child of Array.from(container.children)) {
      if (child !== stage) child.remove();
    }
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
  function renderLibrary() {
    const focused = document.activeElement as HTMLElement | null;
    const restoreSearch = focused?.matches('[data-document-search]');
    const selection = restoreSearch ? [(focused as HTMLInputElement).selectionStart, (focused as HTMLInputElement).selectionEnd] : undefined;
    const focusedAction = focused?.dataset.libraryAction;
    const welcome = document.createElement('section');
    welcome.className = 'library-welcome';
    const heading = document.createElement('h1');
    heading.textContent = `${label} · ${t('welcome')}`;
    const description = document.createElement('p');
    description.textContent = t(options.spreadsheet ? 'welcomeSpreadsheet' : 'welcomeAnalysis');
    const help = document.createElement('p');
    help.textContent = t('agentHelp');
    const actions = document.createElement('div');
    actions.className = 'library-actions';
    for (const action of ['new', 'import'] as const) {
      const button = document.createElement('button');
      button.dataset.libraryAction = action;
      button.textContent = action === 'import' && options.spreadsheet ? t('importSpreadsheet') : t(action);
      button.addEventListener('click', () => dispatchAction(action));
      actions.append(button);
    }
    const formats = document.createElement('small');
    formats.textContent = `${t('supportedFormats')}: ${(options.accept ?? '.csv,.tsv,.json').split(',').map(value => value.replace(/^\./, '').toUpperCase()).join(' · ')}`;
    welcome.append(heading, description, help, actions, formats);
    const section = document.createElement('section');
    section.className = 'library-documents';
    const caption = document.createElement('h2');
    caption.textContent = t('recentDocuments');
    const search = document.createElement('input');
    search.type = 'search';
    search.dataset.documentSearch = '';
    search.setAttribute('aria-label', t('searchDocuments'));
    search.placeholder = t('searchDocuments');
    search.value = libraryQuery;
    const grid = document.createElement('div');
    const populate = () => {
      grid.className = 'documents';
      grid.replaceChildren();
      const matches = libraryDocuments.filter(item => item.title.toLocaleLowerCase().includes(libraryQuery.toLocaleLowerCase()));
      for (const item of matches) {
        const button = document.createElement('button');
        button.className = 'document';
        button.dataset.documentId = item.id;
        const name = document.createElement('strong');
        name.textContent = item.title;
        const time = document.createElement('time');
        time.textContent = new Date(item.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');
        button.append(name, time);
        button.addEventListener('click', () => void run(async () => load(await call('open_document', { id: item.id }))));
        grid.append(button);
      }
      if (!matches.length) {
        grid.className = 'library-empty';
        grid.textContent = t(libraryDocuments.length ? 'noMatches' : 'noDocuments');
      }
      actionStates();
    };
    search.addEventListener('input', () => { libraryQuery = search.value; populate(); });
    section.append(caption, search, grid);
    library.replaceChildren(welcome, section);
    populate();
    if (restoreSearch) { search.focus(); search.setSelectionRange(selection?.[0] ?? 0, selection?.[1] ?? 0); }
    else if (focusedAction) library.querySelector<HTMLButtonElement>(`[data-library-action="${focusedAction}"]`)?.focus();
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
    libraryDocuments = result.documents;
    libraryLoaded = true;
    title.value = label;
    current = undefined;
    dirty = false;
    sourceBytes = undefined;
    sourceData = undefined;
    saveUncertain = false;
    clearTimeout(contextTimer);
    renderLibrary();
    notice('');
    labels();
    void shareContext();
  }
  async function exclusive<T>(operation: () => Promise<T>) {
    if (disposed) throw new Error('App is closed.');
    if (busy) throw new Error('BUSY: Wait for the current editor operation to finish.');
    busy = true;
    idle = new Promise(resolve => {
      finishIdle = resolve;
    });
    actionStates();
    try {
      return await operation();
    } finally {
      busy = false;
      finishIdle?.();
      if (!disposed) {
        actionStates();
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
  async function saveCurrent(mode: LiveSaveMode, beforeSave?: () => Promise<void>): Promise<LiveSaveResult> {
    if (!current || !editor || disposed) throw new Error('No active document.');
    const original = current, originalEditor = editor, own = generation;
    const assertActive = () => {
      if (disposed || own !== generation || current !== original || editor !== originalEditor)
        throw new Error('CONFLICT: The document changed before saving.');
    };
    const savedResult = (saved: AppDocument, status: 'saved' | 'copied'): LiveSaveResult => ({
      status, savedDocument: { id: saved.id, title: saved.title, revision: saved.revision },
    });
    notice(t('saving'));
    if (mode === 'copy') {
      const { data, version } = await withInputLocked(async () => {
        await originalEditor.commitEdit?.();
        await beforeSave?.();
        assertActive();
        const data = await originalEditor.snapshot();
        return { data, version: editVersion };
      });
      const serialized = JSON.stringify(data);
      assertActive();
      const copy = await call('import_document', {
        title: (original.sourceFile ? title.value.replace(/\.[^.]+$/, '') : title.value).slice(0, 120).trim() || t('title'),
        data,
      });
      try {
        await withInputLocked(async () => {
          assertActive();
          await originalEditor.commitEdit?.();
          assertActive();
          const latest = await originalEditor.snapshot();
          if (version !== editVersion || serialized !== JSON.stringify(latest)) {
            dirty = true;
            notice(t('copiedWithEdits'));
            return;
          }
          await load(copy);
        });
      } catch {
        if (!disposed && current === original && editor === originalEditor) {
          dirty = true;
          notice(t('copyDraftUnchecked'), true);
        }
      }
      return savedResult(copy, 'copied');
    }
    if (original.sourceFile) {
      if (saveUncertain) throw new Error(t('saveUnknown'));
      if (!original.sourceFile.writable || !original.sourceFile.etag || !sourceBytes || !sourceData || !originalEditor.serializeSource)
        throw new Error(t('readOnly'));
      const originalSource = original.sourceFile, bytes = sourceBytes, before = sourceData;
      const { serialized, savingEditVersion } = await withInputLocked(async () => {
        await originalEditor.commitEdit?.();
        await beforeSave?.();
        assertActive();
        const serialized = await originalEditor.serializeSource!({ bytes, data: before, name: originalSource.name });
        return { serialized, savingEditVersion: editVersion };
      });
      let binary = '';
      for (const byte of serialized.bytes) binary += String.fromCharCode(byte);
      assertActive();
      let result;
      try {
        result = await app.request({
          method: 'openai/resources/write',
          params: { uri: originalSource.resourceUri, ifMatch: originalSource.etag, blob: btoa(binary) },
        }, z.object({ outcome: z.string(), etag: z.string().optional() }));
      } catch (error) { saveUncertain = true; throw error; }
      assertActive();
      if (result.outcome === 'conflict') throw new Error(t('conflict'));
      if (result.outcome !== 'saved' || !result.etag) {
        saveUncertain = true;
        throw new Error(t('saveUnknown'));
      }
      originalSource.etag = result.etag;
      sourceBytes = serialized.bytes;
      sourceData = structuredClone(serialized.data);
      try {
        await withInputLocked(async () => {
          await originalEditor.commitEdit?.();
          assertActive();
          dirty = editVersion !== savingEditVersion ||
            JSON.stringify(await originalEditor.snapshot()) !== JSON.stringify(serialized.data);
        });
        notice(t(dirty ? 'dirty' : 'saved'));
      } catch {
        if (!disposed && own === generation && editor === originalEditor) {
          dirty = true;
          notice(t('savedDraftUnchecked'), true);
        }
      }
      void shareContext();
      return savedResult(original, 'saved');
    }
    const { data, savingEditVersion } = await withInputLocked(async () => {
      await originalEditor.commitEdit?.();
      await beforeSave?.();
      assertActive();
      const data = await originalEditor.snapshot();
      return { data, savingEditVersion: editVersion };
    });
    assertActive();
    const saved = await call('save_document', {
      id: original.id, expectedRevision: original.revision, title: title.value.trim() || t('title'), data,
    });
    assertActive();
    current = saved;
    try {
      await withInputLocked(async () => {
        await originalEditor.commitEdit?.();
        if (disposed || own !== generation || editor !== originalEditor) return;
        dirty = editVersion !== savingEditVersion ||
          JSON.stringify(await originalEditor.snapshot()) !== JSON.stringify(data);
      });
      if (!disposed) notice(t(dirty ? 'dirty' : 'saved'));
    } catch {
      if (!disposed && own === generation && editor === originalEditor) {
        dirty = true;
        notice(t('savedDraftUnchecked'), true);
      }
    }
    void shareContext();
    return savedResult(saved, 'saved');
  }
  const live = registerLiveTools(app, {
    kind: options.kind,
    applySchema: options.applySchema,
    querySchema: options.querySchema,
    inspectSchema: options.inspectSchema,
    // Prevent a new, uncommitted cell edit during asynchronous calculation or
    // context synchronization. The toolbar lock alone does not cover the canvas.
    exclusive: (operation, lockInput = true) => exclusive(() => lockInput ? withInputLocked(operation) : operation()),
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
    save: saveCurrent,
    syncContext: synchronizeContext,
  });
  function dispatchAction(action: string) {
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
        if (action === 'save' && current && editor) await saveCurrent('document');
        if (action === 'saveCopy' && current && editor) await saveCurrent('copy');
        if (action === 'export' && current && editor) {
          await editor.commitEdit?.();
          const output = await editor.exportFile(exportFormat?.value);
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
  }
  document.querySelector('header')!.addEventListener('click', event => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('button')?.dataset.action;
    if (action) dispatchAction(action);
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
    const nextLocale = ctx?.locale?.startsWith('zh') ? 'zh' : 'en';
    const localeChanged = locale !== nextLocale;
    locale = nextLocale;
    const theme = ctx?.theme ?? 'light';
    if (document.documentElement.dataset.theme !== theme)
      document.documentElement.dataset.theme = theme;
    labels();
    if (localeChanged && libraryLoaded && !current && !library.hidden) renderLibrary();
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
