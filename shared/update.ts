/**
 * 应用内检查更新：主进程与渲染进程共用的**类型与常量**。
 *
 * 这里刻意不 import 任何 Node 模块（渲染进程会引这个文件取类型），
 * 验签、哈希、路径校验等纯逻辑放在 `shared/update-manifest.ts`。
 *
 * ## 为什么不做安装包更新
 *
 * 项目没有代码签名证书。NSIS 安装包每次启动/更新都会触发 UAC 与
 * SmartScreen 警告，用户会以为装了个流氓软件。所以更新走「只替换
 * `resources/app.asar`」这一条代码层路径；只有 Electron / 原生依赖
 * 真的变了（清单里的 `runtimeVersion` 与本机不一致）时才给全量 zip。
 */

/** 仓库 slug —— 与 package.json 的 repository 保持一致 */
export const UPDATE_REPO_SLUG = 'catex-lab/opc-agent';

/** 固定清单地址：GitHub 的 latest release 下载别名，不随版本变化 */
export const UPDATE_MANIFEST_URL =
  `https://github.com/${UPDATE_REPO_SLUG}/releases/latest/download/latest.json`;

/** 手动下载兜底入口（出错时给用户，永远不是死链） */
export const UPDATE_RELEASES_PAGE = `https://github.com/${UPDATE_REPO_SLUG}/releases/latest`;

/** 清单格式版本。字段口径变了就改它，客户端据此拒绝旧格式 */
export const UPDATE_SCHEMA_VERSION = 1;

/** 发布资产 */
export interface UpdateAsset {
  /** 文件名（必须是单段安全文件名，不含路径） */
  name: string;
  /** HTTPS 直链 */
  url: string;
  /** 文件内容的 sha512，base64（标准 base64，不是 hex） */
  sha512: string;
  /** 字节数 */
  size: number;
}

/**
 * latest.json 的正文。
 *
 * 签名覆盖的是**除 `signature` 之外的全部字段**的规范化 JSON
 * （键递归排序、无空白）。规范化实现见 `shared/update-manifest.ts` 的
 * `canonicalManifestBody()` —— 发布脚本与客户端**必须**共用同一份实现，
 * 各自写一份的后果是「签出来的东西自己验不过」。
 */
export interface UpdateManifest {
  schemaVersion: number;
  /** 语义化版本，可带预发布后缀（1.2.0-beta.1） */
  version: string;
  /** ISO 时间 */
  releasedAt: string;
  /** 更新说明（纯文本，客户端按原样显示） */
  notes: string;
  /**
   * 本清单对应的 Electron 运行时版本（与 `process.versions.electron` 精确比对）。
   * 不一致 = 代码层补丁可能加载不了原生模块，必须走全量包。
   */
  runtimeVersion: string;
  /** 发布通道：stable / beta */
  channel: string;
  assets: {
    /** 只替换 resources/app.asar 的代码层包 */
    asar: UpdateAsset;
    /** 完整安装包（zip，解压即用） */
    full: UpdateAsset;
  };
  /** ed25519 签名，base64（对 canonicalManifestBody 的结果签名） */
  signature: string;
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

/** 检查更新得到的新版本信息（给界面用，不含签名） */
export interface UpdateReleaseInfo {
  version: string;
  releasedAt: string;
  notes: string;
  channel: string;
  /** asar 体积（字节） */
  size: number;
  /** 完整包体积（字节） */
  fullSize: number;
  /** 完整包直链 */
  fullUrl: string;
  /** true = 运行时版本不一致，只能走全量包 */
  requiresFull: boolean;
}

export interface UpdateError {
  /** 机器可读的原因：network / manifest-invalid / signature / digest / io / unsupported */
  code: string;
  /** 给用户看的中文一句话 */
  message: string;
  /** 手动下载入口 */
  manualUrl: string;
}

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  checkedAt?: string;
  release?: UpdateReleaseInfo;
  progress?: { received: number; total: number; percent: number };
  error?: UpdateError;
  /** 已下载到本地、待重启的版本号 */
  stagedVersion?: string;
  /** false = 开发态 / 浏览器态，只能看不能装 */
  supported: boolean;
}
