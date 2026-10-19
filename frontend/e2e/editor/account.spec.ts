/**
 * [layout] The right end of the top bar: Share, Comments and Version history (signed-in modes use the adapter's services).
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { addShape, getDoc, moreMenu, openEditor, waitForObjectCount } from './helpers'

test.describe('[layout] share', () => {
  test('creates a link with a role, expiry and password, then changes and deletes it', async ({ page }) => {
    await openEditor(page, 'doc=blank&mode=account')
    await page.getByTestId('ed-share').click()
    const dialog = page.getByRole('dialog', { name: 'Share design' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('No links yet')).toBeVisible()
    await dialog.getByTestId('share-role').selectOption('comment')
    await dialog.getByTestId('share-expiry').selectOption('7d')
    await dialog.getByRole('switch', { name: 'Require a password' }).check()
    const create = dialog.getByTestId('share-create')
    await dialog.getByTestId('share-password').fill('12345')
    await expect(create).toBeDisabled()
    await dialog.getByTestId('share-password').fill('123456')
    await create.click()
    const row = dialog.getByTestId('share-link')
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('textbox', { name: 'Link address' })).toHaveValue(/\/s\/[0-9a-f]{8}$/)
    await expect(row).toContainText('Password protected')
    await expect(row).toContainText('Expires')
    await expect(row.getByRole('combobox', { name: 'Access of this link' })).toHaveValue('comment')

    await row.getByRole('combobox', { name: 'Access of this link' }).selectOption('edit')
    await expect(row.getByRole('combobox', { name: 'Access of this link' })).toHaveValue('edit')
    await row.getByRole('switch', { name: 'Link on' }).uncheck()
    await expect(row).toContainText('Turned off')
    await row.getByRole('button', { name: 'Remove password' }).click()
    await expect(row).not.toContainText('Password protected')

    await row.getByTestId('share-delete').click()
    await row.getByTestId('share-delete-confirm').click()
    await expect(dialog.getByTestId('share-link')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('guests are asked to sign up before sharing', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.getByTestId('ed-share').click()
    await expect.poll(() => page.evaluate(() => window.__doory!.accountRequests)).toContain('share')
  })
})

test.describe('[layout] version history', () => {
  test('saves a named version and restores it as an undoable step', async ({ page }) => {
    await openEditor(page, 'doc=blank&mode=account')
    await addShape(page, 'rect')
    await waitForObjectCount(page, 1)
    await moreMenu(page, 'Version history…')
    const dialog = page.getByRole('dialog', { name: 'Version history' })
    await expect(dialog.getByText('No versions yet')).toBeVisible()
    await dialog.getByTestId('version-label').fill('One rectangle')
    await dialog.getByTestId('version-create').click()
    await expect(dialog.getByTestId('version-row')).toHaveCount(1)
    await expect(dialog.getByTestId('version-row')).toContainText('One rectangle')
    await page.keyboard.press('Escape')

    await addShape(page, 'ellipse')
    await waitForObjectCount(page, 2)
    await moreMenu(page, 'Version history…')
    await dialog.getByTestId('version-restore').click()
    await dialog.getByTestId('version-restore-confirm').click()
    await waitForObjectCount(page, 1)
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click()
    await waitForObjectCount(page, 2)
  })

  test('guests are asked to sign up first', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await moreMenu(page, 'Version history…')
    await expect.poll(() => page.evaluate(() => window.__doory!.accountRequests)).toContain('version-history')
  })
})

test.describe('[layout] comments', () => {
  test('post, reply, resolve, reopen and delete', async ({ page }) => {
    await openEditor(page, 'doc=blank&mode=account')
    await page.getByTestId('ed-end-comments').click()
    const panel = page.getByTestId('comments-panel')
    await expect(panel.getByText('No comments yet')).toBeVisible()
    await page.getByTestId('comment-new-text').fill('Try a bolder heading')
    await page.getByTestId('comment-new-send').click()
    const thread = page.getByTestId('comment-thread')
    await expect(thread).toHaveCount(1)
    await expect(thread).toContainText('Try a bolder heading')
    await expect(thread).toContainText('Page 1')

    await thread.getByTestId('comment-reply-open').click()
    await thread.getByTestId('comment-reply-text').fill('Done, thanks')
    await thread.getByTestId('comment-reply-send').click()
    await expect(thread).toContainText('Done, thanks')

    await thread.getByTestId('comment-resolve').click()
    await expect(panel.getByText('Resolved (1)')).toBeVisible()
    await thread.getByTestId('comment-resolve').click()
    await expect(panel.getByText('Resolved (1)')).toHaveCount(0)

    await thread.getByRole('button', { name: 'Delete thread' }).click()
    await thread.getByTestId('comment-delete-confirm').click()
    await expect(page.getByTestId('comment-thread')).toHaveCount(0)
    expect((await getDoc(page)).pages[0].objects).toHaveLength(0)
  })

  test('a comment can be pinned to the selected object', async ({ page }) => {
    await openEditor(page, 'doc=blank&mode=account')
    await addShape(page, 'rect')
    await waitForObjectCount(page, 1)
    await page.getByTestId('ed-end-comments').click()
    await expect(page.getByLabel('Pin to selection')).toBeChecked()
    await page.getByTestId('comment-new-text').fill('This one')
    await page.getByTestId('comment-new-send').click()
    await expect(page.getByTestId('comment-thread')).toHaveCount(1)
  })

  test('guests get no Comments button: commenting needs an account', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await expect(page.getByTestId('ed-topbar')).toBeVisible()
    await expect(page.getByTestId('ed-end-comments')).toHaveCount(0)
  })
})
