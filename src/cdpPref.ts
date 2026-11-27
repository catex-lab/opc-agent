/**
 * 远程调试端口（CDP / 人机同屏）的界面偏好读写（P0-01，2026-11-26）。
 *
 * 默认**关闭**：端口一旦开放，本机任何进程都能驱动本应用的所有页面，
 * 这是 `--remote-debugging-port` 的固有语义，所以不再默认开。
 *
 * ⚠️ 重启才生效：Chromium 的调试开关只能在 app ready 之前追加，运行期
 * 改偏好不会立刻开关端口。设置页必须把这句话讲清楚（i18n 提示）。
 *
 * 读写沿用全局偏好链路（`bootPref` 服务端注入 > localStorage 镜像 > 默认），
 * 不新建存储。判定主进程侧的同名逻辑在 `electron/cdp.ts:cdpShouldEnable()`，
 * 它读的是同一份 `preferences.json`（环境变量可覆盖，脚本用）。
 */
import { bootPref, pushPrefs } from './prefs';

const STORAGE_KEY = 'opc.cdpEnabled';

/** 默认关：缺键 / 存储被禁 / 非布尔值都返回 false */
export function readCdpEnabled(): boolean {
  const injected = bootPref('cdpEnabled');
  if (typeof injected === 'boolean') return injected;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch {
    /* 隐私模式 / 存储被禁：用默认值 */
  }
  return false;
}

/** 写偏好：localStorage 镜像（dev 与闸门可见）+ 服务端落盘（重启后主进程读） */
export function saveCdpEnabled(enabled: boolean): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* 同 readCdpEnabled */
  }
  pushPrefs({ cdpEnabled: enabled });
  return enabled;
}
