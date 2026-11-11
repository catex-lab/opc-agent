import { useState, useEffect, useCallback, useRef } from 'react';
import { Model } from '../types';
import { asProvenance, type Provenance } from '../../shared/provenance';
import { bootPref } from '../prefs';
import { subscribeCredentialChanges } from '../lib/credentialEvents';

const STORAGE_KEY = 'defaultModel';

export function useModels() {
  const [models, setModels] = useState<Model[]>([]);
  /** P0：这份平台清单的来源 / 取数时刻 / 是否校验过（老服务端为 null） */
  const [modelProvenance, setModelProvenance] = useState<Provenance | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    // A135：服务端注入的默认模型优先，localStorage 只是兜底（打包态每次换源）
    return bootPref('defaultModel') || localStorage.getItem(STORAGE_KEY) || '';
  });

  /** 上一份清单里的模型名。用来分辨「从清单里选的」和「用户手填的」——
   *  后者不在旧清单里，刷新时绝不能被回落抹掉（A151 的教训：清单为空 ≠ 没有）。 */
  const catalogIdsRef = useRef<Set<string>>(new Set());

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      const list: Model[] = Array.isArray(data.models) ? data.models : [];
      setModels(list);
      // 腐败结构不许升格成「已校验」：asProvenance 只认真布尔 true
      setModelProvenance(asProvenance(data.provenance));

      const prevIds = catalogIdsRef.current;
      const nextIds = new Set(list.map(m => m.modelId));
      catalogIdsRef.current = nextIds;

      if (!selectedModel) {
        // 初始 / 被清空后的补默认：沿用旧行为
        const savedDefault = bootPref('defaultModel') || localStorage.getItem(STORAGE_KEY);
        const modelToUse = savedDefault && nextIds.has(savedDefault)
          ? savedDefault
          : (data.defaultModel || list[0]?.modelId);
        if (modelToUse) {
          setSelectedModel(modelToUse);
          localStorage.setItem(STORAGE_KEY, modelToUse);
        }
      } else if (
        nextIds.size > 0 &&
        !nextIds.has(selectedModel) &&
        prevIds.size > 0 &&
        prevIds.has(selectedModel)
      ) {
        // 旧清单里的选中项在新清单里消失了（换账号后 provider 模型全变）。
        // 只在「它确实来自上一份清单」时回落，手填的名字一概不动。
        const fallback = data.defaultModel || list[0].modelId;
        if (fallback) {
          setSelectedModel(fallback);
          localStorage.setItem(STORAGE_KEY, fallback);
        }
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
    }
  }, [selectedModel]);

  // 初始加载
  useEffect(() => {
    void fetchModels();
    // 只跑一次：后续刷新由下面的订阅与 App 的 modelsEpoch 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * #16：服务端清了模型缓存，前端这份清单也必须跟着重拉。
   *
   * 用 ref 拿最新的 fetchModels，订阅本身只装一次 —— 否则 `selectedModel`
   * 一变就重挂订阅，中途那几毫秒的事件会丢。
   */
  const fetchRef = useRef(fetchModels);
  useEffect(() => {
    fetchRef.current = fetchModels;
  }, [fetchModels]);

  useEffect(() => subscribeCredentialChanges(() => {
    void fetchRef.current();
  }), []);

  return {
    models,
    modelProvenance,
    selectedModel,
    setSelectedModel,
    fetchModels,
  };
}
