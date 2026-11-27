/**
 * CDP 偏好闸门（P0-01，2026-11-26）：默认关闭 + 方便用户打开。
 *
 * 四条链路缺一不可（项目纪律「会话级设置走满四步」的同源要求）：
 *   1. 服务端 Prefs 有 cdpEnabled 字段 + PATCH 白名单认它 + 非法值 400；
 *   2. 前端 prefs 映射、read/save 封装（注入 > localStorage > 默认关）；
 *   3. 消费方主进程读偏好而非硬编码 env，判定有单一出口且默认关；
 *   4. 设置页有开关 + 重启提示，状态行文案不再只提 OPC_CDP=0。
 *
 * 反向探针：见 .tmp/probe-cdp-pref.mjs —— 真把 cdp.ts 退回默认开，
 * 确认本闸门变红，再恢复源码。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

let checks = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

/** 剥注释，避免注释里的历史代码造成假绿 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function run(): Promise<void> {
  // [1] 服务端：字段 + 白名单
  const srv = stripComments(read('server/preferences.ts'));
  ok(/cdpEnabled\?: boolean/.test(srv), '服务端：Prefs 有 cdpEnabled?: boolean 字段');
  ok(/case 'cdpEnabled':/.test(srv), '服务端：PATCH 白名单认 cdpEnabled');
  ok(
    /case 'cdpEnabled':[\s\S]{0,220}typeof v === 'boolean'/.test(srv),
    '服务端：只接受布尔值（非法值 400 不静默纠正）'
  );

  // [2] 前端：prefs 映射 + 读写封装
  const prefs = stripComments(read('src/prefs.ts'));
  ok(/cdpEnabled\?: boolean/.test(prefs), '前端：Prefs 映射有 cdpEnabled');
  const mod = stripComments(read('src/cdpPref.ts'));
  ok(/bootPref\('cdpEnabled'\)/.test(mod), '前端：读取走服务端注入（首帧同步）');
  ok(/localStorage\.getItem\(STORAGE_KEY\)/.test(mod), '前端：localStorage 只是镜像兜底');
  ok(/return false;/.test(mod), '前端：缺键默认关');
  ok(/pushPrefs\(\{ cdpEnabled: enabled \}\)/.test(mod), '前端：写入经 pushPrefs 同时落 localStorage + 服务端');

  // [3] 消费方：主进程单一判定 + 默认关
  const cdp = stripComments(read('electron/cdp.ts'));
  ok(/export function cdpShouldEnable\(\): boolean/.test(cdp), '主进程：判定有单一出口');
  ok(
    /if \(process\.env\.OPC_CDP === '0'\) return false;[\s\S]{0,120}if \(process\.env\.OPC_CDP === '1'\) return true;[\s\S]{0,120}return loadPrefs\(\)\.cdpEnabled === true;/.test(cdp),
    '主进程：优先级 强制关 > 强制开 > 偏好（缺键=关）'
  );
  ok(/if \(!cdpShouldEnable\(\)\)/.test(cdp), '主进程：开关层走判定');
  ok((cdp.match(/if \(!cdpShouldEnable\(\)\)/g) ?? []).length >= 2, '主进程：端点层也走同一判定（两处共用出口）');
  ok(!/appendSwitch\('remote-debugging-port', '0'\);[\s\S]{0,20}if \(!cdpShouldEnable/.test(cdp), '主进程：不会先开端口再判断');

  // [4] UI：设置页开关 + 重启提示 + 状态行文案
  const page = stripComments(read('src/components/SettingsPage.tsx'));
  ok(/function CdpSetting\(\)/.test(page), 'UI：设置页有 CdpSetting 组件');
  ok(/readCdpEnabled/.test(page) && /saveCdpEnabled/.test(page), 'UI：读写走偏好封装');
  ok(/data-cdp-setting/.test(page) && /data-cdp-restart-note/.test(page), 'UI：有稳定的闸门锚点');
  ok(/settings\.cdp\.restartNote/.test(page), 'UI：如实告知重启才生效');
  const browser = read('src/components/WorkspaceBrowser.tsx');
  ok(!/远程调试端口已关闭（OPC_CDP=0）/.test(browser), 'UI：状态行不再只说 OPC_CDP=0（默认关也要能解释）');
  ok(/设置 → 外观 → 高级/.test(browser), 'UI：状态行给出开启路径');

  // [5] i18n 双写
  const zh = read('src/i18n/zh.ts');
  const en = read('src/i18n/en.ts');
  for (const key of [
    'settings.cdp.label',
    'settings.cdp.hint',
    'settings.cdp.switch',
    'settings.cdp.restartNote',
    'settings.appearance.groupAdvanced',
  ]) {
    ok(zh.includes(`'${key}':`), `zh 有键 ${key}`);
    ok(en.includes(`'${key}':`), `en 有键 ${key}`);
  }
}

void run().then(() => {
  console.log(`\nCDP 偏好闸门：${checks - failures.length}/${checks} 通过`);
  if (failures.length) {
    console.error(`失败 ${failures.length} 项：${failures.join('；')}`);
    process.exitCode = 1;
  }
}).catch(err => {
  console.error('闸门执行异常：', err);
  process.exitCode = 1;
});
