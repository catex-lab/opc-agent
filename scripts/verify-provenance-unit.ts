/**
 * P0 溯源契约：纯函数闸门。
 *
 * 只 import shared/provenance.ts，不碰 dist / 浏览器。
 * 最关键的一条是「读到文件 ≠ 已校验」：这条要是被改掉，账号卡就会重新
 * 把过时的本地缓存说成有效账号，正是用户报的那个现象。
 */
import {
  PROVENANCE_TTL_MS,
  asProvenance,
  describeProvenance,
  formatAge,
  isStale,
  makeProvenance,
} from '../shared/provenance.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

console.log('\n[1] makeProvenance：默认不校验，时钟可注入');
{
  const p = makeProvenance('~/.workbuddy/keyblob', { now: NOW });
  eq(p.source, '~/.workbuddy/keyblob', '来源原样保留');
  eq(p.probedAt, NOW, '时钟注入生效');
  ok(p.verified === false, '★ 没显式验过就是 false（读文件不能反推已校验）');
  eq(p.note, undefined, '没给 note 就不编');
  const verified = makeProvenance('SDK 实时清单', { now: NOW, verified: true, note: '按账号拉取' });
  ok(verified.verified === true, '显式 verified:true 才为 true');
  eq(verified.note, '按账号拉取', 'note 原样透传');
  const withStamp = makeProvenance('x', { probedAt: NOW - DAY, now: NOW, verified: true });
  eq(withStamp.probedAt, NOW - DAY, '显式 probedAt 优先于注入时钟');
  eq(makeProvenance('x', { verified: undefined as unknown as boolean, now: NOW }).verified, false,
    'verified:undefined 也不能变成 true');
}

console.log('\n[2] formatAge：边界不跳档，未来不显负数');
{
  eq(formatAge(NOW, NOW), '刚刚', '刚好此刻');
  eq(formatAge(NOW + 60_000, NOW), '刚刚', '未来时间说「刚刚」');
  eq(formatAge(NOW - 59_000, NOW), '刚刚', '59 秒仍是刚刚');
  eq(formatAge(NOW - MIN, NOW), '1 分钟前', '整 1 分钟进分钟档');
  eq(formatAge(NOW - 59 * MIN, NOW), '59 分钟前', '59 分钟不进小时档');
  eq(formatAge(NOW - HOUR, NOW), '1 小时前', '整 1 小时进小时档');
  eq(formatAge(NOW - 23 * HOUR, NOW), '23 小时前', '23 小时不进天档');
  eq(formatAge(NOW - DAY, NOW), '1 天前', '整 1 天进天档');
  eq(formatAge(NOW - 29 * DAY, NOW), '29 天前', '29 天仍用天数');
  ok(!formatAge(NOW - 30 * DAY, NOW).includes('天前'), '30 天退回日期而不是「30 天前」');
  eq(formatAge(Number.NaN, NOW), '时间未知', 'NaN 时间不崩');
}

console.log('\n[3] isStale：阈值边界与非法输入');
{
  ok(!isStale(NOW, PROVENANCE_TTL_MS, NOW), '刚读的不陈旧');
  ok(!isStale(NOW - PROVENANCE_TTL_MS, PROVENANCE_TTL_MS, NOW), '恰好等于阈值不算陈旧');
  ok(isStale(NOW - PROVENANCE_TTL_MS - 1, PROVENANCE_TTL_MS, NOW), '超阈值 1ms 即陈旧');
  ok(!isStale(NOW + DAY, PROVENANCE_TTL_MS, NOW), '未来时间不算陈旧');
  ok(!isStale(Number.NaN, PROVENANCE_TTL_MS, NOW), 'NaN 不算陈旧');
  ok(!isStale(NOW - 10 * DAY, 0, NOW), 'ttl<=0 时不做判断');
  ok(isStale(NOW - 6 * MIN, 5 * MIN, NOW), '自定义短 ttl 生效（模型清单场景）');
}

