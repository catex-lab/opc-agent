/**
 * 头像裁剪对话框（A160）。
 *
 * ## 为什么自己写而不引裁剪库
 *
 * 需求只有四条：正方形、拖动、缩放、导出 WebP。引一个库（react-easy-crop
 * 之类）要带进几十 KB 和一套自己的样式语言，而这里只需要一个 canvas ——
 * 工程里已有的依赖（TDesign / lucide）都不提供裁剪，加库反而更难维护。
 *
 * ## 为什么先缩放到「铺满」再允许放大
 *
 * 头像位永远是圆形方框。先按 cover 把短边铺满，用户只会往下裁掉多余部分，
 * 永远不会出现「图片没盖满、露出圆角底色」的半成品 —— 那看起来像上传失败。
 *
 * ## 透明 PNG
 *
 * 导出时保留 alpha（WebP 支持透明）；预览用浅色底衬，否则透明区域的边缘
 * 在整块深色遮罩上完全看不见。检测方式只查四角 alpha —— 头像常见的
 * 「透明背景 logo」都是四角全透，逐像素扫描没有必要。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 预览区边长（逻辑像素）。导出固定 320，与显示尺寸无关 */
const VIEW = 280;
/** 导出边长。> 320 会明显变大但肉眼收益低；再小在大头像（80px@3x）会糊 */
const OUTPUT = 320;

interface AvatarCropDialogProps {
  file: File | null;
  title?: string;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}

export function AvatarCropDialog({ file, title = '更换头像', onCancel, onConfirm }: AvatarCropDialogProps) {
  const [url, setUrl] = useState<string>('');
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [transparent, setTransparent] = useState(false);
  const [error, setError] = useState('');
  /** 拖动起点。放 ref 里避免每次 pointermove 都触发一次重渲染前的闭包丢状态 */
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  // 文件 → objectURL → Image。卸载时释放 URL，否则连续换图会一直占内存
  useEffect(() => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    setImg(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setTransparent(false);
    setError('');
    const next = new Image();
    next.onload = () => {
      setImg(next);
      setOffset({ x: 0, y: 0 });
      // cover 基准缩放：短边刚好铺满预览框
      setZoom(1);
      setTransparent(hasTransparentCorner(next));
    };
    next.onerror = () => setError('这张图片打不开，请换一张 PNG / JPEG / WebP');
    next.src = objectUrl;
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  /** 当前图片在预览框里的绘制尺寸（含缩放） */
  const drawSize = img
    ? (() => {
        const base = VIEW / Math.min(img.naturalWidth, img.naturalHeight);
        const scale = base * zoom;
        return { w: img.naturalWidth * scale, h: img.naturalHeight * scale };
      })()
    : { w: VIEW, h: VIEW };

  /** 把偏移夹在「图片始终盖满预览框」的范围里 */
  const clamp = useCallback(
    (next: { x: number; y: number }, size: { w: number; h: number }) => ({
      x: Math.min(0, Math.max(VIEW - size.w, next.x)),
      y: Math.min(0, Math.max(VIEW - size.h, next.y)),
    }),
    []
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!img) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset(
      clamp(
        { x: drag.baseX + (e.clientX - drag.startX), y: drag.baseY + (e.clientY - drag.startY) },
        drawSize
      )
    );
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const changeZoom = (next: number) => {
    setZoom(next);
    // 缩放后可视窗口变小，旧偏移可能越界；按新尺寸重新夹一次
    const base = img ? VIEW / Math.min(img.naturalWidth, img.naturalHeight) : 1;
    const size = {
      w: (img?.naturalWidth ?? VIEW) * base * next,
      h: (img?.naturalHeight ?? VIEW) * base * next,
    };
    setOffset(prev => clamp(prev, size));
  };

  /**
   * 导出 320×320 WebP。quality 0.85 在 10~40KB 量级，
   * 对头像这种小尺寸足够清晰，又不会让数据目录被零碎大图撑大。
   */
  const exportDataUrl = (): string => {
    if (!img) throw new Error('图片还没加载完成');
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境不支持图片裁剪');
    const ratio = OUTPUT / VIEW;
    ctx.drawImage(
      img,
      offset.x * ratio,
      offset.y * ratio,
      drawSize.w * ratio,
      drawSize.h * ratio
    );
    return canvas.toDataURL('image/webp', 0.85);
  };

  if (!file) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
      data-avatar-crop
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-[360px] rounded-2xl p-5"
        style={{
          backgroundColor: 'var(--td-bg-color-container)',
          border: '1px solid var(--tc-edge)',
          boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
        }}
      >
        <h3 className="mb-1 text-title font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
          {title}
        </h3>
        <p className="mb-3 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
          拖动调整位置，滑块缩放。导出为正圆形。
        </p>

        <div
          className="relative mx-auto overflow-hidden rounded-2xl touch-none"
          style={{
            width: VIEW,
            height: VIEW,
            // 透明图用浅色底衬：深色遮罩上看不见透明区域，用户会以为是黑块
            backgroundColor: transparent ? 'var(--agent-logo-tile)' : '#000',
            cursor: img ? 'grab' : 'default',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          data-avatar-crop-view
        >
          {url && (
            <img
              src={url}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: offset.x,
                top: offset.y,
                width: drawSize.w,
                height: drawSize.h,
                maxWidth: 'none',
                userSelect: 'none',
              }}
            />
          )}
          {/* 圆形裁切预览：外面压暗，让用户看到最终头像的边界 */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              borderRadius: '50%',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.32)',
              border: '1px solid rgba(255,255,255,0.55)',
            }}
          />
        </div>

        <label className="mt-4 flex items-center gap-3 text-secondary" style={{ color: 'var(--td-text-color-secondary)' }}>
          <span className="shrink-0">缩放</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            disabled={!img}
            onChange={e => changeZoom(Number(e.target.value))}
            className="w-full"
            data-avatar-crop-zoom
            aria-label="缩放"
          />
        </label>

        {error && (
          <p className="mt-3 text-secondary" style={{ color: 'var(--td-error-color)' }}>
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="tc-btn-secondary" onClick={onCancel} data-avatar-crop-cancel>
            取消
          </button>
          <button
            type="button"
            className="tc-btn-brand"
            disabled={!img || !!error}
            onClick={() => {
              try {
                onConfirm(exportDataUrl());
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
            data-avatar-crop-confirm
          >
            使用这张图
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 四角 alpha 检测。取 16×16 的一次缩略图，读四个角的 alpha：
 * 全透明 = 这是一张带透明背景的图，预览需要浅色底衬。
 */
function hasTransparentCorner(image: HTMLImageElement): boolean {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(image, 0, 0, size, size);
  try {
    const data = ctx.getImageData(0, 0, size, size).data;
    const alphaAt = (x: number, y: number) => data[(y * size + x) * 4 + 3];
    return [alphaAt(0, 0), alphaAt(size - 1, 0), alphaAt(0, size - 1), alphaAt(size - 1, size - 1)]
      .every(a => a < 16);
  } catch {
    // canvas 被污染（理论上不会，图是自己 objectURL 载入的）就当不透明
    return false;
  }
}
