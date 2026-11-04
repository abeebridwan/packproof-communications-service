import { test, expect } from '@playwright/test'
test('mobile voice entry renders and rejects missing authorization without a room request', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  let requests = 0
  page.on('request', r => {
    if (r.url().includes('/v1/voice/sessions')) requests++
  })
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'Talk through the evidence.' }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: /Continue in PackProof Inspector/ }),
  ).toHaveAttribute('href', 'https://packproof-p0.vercel.app/review')
  await page.getByRole('button', { name: 'Connect microphone' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Open voice from PackProof',
  )
  expect(requests).toBe(0)
  expect(errors).toEqual([])
  await page.screenshot({
    path: '.runtime/artifacts/web-demo-mobile.png',
    fullPage: true,
  })
})
test('an expired invitation shows an actionable retry and does not expose evidence', async ({
  page,
}) => {
  await page.route('**/v1/voice/sessions', route =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"Expired"}',
    }),
  )
  await page.goto('/')
  await page.getByText('Authorized demo access', { exact: true }).click()
  await page
    .getByLabel('Short-lived invitation')
    .fill('expired-test-invitation')
  await page.getByRole('button', { name: 'Connect microphone' }).click()
  await expect(page.getByRole('alert')).toContainText('fresh demo invitation')
  await expect(
    page.getByRole('heading', { name: 'Evidence references' }),
  ).toHaveCount(0)
})

test('the development server refuses direct access to the private root environment file', async ({
  request,
}) => {
  const rootEnv = new URL('../../.env.local', import.meta.url).pathname
  const response = await request.get('/@fs' + rootEnv)
  expect(response.status()).toBe(403)
})
