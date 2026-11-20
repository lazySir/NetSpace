// Browser-only fixtures: this server cannot discover devices or open target TCP connections.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('../.tools/qa/node_modules/playwright');
const webRoot = path.resolve(__dirname, '../web');
const output = path.resolve(__dirname, '../artifacts');
const images = path.resolve(__dirname, '../docs/images');
const adapters = [
  { id: '9', alias: '虚构测试网络 A', ip: '192.0.2.20', gateway: '192.0.2.1', cidr: '192.0.2.0/24', scanCidr: '192.0.2.0/24' },
  { id: '10', alias: '虚构测试网络 B', ip: '198.51.100.20', gateway: '198.51.100.1', cidr: '198.51.100.0/24', scanCidr: '198.51.100.0/24' },
];
const monitor = { enabled: false, interfaceId: null, intervalSeconds: 300, nextScanAt: null, error: null, notificationsEnabled: true };
function snapshot(adapter, networkId, scanId) {
  const devices = [
    { id: adapter.gateway, ip: adapter.gateway, deviceKey: 'router', kind: 'gateway', hostname: '示例路由器（虚构测试数据）', status: 'resolved', evidence: ['arp'], profile: {} },
    { id: adapter.ip, ip: adapter.ip, deviceKey: 'self', kind: 'self', hostname: '示例电脑', status: 'online', evidence: ['self'], profile: {} },
    { id: adapter.ip.replace(/20$/, '30'), ip: adapter.ip.replace(/20$/, '30'), deviceKey: 'nas', kind: 'device', hostname: '示例存储（虚构测试数据）', status: 'cached', evidence: ['neighbor-cache'], profile: {} },
  ];
  return { networkId, scanId, interface: adapter, devices, links: [{ source: devices[0].id, target: devices[1].id }], scannedAt: new Date().toISOString(), durationMs: 12, scope: { cidr: adapter.cidr, scanCidr: adapter.scanCidr, targetCount: 253 }, warnings: [] };
}
function checking(networkId = 'test-network-A', deviceKey = 'nas', scanId = 1) { return { status: 'checking', completed: 0, total: 7, results: [], networkId, deviceKey, scanId }; }
const allResults = [
  { port: 21, service: 'FTP', status: 'closed' }, { port: 22, service: 'SSH', status: 'open' },
  { port: 23, service: 'Telnet', status: 'closed' }, { port: 80, service: 'HTTP', status: 'open' },
  { port: 443, service: 'HTTPS', status: 'no_response' }, { port: 445, service: 'SMB', status: 'unavailable' },
  { port: 3389, service: 'RDP', status: 'closed' },
];
async function run() {
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(images, { recursive: true });
  const unexpectedApi = [];
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname.startsWith('/api/')) { unexpectedApi.push(pathname); response.writeHead(500); response.end('All test APIs must be intercepted'); return; }
    const file = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.NETSPACE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => { const clock = Date.now.bind(Date); let offset = 0; Date.now = () => clock() + offset; window.setDeviceCheckTimeOffset = value => { offset = value; }; });
    const page = await context.newPage(); const errors = [], external = [], posts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base + '/')) external.push(request.url()); });
    const a = snapshot(adapters[0], 'test-network-A', 1), b = snapshot(adapters[1], 'test-network-B', 2);
    const old = { ...a, scanId: 3, scannedAt: '2026-01-01T00:00:00Z' };
    let live = a, scanStatus = 'complete', check = { status: 'idle', completed: 0, total: 7, results: [], networkId: null, deviceKey: null };
    let failNext = null, delayNextPost = false, releasePost = null, checkReads = 0;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (/^https?:$/.test(url.protocol) && url.origin !== base) return route.abort('blockedbyclient');
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const respond = (json, status = 200) => route.fulfill({ status, json });
      if (method === 'POST') posts.push({ path: url.pathname, body: request.postDataJSON(), origin: request.headers().origin });
      if (url.pathname === '/api/interfaces') return respond({ interfaces: adapters, error: null });
      if (url.pathname === '/api/state') return respond({ status: scanStatus, progress: {}, result: live, error: null, monitor, deviceCheck: check });
      if (url.pathname === '/api/monitor') return respond(monitor);
      if (url.pathname === '/api/networks') return respond({ networks: [a, b].map(x => ({ id: x.networkId, label: x.interface.alias, cidr: x.interface.cidr })) });
      if (url.pathname === '/api/history') return respond({ scans: [{ id: 3, networkId: a.networkId, scannedAt: old.scannedAt, deviceCount: 3 }] });
      if (url.pathname === '/api/history/3') return respond({ result: old });
      if (url.pathname === '/api/devices') return respond({ devices: live.devices });
      if (url.pathname === '/api/events') return respond({ events: [], unreadCount: 0, notificationsEnabled: true });
      if (url.pathname === '/api/device-check/cancel') { check = { ...check, status: 'cancelled' }; return respond({ cancelled: true }); }
      if (url.pathname === '/api/device-check') {
        if (method === 'GET') { checkReads++; return respond(check); }
        if (failNext) { const failure = failNext; failNext = null; return respond({ error: failure.error }, failure.status); }
        const body = request.postDataJSON(); check = checking(body.networkId, body.deviceKey, live.scanId);
        if (delayNextPost) { delayNextPost = false; const held = { ...check }; await new Promise(resolve => { releasePost = resolve; }); return respond(held, 202); }
        return respond(check, 202);
      }
      if (url.pathname === '/api/shutdown') return respond({ status: 'stopped' });
      return respond({ error: 'Unexpected test API: ' + url.pathname }, 500);
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#device-check-open').count(), 1, 'selected devices must expose the beginner-friendly check entry');
    await page.locator('#device-list button[data-device-id="192.0.2.30"]').click();
    assert.equal(await page.locator('#device-check-open').isDisabled(), false);
    assert.equal(posts.length, 0, 'loading and selecting a current peer must never start a check');
    await page.locator('#device-check-open').click();
    const dialog = page.getByRole('dialog', { name: '检查这台设备的服务' });
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#device-check-consent').isChecked(), false);
    assert.equal(await page.locator('#device-check-start').isDisabled(), true);
    await page.locator('#device-check-consent').check();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false, 'Escape closes the dialog without starting or cancelling a task');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'device-check-open', 'closing returns keyboard focus to the entry');
    await page.locator('#device-check-open').click();
    assert.equal(await page.locator('#device-check-consent').isChecked(), false, 'every opening must require fresh consent');
    await page.locator('#device-check-consent').check(); await page.locator('#device-check-start').click();
    await page.waitForFunction(() => document.querySelector('#device-check-cancel').disabled === false);
    assert.deepEqual(posts[0].body, { networkId: 'test-network-A', deviceKey: 'nas', authorized: true });
    assert.equal(posts[0].origin, base, 'the explicit POST must carry the same browser Origin');
    assert.equal(await page.locator('#device-check-start').isDisabled(), true, 'a running check cannot be started twice');
    check = { ...check, status: 'complete', completed: 7, results: allResults };
    await page.waitForFunction(() => document.querySelectorAll('#device-check-results li').length === 7);
    assert.match(await page.locator('#device-check-results').innerText(), /可连接/);
    assert.match(await page.locator('#device-check-results').innerText(), /未响应/);
    assert.match(await page.locator('#device-check-results').innerText(), /不可用/);
    assert.equal(await page.locator('#detail-ip').innerText(), '192.0.2.30', 'service results must not replace the device address');
    assert.equal(await page.locator('#device-check-consent').isChecked(), false, 'consent is consumed by one run');
    assert.equal(posts.filter(x => x.path === '/api/device-check').length, 1, 'polling must only read check state');
    await page.evaluate(() => { window.checkResultMutations = 0; const observer = new MutationObserver(records => { window.checkResultMutations += records.length; }); for (const id of ['device-check-status', 'device-check-results']) observer.observe(document.getElementById(id), { childList: true, subtree: true, characterData: true }); });
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.checkResultMutations), 0, 'an unchanged completed check must not repeatedly announce its status or replace result rows');
    await page.screenshot({ path: path.join(images, 'netspace-device-check.png') });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.screenshot({ path: path.join(images, 'netspace-device-check-320.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'dialog must fit a 320 px screen');
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'dialog content must wrap within its panel');
    assert.equal(await page.evaluate(() => { const entry = document.querySelector('.device-check-entry').getBoundingClientRect(); const panel = document.querySelector('#detail-content').getBoundingClientRect(); return entry.width > panel.width * .8; }), true, 'the new check entry must span the mobile details panel');
    await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.equal(await page.locator('#device-check-close').isVisible(), true, 'the close action remains reachable in a narrow scrolling dialog');
    await page.screenshot({ path: path.join(output, 'netspace-device-check-320-actions.png') });
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.locator('#device-check-consent').check(); await page.locator('#device-check-start').click();
    await page.waitForFunction(() => !document.querySelector('#device-check-cancel').disabled);
    await page.evaluate(() => window.setDeviceCheckTimeOffset(350000));
    await page.waitForTimeout(1100);
    assert.equal(await dialog.isVisible(), true, 'crossing the freshness deadline must not hide a running check or its cancel action');
    assert.equal(await page.locator('#device-check-cancel').isDisabled(), false);
    await page.locator('#device-check-cancel').click();
    await page.waitForFunction(() => document.querySelector('#device-check-status').textContent.includes('已取消'));
    assert.deepEqual(posts.find(x => x.path === '/api/device-check/cancel').body, {});
    await page.locator('#device-check-close').click();
    await page.evaluate(() => window.setDeviceCheckTimeOffset(0));
    await page.locator('#device-list button[data-device-id="192.0.2.20"]').click();
    assert.equal(await page.locator('#device-check-open').isDisabled(), true, 'the local computer is excluded');
    await page.locator('#device-list button[data-device-id="192.0.2.30"]').click();
    for (const failure of [{ status: 409, error: '其他任务正在进行，请稍候' }, { status: 400, error: '记录已过期，请重新发现设备' }, { status: 404, error: '设备已不在最新记录中' }]) {
      await page.locator('#device-check-open').click(); failNext = failure;
      await page.locator('#device-check-consent').check(); await page.locator('#device-check-start').click();
      await page.locator('#device-check-error').filter({ hasText: failure.error }).waitFor();
      assert.equal(await page.locator('#device-check-start').isDisabled(), true, 'failure retry also requires fresh consent');
      await page.locator('#device-check-close').click();
    }
    // A late POST response must not reopen a dialog or attach the old result to another network.
    await page.locator('#device-check-open').click(); delayNextPost = true;
    await page.locator('#device-check-consent').check(); await page.locator('#device-check-start').click();
    for (let n = 0; !releasePost && n < 50; n++) await page.waitForTimeout(20);
    assert.ok(releasePost); await page.locator('#device-check-close').click();
    await page.locator('#interface-select').selectOption('10');
    releasePost(); releasePost = null; await page.waitForTimeout(150);
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.locator('#device-check-consent').isChecked(), false);
    assert.equal(await page.locator('#device-check-results li').count(), 0);
    live = b; check = { ...check, status: 'complete', results: allResults, completed: 7 };
    await page.waitForFunction(() => document.querySelector('#stat-total').textContent === '03');
    await page.locator('#device-list button[data-device-id="198.51.100.30"]').click();
    await page.locator('#device-check-open').click();
    assert.equal(await page.locator('#device-check-results li').count(), 0, 'previous network results must stay hidden');
    await page.locator('#device-check-close').click();
    await page.locator('#demo-toggle').click();
    assert.equal(await page.locator('#device-check-open').isDisabled(), true, 'demo never supports real checks');
    await page.locator('#leave-demo').click();
    scanStatus = 'scanning';
    await page.waitForFunction(() => document.querySelector('#scan-button').disabled && document.querySelector('#scan-button-text').textContent.includes('正在'));
    assert.equal(await page.locator('#device-check-open').isDisabled(), true, 'discovery and checks cannot overlap');
    scanStatus = 'complete';
    await page.waitForFunction(() => !document.querySelector('#scan-button').disabled);
    await page.locator('#interface-select').selectOption('9'); live = a;
    await page.waitForTimeout(3300);
    await page.locator('#tab-history').click();
    await page.locator('#history-scan').selectOption('3');
    await page.locator('#replay-banner').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#device-check-open').isDisabled(), true, 'historical results never support checks');
    await page.locator('#return-current').click();
    await page.locator('#tab-devices').click();
    live = { ...a, scanId: 4, scannedAt: new Date().toISOString(), devices: a.devices.map(device => device.deviceKey === 'nas' ? { ...device, id: '192.0.2.31', ip: '192.0.2.31' } : device) };
    await page.waitForFunction(() => document.querySelector('#device-list').textContent.includes('192.0.2.31'));
    await page.locator('#device-list button[data-device-id="192.0.2.31"]').click();
    await page.locator('#device-check-open').click();
    assert.equal(await page.locator('#device-check-results li').count(), 0, 'a result for a previous scan must not follow a stable device key to a new address');
    await page.locator('#device-check-dismiss').click();
    live = { ...live, scannedAt: '2026-01-01T00:00:00Z' };
    await page.waitForFunction(() => document.querySelector('#device-check-availability').textContent.includes('5 分钟'));
    assert.equal(await page.locator('#device-check-open').isDisabled(), true, 'expired discovery cannot start a check');
    live = { ...live, scanId: 5, scannedAt: new Date().toISOString(), devices: live.devices.map(device => device.deviceKey === 'nas' ? { ...device, deviceKey: undefined } : device) };
    await page.waitForFunction(() => document.querySelector('#device-check-availability').textContent.includes('请先'));
    assert.equal(await page.locator('#device-check-open').isDisabled(), true, 'devices without stable saved identifiers cannot start a check');
    live = { ...live, scanId: 6, scannedAt: new Date().toISOString(), devices: live.devices.map(device => device.id === '192.0.2.31' ? { ...device, deviceKey: 'nas' } : device) };
    await page.waitForFunction(() => !document.querySelector('#device-check-open').disabled);
    await page.locator('#shutdown-button').click();
    await page.waitForFunction(() => document.querySelector('#shutdown-button').textContent.includes('服务已停止'));
    assert.equal(await page.locator('#device-check-open').isDisabled(), true, 'stopped services cannot start checks');
    assert.equal(posts.filter(x => x.path === '/api/scan').length, 0, 'the fixture must never request LAN discovery');
    assert.ok(checkReads > 0, 'running checks must refresh status with GET');
    assert.deepEqual(external, []); assert.deepEqual(unexpectedApi, []); assert.deepEqual(errors, []);
    console.log('Device check UI passed: explicit single-run consent, cancellation, plain results, stale-target isolation, disabled views, same-origin POST and 320 px layout; all APIs mocked, no scans or target connections.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
