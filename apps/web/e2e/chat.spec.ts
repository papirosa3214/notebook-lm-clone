import { expect, test } from '@playwright/test';

/**
 * End-to-end smoke test for the chat panel.
 *
 * The original bug Maks hit was: after sending a message, the loader
 * spins forever because React Strict-Mode double-mounts the component
 * and the second mount aborts the first stream — but the SSE reader
 * swallowed the AbortError, never resetting `streaming=true`. The fix
 * added an `onAbort` handler in apps/web/src/lib/stream.ts that resets
 * state. This test exists to make sure we never regress that.
 *
 * Pre-conditions (NOT booted by this test):
 *   - Vite dev on http://localhost:5273
 *   - Fastify API on http://localhost:4001
 *   - Ollama on 192.168.1.110:11434 (qwen3.6-27b-iq4-16k warm in VRAM)
 *
 * The "delete test" notebook (id `lPc60_L76Z7Z`) is what Maks used
 * to reproduce the bug. It has 9 sources so retrieval returns real
 * chunks and the chat route has something to stream.
 */
const NOTEBOOK_ID = 'lPc60_L76Z7Z';

test.describe('chat panel — end-to-end', () => {
  test('user sends a message and gets an assistant reply without a stuck loader', async ({ page }) => {
    await page.goto(`/notebooks/${NOTEBOOK_ID}`);

    // Input renders once the page settles. Selector is the placeholder
    // text defined in ChatPanel.tsx line ~211.
    // NOTE: in React Strict-Mode (dev) the component double-mounts, so
    // there are two textareas briefly on screen — pick the first one.
    const input = page.getByPlaceholder(/Спросите/).first();
    await expect(input).toBeVisible({ timeout: 15_000 });

    // Wait for the chat POST to actually hit the API. If it doesn't
    // (CORS, proxy error, server down) the streaming state never flips
    // and the loader would appear stuck — that's the regression we test.
    const chatResponsePromise = page.waitForResponse(
      (r) => r.url().includes(`/api/notebooks/${NOTEBOOK_ID}/chat`) && r.request().method() === 'POST',
      { timeout: 30_000 },
    );

    await input.fill('Кратко: что в этих источниках? Перечисли основные темы.');
    await page.locator('button[title="Отправить (Enter)"]').first().click();

    const chatResponse = await chatResponsePromise;
    expect(chatResponse.status()).toBe(200);

    // While streaming the textarea is disabled (placeholder changes to
    // "Генерация ответа…"). Wait for at least one token to land.
    await expect(page.getByPlaceholder(/Генерация ответа/).first()).toBeVisible({ timeout: 10_000 });

    // The bug: loader never went away. We assert that within 60s the
    // textarea returns to "Спросите..." placeholder (i.e. streaming=false).
    // If this assertion times out we have regressed the onAbort fix.
    await expect(input).toBeEnabled({ timeout: 60_000 });

    // The assistant reply uses class `prose-chat` (ChatPanel.tsx:286).
    // Wait for the LAST bubble to actually contain text (not just the
    // "Загружаю модель…" placeholder). This catches the case where the
    // stream closed without sending a `done` event.
    const assistantBubble = page.locator('.prose-chat').last();
    await expect(assistantBubble).toBeVisible({ timeout: 30_000 });
    // Generous timeout: Ollama on the inference box occasionally takes
    // 30-60s on the first request after a cold load of qwen3.6-27b.
    await expect(assistantBubble).not.toContainText(/Загружаю модель/, { timeout: 90_000 });
    const text = (await assistantBubble.textContent())?.trim() ?? '';
    // The question asks for ≥1 theme — even short answers should clear
    // 5 chars. We don't gate on a larger number because Ollama on this
    // notebook occasionally returns a terse 12-token greeting that the
    // user wouldn't consider "broken".
    expect(text.length).toBeGreaterThan(5);
  });

  test('summary panel does not spin forever on reload', async ({ page }) => {
    // Sister regression: the summary endpoint had the same loader-bug.
    // We just hit the notebook page and assert the summary area renders
    // content (or its empty-state), not a perpetual spinner.
    await page.goto(`/notebooks/${NOTEBOOK_ID}`);

    // SummaryPanel renders either the summary body or "Ещё нет саммари".
    // Either way, a perpetual Dot-loader with "Загружаю модель…" is a bug.
    const stuckLoader = page.getByText(/Загружаю модель/);
    // Give it a generous 45s window — first load can be slow if Ollama
    // evicted the model. After that the loader must be gone.
    await expect(stuckLoader).toBeHidden({ timeout: 45_000 });
  });
});