console.log('\n[4] asProvenance：腐败数据不许升格成「已校验」');
{
  eq(asProvenance(null), null, 'null → null');
  eq(asProvenance({}), null, '空对象 → null');
  eq(asProvenance({ source: '', probedAt: NOW }), null, '空来源 → null');
  eq(asProvenance({ source: 'x', probedAt: 'now' }), null, '字符串时间 → null');
  eq(asProvenance({ source: 'x', probedAt: Number.NaN }), null, 'NaN 时间 → null');
  const p = asProvenance({ source: 'x', probedAt: NOW, verified: 'true', note: 42 });
  ok(p?.verified === false, 'verified 是字符串 "true" 也不认（只认布尔 true）');
  eq(p?.note, undefined, '非字符串 note 丢掉');
  const good = asProvenance({ source: 'x', probedAt: NOW, verified: true, note: '边界' });
  ok(good?.verified === true, '合法结构原样收下');
  eq(good?.note, '边界', '合法 note 保留');
}

console.log('\n[5] describeProvenance：三段齐全 + 陈旧标注');
{
  const fresh = makeProvenance('WorkBuddy SDK', { now: NOW, verified: false });
  const text = describeProvenance(fresh, { now: NOW });
  ok(text.includes('来源 WorkBuddy SDK'), '带来源');
  ok(text.includes('探测于 刚刚'), '带探测时间');
  ok(text.includes('未校验'), '★ 未校验这一段不许被省掉');
  ok(!text.includes('已过期'), '新鲜数据不打过期标');
  const verifiedText = describeProvenance(
    makeProvenance('SDK', { now: NOW, verified: true }), { now: NOW });
  ok(verifiedText.includes('已校验') && !verifiedText.includes('未校验'), '验过才说已校验');
  const old = describeProvenance(
    makeProvenance('本地缓存', { probedAt: NOW - 2 * DAY }), { now: NOW });
  ok(old.includes('2 天前') && old.includes('已过期，仅供参考'), '两天前的缓存明确标过期');
  const shortTtl = describeProvenance(
    makeProvenance('目录', { probedAt: NOW - 6 * MIN }), { now: NOW, ttlMs: 5 * MIN });
  ok(shortTtl.includes('已过期'), '短 ttl 也生效');
  eq(describeProvenance(null, { now: NOW }), '数据来源与时间未知', '没数据时明说未知');
  eq(describeProvenance({ source: 'x', probedAt: 'bad' }, { now: NOW }), '数据来源与时间未知',
    '腐败数据也说未知，不假装验过');
}

console.log('\n[6] ttlMs：每份数据自带阈值，且不许被腐败输入污染');
{
  const longLived = makeProvenance('~/.codex/auth.json', {
    // 20 天：按默认 24h 一定过期，按这份数据自己的 30 天阈值还没过期。
    probedAt: NOW - 20 * DAY,
    ttlMs: 30 * DAY,
    now: NOW,
  });
  eq(longLived.ttlMs, 30 * DAY, '合法 ttlMs 原样保留');
  const text = describeProvenance(longLived, { now: NOW });
  ok(!text.includes('已过期'), '★ 20 天前的 token 快照用自己的阈值，不按 24h 误判');
  ok(text.includes('未校验'), '阈值再长也不改变「未校验」');
  const short = makeProvenance('ZCode 套餐缓存', { probedAt: NOW - 2 * DAY, ttlMs: DAY, now: NOW });
  ok(describeProvenance(short, { now: NOW }).includes('已过期'), '自带短阈值照样标过期');
  eq(makeProvenance('x', { ttlMs: 0, now: NOW }).ttlMs, undefined, 'ttlMs=0 不收');
  eq(makeProvenance('x', { ttlMs: Number.NaN, now: NOW }).ttlMs, undefined, 'NaN 阈值不收');
  eq(asProvenance({ source: 'x', probedAt: NOW, ttlMs: '999999999' })?.ttlMs, undefined,
    '字符串阈值不许让旧数据永远新鲜');
  eq(asProvenance({ source: 'x', probedAt: NOW, ttlMs: -1 })?.ttlMs, undefined,
    '负阈值不许让旧数据永远新鲜');
}

console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
if (fail > 0) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
