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
function resultFor(adapter, count = 3) {
  const prefix = adapter.ip.slice(0, adapter.ip.lastIndexOf('.') + 1);
  const devices = [
    { id: adapter.ip, ip: adapter.ip, hostname: 'WORKSTATION', mac: adapter.mac, kind: 'self', status: 'online', evidence: ['本机已连接的 IPv4 网络接口'], latencyMs: null },
    { id: adapter.gateway, ip: adapter.gateway, hostname: null, mac: '02:00:00:00:00:01', kind: 'gateway', status: 'resolved', evidence: ['本次地址解析成功，可能来自系统缓存，不保证当前在线'], latencyMs: .8 },
  ];
  for (let index = 2; index < count; index++) {
    const ip = prefix + (index + 40);
    devices.push({ id: ip, ip, hostname: index === 2 ? 'DESKTOP-LAB' : null, mac: '02:00:00:00:' + index.toString(16).padStart(2, '0') + ':42', kind: 'device', status: index % 2 ? 'cached' : 'resolved', evidence: ['设备地址解析记录'], latencyMs: 1.2 });
  }
  return { interface: adapter, devices, links: devices.filter(x => x.id !== adapter.gateway).map(x => ({ source: adapter.gateway, target: x.id, kind: 'same-subnet', inferred: true })), warnings: [], scannedAt: '2026-11-19T10:20:30+08:00', durationMs: 19000, scope: { cidr: adapter.cidr, scanCidr: adapter.scanCidr, targetCount: 253, limited: false } };
}
async function run() {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base + '/')) external.push(request.url()); });
  let current = { status: 'idle', progress: { phase: 'idle', completed: 0, total: 0, message: '准备就绪' }, result: null, error: null };
  await page.route('**/api/interfaces', route => route.fulfill({ json: { interfaces, error: null } }));
  await page.route('**/api/state', route => route.fulfill({ json: current }));
  await page.route('**/api/scan', async route => {
    const adapter = interfaces.find(x => x.id === route.request().postDataJSON().interfaceId);
    current = { status: 'complete', progress: { phase: 'complete', completed: 253, total: 253, message: '设备发现完成' }, result: resultFor(adapter), error: null };
    await route.fulfill({ status: 202, json: current });
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#stat-total').filter({ hasText: '3' }).waitFor();
  await page.locator('#device-list button').first().click();
  await page.locator('#detail-content').waitFor({ state: 'visible' });
  assert.equal(await page.locator('canvas').count() > 0, true);
  assert.equal(await page.locator('#rotate-button').getAttribute('aria-pressed'), 'false');
  await page.screenshot({ path: path.join(output, 'netspace-real-layout.png'), fullPage: true });
  await page.locator('#device-search').fill('192.168.50.42');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#device-list button').count(), 1, 'search should filter devices');
  await page.locator('#device-search').fill('');
  await page.locator('#demo-toggle').click();
  await page.locator('#demo-banner').waitFor({ state: 'visible' });
  assert.ok(Number(await page.locator('#stat-total').innerText()) > 3);
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
  await page.locator('#interface-select').selectOption('10');
  await page.locator('#scan-button').click();
  await page.waitForFunction(() => document.querySelector('#stat-cidr').textContent.includes('192.168.60'));
  assert.equal(await page.locator('#device-list').innerText().then(x => x.includes('192.168.50.')), false, 'old adapter devices must not leak');
  await page.locator('#reset-button').click();
  await page.locator('#rotate-button').click();
  assert.equal(await page.locator('#rotate-button').getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 375, height: 900 });
  await page.screenshot({ path: path.join(output, 'netspace-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile layout must not overflow horizontally');
  assert.deepEqual(errors, [], 'browser must have no JavaScript runtime errors');
  assert.deepEqual(external, [], 'app must not require any external resources');
  console.log(JSON.stringify({ result: 'PASS', checks: ['real layout', 'node selection', 'search', 'demo isolation', 'marked export', 'adapter switching', 'camera controls', '375px responsive', 'reduced motion', 'offline assets'], screenshots: output }));
  await browser.close();
}
run().catch(error => { console.error(error); process.exitCode = 1; });
