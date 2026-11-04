import { test, expect } from '@playwright/test'
test.beforeEach(async ({ page }) => {
  // Browser regression tests must never consume the running demo's quota.
  await page.route('**/v1/voice/sessions', route =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"code":"request_denied"}',
    }),
  )
})
async function enterDemo(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByText('Authorized demo access', { exact: true }).click()
  await page
    .getByLabel('Short-lived invitation')
    .fill('browser-test-invitation')
}
test('a WebRTC-blocking extension is explained before any room or budget is requested', async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const name of [
      'RTCPeerConnection',
      'webkitRTCPeerConnection',
      'mozRTCPeerConnection',
    ])
      Object.defineProperty(window, name, {
        value: undefined,
        writable: true,
        configurable: true,
      })
  })
  let requests = 0
  page.on('request', r => {
    if (r.url().includes('/v1/voice/sessions')) requests++
  })
  await enterDemo(page)
  await page.getByRole('button', { name: 'Connect microphone' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Allow WebRTC for this site',
  )
  expect(requests).toBe(0)
})
test('denied microphone permission does not consume a session or invitation', async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('denied', 'NotAllowedError')
    }
  })
  let requests = 0
  page.on('request', r => {
    if (r.url().includes('/v1/voice/sessions')) requests++
  })
  await enterDemo(page)
  await page.getByRole('button', { name: 'Connect microphone' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Allow the microphone for this site',
  )
  await expect(page.getByRole('alert')).not.toContainText('fresh')
  expect(requests).toBe(0)
})
for (const failure of [
  {
    code: 'budget_exhausted',
    retryAfterSeconds: 0,
    expected: 'allowance is fully reserved',
  },
  { code: 'rate_limited', retryAfterSeconds: 180, expected: '3 minute(s)' },
  {
    code: 'capacity_busy',
    retryAfterSeconds: 10,
    expected: 'channels are in use',
  },
])
  test(`explains ${failure.code} without mislabelling every limit as busy`, async ({
    page,
  }) => {
    await page.route('**/v1/voice/sessions', route =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify(failure),
      }),
    )
    await enterDemo(page)
    await page.getByRole('button', { name: 'Connect microphone' }).click()
    await expect(page.getByRole('alert')).toContainText(failure.expected)
    await expect(page.getByRole('alert')).not.toContainText(
      'new authorized session',
    )
  })
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
