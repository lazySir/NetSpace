// Static browser fixtures only: this server cannot scan a LAN or contact a target device.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('../.tools/qa/node_modules/playwright');
const webRoot = path.resolve(__dirname, '../web');
const images = process.env.NETSPACE_DOC_IMAGES ? path.resolve(process.env.NETSPACE_DOC_IMAGES) : path.resolve(__dirname, '../docs/images');
const adapters = [
  { id: '9', alias: '虚构测试网络 A', ip: '192.0.2.20', gateway: '192.0.2.1', cidr: '192.0.2.0/24', scanCidr: '192.0.2.0/24' },
  { id: '10', alias: '虚构测试网络 B', ip: '198.51.100.20', gateway: '198.51.100.1', cidr: '198.51.100.0/24', scanCidr: '198.51.100.0/24' },
];
const networkA = 'test-network-A', networkB = 'test-network-B';
const hostileName = '<img src=x onerror="window.archiveInjected=1">虚构不可信名称';
const hostileNotes = '<svg onload="window.archiveInjected=2">虚构备注 & 安全文本</svg>';
const stamp = '2026-11-01T08:00:00Z';
function record(deviceKey, overrides = {}) {
  return { deviceKey, kind: 'device', hostname: '虚构已保存设备', ip: '192.0.2.70', mac: '02:00:00:00:00:70', present: true, firstSeen: stamp, lastSeen: stamp, profile: { alias: '', notes: '', group: '', known: false, ignored: false }, ...overrides };
}
const savedA = [
  record('archive-printer', { hostname: 'synthetic-printer', ip: '192.0.2.60', present: false, profile: { alias: 'Studio Printer', notes: '虚构打印机档案，供界面验证', group: '工作室', known: false, ignored: false } }),
  record('archive-known', { hostname: '已认识的虚构存储', ip: '192.0.2.61', present: false, profile: { alias: '家庭存储', notes: '本次没有出现', group: '家庭', known: true, ignored: false } }),
  record('archive-ignored', { hostname: '已忽略的虚构设备', ip: '192.0.2.62', present: false, profile: { alias: '', notes: '已由用户忽略', group: '', known: false, ignored: true } }),
  record('archive-self', { kind: 'self', hostname: '虚构本机档案', ip: '192.0.2.20', present: false }),
  record('archive-shared-old', { hostname: '旧地址使用者（虚构）', ip: '192.0.2.88', present: false }),
  record('archive-shared-new', { hostname: '新地址使用者（虚构）', ip: '192.0.2.88', mac: '02:00:00:00:00:88' }),
  record('archive-hostile', { hostname: hostileName, ip: '192.0.2.90', profile: { alias: '', notes: hostileNotes, group: '安全文本测试', known: false, ignored: false } }),
  ...Array.from({ length: 53 }, (_, index) => record('archive-known-' + String(index + 1).padStart(2, '0'), { hostname: '虚构档案设备 ' + (index + 1), ip: '192.0.2.' + (100 + index), mac: '02:00:00:00:01:' + (index + 1).toString(16).padStart(2, '0'), profile: { alias: '已认识设备 ' + (index + 1), notes: '仅为合成界面数据', group: '示例分组', known: true, ignored: false } })),
];
const savedB = [record('archive-network-b', { hostname: '网络 B 的虚构设备', ip: '192.0.2.88', mac: '02:00:00:00:02:88', profile: { alias: '另一网络的设备', notes: '同一个地址不代表同一个设备', group: '网络 B', known: true, ignored: false } })];
const monitor = { enabled: false, interfaceId: null, intervalSeconds: 300, nextScanAt: null, error: null, notificationsEnabled: true };
const idleCheck = { status: 'idle', completed: 0, total: 7, results: [], networkId: null, deviceKey: null, scanId: null, runId: null };
function currentResult() {
  const adapter = adapters[0];
  const devices = [
    { id: adapter.gateway, ip: adapter.gateway, deviceKey: 'current-router', kind: 'gateway', hostname: '当前虚构路由器', status: 'resolved', evidence: ['arp'], profile: {} },
    { id: adapter.ip, ip: adapter.ip, deviceKey: 'current-self', kind: 'self', hostname: '当前虚构电脑', status: 'online', evidence: ['self'], profile: {} },
    { id: '192.0.2.30', ip: '192.0.2.30', deviceKey: 'current-nas', kind: 'device', hostname: '当前虚构存储', status: 'cached', evidence: ['neighbor-cache'], profile: {} },
  ];
  return { networkId: networkA, scanId: 1, interface: adapter, devices, links: [{ source: devices[0].id, target: devices[1].id }], scannedAt: new Date().toISOString(), durationMs: 12, scope: { cidr: adapter.cidr, scanCidr: adapter.scanCidr, targetCount: 253 }, warnings: [] };
}
async function run() {
  fs.mkdirSync(images, { recursive: true });
  const unexpectedApi = [], external = [], requests = [], posts = [], errors = [], controlledReads = [];
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname.startsWith('/api/')) { unexpectedApi.push(pathname); response.writeHead(500); response.end('All test APIs must be intercepted'); return; }
    const file = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.NETSPACE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let live = currentResult(), revision = 0;
    let catalogue = adapters.map((adapter, index) => ({ id: index ? networkB : networkA, label: adapter.alias, cidr: adapter.cidr }));
    const records = new Map([[networkA, savedA], [networkB, savedB]]);
    const plans = [];
    function planRead(apiPath, networkId, options = {}) {
      let release, observe;
      const plan = { path: apiPath, networkId, ...options, gate: new Promise(resolve => { release = resolve; }), started: new Promise(resolve => { observe = resolve; }) };
      plan.release = release; plan.observe = observe; plans.push(plan); controlledReads.push(plan); return plan;
    }
    async function plannedResponse(apiPath, networkId, json, respond) {
      const index = plans.findIndex(plan => plan.path === apiPath && (plan.networkId === undefined || plan.networkId === networkId));
      if (index < 0) return respond(json);
      const plan = plans.splice(index, 1)[0];
      const held = structuredClone(plan.json === undefined ? json : plan.json);
      plan.observe();
      if (plan.hold) await plan.gate;
      return respond(held, plan.status || 200);
    }
    const awaitRead = async plan => {
      let timer;
      try { await Promise.race([plan.started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected controlled fixture read: ' + plan.path)), 5000); })]); }
      finally { clearTimeout(timer); }
    };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== base) { external.push(url.href); return route.abort('blockedbyclient'); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      requests.push({ path: url.pathname, method, networkId: url.searchParams.get('networkId') });
      const respond = (json, status = 200) => route.fulfill({ status, json });
      if (method !== 'GET') { posts.push({ path: url.pathname, method }); return respond({ error: 'Archive fixtures allow GET only' }, 405); }
      if (url.pathname === '/api/interfaces') return respond({ interfaces: adapters, error: null });
      if (url.pathname === '/api/state') return respond({ status: live ? 'complete' : 'idle', progress: {}, result: live, error: null, dataRevision: revision, monitor, deviceCheck: idleCheck, webHeaderCheck: { ...idleCheck, total: 0 } });
      if (url.pathname === '/api/monitor') return respond(monitor);
      if (url.pathname === '/api/networks') return plannedResponse(url.pathname, undefined, { networks: catalogue }, respond);
      if (url.pathname === '/api/devices') {
        const networkId = url.searchParams.get('networkId');
        if (!records.has(networkId)) return respond({ error: 'A saved device request must identify a fixture network' }, 400);
        return plannedResponse(url.pathname, networkId, { devices: records.get(networkId) }, respond);
      }
      if (url.pathname === '/api/history') return respond({ scans: [] });
      if (url.pathname === '/api/events') return respond({ events: [], unreadCount: 0, notificationsEnabled: true });
      if (url.pathname === '/api/device-check') return respond(idleCheck);
      if (url.pathname === '/api/web-header-check') return respond({ ...idleCheck, total: 0 });
      unexpectedApi.push(url.pathname); return respond({ error: 'Unexpected test API: ' + url.pathname }, 500);
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#archive-open').count(), 1, 'saved records must expose the manual 查看已保存设备 entry');
    assert.match(await page.locator('#archive-open').innerText(), /查看已保存设备/);
    await page.locator('#device-list button[data-device-id="192.0.2.30"]').click();
    const currentBefore = await page.locator('#device-list').innerText();
    const selectedBefore = await page.locator('#detail-ip').innerText();
    const baselineReads = requests.filter(item => item.path === '/api/devices').length;
    assert.equal(baselineReads, requests.filter(item => item.path === '/api/history').length, 'startup saved-device reads belong only to the existing workspace refresh');
    await page.waitForTimeout(700);
    assert.equal(requests.filter(item => item.path === '/api/devices').length, baselineReads, 'idle archive must not refresh saved devices in the background');
    await page.locator('#archive-open').click();
    const dialog = page.locator('#device-archive-dialog');
    await dialog.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 50);
    assert.equal(await page.locator('#archive-summary').getAttribute('role'), 'status', 'the summary is exposed as a status announcement');
    assert.equal(await page.locator('#archive-error').getAttribute('role'), 'alert', 'read failures are announced accessibly');
    assert.equal(await page.locator('#archive-network').inputValue(), networkA);
    assert.equal(await page.locator('#archive-network option').count(), 2);
    assert.equal(await page.locator('#archive-empty').isVisible(), false);
    assert.equal(await page.locator('#archive-more').isVisible(), true, 'long catalogues offer an explicit next page');
    const initialSummary = await page.locator('#archive-summary').innerText();
    for (const count of [60, 5, 4, 50]) assert.match(initialSummary, new RegExp('(^|\\D)' + count + '(\\D|$)'), 'summary exposes total, missing, review and visible counts');
    await page.locator('#archive-more').click();
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 60);
    assert.equal(await page.locator('#archive-more').isVisible(), false, 'the next-page action disappears after the final row');
    assert.equal(await page.locator('#archive-list > li[data-device-key="archive-shared-old"]').count(), 1);
    assert.equal(await page.locator('#archive-list > li[data-device-key="archive-shared-new"]').count(), 1, 'different stable keys sharing an IP must remain separate records');
    await page.locator('#archive-search').fill('Stduio Prnter');
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 1);
    assert.match(await page.locator('#archive-list').innerText(), /Studio Printer/);
    await page.locator('#archive-search').fill('192.0.2.89');
    await page.locator('#archive-empty').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#archive-list > li').count(), 0, 'IP searches must not fuzzy-match nearby addresses');
    await page.locator('#archive-search').fill('192.0.2.88');
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 2);
    await page.locator('#archive-search').fill('02:00:00:00:00:89');
    await page.locator('#archive-empty').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#archive-list > li').count(), 0, 'MAC searches must not fuzzy-match adjacent addresses');
    await page.locator('#archive-search').fill('02:00:00:00:00:88');
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 1);
    assert.equal(await page.locator('#archive-list > li').getAttribute('data-device-key'), 'archive-shared-new');
    await page.locator('#archive-search').fill('');
    await page.locator('#archive-filter').selectOption('missing');
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 5);
    await page.locator('#archive-filter').selectOption('review');
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 4);
    assert.equal(await page.locator('#archive-list > li[data-device-key="archive-self"]').count(), 0, 'the local computer does not need review');
    assert.equal(await page.locator('#archive-list > li[data-device-key="archive-known"]').count(), 0);
    assert.equal(await page.locator('#archive-list > li[data-device-key="archive-ignored"]').count(), 0);
    const hostile = page.locator('#archive-list > li[data-device-key="archive-hostile"]');
    assert.ok((await hostile.innerText()).includes(hostileName));
    await hostile.locator('summary').click();
    assert.ok((await hostile.innerText()).includes(hostileNotes), 'saved notes are readable as literal text');
    assert.equal(await hostile.locator('img[src=x], svg[onload], [onerror], script').count(), 0, 'untrusted archive strings never become HTML');
    assert.equal(await page.evaluate(() => window.archiveInjected), undefined);
    await page.locator('#archive-search').fill('zzzz-no-synthetic-match-qqqq');
    await page.locator('#archive-empty').waitFor({ state: 'visible' });
    await page.locator('#archive-search').fill('');
    await page.locator('#archive-filter').selectOption('all');
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 50);
    await page.screenshot({ path: path.join(images, 'netspace-device-archive.png') });
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the archive must fit a 320 px screen');
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'archive rows and controls wrap inside the dialog');
    for (const id of ['archive-network', 'archive-search', 'archive-filter', 'archive-refresh']) {
      assert.equal(await page.locator('#' + id).isVisible(), true, id + ' remains readable on narrow screens');
      assert.equal(await page.locator('#' + id).evaluate(element => element.getBoundingClientRect().width > 60), true, id + ' has a usable width');
    }
    await page.screenshot({ path: path.join(images, 'netspace-device-archive-320.png') });
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'archive-open', 'Escape restores keyboard focus to the archive entry');
    assert.equal(await page.locator('#device-list').innerText(), currentBefore, 'saved records never replace the current discovery result');
    assert.equal(await page.locator('#detail-ip').innerText(), selectedBefore, 'archive browsing never changes the selected current device');
    await page.setViewportSize({ width: 1600, height: 1100 });

    // A delayed network B read cannot replace a newer selection of network A.
    await page.locator('#archive-open').click();
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 50);
    const lateNetwork = planRead('/api/devices', networkB, { hold: true });
    await page.locator('#archive-network').selectOption(networkB);
    await awaitRead(lateNetwork);
    await page.locator('#archive-network').selectOption(networkA);
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 50);
    lateNetwork.release();
    await page.waitForTimeout(120);
    assert.equal(await page.locator('#archive-network').inputValue(), networkA);
    assert.equal(await page.locator('#archive-list > li[data-device-key="archive-network-b"]').count(), 0, 'an old network response cannot leak into the newer catalogue');
    assert.equal(await page.locator('#archive-list > li').count(), 50);

    // Reopening starts a new view even when a read from the previous opening is pending.
    const lateClosed = planRead('/api/devices', networkB, { hold: true });
    await page.locator('#archive-network').selectOption(networkB);
    await awaitRead(lateClosed);
    await page.locator('#archive-close').click();
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'archive-open');
    records.set(networkB, [record('archive-network-b-new', { hostname: '重新打开后读取的虚构设备', ip: '192.0.2.88' })]);
    await page.locator('#archive-open').click();
    await page.waitForFunction(() => document.querySelector('#archive-network').value === 'test-network-A' && document.querySelectorAll('#archive-list > li').length === 50);
    await page.locator('#archive-network').selectOption(networkB);
    await page.locator('#archive-list > li[data-device-key="archive-network-b-new"]').waitFor();
    lateClosed.release();
    await page.waitForTimeout(120);
    assert.equal(await page.locator('#archive-list > li').count(), 1);
    assert.equal(await page.locator('#archive-list > li').getAttribute('data-device-key'), 'archive-network-b-new', 'a previous opening cannot overwrite fresh records from the same network');
    assert.equal(await page.locator('#device-list').innerText(), currentBefore);
    assert.equal(await page.locator('#detail-ip').innerText(), selectedBefore);
    await page.locator('#archive-dismiss').click();
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'archive-open');

    // Read failures are local to the archive, and explicit refresh retries the selected network.
    await page.locator('#archive-open').click();
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 50);
    const failedRead = planRead('/api/devices', networkB, { status: 503, json: { error: '虚构读取失败，请刷新重试' } });
    await page.locator('#archive-network').selectOption(networkB);
    await awaitRead(failedRead);
    await page.locator('#archive-error').filter({ hasText: '虚构读取失败' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#archive-list > li').count(), 0, 'a failed network read cannot retain another network’s rows');
    await page.locator('#archive-refresh').click();
    await page.locator('#archive-list > li[data-device-key="archive-network-b-new"]').waitFor();
    assert.equal(await page.locator('#archive-error').isVisible(), false, 'successful refresh clears the old error');

    // Data cleanup updates arrive through the real state polling path. Old device and
    // catalogue responses are deliberately released after each new revision is visible.
    await page.locator('#archive-network').selectOption(networkA);
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 50);
    await page.locator('#archive-search').fill('Studio');
    await page.locator('#archive-filter').selectOption('missing');
    await page.waitForFunction(() => document.querySelectorAll('#archive-list > li').length === 1);
    const deletedNetworkRead = planRead('/api/devices', networkB, { hold: true });
    await page.locator('#archive-network').selectOption(networkB);
    await awaitRead(deletedNetworkRead);
    catalogue = catalogue.filter(network => network.id !== networkB);
    records.set(networkB, []); revision = 1;
    await page.waitForFunction(() => document.querySelector('#archive-network').value === 'test-network-A' && !document.querySelector('#archive-network option[value="test-network-B"]') && document.querySelectorAll('#archive-list > li').length === 50, null, { timeout: 10000 });
    assert.equal(await page.locator('#archive-search').inputValue(), '', 'a new data revision clears stale search state');
    assert.equal(await page.locator('#archive-filter').inputValue(), 'all', 'a new data revision clears stale filter state');
    deletedNetworkRead.release();
    await page.waitForTimeout(120);
    assert.equal(await page.locator('#archive-list > li[data-device-key="archive-network-b-new"]').count(), 0, 'late deleted-network data stays invalid after cleanup');

    const deletedCatalogueRead = planRead('/api/networks', undefined, { hold: true });
    await page.locator('#archive-refresh').click();
    await awaitRead(deletedCatalogueRead);
    catalogue = []; records.set(networkA, []); live = null; revision = 2;
    await page.waitForFunction(() => !document.querySelector('#archive-network option[value="test-network-A"]') && document.querySelectorAll('#archive-list > li').length === 0 && !document.querySelector('#archive-empty').hidden && document.querySelector('#archive-summary').textContent.includes('共 0 条档案'), null, { timeout: 10000 });
    deletedCatalogueRead.release();
    await page.waitForTimeout(120);
    assert.equal(await page.locator('#archive-network option[value="test-network-A"]').count(), 0, 'a late old catalogue cannot resurrect a deleted network');
    assert.equal(await page.locator('#archive-list > li').count(), 0);
    await page.locator('#archive-empty').waitFor({ state: 'visible' });
    assert.equal(await dialog.isVisible(), true, 'cleanup leaves the archive available for an honest empty state');
    await page.locator('#archive-close').click();
    await page.locator('#demo-toggle').click();
    assert.equal(await page.locator('#archive-open').isDisabled(), true, 'demo mode cannot read real saved records');
    assert.equal(await dialog.isVisible(), false);
    assert.deepEqual(posts, [], 'archive actions cannot scan, check, delete, or edit saved data');
    assert.deepEqual(external, [], 'fixtures block all external URLs');
    assert.deepEqual(unexpectedApi, []);
    assert.deepEqual(errors, []);
    console.log('Saved-device archive UI passed: manual reads, stable saved identities, bounded rows, safe notes, fuzzy names/exact addresses, filters, late-network and reopened-dialog isolation, errors/retry, cleanup revision invalidation, read-only state and 320 px layout; all APIs mocked, no scans or target connections.');
  } finally { for (const plan of controlledReads) plan.release(); if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
