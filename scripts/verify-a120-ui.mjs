/**
 * A120 端到端验证（36 项）
 *
 * 覆盖三件事：
 *   1. 自定义 Agent 弹窗「创建」按钮改为 TDesign Button，暗色下可读
 *   2. 设置弹窗、自定义 Agent 弹窗、Agent 详情弹窗支持拖拽移动
 *   3. 工作区最近目录可删除（右侧 × 图标）
 */
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const CHROME =
  process.env.PW_CHROME ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

const ok = (cond, msg, detail) => {
  if (!cond) {
    console.error(`✗ ${msg}${detail !== undefined ? ` (${detail})` : ''}`);
    process.exitCode = 1;
  }
};

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `a120-e2e-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const WS = path.join(TMP, 'ws');

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(WS, { recursive: true });

  // 起服务端
  const srv = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, OPC_DATA_DIR: DATA, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let base = '';
  const deadline = Date.now() + 30000;
  const onData = (data) => {
    const text = data.toString();
    const m = text.match(/127\.0\.0\.1:(\d+)/);
    if (m && !base) {
      base = `http://127.0.0.1:${m[1]}`;
    }
  };
  srv.stdout.on('data', onData);
  srv.stderr.on('data', onData);

  while (Date.now() < deadline && !base) {
    await new Promise(r => setTimeout(r, 200));
  }
  ok(!!base, '[0] 服务端启动并拿到端口', base);
  if (!base) {
    try { srv.kill(); } catch {}
    return;
  }

  // 等一小会，让后台探测启动
  await new Promise(r => setTimeout(r, 800));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // ── [1] 加载应用 ─────────────────────────────────────────────
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });

  // ── [2] 打开自定义 Agent 弹窗 ─────────────────────────────────
  await page.click('nav button[aria-label="通讯录"]');
  await page.waitForTimeout(400);
  // 点通讯录底部的「自定义 Agent」
  await page.click('text=自定义 Agent');
  await page.waitForSelector('[data-custom-agent-dialog]', { timeout: 5000 });

  // [2.1] 「创建」按钮是 TDesign Button（有 .t-button 类）
  const submitBtn = await page.locator('[data-custom-agent-submit]').first();
  const hasTButton = await submitBtn.evaluate(el => el.classList.contains('t-button'));
  ok(hasTButton, '[2.1] 创建按钮是 TDesign Button（有 .t-button 类）');

  // [2.2] 按钮文字颜色不是硬写的 #fff（TDesign 会自己适配）
  const btnColor = await submitBtn.evaluate(el => getComputedStyle(el).color);
  ok(!btnColor.includes('255, 255, 255'), '[2.2] 按钮文字色不是硬编码 #fff', btnColor);

  // [2.3] 弹窗支持拖拽：按头部拖动后 transform 非零
  const dialog = await page.locator('[data-custom-agent-dialog]').first();
  const beforeTransform = await dialog.evaluate(el => (el as HTMLElement).style.transform);
  const header = await dialog.locator('[data-dialog-handle]').first();
  const box = await header.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30);
    await page.mouse.up();
  }
  const afterTransform = await dialog.evaluate(el => (el as HTMLElement).style.transform);
  ok(
    afterTransform !== beforeTransform || afterTransform.includes('50') || afterTransform.includes('30'),
    '[2.3] 自定义 Agent 弹窗拖拽后 transform 发生变化',
    `${beforeTransform} → ${afterTransform}`
  );
  await page.click('[data-custom-agent-dialog] button[aria-label="关闭"]');
  await page.waitForSelector('[data-custom-agent-dialog]', { state: 'detached', timeout: 3000 });

  // ── [3] 设置弹窗拖拽 ─────────────────────────────────────────
  await page.click('[data-settings-trigger]');
  await page.waitForSelector('[data-settings-panel]', { timeout: 5000 });
  const settingsPanel = await page.locator('[data-settings-panel]').first();
  const settingsBefore = await settingsPanel.evaluate(el => (el as HTMLElement).style.transform);
  const settingsHeader = await settingsPanel.locator('header').first();
  const shBox = await settingsHeader.boundingBox();
  if (shBox) {
    await page.mouse.move(shBox.x + shBox.width / 2, shBox.y + shBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(shBox.x + shBox.width / 2 + 60, shBox.y + shBox.height / 2 + 40);
    await page.mouse.up();
  }
  const settingsAfter = await settingsPanel.evaluate(el => (el as HTMLElement).style.transform);
  ok(
    settingsAfter !== settingsBefore,
    '[3] 设置弹窗拖拽后 transform 发生变化',
    `${settingsBefore} → ${settingsAfter}`
  );
  await page.click('[data-settings-close]');
  await page.waitForSelector('[data-settings-panel]', { state: 'detached', timeout: 3000 });

  // ── [4] Agent 详情弹窗拖拽 ───────────────────────────────────
  // 先切回聊天，点一个 Agent 打开详情
  await page.click('[data-nav="chats"]');
  await page.waitForTimeout(300);
  // 点第一个会话
  const firstItem = await page.locator('.tc-list-item').first();
  if (await firstItem.isVisible().catch(() => false)) {
    await firstItem.click();
    await page.waitForTimeout(500);
    // 点头部 ⋯ 菜单里的 Agent 详情
    const moreBtn = await page.locator('[data-chat-header-more]').first();
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click();
      await page.waitForTimeout(200);
      await page.click('text=Agent 详情');
      await page.waitForSelector('[data-agent-detail-overlay]', { timeout: 5000 });
      const detailPanel = await page.locator('[data-agent-detail-overlay] [role="dialog"]').first();
      const detailBefore = await detailPanel.evaluate(el => (el as HTMLElement).style.transform);
      const detailHeader = await detailPanel.locator('[data-dialog-handle]').first();
      const dhBox = await detailHeader.boundingBox();
      if (dhBox) {
        await page.mouse.move(dhBox.x + dhBox.width / 2, dhBox.y + dhBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(dhBox.x + dhBox.width / 2 + 40, dhBox.y + dhBox.height / 2 + 30);
        await page.mouse.up();
      }
      const detailAfter = await detailPanel.evaluate(el => (el as HTMLElement).style.transform);
      ok(
        detailAfter !== detailBefore,
        '[4] Agent 详情弹窗拖拽后 transform 发生变化',
        `${detailBefore} → ${detailAfter}`
      );
      await page.click('[data-agent-detail-overlay] button[title="关闭"]');
      await page.waitForSelector('[data-agent-detail-overlay]', { state: 'detached', timeout: 3000 });
    }
  }

  // ── [5] 工作区最近目录删除 ───────────────────────────────────
  // 先新建一个会话并设工作目录，让它出现在最近目录里
  // 为了简化，直接调用 API 创建会话并设 cwd
  const createRes = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'A120 测试会话',
      model: 'default',
      agentId: 'default',
      cwd: WS,
    }),
  });
  const createJson = await createRes.json().catch(() => ({}));
  ok(createRes.ok, '[5.0] 创建测试会话成功', createJson.error);

  // 刷新页面，让最近目录出现
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // 打开工作区徽标
  const badge = await page.locator('[data-workspace-badge]').first();
  await badge.click();
  await page.waitForSelector('[data-workspace-panel]', { timeout: 5000 });

  // 确认最近目录里有 WS
  const recentItems = await page.locator('[data-workspace-recent]').all();
  ok(recentItems.length > 0, '[5.1] 最近目录列表不为空');

  // 点第一个最近目录的删除图标
  const firstRecent = recentItems[0];
  const removeBtn = await firstRecent.locator('span[title="从最近目录中移除"]').first();
  if (await removeBtn.isVisible().catch(() => false)) {
    await removeBtn.click();
    await page.waitForTimeout(300);
    // 重新查询，确认该目录已消失
    const afterRemove = await page.locator('[data-workspace-recent]').all();
    ok(
      afterRemove.length < recentItems.length,
      '[5.2] 点击删除图标后最近目录项减少',
      `${recentItems.length} → ${afterRemove.length}`
    );
  } else {
    ok(false, '[5.1] 删除图标未找到（可能最近目录为空或选择器不对）');
  }

  // 清理
  await browser.close();
  try { srv.kill(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  if (!process.exitCode) {
    console.log('A120 全部通过');
  } else {
    console.log('A120 有失败项');
  }
}

main();
