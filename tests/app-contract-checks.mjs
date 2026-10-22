import assert from 'node:assert/strict';

const key = 'ui/shared-header';

/** The same checks run for built Apps and deliberately broken counterexamples. */
export async function verifyAppContract(page, frame) {
  assert.equal(
    await page.evaluate(key => globalThis.appCapabilities?.experimental?.[key]?.version, key),
    1,
    'App must actually advertise ui/shared-header v1 during initialization',
  );
  for (const marker of ['data-app-toolbar', 'data-app-title', 'data-app-content']) {
    assert.equal(await frame.locator(`[${marker}]`).count(), 1, `App needs one ${marker} marker`);
  }
  await frame.locator('[data-app-toolbar]').waitFor();
  await frame.evaluate(() => {
    const title = document.querySelector('[data-app-title]');
    const content = document.querySelector('[data-app-content]');
    if (!title || !content) throw new Error('App contract DOM markers are missing');
    if (title instanceof HTMLInputElement && !title.readOnly) {
      title.value = 'Contract unsaved draft';
      title.setSelectionRange(2, 7);
      title.dispatchEvent(new Event('input', { bubbles: true }));
    }
    globalThis.contractOriginal = { title, content, value: title.value ?? title.textContent };
  });
  const snapshot = () =>
    frame.evaluate(() => {
      const toolbar = document.querySelector('[data-app-toolbar]');
      const title = document.querySelector('[data-app-title]');
      const content = document.querySelector('[data-app-content]');
      const rect = content.getBoundingClientRect();
      const style = getComputedStyle(toolbar);
      return {
        shared: document.documentElement.hasAttribute('data-shared-header'),
        height: toolbar.getBoundingClientRect().height,
        titleVisible: getComputedStyle(title).display !== 'none',
        left: parseFloat(style.paddingLeft),
        right: parseFloat(style.paddingRight),
        x: rect.x,
        width: rect.width,
        retained:
          globalThis.contractOriginal.title === title &&
          globalThis.contractOriginal.content === content &&
          globalThis.contractOriginal.value === (title.value ?? title.textContent),
      };
    });
  const update = async value => {
    await page.evaluate(([key, value]) => globalThis.updateContext({ [key]: value }), [key, value]);
    await frame.evaluate(
      () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  const baseline = await snapshot();
  assert.ok(baseline.titleVisible, 'Standalone title must be visible without a layout');
  assert.ok(baseline.width > 0, 'The real App content must have a visible area');
  const calls = await page.evaluate(() => globalThis.businessCalls);
  let viewportBaseline = baseline;
  for (const [width, layout] of [
    [900, { height: 44, left: 180, right: 96 }],
    [900, { height: 44, left: 180, right: 96 }],
    [900, { height: 32, left: 80, right: 60 }],
    [900, { height: 64, left: 80, right: 60 }],
    [360, { height: 44, left: 120, right: 96 }],
  ]) {
    if (page.viewportSize().width !== width) {
      await page.setViewportSize({ width, height: 700 });
      await update(null);
      viewportBaseline = await snapshot();
    }
    await update(layout);
    const state = await snapshot();
    assert.ok(
      state.shared && !state.titleVisible,
      'App must apply the shared layout and hide its duplicate title',
    );
    assert.equal(state.height, layout.height, 'Shared toolbar must occupy exactly one row');
    assert.equal(state.left, layout.left);
    assert.equal(state.right, layout.right);
    assert.equal(state.x, viewportBaseline.x, 'Header insets must not move the editor');
    assert.equal(state.width, viewportBaseline.width, 'Header insets must not shrink the editor');
    assert.ok(state.retained, 'Layout changes must retain existing DOM and unsaved input');
    for (const button of await frame
      .locator('[data-app-toolbar] button:visible:not(:disabled)')
      .all()) {
      await button.focus();
      const bounds = await button.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const toolbar = element.closest('[data-app-toolbar]');
        const bounds = toolbar.getBoundingClientRect(),
          style = getComputedStyle(toolbar);
        return {
          action: element.getAttribute('aria-label') ?? element.textContent,
          button: rect.toJSON(),
          toolbar: bounds.toJSON(),
          left: parseFloat(style.paddingLeft),
          right: parseFloat(style.paddingRight),
          accessible:
            rect.width > 0 &&
            rect.left >= bounds.left + parseFloat(style.paddingLeft) - 1 &&
            rect.right <= bounds.right - parseFloat(style.paddingRight) + 1 &&
            rect.top >= bounds.top - 1 &&
            rect.bottom <= bounds.bottom + 1,
        };
      });
      assert.ok(
        bounds.accessible,
        `Every action must remain accessible inside the available toolbar area: ${JSON.stringify(bounds)}`,
      );
    }
  }
  await page.setViewportSize({ width: 900, height: 700 });
  for (const value of [
    null,
    {},
    { height: 44, left: NaN, right: 20 },
    { height: Infinity, left: 80, right: 20 },
    { height: 44, left: -1, right: 20 },
    { height: 44, left: '80px', right: 20 },
    { height: 80, left: 80, right: 20 },
    { height: 44, left: 99999, right: 20 },
  ]) {
    await update(value);
    const state = await snapshot();
    assert.ok(
      !state.shared && state.titleVisible,
      'Null or invalid layouts must restore the standalone title',
    );
    assert.equal(state.height, baseline.height);
    assert.equal(state.left, baseline.left);
    assert.equal(state.right, baseline.right);
    assert.ok(state.retained);
  }
  await update({ height: 44, left: 80, right: 60 });
  assert.ok((await snapshot()).shared, 'Sharing must work again after withdrawal');
  assert.equal(
    await page.evaluate(() => globalThis.businessCalls),
    calls,
    'Presentation updates must not create, save, export or otherwise call business tools',
  );
}
