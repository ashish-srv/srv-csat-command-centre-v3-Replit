const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');

async function main() {
  const { chromium } = require(process.env.CSAT_BROWSER_TEST_MODULE || 'playwright');
  const output = path.resolve('.local/report-qa');
  fs.mkdirSync(output, { recursive: true });
  await build({ entryPoints: ['scripts/fixtures/manage-export-ui.jsx'], bundle: true, outfile: path.join(output, 'ui.js'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CSAT_BROWSER_TEST_EXECUTABLE ? { executablePath: process.env.CSAT_BROWSER_TEST_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
    await page.addStyleTag({ path: path.join(output, 'ui.css') });
    await page.addScriptTag({ path: path.join(output, 'ui.js') });
    await page.locator('.consolidated-export-heading').click();
    await page.getByRole('button', { name: 'Clusters', exact: true }).click();
    const menu = page.locator('.filter-menu-portal');
    await menu.getByRole('option', { name: 'Cluster 20', exact: true }).click();
    const footer = await menu.locator('.filter-menu-actions').boundingBox();
    assert.ok(footer.y >= 0 && footer.y + footer.height <= 900, 'Clear/OK remain on screen');
    await page.screenshot({ path: path.join(output, 'export-filters.png') });
    await menu.getByRole('button', { name: 'Clear', exact: true }).click();
    await menu.getByRole('button', { name: 'OK', exact: true }).click();
    assert.equal(await menu.count(), 0);
    await page.locator('.manage-section-nav').getByRole('button', { name: 'Application Users', exact: true }).click();
    await page.waitForFunction(() => {
      const y = document.getElementById('manage-app-users').getBoundingClientRect().top;
      const nav = document.querySelector('.manage-section-nav').getBoundingClientRect();
      return y >= nav.bottom && y < nav.bottom + 30;
    });
    await page.locator('.role-group-admin > summary').click();
    await page.locator('.role-group-admin .app-user-card > summary').click();
    const admin = page.locator('.role-group-admin');
    await admin.getByRole('button', { name: 'Assigned Clusters', exact: true }).click();
    await menu.getByRole('option', { name: 'Cluster 20', exact: true }).click();
    assert.equal(await menu.getByRole('option', { selected: true }).count(), 2);
    await page.screenshot({ path: path.join(output, 'manage-clusters.png') });
    await menu.getByRole('button', { name: 'OK', exact: true }).click();
    await page.setViewportSize({ width: 800, height: 650 });
    await page.locator('.manage-section-nav').getByRole('button', { name: 'Internal POCs', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#manage-internal-pocs > details')?.open);
    await page.setContent(fs.readFileSync(path.join(output, 'report.html'), 'utf8'));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'report-screen.png') });
    assert.equal(await page.locator('.poc-group').count(), 4);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.chat-scroll').first().evaluate(el => getComputedStyle(el).maxHeight), 'none');
    await page.pdf({ path: path.join(output, 'report.pdf'), preferCSSPageSize: true, printBackground: true });
    assert.deepEqual(errors, []);
    console.log('PASS real Chromium: last cluster selection, visible Clear/OK, assigned multi-cluster picker, Manage jump offset/opening, report grouping and print expansion.');
  } finally { await browser?.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
