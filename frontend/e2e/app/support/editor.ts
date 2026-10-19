import { expect, type Page } from '@playwright/test'

/** The first page of the editor is drawn and ready for input. */
export async function editorReady(page: Page): Promise<void> {
  await expect(page.locator('[data-artboard] .doory-canvas').first()).toBeVisible({ timeout: 30_000 })
}

/**
 * Adds a heading from the Text drawer and types into it. The typing starts only once the new text is in edit mode: before that
 * the keys are shortcuts of the editor (a busy machine is slow enough for that to happen).
 */
export async function addHeading(page: Page, text: string): Promise<void> {
  await page.getByTestId('ed-add-entry-text').click()
  await page.getByTestId('text-preset-heading').click()
  await page.waitForFunction(() => document.activeElement instanceof HTMLTextAreaElement)
  await page.keyboard.type(text)
}
