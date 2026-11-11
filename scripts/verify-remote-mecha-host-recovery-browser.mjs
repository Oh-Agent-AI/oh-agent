#!/usr/bin/env node
// Real RemoteApp and client with a synthetic WebSocket; no user data or live relay.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { deploymentGatewayFixture } from '../apps/agent-city/ui/tests/remote-deployment-gateway-fixture.ts';
const { chromium } = createRequire(new URL('../apps/desktop/ui-dev/package.json', import.meta.url))('playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:52971';
const snapshot = deploymentGatewayFixture().messages[0].result.value;
const output = 'artifacts/mecha-clarity-p0/remote-host-recovery-synthetic-2026-11-03';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal'] });
try {
  for (const [locale, width, height] of [['zh-CN', 1100, 700], ['en-US', 390, 844]]) {
    const context = await browser.newContext({ locale, viewport: { width, height } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ snapshot }) => {
      window.fixtureHostOnline = true;
      class SyntheticSocket extends EventTarget {
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        send(data) {
          const request = JSON.parse(data);
          const result = window.fixtureHostOnline ? { ok: true, value: snapshot } : { ok: false, error: { code: 'host_offline' } };
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
            protocol: 'app-remote:v1', appId: 'city', sessionId: 'm1', capability: 'mecha:v2',
            type: 'response', requestId: request.requestId, result,
          }) })));
        }
        close() {}
      }
      window.WebSocket = SyntheticSocket;
    }, { snapshot });
    await page.goto(`${base}/remote.html?match=m1&ws=${encodeURIComponent('ws://synthetic.invalid')}&capability=mecha%3Av2`);
    const zh = locale.startsWith('zh');
    const online = page.getByRole('button', { name: zh ? '在线' : 'Online', exact: true });
    const retry = page.getByRole('button', { name: zh ? '重新同步' : 'Sync again', exact: true });
    const cells = page.locator('.remote-row button.deployable');
    await online.waitFor(); await cells.first().waitFor();
    assert.equal(await cells.first().isDisabled(), false);
    await cells.first().click();
    await page.evaluate(() => { window.fixtureHostOnline = false; });
    await online.click();
    await retry.waitFor();
    await page.getByText(zh ? '已连接中继，但电脑端暂不可用；正在自动重试，操作已暂停。' : 'Relay connected, but the host is unavailable. Retrying automatically; input is paused.').waitFor();
    assert.equal(await cells.first().isDisabled(), true);
    assert.match(await page.locator('.remote-deployment [role="status"]').first().textContent(), /1\/3/);
    const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    assert.ok(geometry.document <= geometry.viewport, `horizontal overflow: ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: `${output}/${locale}-${width}.png`, fullPage: true });
    await page.evaluate(() => { window.fixtureHostOnline = true; });
    await online.waitFor({ timeout: 8000 });
    assert.equal(await cells.first().isDisabled(), false);
    assert.match(await page.locator('.remote-deployment [role="status"]').first().textContent(), /1\/3/);
    assert.deepEqual(errors, []);
    console.log(`PASS RemoteApp host offline/recovery ${locale} ${width}x${height}`);
    await context.close();
  }
} finally { await browser.close(); }
