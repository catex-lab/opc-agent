import { useState } from 'react';
import { Loading } from 'tdesign-react';
import { ImageOff } from 'lucide-react';
import type { ImageBlock } from '../types';

/**
 * 生成图像气泡（P4-4）。
 *
 * 为什么要单独一个组件而不是内联几行 JSX：
 *   1. 图像有**自己的加载状态机**（loading / loaded / error）。远端链接过期、
 *      本地缓存文件被清理，都会走到 error —— 必须给出可操作的降级界面，
 *      而不是留一个裂图图标让用户猜发生了什么。
 *   2. 它需要局部 state，放在 ChatMessages 里会让那个已经很长的渲染函数
 *      再多三个 useState，并且每个图片块各要一份。
 */
interface ImageBubbleProps {
  image: ImageBlock;
}

export function ImageBubble({ image }: ImageBubbleProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const caption = image.prompt?.trim();

  return (
    <div className="tc-bubble-assistant p-2" data-image-bubble>
      <div
        className="relative overflow-hidden rounded-xl"
        style={{
          backgroundColor: 'var(--td-bg-color-secondarycontainer)',
          minHeight: 140,
        }}
      >
        {status === 'error' ? (
          // 降级界面：告诉用户「图没了」，并给出还能做什么
          <div
            className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-caption"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <ImageOff size={22} />
            <span>图像无法加载（链接可能已过期，或本地缓存已被清理）</span>
            {image.sourceUrl && image.sourceUrl !== image.url && (
              <a
                href={image.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="underline"
                style={{ color: 'var(--td-brand-color)' }}
              >
                尝试打开原始链接
              </a>
            )}
          </div>
        ) : (
          <img
            src={image.url}
            alt={image.alt || caption || '生成的图像'}
            loading="lazy"
            draggable={false}
            onLoad={() => setStatus('loaded')}
            onError={() => setStatus('error')}
            className="block max-w-full rounded-xl"
            style={{
              maxHeight: 420,
              // 加载完成前先透明：避免浏览器把「半张图」直接推上屏
              opacity: status === 'loaded' ? 1 : 0,
              transition: 'opacity .2s ease',
            }}
          />
        )}

        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2">
            <Loading size="small" />
            <span className="text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
              图像加载中…
            </span>
          </div>
        )}
      </div>

      {(caption || image.size || image.model) && (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pt-2 text-caption"
          style={{ color: 'var(--td-text-color-placeholder)' }}
        >
          {caption && (
            <span className="truncate" title={caption} style={{ maxWidth: 320 }}>
              {caption}
            </span>
          )}
          {image.size && <span>· {image.size}</span>}
          {image.model && <span>· {image.model}</span>}
        </div>
      )}

      {image.expiresAt && (
        <div className="px-2 pt-1 text-caption" style={{ color: 'var(--td-warning-color-6, #E37318)' }}>
          此图未缓存到本地，远端链接可能已失效
        </div>
      )}
    </div>
  );
}
