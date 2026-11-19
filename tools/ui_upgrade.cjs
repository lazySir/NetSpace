// Isolated browser fixtures verify the 1.1 workflow without discovering the LAN.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../.tools/qa/node_modules/playwright');
const base = process.env.NETSPACE_URL || 'http://127.0.0.1:8767';
const output = path.resolve(__dirname, '../artifacts');
const adapters = [
  { id: '9', alias: 'Ethernet', ip: '192.168.50.20', gateway: '192.168.50.1', cidr: '192.168.50.0/24', scanCidr: '192.168.50.0/24' },
  { id: '10', alias: 'Wi-Fi', ip: '192.168.60.20', gateway: '192.168.60.1', cidr: '192.168.60.0/24', scanCidr: '192.168.60.0/24' },
];
const blank = () => ({ alias: '', notes: '', group: '', known: false, ignored: false });
function snapshot(adapter, networkId, scanId, historical = false) {
  const devices = [
    { id: adapter.gateway, deviceKey: 'gateway', ip: adapter.gateway, hostname: 'ROUTER-FACTUAL', kind: 'gateway', mac: '02:00:00:00:00:01', status: 'resolved', profile: blank(), firstSeen: '2026-11-18T09:00:00Z', lastSeen: '2026-11-19T02:00:00Z', evidence: ['arp'] },
    { id: adapter.ip, deviceKey: 'workstation', ip: adapter.ip, hostname: historical ? 'HISTORICAL-PC' : 'WORKSTATION', kind: 'self', mac: '02:00:00:00:00:20', status: 'online', profile: blank(), firstSeen: '2026-11-18T09:00:00Z', lastSeen: '2026-11-19T02:00:00Z', evidence: ['self'] },
  ];
  return { networkId, scanId, interface: adapter, devices, links: [{ source: devices[0].id, target: devices[1].id }], scannedAt: historical ? '2026-11-18T09:00:00Z' : '2026-11-19T02:00:00Z', durationMs: 120, scope: { cidr: adapter.cidr, scanCidr: adapter.cidr }, warnings: [] };
}
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.NETSPACE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce', acceptDownloads: true });
    await context.addInitScript(() => {
      let permission = 'default';
      window.desktopNotifications = [];
      window.notificationPermissionRequests = 0;
      window.setNotificationPermission = value => { permission = value; };
      window.Notification = class {
        static get permission() { return permission; }
        static requestPermission() {
          window.notificationPermissionRequests++;
          permission = window.notificationPermissionOutcome || 'granted';
          return Promise.resolve(permission);
        }
        constructor(title, options = {}) {
          if (permission !== 'granted') throw new Error('notifications are not permitted');
          window.desktopNotifications.push({ title, body: options.body || '', tag: options.tag || '' });
          this.close = () => {};
        }
      };
    });
    const page = await context.newPage();
    const errors = [], external = [], posts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base + '/')) external.push(request.url()); });
    const a = snapshot(adapters[0], 'network-A', 2), b = snapshot(adapters[1], 'network-B', 3), old = snapshot(adapters[0], 'network-A', 1, true);
    let live = a, failSave = false, stateReads = 0, delayHistory = false, availableAdapters = adapters;
    let releaseEvents = null, releaseMonitor = null, releaseOldState = null, holdNextEvents = false, holdNextMonitor = false, holdNextState = false;
    let monitor = { enabled: false, interfaceId: null, intervalSeconds: 300, nextScanAt: null, error: null, notificationsEnabled: true };
    const events = [{ id: 11, networkId: 'network-A', scanId: 2, deviceKey: 'workstation', kind: 'new', ip: a.interface.ip, previousIp: null, name: '<svg onload=alert(1)>新设备', occurredAt: a.scannedAt, read: false, notify: true }];
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()), body = req.method() === 'POST' ? req.postDataJSON() : null;
      if (url.pathname === '/api/history/1' && delayHistory) await new Promise(resolve => setTimeout(resolve, 900));
      if (body) posts.push({ path: url.pathname, body });
      let json;
      if (url.pathname === '/api/interfaces') json = { interfaces: availableAdapters, error: null };
      else if (url.pathname === '/api/state') {
        stateReads++; json = { status: 'complete', result: live, error: null, monitor };
        if (holdNextState) {
          holdNextState = false;
          json = { ...json, result: { ...live, devices: live.devices.map(device => device.deviceKey === 'gateway' ? { ...device, profile: blank() } : device) } };
          await new Promise(resolve => { releaseOldState = resolve; });
        }
      }
      else if (url.pathname === '/api/networks') json = { networks: [a, b].map(result => ({ id: result.networkId, label: result.interface.alias, cidr: result.interface.cidr, gateway: result.interface.gateway, lastSeen: result.scannedAt, deviceCount: 2 })) };
      else if (url.pathname === '/api/history') { const networkId = url.searchParams.get('networkId') || 'network-A'; json = { scans: (networkId === 'network-A' ? [a, old] : [b]).map(result => ({ id: result.scanId, networkId, scannedAt: result.scannedAt, deviceCount: 2, changeCount: 1, durationMs: 120 })) }; }
      else if (url.pathname === '/api/history/1') json = { result: old };
      else if (url.pathname === '/api/history/2') json = { result: a };
      else if (url.pathname === '/api/history/3') json = { result: b };
      else if (url.pathname === '/api/devices') json = { devices: (url.searchParams.get('networkId') === 'network-B' ? b : a).devices.map(device => ({ ...device, present: true })) };
      else if (url.pathname === '/api/profile') {
        if (failSave) return route.fulfill({ status: 500, json: { error: '档案暂时无法写入，请重试。' } });
        const result = body.networkId === 'network-B' ? b : a, device = result.devices.find(item => item.deviceKey === body.deviceKey);
        assert.ok(device, 'profile must use network-scoped stable device key');
        device.profile = Object.fromEntries(['alias', 'notes', 'group', 'known', 'ignored'].map(key => [key, body[key]]));
        json = { profile: device.profile };
      } else if (url.pathname === '/api/monitor') {
        if (body) { if (body.enabled) assert.equal(body.interfaceId, '9'); monitor = { ...monitor, ...body, nextScanAt: body.enabled === false ? null : '2026-11-19T03:00:00Z' }; }
        json = { ...monitor };
        if (!body && holdNextMonitor) { holdNextMonitor = false; await new Promise(resolve => { releaseMonitor = resolve; }); }
      } else if (url.pathname === '/api/events/read') { let updated = 0; for (const event of events) if (body.allUnread ? event.networkId === body.networkId && !event.read : body.eventIds.includes(event.id)) { event.read = true; updated++; } json = { updated }; }
      else if (url.pathname === '/api/events') {
        const filtered = events.filter(event => event.networkId === (url.searchParams.get('networkId') || 'network-A'));
        json = { events: filtered.slice(0, 50).map(event => ({ ...event })), unreadCount: filtered.filter(event => !event.read && event.notify).length, notificationsEnabled: monitor.notificationsEnabled };
        if (holdNextEvents) { holdNextEvents = false; await new Promise(resolve => { releaseEvents = resolve; }); }
      }
      else if (url.pathname === '/api/scan') { live = body.interfaceId === '10' ? b : a; json = { status: 'complete', result: live, error: null, monitor }; }
      else return route.fulfill({ status: 404, json: { error: 'fixture path missing ' + url.pathname } });
      return route.fulfill({ json });
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => window.notificationPermissionRequests), 0, 'page load must not request desktop notification permission');
    await page.locator('#desktop-notifications-toggle').waitFor();
    assert.equal(await page.locator('#desktop-notifications-toggle').innerText(), '启用桌面提醒');
    await page.locator('#needs-review-filter').check();
    assert.equal(await page.locator('#device-list button').count(), 1, 'review queue should contain the unreviewed gateway while excluding the local computer');
    await page.locator('#needs-review-filter').uncheck();
    await page.locator('#device-list button').first().click();
    await page.locator('#profile-alias').waitFor({ state: 'visible', timeout: 1800 });
    assert.equal(await page.locator('#monitor-interval').count(), 1, 'monitor toolbar must exist');
    await page.locator('#profile-alias').fill('<img src=x onerror=alert(1)>我的路由器');
    await page.locator('#profile-notes').fill('客厅机柜，保留原始主机名称');
    await page.locator('#profile-group').fill('家庭设备');
    await page.locator('#profile-known').check();
    await page.locator('#profile-save').click();
    await page.waitForFunction(() => document.querySelector('#profile-status').textContent.includes('已保存'));
    assert.equal(await page.locator('#device-group-filter option').filter({ hasText: '家庭设备' }).count(), 1, 'saving a profile should add its group to the live filter');
    await page.locator('#device-group-filter').selectOption({ label: '家庭设备' });
    assert.equal(await page.locator('#device-list button').count(), 1, 'saving a profile group should make the device filterable immediately');
    await page.locator('#device-group-filter').selectOption('');
    await page.locator('#needs-review-filter').check();
    assert.equal(await page.locator('#device-list button').count(), 0, 'marking the gateway as known should remove it from the review queue');
    await page.locator('#needs-review-filter').uncheck();
    assert.ok((await page.locator('#device-list').innerText()).includes('<img src=x onerror=alert(1)>我的路由器'));
    assert.equal(await page.locator('#device-list img').count(), 0, 'alias must render as safe text');
    assert.equal(await page.locator('#detail-hostname').innerText(), 'ROUTER-FACTUAL', 'alias must not replace factual hostname');
    await page.waitForFunction(() => document.querySelector('#scene-labels').textContent.includes('我的路由器'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#device-list button').first().click();
    assert.equal(await page.locator('#profile-group').inputValue(), '家庭设备', 'saved profile must survive a reload');
    await page.locator('#profile-group').fill('办公设备');
    await page.locator('#profile-save').click();
    await page.waitForFunction(() => document.querySelector('#profile-status').textContent.includes('已保存'));
    assert.equal(await page.locator('#device-group-filter option').filter({ hasText: '办公设备' }).count(), 1, 'changing a saved group should add its new filter option');
    assert.equal(await page.locator('#device-group-filter option').filter({ hasText: '家庭设备' }).count(), 0, 'changing a saved group should remove its unused old option');
    await page.locator('#profile-group').fill('');
    await page.locator('#profile-save').click();
    await page.waitForFunction(() => document.querySelector('#profile-status').textContent.includes('已保存'));
    assert.equal(await page.locator('#device-group-filter option').filter({ hasText: '办公设备' }).count(), 0, 'clearing a saved group should remove its unused option');
    await page.locator('#device-group-filter').selectOption('ungrouped');
    assert.equal(await page.locator('#device-list button').count(), 2, 'cleared live profiles should appear in the ungrouped filter');
    await page.locator('#device-group-filter').selectOption('');
    const externalReads = stateReads;
    live = { ...a, scanId: 4, devices: a.devices.map(device => device.kind === 'self' ? { ...device, hostname: 'EXTERNAL-MANUAL-PC' } : device) };
    await page.waitForFunction(() => document.querySelector('#device-list').textContent.includes('EXTERNAL-MANUAL-PC'), null, { timeout: 4500 });
    assert.ok(stateReads > externalReads, 'an external manual completion must be observed with monitoring disabled');
    live = a;
    holdNextState = true;
    for (let retry = 0; !releaseOldState && retry < 40; retry++) await page.waitForTimeout(100);
    assert.ok(releaseOldState, 'fixture must hold an old profile snapshot');
    await page.locator('#profile-alias').fill('saved alias');
    await page.locator('#profile-save').click();
    await page.waitForFunction(() => document.querySelector('#profile-status').textContent.includes('已保存'));
    releaseOldState(); releaseOldState = null;
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#profile-alias').inputValue(), 'saved alias', 'a stale in-flight state response must not undo a saved profile');
    await page.locator('#profile-notes').fill('second edit after stale response');
    await page.locator('#profile-save').click();
    await page.waitForFunction(() => document.querySelector('#profile-status').textContent.includes('已保存'));
    assert.equal(posts.filter(post => post.path === '/api/profile').at(-1).body.alias, 'saved alias', 'a later field edit must preserve a profile saved before a stale response');
    await page.evaluate(() => {
      window.newDeviceToasts = 0;
      new MutationObserver(() => { if (document.querySelector('#toast').textContent.includes('台新设备')) window.newDeviceToasts++; }).observe(document.querySelector('#toast'), { childList: true, subtree: true, characterData: true });
    });
    await page.locator('#profile-alias').fill('未保存的草稿');
    await page.locator('#monitor-interval').selectOption('60');
    await page.locator('#monitor-toggle').click();
    await page.waitForFunction(() => document.querySelector('#monitor-toggle').textContent.includes('停止'));
    const readsBefore = stateReads;
    await page.waitForTimeout(3600);
    assert.ok(stateReads > readsBefore, 'running monitor must observe server completions');
    assert.equal(await page.locator('#profile-alias').inputValue(), '未保存的草稿', 'background polling must preserve dirty input');
    assert.equal(await page.evaluate(() => window.newDeviceToasts), 0, 'polling the same event must not repeat a notification');
    await page.locator('#mute-toggle').click();
    await page.waitForFunction(() => document.querySelector('#mute-toggle').getAttribute('aria-pressed') === 'true');
    assert.equal(monitor.notificationsEnabled, false);
    await page.locator('#monitor-toggle').click();
    failSave = true;
    await page.locator('#profile-save').click();
    await page.locator('#profile-status').filter({ hasText: '暂时无法写入' }).waitFor();
    assert.equal(await page.locator('#profile-alias').inputValue(), '未保存的草稿', 'save failure must keep user input');
    failSave = false;
    await page.locator('#tab-events').click();
    await page.locator('#event-list').filter({ hasText: '新设备' }).waitFor();
    assert.equal(await page.locator('#event-list svg').count(), 0, 'event name must render as safe text');
    assert.equal(await page.locator('#unread-count').innerText(), '1');
    await page.locator('#events-read').click();
    await page.waitForFunction(() => document.querySelector('#unread-count').textContent === '0');
    assert.deepEqual(posts.find(post => post.path === '/api/events/read').body, { networkId: 'network-A', allUnread: true });
    events.unshift({ ...events[0], id: 12, read: false, name: '家庭打印机', deviceKey: 'printer' });
    await page.waitForTimeout(3300);
    assert.equal(await page.evaluate(() => window.newDeviceToasts), 0, 'muted new events must be recorded without a toast');
    assert.equal(await page.locator('#unread-count').innerText(), '1');
    await page.locator('#mute-toggle').click();
    await page.waitForTimeout(3300);
    assert.equal(await page.evaluate(() => window.newDeviceToasts), 1, 'an unread new device should notify once when reminders resume');
    await page.waitForTimeout(3300);
    assert.equal(await page.evaluate(() => window.newDeviceToasts), 1, 'new-device notification must stay deduplicated across repeated event refreshes');
    await page.locator('#events-read').click();
    const toastCount = await page.evaluate(() => window.newDeviceToasts);
    holdNextEvents = true;
    for (let retry = 0; !releaseEvents && retry < 60; retry++) await page.waitForTimeout(100);
    assert.ok(releaseEvents, 'fixture must hold an event response before mute');
    events.unshift({ ...events[0], id: 13, read: false, name: '异步变化中的新设备', deviceKey: 'late-device' });
    await page.locator('#mute-toggle').click();
    await page.waitForFunction(() => document.querySelector('#mute-toggle').getAttribute('aria-pressed') === 'true');
    releaseEvents(); releaseEvents = null;
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#mute-toggle').getAttribute('aria-pressed'), 'true', 'stale event GET cannot reverse a newer mute');
    assert.equal(await page.evaluate(() => window.newDeviceToasts), toastCount, 'stale event GET cannot notify after a successful mute');
    holdNextMonitor = true;
    for (let retry = 0; !releaseMonitor && retry < 60; retry++) await page.waitForTimeout(100);
    assert.ok(releaseMonitor, 'fixture must hold the monitor GET');
    await page.locator('#mute-toggle').click();
    await page.waitForFunction(() => document.querySelector('#mute-toggle').getAttribute('aria-pressed') === 'false');
    releaseMonitor(); releaseMonitor = null;
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#mute-toggle').getAttribute('aria-pressed'), 'false', 'stale monitor GET cannot reverse the newer unmute');
    events.length = 0;
    for (let index = 0; index < 51; index++) events.push({ id: 100 + index, networkId: 'network-A', scanId: 2, deviceKey: 'device-' + index, kind: 'new', ip: '192.168.50.' + (index + 2), name: '未读设备 ' + index, occurredAt: a.scannedAt, read: false, notify: true });
    events.push({ ...events[0], id: 999, networkId: 'network-B' });
    await page.waitForFunction(() => document.querySelector('#unread-count').textContent === '51', null, { timeout: 5000 });
    assert.equal(await page.locator('#event-list li').count(), 50);
    await page.locator('#events-read').click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#unread-count').innerText(), '0', 'mark-read must clear all51 unread records, including the hidden oldest record');
    assert.equal(events.find(event => event.id === 999).read, false, 'mark-read must preserve unread events belonging to another network');
    await page.locator('#tab-history').click();
    delayHistory = true;
    await page.locator('#history-scan').selectOption('1');
    await page.locator('#network-filter').selectOption('network-B');
    await page.waitForFunction(() => document.querySelector('#history-scan option[value="3"]'));
    assert.equal(await page.locator('#history-scan').isDisabled(), false, 'switching networks during replay loading must enable the new network history');
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('#replay-banner').isVisible(), false, 'late historical response must not reopen another network replay');
    delayHistory = false;
    await page.locator('#network-filter').selectOption('network-A');
    await page.waitForFunction(() => document.querySelector('#history-scan option[value="1"]'));
    await page.locator('#history-scan').selectOption('1');
    await page.locator('#replay-banner').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#profile-save').isDisabled(), true);
    assert.equal(await page.locator('#monitor-toggle').isDisabled(), true);
    assert.ok((await page.locator('#device-list').innerText()).includes('HISTORICAL-PC'));
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-button').click();
    const download = await downloadPromise;
    const exportPath = path.join(output, 'history-export.json'); await download.saveAs(exportPath);
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    assert.equal(exported.source, 'local-network-history'); assert.equal(exported.historical, true); assert.equal(exported.scanId, 1);
    live = { ...a, scannedAt: '2026-11-19T02:10:00Z' }; monitor.enabled = true;
    await page.waitForTimeout(3600);
    assert.ok((await page.locator('#device-list').innerText()).includes('HISTORICAL-PC'), 'background completion must not replace replay');
    await page.locator('#return-current').click();
    await page.locator('#replay-banner').waitFor({ state: 'hidden' });
    assert.ok((await page.locator('#device-list').innerText()).includes('WORKSTATION'));
    await page.evaluate(() => { window.notificationPermissionOutcome = 'denied'; });
    await page.locator('#desktop-notifications-toggle').click();
    await page.waitForFunction(() => document.querySelector('#desktop-notifications-toggle').textContent.includes('系统已阻止'));
    assert.equal(await page.evaluate(() => window.notificationPermissionRequests), 1, 'denied permission must be requested only after a click');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('未获桌面提醒权限'));
    await page.evaluate(() => {
      window.setNotificationPermission('default');
      window.notificationPermissionOutcome = 'granted';
    });
    await page.waitForFunction(() => !document.querySelector('#desktop-notifications-toggle').disabled, null, { timeout: 5000 });
    await page.locator('#desktop-notifications-toggle').click();
    await page.waitForFunction(() => document.querySelector('#desktop-notifications-toggle').textContent.includes('已开启'));
    assert.equal(await page.evaluate(() => window.notificationPermissionRequests), 2, 'permission must be requested only after an explicit click');
    events.unshift({ ...events[0], id: 1001, networkId: 'network-A', read: false, notify: true, name: '<script>私人设备</script>', ip: '192.168.50.222' });
    await page.waitForFunction(() => window.desktopNotifications.length === 1, null, { timeout: 5000 });
    const notification = await page.evaluate(() => window.desktopNotifications[0]);
    assert.equal(notification.title, 'NetSpace · 网络变化');
    assert.equal(notification.body, '发现 1 台新设备。打开应用查看变化记录。');
    assert.equal(notification.tag, 'netspace-new-devices');
    assert.equal(JSON.stringify(notification).includes('192.168.50.222'), false, 'desktop notification must not expose device IP');
    assert.equal(JSON.stringify(notification).includes('私人设备'), false, 'desktop notification must not expose device names');
    await page.waitForTimeout(3300);
    assert.equal(await page.evaluate(() => window.desktopNotifications.length), 1, 'polling must not repeat a desktop notification for the same event');
    const fallbackCount = await page.evaluate(() => window.newDeviceToasts);
    await page.evaluate(() => window.setNotificationPermission('denied'));
    await page.waitForFunction(() => document.querySelector('#desktop-notifications-toggle').textContent.includes('系统已阻止'));
    events.unshift({ ...events[0], id: 1002, networkId: 'network-A', read: false, notify: true, name: '安全测试设备', ip: '192.168.50.223' });
    await page.waitForFunction(count => window.newDeviceToasts > count, fallbackCount, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.desktopNotifications.length), 1, 'denied permission must fall back to the in-page toast');
    await page.locator('#demo-toggle').click();
    await page.locator('#demo-banner').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#profile-save').isDisabled(), true); assert.equal(await page.locator('#monitor-toggle').isDisabled(), true);
    const postCount = posts.length, count = await page.locator('#stat-total').innerText();
    await page.waitForTimeout(3600);
    assert.equal(await page.locator('#stat-total').innerText(), count, 'background completion must not replace demo');
    assert.equal(posts.length, postCount, 'demo must not create profiles, monitor changes, or events');
    await page.locator('#leave-demo').click();
    await page.locator('#network-filter').selectOption('network-B');
    await page.waitForFunction(() => document.querySelector('#history-scan option[value="3"]'));
    assert.equal(await page.locator('#history-scan option[value="1"]').count(), 0, 'history must be isolated by network');
    await page.locator('#history-scan').selectOption('3');
    await page.waitForFunction(() => document.querySelector('#stat-cidr').textContent.includes('192.168.60'));
    assert.equal((await page.locator('#device-list').innerText()).includes('192.168.50'), false);
    await page.locator('#return-current').click();
    await page.locator('#network-filter').selectOption('network-A');
    await page.locator('#tab-devices').click();
    await page.locator('#profile-alias').fill('我的路由器');
    await page.locator('#profile-save').click();
    await page.waitForFunction(() => document.querySelector('#profile-status').textContent.includes('已保存'));
    if (monitor.enabled) await page.locator('#monitor-toggle').click();
    await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(output, 'netspace-1.1-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 900 });
    await page.locator('#tab-history').click();
    await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(output, 'netspace-1.1-mobile.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '375px layout must not overflow');
    await page.locator('#tab-history').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-events', 'tabs need keyboard navigation');
    availableAdapters = [];
    monitor = { ...monitor, enabled: true, interfaceId: '9', nextScanAt: '2026-11-19T03:00:00Z' };
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#monitor-status').textContent.includes('运行中'));
    assert.equal(await page.locator('#monitor-toggle').isDisabled(), false, 'active monitoring must remain stoppable after every adapter disconnects');
    await page.locator('#monitor-toggle').click();
    await page.waitForFunction(() => document.querySelector('#monitor-status').textContent.includes('尚未开启'));
    assert.deepEqual(posts.filter(post => post.path === '/api/monitor').at(-1).body, { enabled: false }, 'stopping must not submit an unavailable interface');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(JSON.stringify({ result: 'PASS', checks: ['profile persistence and safe text', 'dirty form survives polling', 'explicit save failure', 'monitor interval/start/stop/mute', 'event read/unread', 'explicit desktop notification permission', 'privacy-safe notification content and deduplication', 'history network isolation', 'historical export', 'demo/replay isolation', '375px and keyboard'], screenshots: output }));
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
