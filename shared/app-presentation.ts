import { App } from '@modelcontextprotocol/ext-apps';

export const SHARED_HEADER = 'ui/shared-header';

/** Repo App profile. Actual layout behavior is checked against the built UI. */
export function createApp(
  info: ConstructorParameters<typeof App>[0],
  capabilities: NonNullable<ConstructorParameters<typeof App>[1]> = {},
) {
  return new App(info, {
    ...capabilities,
    experimental: { ...capabilities.experimental, [SHARED_HEADER]: { version: 1 } },
  });
}

export function applySharedHeader(app: App) {
  const capability = app.getHostCapabilities()?.experimental?.[SHARED_HEADER] as
    { version?: unknown } | undefined;
  const value = app.getHostContext()?.[SHARED_HEADER];
  const layout =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const active =
    capability?.version === 1 &&
    layout &&
    typeof layout.height === 'number' &&
    Number.isFinite(layout.height) &&
    layout.height >= 32 &&
    layout.height <= 64 &&
    ['left', 'right'].every(
      key =>
        typeof layout[key] === 'number' &&
        Number.isFinite(layout[key]) &&
        (layout[key] as number) >= 0,
    ) &&
    (layout.left as number) + (layout.right as number) < window.innerWidth;
  const root = document.documentElement;
  root.toggleAttribute('data-shared-header', Boolean(active));
  root.style.setProperty('--app-header-height', active ? `${layout.height}px` : '46px');
  root.style.setProperty('--app-header-left', active ? `${layout.left}px` : '10px');
  root.style.setProperty('--app-header-right', active ? `${layout.right}px` : '10px');
}
