/**
 * 过程流（A149）闸门辅助。
 *
 * 背景：答案一出现，答案之前的「思考 / 中途旁白 / 轨迹条」会被 `ProcessFlow`
 * 收成一行，**子节点整棵卸载**（不是 visibility 隐藏）。于是所有「点开轨迹看
 * 步骤」的闸门都先撞上一个空 locator —— 失败信息是 `waiting for locator(...)`，
 * 看起来像选择器写错了，实际是「这条消息的过程默认收起了」。
 *
 * 用法：导航到消息页之后、任何要碰 `[data-steps-bar]` / `.tc-thinking` 之前
 * 调一次 `openAllProcess(page)`。
 *
 * 为什么写「全部展开」而不是「展开第一条」：一条会话里可能有多条带答案的消息，
 * 闸门里既有 `.first()` 也有 `.last()` 的取法，只开第一条会让后一种继续红。
 */

/** 折叠过渡 220ms + 一帧余量 */
const FOLD_WAIT_MS = 260;

/**
 * 展开页面上所有处于收起态的过程流。已经是展开态的不动（避免把它又收回去）。
 * @param {import('playwright-core').Page} page
 * @returns {Promise<number>} 实际点开的条数
 */
export async function openAllProcess(page) {
  let opened = 0;
  // 每次都重新取「还处于收起态」的第一个：点开之后它就不在这个集合里了
  for (;;) {
    const bar = page.locator('[data-process-flow][data-process-open="0"] [data-process-bar]').first();
    if ((await bar.count()) === 0) break;
    await bar.click();
    await page.waitForTimeout(FOLD_WAIT_MS);
    opened += 1;
    if (opened > 50) break; // 防御：状态没翻过来时不要无限循环
  }
  return opened;
}

export default openAllProcess;
