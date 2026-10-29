import { expect, test } from '@playwright/test';

test('missing identity reflects processing without replacing the report', async ({
  page,
}) => {
  await page.goto('/?identity=missing');
  await expect(page.getByRole('link', { name: /Company pending/ })).toHaveCount(
    2,
  );
  await expect(
    page.getByRole('link', { name: /Company unavailable/ }),
  ).toHaveCount(1);
  await page.getByRole('link', { name: /Company unavailable/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Title unavailable' }),
  ).toBeVisible();
  await expect(
    page.getByText('Company: Report company · Role: Report role'),
  ).toBeVisible();
});

test('shows the listing location beside the company, including unknown locations', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Alpha/ })).toContainText(
    'Alpha · Remote in Germany',
  );
  await expect(page.getByRole('link', { name: /Beta/ })).toContainText(
    'Beta · Location unknown',
  );
  await page.getByRole('link', { name: /Alpha/ }).click();
  await expect(page.locator('.report__eyebrow')).toHaveText(
    'Alpha · Remote in Germany',
  );
});

test('search and recommendation filters select a complete report', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Find an evaluation').fill('Beta');
  await expect(page.getByRole('link', { name: /Beta/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Alpha/ })).toHaveCount(0);
  await page.getByRole('link', { name: /Beta/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Platform engineer' }),
  ).toBeVisible();
  await expect(page.getByText('explicit gap', { exact: true })).toBeVisible();
  await expect(page.getByText('Not stated').first()).toBeVisible();
  await page.getByLabel('Find an evaluation').clear();
  await page.getByLabel('Filters').click();
  await page.getByLabel('Apply', { exact: true }).check();
  await expect(page.getByRole('link', { name: /Beta/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Alpha/ })).toBeVisible();
});

test('fixture actions hide and restore without losing saved assessment', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Alpha/ }).click();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByRole('link', { name: /Alpha/ })).toHaveCount(0);
  await page.getByLabel('Filters').click();
  await page.getByLabel('Review status').selectOption('hidden');
  await page.getByLabel('Filters').click();
  await page.getByRole('link', { name: /Alpha/ }).click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.getByLabel('Filters').click();
  await page.getByLabel('Review status').selectOption('active');
  await page.getByLabel('Filters').click();
  await page.getByRole('link', { name: /Alpha/ }).click();
  await expect(page.getByText('Strong match for the role.')).toBeVisible();
});

test('applied listings can be filtered and restored', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Alpha/ }).click();
  await expect(page.locator('.report__actions button').first()).toHaveText(
    'Applied',
  );
  await page.getByRole('button', { name: 'Applied', exact: true }).click();
  await expect(page.getByRole('link', { name: /Alpha/ })).toHaveCount(0);
  await page.getByLabel('Filters').click();
  await page.getByLabel('Review status').selectOption('applied');
  await page.getByLabel('Filters').click();
  await page.getByRole('link', { name: /Alpha/ }).click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.getByLabel('Filters').click();
  await page.getByLabel('Review status').selectOption('active');
  await page.getByLabel('Filters').click();
  await expect(page.getByRole('link', { name: /Alpha/ })).toBeVisible();
});

test('narrow layout remains operable with keyboard and long text', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await page.getByLabel('Find an evaluation').focus();
  await page.keyboard.type('Beta');
  await page.getByRole('link', { name: /Beta/ }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Platform engineer' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('failed assessments offer retry and show waiting afterward', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Gamma/ }).click();
  await expect(page.getByText('Assessment unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(
    page.getByText('This evaluation is waiting to start.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});

test('an older listing that was not queued is not presented as a failure', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Historical listing/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Evaluation', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('This evaluation has not been queued.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});

test('a hidden failed listing can be restored but not retried until active', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Gamma/ }).click();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.getByLabel('Filters').click();
  await page.getByLabel('Review status').selectOption('hidden');
  await page.getByLabel('Filters').click();
  await page.getByRole('link', { name: /Gamma/ }).click();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();
});

test('untrusted text remains text and unsafe source links are not clickable', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Unsafe/ }).click();
  await expect(page.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  await expect(page.locator('img')).toHaveCount(0);
  await expect(page.getByText('Source link unavailable')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'View', exact: true }),
  ).toHaveCount(0);
});

test('source links containing credentials are not clickable', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Credential link/ }).click();
  await expect(page.getByText('Source link unavailable')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'View', exact: true }),
  ).toHaveCount(0);
});

test('a large inbox remains searchable and displays long report content', async ({
  page,
}) => {
  await page.goto('/?volume=1000');
  await expect(page.getByRole('status')).toContainText(
    '1,006 of 1,006 listings',
  );
  await page.getByLabel('Find an evaluation').fill('Company 999');
  await expect(page.getByRole('status')).toContainText('1 of 1,006 listings');
  await page.getByRole('link', { name: /Company 999/ }).click();
  await expect(page.getByRole('heading', { name: 'Role 999' })).toBeVisible();
  await expect(page.getByText(/A lengthy responsibility/)).toBeVisible();
});

test('loading and failed requests are distinguishable from an empty inbox', async ({
  page,
}) => {
  await page.goto('/?state=loading');
  await expect(page.getByRole('status')).toHaveText('Loading listings…');
  await page.goto('/?state=error');
  await expect(page.getByRole('alert')).toHaveText('Could not load listings.');
  await page.goto('/?state=empty');
  await expect(page.getByText('No listings match your search.')).toBeVisible();
});

test('rejected listings can be restored', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Alpha/ }).click();
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByLabel('Filters').click();
  await page.getByLabel('Review status').selectOption('rejected');
  await page.getByLabel('Filters').click();
  await page.getByRole('link', { name: /Alpha/ }).click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.getByLabel('Filters').click();
  await page.getByLabel('Review status').selectOption('active');
  await page.getByLabel('Filters').click();
  await expect(page.getByRole('link', { name: /Alpha/ })).toBeVisible();
});

test('review status lives inside filters and dates use relative time', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-01-02T00:00:00Z'));
  await page.goto('/');
  await expect(page.getByLabel('Review status')).toBeHidden();
  await expect(page.getByText('Found: 1 day ago').first()).toBeVisible();
  await expect(page.getByText('Posted: date unknown').first()).toBeVisible();
  await page.getByLabel('Filters').click();
  await expect(page.getByLabel('Review status')).toBeVisible();
});
