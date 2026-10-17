/**
 * 最小 PNG 解码器（够用来量截图里某条水平带的平均亮度）。
 *
 * ## 为什么自己写
 *
 * 验证「Windows 原生标题栏是否跟着主题变色」时，需要量化截图上
 * 顶部那条带的亮度。但那块区域是**操作系统画的**，页面里没有对应
 * 的 DOM 节点，`page.evaluate` 拿不到 —— 只能从截图像素里读。
 *
 * 项目没有 pngjs / sharp / jimp，为一个断言装一个图像库不划算；
 * PNG 的格式很规整，playwright 产出的图又是固定几种参数，
 * 手写解码器比引入依赖更轻。
 *
 * 只实现必要部分：8-bit RGB / RGBA、非隔行、5 种行过滤。
 * 其它参数（调色板、16-bit、隔行）遇上了直接抛错，不静默给错值。
 */
import { inflateSync } from 'node:zlib';

/**
 * @param {Buffer} buf PNG 文件内容
 * @returns {{width:number,height:number,data:Uint8Array}} data 为 RGBA，长宽*4
 */
export function decodePng(buf) {
  // PNG 签名: 89 50 4E 47 0D 0A 1A 0A
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error('不是合法的 PNG 文件');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // 4 len + 4 type + data + 4 crc

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`不支持的位深: ${bitDepth}（只支持 8）`);
  if (interlace !== 0) throw new Error('不支持隔行扫描的 PNG');
  // 2=truecolor RGB，6=truecolor+alpha
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`不支持的颜色类型: ${colorType}（只支持 2/6）`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));

  // 每行前面有 1 个 filter 字节，且 filter 可能引用上一行，
  // 所以必须从第一行开始顺序还原。
  const out = new Uint8Array(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0; // 左
      const b = prev ? prev[x] : 0;                    // 上
      const c = prev && x >= channels ? prev[x - channels] : 0; // 左上
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: v += paeth(a, b, c); break;
        default: throw new Error(`未知的行过滤器: ${filter}`);
      }
      cur[x] = v & 0xff;
    }
  }

  if (channels === 3) {
    // 统一成 RGBA，调用处就不用分两种布局
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      rgba[i * 4] = out[j];
      rgba[i * 4 + 1] = out[j + 1];
      rgba[i * 4 + 2] = out[j + 2];
      rgba[i * 4 + 3] = 255;
    }
    return { width, height, data: rgba };
  }
  return { width, height, data: out };
}

/**
 * 量截图里任意矩形的平均亮度（0~255）。
 *
 * 矩形坐标是**物理像素**，会按图的实际尺寸裁剪（clamp），
 * 越界不报错 —— 调用处（窗口几何换算）本来就允许有几个像素的误差。
 *
 * @param {Buffer} png PNG 文件内容
 * @param {{x:number,y:number,w:number,h:number}} rect
 */
export function rectLuminance(png, rect) {
  const { width, height, data } = decodePng(png);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  if (x1 - x0 < 1 || y1 - y0 < 1) return 0;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * 量截图顶部若干行的平均亮度（0~255）。
 *
 * 跳过最外侧 1 像素：窗口边框可能有抗锯齿，会把结果拉偏。
 *
 * @param {Buffer} png
 * @param {number} bandHeight 取顶部多少行
 */
export function topBandLuminance(png, bandHeight) {
  const { width, height } = decodePng(png);
  return rectLuminance(png, {
    x: 1,
    y: 1,
    w: width - 2 - 1,
    h: Math.min(bandHeight, height) - 1 - 1,
  });
}
