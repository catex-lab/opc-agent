import { useEffect, useRef, useState } from 'react';
import { MessagePlugin } from 'tdesign-react';
import { useUserProfile, saveUserProfile } from '../userProfile';
import { removeUserAvatar, uploadUserAvatar } from '../avatarApi';
import { AvatarPickerGrid, UserAvatar } from './UserAvatar';
import { AvatarCropDialog } from './AvatarCropDialog';

/**
 * 「我的资料」分区（A115）。
 *
 * 原话：「增加用户更换自己头像和昵称的功能，昵称可以被 agent 识别」。
 *
 * ## 为什么昵称走服务端
 *
 * Agent 跑在服务端子进程里，前端存什么都不够 —— 必须在拼 systemPrompt 时
 * 注入。所以这里是 PUT `/api/user-profile`，保存成功后由
 * `registry.stream()` 在**下一轮对话**带上。当前正在跑的那一轮不会变
 * （它的 prompt 已经发出去了），这也是为什么保存后没有「立即生效」的提示。
 *
 * ## 保存策略
 *
 * 失焦/回车即存，不设「保存」按钮。两个字段都是一改就该生效的东西，
 * 让用户先按保存等于多一次无意义操作。失败时 MessagePlugin 报错并回滚
 * （回滚在 userProfile.ts 里做，这里只管提示）。
 */
export function ProfilePanel() {
  const profile = useUserProfile();
  const [draft, setDraft] = useState(profile.nickname);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // A160：上传图片头像。待裁剪的文件放这里，null = 对话框关闭
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 外部变化（比如另一处入口改了昵称）要能反映到输入框里
  useEffect(() => {
    setDraft(profile.nickname);
  }, [profile.nickname]);

  // 「已保存」提示 1.5 秒后自动消失
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 1500);
    return () => clearTimeout(t);
  }, [savedAt]);

  const commit = async (next: string) => {
    const trimmed = next.trim().slice(0, 24);
    if (trimmed === profile.nickname) {
      setDraft(trimmed);
      return;
    }
    setSaving(true);
    try {
      await saveUserProfile({ nickname: trimmed });
      setDraft(trimmed);
      if (!trimmed) {
        MessagePlugin.success('已清空昵称，Agent 将不再使用称呼');
      } else {
        setSavedAt(Date.now());
      }
    } catch (err) {
      setDraft(profile.nickname);
      MessagePlugin.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-settings-panel="profile">
      {/* A160：待裁剪的图片。选完文件先弹裁剪，再上传 */}
      <AvatarCropDialog
        file={cropFile}
        title="更换我的头像"
        onCancel={() => setCropFile(null)}
        onConfirm={dataUrl => {
          setCropFile(null);
          setUploadingAvatar(true);
          void uploadUserAvatar(dataUrl)
            .catch(err => MessagePlugin.error(`头像上传失败：${err instanceof Error ? err.message : String(err)}`))
            .finally(() => setUploadingAvatar(false));
        }}
      />

      <div className="mb-4">
        <h2 className="text-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          我的资料
        </h2>
      </div>

      {/* 头像 + 昵称一行：左边一颗大头像，右边昵称输入框。
          不用卡片包起来 —— 这个分区只有两项，包卡片会显得很空。 */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="flex flex-col items-center gap-2">
          <UserAvatar
            nickname={profile.nickname}
            avatar={profile.avatar}
            image={profile.avatarImage}
            size={72}
          />
          <span className="tc-hint">这就是 Agent 看到的你</span>
          {/* A160：上传本地图片。图片是覆盖层，移除后回到下面的预设 */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="tc-btn-secondary"
              disabled={uploadingAvatar}
              data-user-avatar-upload
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadingAvatar ? '上传中…' : '上传图片'}
            </button>
            {profile.avatarImage && (
              <button
                type="button"
                className="text-caption underline"
                style={{ color: 'var(--td-text-color-placeholder)' }}
                data-user-avatar-remove
                onClick={() => {
                  void removeUserAvatar().catch(err =>
                    MessagePlugin.error(`移除头像失败：${err instanceof Error ? err.message : String(err)}`)
                  );
                }}
              >
                移除图片
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            data-user-avatar-file
            onChange={e => {
              const f = e.target.files?.[0] ?? null;
              // 清空 value：同一张图再选一次也要能触发 onChange
              e.target.value = '';
              if (f) setCropFile(f);
            }}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <label
              htmlFor="opc-user-nickname"
              className="mb-1.5 flex items-center justify-between text-body font-medium"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              <span>昵称</span>
              {savedAt && (
                <span className="text-caption" style={{ color: 'var(--td-brand-color)' }}>
                  已保存
                </span>
              )}
            </label>
            <input
              id="opc-user-nickname"
              value={draft}
              disabled={saving}
              onChange={e => setDraft(e.target.value)}
              onBlur={() => void commit(draft)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commit(draft);
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setDraft(profile.nickname);
                }
              }}
              placeholder="还没起昵称"
              maxLength={24}
              data-user-nickname-input
              /* A115 续：改挂 .tc-input —— 描边走 --tc-edge、聚焦态由
                 --tc-focus-shadow 抬起来。原来这里是内联实色底 + 10% 墨描边，
                 聚焦时没有任何反馈（outline-none 把 TDesign 默认环也杀了）。 */
              className="tc-input w-full px-3 py-2 text-body"
            />
            <p className="mt-1.5 text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
              最多 24 字。保存后 Agent 会在 systemPrompt 里看到「与你对话的人叫××」，
              可以直接用这个称呼 —— <strong style={{ color: 'var(--td-text-color-secondary)' }}>正在进行的对话不会变</strong>，
              下一轮才带上。
            </p>
          </div>

          <div>
            <div className="mb-1.5 text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              头像
            </div>
            <AvatarPickerGrid
              value={profile.avatar}
              onChange={id => void saveUserProfile({ avatar: id, avatarImage: '' }).catch(err =>
                MessagePlugin.error(`头像保存失败：${err instanceof Error ? err.message : String(err)}`)
              )}
            />
            <p className="mt-1.5 text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
              上传的图片优先于预设；点上面的预设会切回预设头像。没有头像时用昵称首字；昵称也没有就显示「我」。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
