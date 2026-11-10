import { useState, useEffect, useCallback } from 'react';
import { Model } from '../types';
import { asProvenance, type Provenance } from '../../shared/provenance';
import { bootPref } from '../prefs';

const STORAGE_KEY = 'defaultModel';

export function useModels() {
  const [models, setModels] = useState<Model[]>([]);
  /** P0：这份平台清单的来源 / 取数时刻 / 是否校验过（老服务端为 null） */
  const [modelProvenance, setModelProvenance] = useState<Provenance | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    // A135：服务端注入的默认模型优先，localStorage 只是兜底（打包态每次换源）
    return bootPref('defaultModel') || localStorage.getItem(STORAGE_KEY) || '';
  });

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      setModels(data.models || []);
      // 腐败结构不许升格成「已校验」：asProvenance 只认真布尔 true
      setModelProvenance(asProvenance(data.provenance));
      if (data.models?.length > 0 && !selectedModel) {
        const savedDefault = bootPref('defaultModel') || localStorage.getItem(STORAGE_KEY);
        const modelToUse = savedDefault && data.models.some((m: Model) => m.modelId === savedDefault)
          ? savedDefault
          : (data.defaultModel || data.models[0].modelId);
        setSelectedModel(modelToUse);
        localStorage.setItem(STORAGE_KEY, modelToUse);
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
    }
  }, [selectedModel]);

  // 初始加载
  useEffect(() => {
    fetchModels();
  }, []);

  return {
    models,
    modelProvenance,
    selectedModel,
    setSelectedModel,
    fetchModels,
  };
}
