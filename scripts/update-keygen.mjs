#!/usr/bin/env node
/**
 * 生成更新签名用的 ed25519 密钥对。
 *
 * 用法：
 *   npm run update:keygen                # 写到 .tmp/update-signing-key.json（已 gitignore）
 *   npm run update:keygen -- --out path  # 指定位置
 *
 * 输出：
 *   · 公钥（base64 SPKI）→ 替换 `electron/updater/config.ts` 里的
 *     `UPDATE_PUBLIC_KEY_BASE64`，然后提交、重新打包；
 *   · 私钥（base64 PKCS#8）→ **只**放进 GitHub Secrets 的
 *     `OPC_UPDATE_PRIVATE_KEY`，不要提交到仓库，也不要留在共享目录。
 *
 * 换密钥等于让旧客户端不再信任新清单 —— 换完必须发一个带新公钥的版本，
 * 否则老版本只会一直提示「签名不匹配」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';

const args = process.argv.slice(2);
const outArgIndex = args.indexOf('--out');
const out =
  outArgIndex >= 0 && args[outArgIndex + 1]
    ? path.resolve(args[outArgIndex + 1])
    : path.resolve('.tmp', 'update-signing-key.json');
const force = args.includes('--force');

if (fs.existsSync(out) && !force) {
  console.error(`[update-keygen] ${out} 已存在。要覆盖请加 --force（旧私钥一旦丢失就无法再签新清单）`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ publicKey: pub, privateKey: priv }, null, 2), { mode: 0o600 });

// 指纹便于在回报 / 票据里核对「换的是哪把钥匙」，而不暴露任何私钥材料。
const fingerprint = createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);

console.log('\n[update-keygen] 已生成 ed25519 密钥对\n');
console.log(`公钥指纹（SHA-256 前 16 位）：${fingerprint}\n`);
console.log('1) 把下面这行替换进 electron/updater/config.ts 的 UPDATE_PUBLIC_KEY_BASE64：\n');
console.log(`   ${pub}\n`);
console.log('2) 私钥（base64 PKCS#8）已写入下面的文件，**不会打印到终端**：');
console.log(`   ${out}\n`);
console.log('   打开该文件，把 privateKey 那一行的值存进 GitHub Secrets，名称 OPC_UPDATE_PRIVATE_KEY。');
console.log('   确认 Actions 能读到、测试 release 发出成功后，删除这个本地文件。\n');
