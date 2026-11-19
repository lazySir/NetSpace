// Optional browser verification. Install Playwright under .tools/qa first.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../.tools/qa/node_modules/playwright');
const base = process.env.NETSPACE_URL || 'http://127.0.0.1:8765';
const output = path.resolve(__dirname, '../artifacts');
fs.mkdirSync(output, { recursive: true });
const interfaces = [
  { id: '9', alias: 'Ethernet', ip: '192.168.50.20', prefixLength: 24, gateway: '192.168.50.1', mac: '02:00:00:00:00:20', type: 'ethernet', cidr: '192.168.50.0/24', scanCidr: '192.168.50.0/24', scopeLimited: false },
  { id: '10', alias: 'Wi-Fi', ip: '192.168.60.20', prefixLength: 24, gateway: '192.168.60.1', mac: '02:00:00:00:00:21', type: 'wifi', cidr: '192.168.60.0/24', scanCidr: '192.168.60.0/24', scopeLimited: false },
];
async function assertTopologyHonorsListFilter(page, label) {
  const unexpected = await page.evaluate(() => {
    const listed = new Set([...document.querySelectorAll('#device-list .device-row')].map(row => row.dataset.deviceId));
    return [...document.querySelectorAll('#scene-labels .scene-node-label:not([hidden])')]
      .map(node => node.dataset.deviceId).filter(id => !listed.has(id));
  });
  assert.deepEqual(unexpected, [], label + ' should hide every filtered-out topology node');
}
function resultFor(adapter, count = 3) {
  const prefix = adapter.ip.slice(0, adapter.ip.lastIndexOf('.') + 1);
  const devices = [
    { id: adapter.ip, ip: adapter.ip, hostname: 'WORKSTATION', mac: adapter.mac, kind: 'self', status: 'online', evidence: ['本机已连接的 IPv4 网络接口'], latencyMs: null },
    { id: adapter.gateway, ip: adapter.gateway, hostname: null, mac: '02:00:00:00:00:01', kind: 'gateway', status: 'resolved', evidence: ['本次地址解析成功，可能来自系统缓存，不保证当前在线'], latencyMs: .8, profile: { alias: '', notes: '', group: '基础设施', known: false, ignored: false } },
  ];
  for (let index = 2; index < count; index++) {
    const ip = prefix + (index + 40);
    devices.push({ id: ip, ip, hostname: index === 2 ? 'DESKTOP-LAB' : null, mac: '02:00:00:00:' + index.toString(16).padStart(2, '0') + ':42', kind: 'device', status: index % 2 ? 'cached' : 'resolved', evidence: ['设备地址解析记录'], latencyMs: 1.2, profile: { alias: '', notes: '', group: '工作设备', known: false, ignored: false } });
  }
  return { interface: adapter, devices, links: devices.filter(x => x.id !== adapter.gateway).map(x => ({ source: adapter.gateway, target: x.id, kind: 'same-subnet', inferred: true })), warnings: [], scannedAt: '2026-11-19T10:20:30+08:00', durationMs: 19000, scope: { cidr: adapter.cidr, scanCidr: adapter.scanCidr, targetCount: 253, limited: false } };
}
let testBrowser = null;
async function run() {
  const browser = testBrowser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  const cspViolations = [];
  const external = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (/content security policy/i.test(message.text())) cspViolations.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base + '/')) external.push(request.url()); });
  let current = { status: 'idle', progress: { phase: 'idle', completed: 0, total: 0, message: '准备就绪' }, result: null, error: null };
  let failBackup = false;
  await page.route('**/api/interfaces', route => route.fulfill({ json: { interfaces, error: null } }));
  await page.route('**/api/state', route => route.fulfill({ json: current }));
  await page.route('**/api/scan', async route => {
    const adapter = interfaces.find(x => x.id === route.request().postDataJSON().interfaceId);
    current = { status: 'complete', progress: { phase: 'complete', completed: 253, total: 253, message: '设备发现完成' }, result: resultFor(adapter), error: null };
    await route.fulfill({ status: 202, json: current });
  });
  await page.route('**/api/backup', route => failBackup
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '无法生成本地数据备份，请稍后重试。' }) })
    : route.fulfill({ status: 200, contentType: 'application/vnd.sqlite3', headers: { 'Content-Disposition': 'attachment; filename="NetSpace-backup-20261120-120000-123456.db"', 'Cache-Control': 'no-store' }, body: Buffer.from('SQLite format 3\0fixture') }));
  await page.route('**/api/shutdown', route => route.fulfill({ json: { status: 'stopped' } }));
  const documentResponse = await page.goto(base, { waitUntil: 'networkidle' });
  const policy = documentResponse.headers()['content-security-policy'] || '';
  assert.match(policy, /default-src 'self'/, 'document response should enforce its CSP');
  assert.match(policy, /object-src 'none'/, 'document response should block embedded objects');
  assert.match(policy, /frame-ancestors 'none'/, 'document response should prevent framing');
  const theme = await page.evaluate(() => ({
    background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    browserColor: document.querySelector('meta[name=theme-color]')?.content,
    metricFont: getComputedStyle(document.querySelector('#stat-cidr')).fontFamily,
    topologyGrid: getComputedStyle(document.querySelector('.scene-view'), '::before').backgroundImage,
  }));
  assert.equal(theme.background, '#050907', 'hacker console uses a near-black background');
  assert.equal(theme.accent, '#60ff9d', 'hacker console uses a readable green accent');
  assert.equal(theme.browserColor, '#050907', 'browser chrome matches the console theme');
  assert.match(theme.metricFont, /Consolas|Cascadia Code/, 'network metrics use a monospace typeface');
  assert.match(theme.topologyGrid, /linear-gradient/, 'topology includes a terminal grid overlay');
  await page.locator('#stat-total').filter({ hasText: '3' }).waitFor();
  assert.equal(await page.locator('#backup-button').isDisabled(), false, 'backup is enabled after the local service connects');
  const backupDownloadPromise = page.waitForEvent('download');
  await page.locator('#backup-button').click();
  const backupDownload = await backupDownloadPromise;
  assert.equal(backupDownload.suggestedFilename(), 'NetSpace-backup-20261120-120000-123456.db');
  await backupDownload.saveAs(path.join(output, 'netspace-backup-fixture.db'));
  assert.ok(fs.readFileSync(path.join(output, 'netspace-backup-fixture.db')).subarray(0, 15).toString('ascii').startsWith('SQLite format 3'));
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('备份已下载'));
  failBackup = true;
  await page.locator('#backup-button').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('无法生成本地数据备份'));
  assert.equal(await page.locator('#backup-button').isDisabled(), false, 'backup can be retried after a server error');
  failBackup = false;
  await page.locator('#device-list button').first().click();
  await page.locator('#detail-content').waitFor({ state: 'visible' });
  assert.equal(await page.locator('canvas').count() > 0, true);
  assert.equal(await page.locator('#rotate-button').getAttribute('aria-pressed'), 'false');
  await page.screenshot({ path: path.join(output, 'netspace-real-layout.png'), fullPage: true });
  await page.locator('#device-search').fill('192.168.50.42');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#device-list button').count(), 1, 'search should filter devices');
  await page.locator('#device-search').fill('');
  assert.equal(await page.locator('#device-group-filter').count(), 1, 'device panel should provide a profile-group filter');
  await page.locator('#device-group-filter').selectOption({ label: '工作设备' });
  assert.equal(await page.locator('#device-list button').count(), 1, 'group filter should find saved profile groups in live results');
  await assertTopologyHonorsListFilter(page, 'live profile group');
  await page.locator('#needs-review-filter').check();
  await page.locator('#device-status-filter').selectOption('cached');
  assert.equal(await page.locator('#device-list button').count(), 0, 'group, review, and status filters should compose');
  await page.locator('#needs-review-filter').uncheck();
  await page.locator('#device-status-filter').selectOption('');
  await page.locator('#device-group-filter').selectOption('');
  await page.locator('#device-group-filter').selectOption('ungrouped');
  assert.equal(await page.locator('#device-list button').count(), 1, 'live ungrouped filter should show records without a saved group');
  await page.locator('#device-group-filter').selectOption('');
  assert.equal(await page.locator('#needs-review-filter').count(), 1, 'device panel should provide a review-queue control');
  await page.locator('#needs-review-filter').check();
  assert.equal(await page.locator('#device-list button').count(), 2, 'review queue should show unresolved peers and omit the local computer');
  await assertTopologyHonorsListFilter(page, 'review queue');
  await page.locator('#device-status-filter').selectOption('resolved');
  assert.equal(await page.locator('#device-list button').count(), 2, 'review queue should compose with discovery status');
  await page.locator('#needs-review-filter').uncheck();
  await page.locator('#device-status-filter').selectOption('');
  await page.locator('#device-status-filter').selectOption('cached');
  assert.equal(await page.locator('#device-list button').count(), 0, 'status filter should apply before demo is entered');
  await page.locator('#demo-toggle').click();
  await page.locator('#demo-banner').waitFor({ state: 'visible' });
  assert.ok(Number(await page.locator('#stat-total').innerText()) > 3);
  assert.equal(await page.locator('#device-status-filter').inputValue(), '', 'entering demo resets the previous network status filter');
  assert.equal(await page.locator('#needs-review-filter').isChecked(), false, 'entering demo resets the review queue filter');
  assert.equal(await page.locator('#device-group-filter').inputValue(), '', 'entering demo resets the previous network group filter');
  await page.locator('#device-group-filter').selectOption({ label: '工作设备' });
  assert.equal(await page.locator('#device-list button').count(), 3, 'group filter should show every device assigned to that profile group');
  await assertTopologyHonorsListFilter(page, 'profile group');
  assert.equal((await page.locator('#filter-info').innerText()).trim(), '3 / 12', 'group filter should update the visible count');
  await page.locator('#device-group-filter').selectOption({ label: '未分组' });
  assert.equal(await page.locator('#device-list button').count(), 2, 'ungrouped filter should include records without a saved group');
  await page.locator('#device-group-filter').selectOption('');
  const statusCases = [['online', 1], ['resolved', 8], ['cached', 2], ['unverified', 1]];
  for (const [status, count] of statusCases) {
    await page.locator('#device-status-filter').selectOption(status);
    assert.equal(await page.locator('#device-list button').count(), count, status + ' filter should only show matching evidence');
    await assertTopologyHonorsListFilter(page, status + ' filter');
    assert.equal((await page.locator('#filter-info').innerText()).trim(), count + ' / 12', status + ' filter should update the visible count');
  }
  await page.locator('#device-status-filter').selectOption('');
  await page.locator('#needs-review-filter').check();
  await page.locator('#device-group-filter').selectOption({ label: '影音设备' });
  assert.equal(await page.locator('#device-list button').count(), 2, 'group and review filters should intersect');
  await assertTopologyHonorsListFilter(page, 'combined group and review filters');
  await page.locator('#device-status-filter').selectOption('cached');
  assert.equal(await page.locator('#device-list button').count(), 0, 'group, review, and status filters should intersect');
  await page.locator('#device-status-filter').selectOption('');
  await page.locator('#device-group-filter').selectOption('');
  assert.equal(await page.locator('#device-list button').count(), 9, 'clearing group should retain the review queue');
  assert.equal(await page.locator('#device-list button').count(), 9, 'review queue should omit the local computer, recognized and ignored demo devices');
  await assertTopologyHonorsListFilter(page, 'demo review queue');
  assert.equal((await page.locator('#filter-info').innerText()).trim(), '9 / 12', 'review queue count should include every active filter');
  await page.locator('#device-status-filter').selectOption('cached');
  await page.locator('#device-group-filter').selectOption({ label: '影音设备' });
  assert.equal(await page.locator('#device-list button').count(), 0, 'ignored cached device should stay out of the grouped review queue');
  assert.equal(await page.locator('#export-csv-button').isDisabled(), true, 'CSV export should be disabled when no devices match');
  await page.locator('#device-search').fill('iPhone');
  assert.equal(await page.locator('#device-list button').count(), 0, 'search should compose with review and status filters');
  await page.locator('#device-search').fill('');
  await page.locator('#device-status-filter').selectOption('');
  await page.locator('#needs-review-filter').uncheck();
  await page.locator('#device-group-filter').selectOption('');
  await page.locator('#device-search').fill('iPhone');
  assert.equal(await page.locator('#device-list button').count(), 1, 'clearing filters should restore matching search results');
  await page.locator('#device-status-filter').selectOption('resolved');
  assert.equal(await page.locator('#device-list button').count(), 1, 'search should compose with the resolved status filter');
  await page.locator('#device-search').fill('');
  await page.locator('#device-status-filter').selectOption('');
  assert.equal(await page.locator('#device-list button').count(), 12, 'all status should restore every demo device');
  await page.locator('#device-group-filter').selectOption({ label: '移动设备' });
  await page.locator('#device-search').fill('iPhone');
  assert.equal(await page.locator('#device-list button').count(), 1, 'group filtering should compose with search');
  await page.locator('#device-search').fill('');
  await page.locator('#device-group-filter').selectOption('');
  await page.locator('#device-group-filter').selectOption({ label: '移动设备' });
  await page.locator('#device-search').fill('iPhone');
  assert.equal(await page.locator('#device-list button').count(), 1, 'CSV should use the current combined filters');
  assert.equal(await page.locator('#export-csv-button').count(), 1, 'device panel should provide a CSV export action');
  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#export-csv-button').click();
  const csvDownload = await csvDownloadPromise;
  await csvDownload.saveAs(path.join(output, 'demo-filtered.csv'));
  const csvBytes = fs.readFileSync(path.join(output, 'demo-filtered.csv'));
  assert.equal(csvBytes.subarray(0, 3).toString('hex'), 'efbbbf', 'CSV should include a UTF-8 BOM for Windows spreadsheet compatibility');
  const csvText = csvBytes.subarray(3).toString('utf8');
  assert.ok(csvText.includes('虚构演示数据'), 'CSV should identify synthetic demo data');
  assert.ok(csvText.includes('iPhone'), 'CSV should include the visible filtered device');
  assert.ok(!csvText.includes('Living Room TV'), 'CSV should exclude devices hidden by filters');
  const formulaCsv = await page.evaluate(async () => {
    const { buildDeviceCsv } = await import('/csv.js');
    return buildDeviceCsv({ scannedAt: '2026-11-20T00:00:00Z', interface: { cidr: '192.168.1.0/24' } }, [{
      id: 'fixture', ip: '192.168.1.5', mac: ' \t-1+1', hostname: 'Host, "quoted"', kind: 'device', status: 'unverified',
      profile: { alias: '=HYPERLINK("https://example.invalid")', group: '+SUM(1,2)', notes: '@cmd', known: false, ignored: false }, evidence: ['demo'],
    }, ...['\0=1', '＝1', '＋1', '－1', '＠cmd'].map((alias, index) => ({
      id: 'formula-' + index, ip: '192.168.1.' + (10 + index), kind: 'device', status: 'unverified',
      profile: { alias, known: false, ignored: false }, evidence: ['demo'],
    }))], { source: '虚构演示数据', exportedAt: '2026-11-20T00:00:00Z' });
  });
  assert.ok(formulaCsv.includes("'=HYPERLINK(\"\"https://example.invalid\"\")"), 'CSV should neutralize formula-like aliases and quote embedded quotes');
  assert.ok(formulaCsv.includes("'+SUM(1,2)"), 'CSV should neutralize formula-like group labels');
  assert.ok(formulaCsv.includes("'@cmd"), 'CSV should neutralize formula-like notes');
  assert.ok(formulaCsv.includes("' \t-1+1"), 'CSV should neutralize formula-like values after leading whitespace');
  assert.ok(formulaCsv.includes("'\0=1"), 'CSV should neutralize formula-like aliases after a leading NUL');
  for (const trigger of ['＝1', '＋1', '－1', '＠cmd']) {
    assert.ok(formulaCsv.includes("'" + trigger), 'CSV should neutralize full-width formula trigger ' + trigger[0]);
  }
  assert.ok(formulaCsv.includes('Host, ""quoted""'), 'CSV should escape embedded commas and quotes');
  await page.locator('#device-search').fill('');
  await page.locator('#device-group-filter').selectOption('');
  await page.evaluate(() => { document.activeElement.blur(); document.querySelector('#toast').hidden = true; window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(output, 'netspace-demo.png'), fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const download = await downloadPromise;
  await download.saveAs(path.join(output, 'demo-export.json'));
  const exported = JSON.parse(fs.readFileSync(path.join(output, 'demo-export.json'), 'utf8'));
  assert.ok(JSON.stringify(exported).includes('demo') || JSON.stringify(exported).includes('演示'), 'export should mark demo data');
  await page.locator('#leave-demo').click();
  await page.locator('#demo-banner').waitFor({ state: 'hidden' });
  assert.equal(Number(await page.locator('#stat-total').innerText()), 3);
  const liveCsvPromise = page.waitForEvent('download');
  await page.locator('#export-csv-button').click();
  const liveCsv = await liveCsvPromise;
  await liveCsv.saveAs(path.join(output, 'live-export.csv'));
  assert.ok(fs.readFileSync(path.join(output, 'live-export.csv'), 'utf8').includes('本地网络发现'), 'CSV should label current discovery data');
  await page.locator('#device-status-filter').selectOption('cached');
  await page.locator('#device-group-filter').selectOption({ label: '基础设施' });
  await page.locator('#needs-review-filter').check();
  await page.locator('#interface-select').selectOption('10');
  assert.equal(await page.locator('#needs-review-filter').isChecked(), false, 'switching adapters resets the review queue');
  assert.equal(await page.locator('#device-status-filter').inputValue(), '', 'switching adapters resets the old status filter');
  assert.equal(await page.locator('#device-group-filter').inputValue(), '', 'switching adapters resets the old group filter');
  await page.locator('#scan-button').click();
  await page.waitForFunction(() => document.querySelector('#stat-cidr').textContent.includes('192.168.60'));
  assert.equal(await page.locator('#device-list').innerText().then(x => x.includes('192.168.50.')), false, 'old adapter devices must not leak');
  await page.locator('#reset-button').click();
  await page.locator('#rotate-button').click();
  assert.equal(await page.locator('#rotate-button').getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 375, height: 900 });
  await page.screenshot({ path: path.join(output, 'netspace-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile layout must not overflow horizontally');
  await page.setViewportSize({ width: 320, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'CSV actions must fit the minimum supported 320px viewport');
  assert.ok(await page.locator('#backup-button').isVisible(), 'local backup action remains visible at 320px');
  await page.locator('#shutdown-button').click();
  await page.waitForFunction(() => document.querySelector('#shutdown-button').textContent.includes('已停止'));
  assert.deepEqual(errors, [], 'browser must have no JavaScript runtime errors');
  assert.deepEqual(cspViolations, [], 'browser must report no CSP violations while modules and scene load');
  assert.deepEqual(external, [], 'app must not require any external resources');
  assert.equal(await page.locator('#backup-button').isDisabled(), true, 'backup is disabled after the service stops');
  console.log(JSON.stringify({ result: 'PASS', checks: ['CSP response', 'no CSP violations', 'real layout', 'review queue and filter composition', 'node selection', 'search', 'demo isolation', 'JSON and filtered CSV exports', 'CSV UTF-8 BOM and formula-injection/quoting protection', 'local backup download, retry, shutdown and mobile visibility', 'adapter switching', 'camera controls', '375px and 320px responsive', 'reduced motion', 'offline assets'], screenshots: output }));
  await browser.close();
  testBrowser = null;
}
run().catch(async error => { console.error(error); if (testBrowser) { try { await testBrowser.close(); } catch {} } process.exitCode = 1; });
