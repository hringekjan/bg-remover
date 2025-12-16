import { useState, useCallback } from 'react';
import { ProductIdentityService } from '../services/ProductIdentityService';
import type {
  ProductIdentitySettings,
  ProductGroup,
  GroupingResult,
} from '../types/product-identity-settings';
import { DEFAULT_SETTINGS } from '../types/product-identity-settings';

interface ImageData {
  id: string;
  url: string;
}

export interface UseProductIdentityClusteringReturn {
  groups: ProductGroup[];
  ungroupedImages: string[];
  isProcessing: boolean;
  error: string | null;
  progress: number;
  processingTime: number;
  cacheHitRate: number;

  // Actions
  triggerClustering: (images: ImageData[], settings?: ProductIdentitySettings) => Promise<void>;
  updateGroupName: (groupId: string, name: string) => void;
  splitGroup: (groupId: string) => void;
  mergeGroups: (groupIds: string[]) => void;
  removeImageFromGroup: (groupId: string, imageId: string) => void;
  createManualGroup: (imageIds: string[], name?: string) => void;
  reset: () => void;
}

export function useProductIdentityClustering(): UseProductIdentityClusteringReturn {
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [ungroupedImages, setUngroupedImages] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [processingTime, setProcessingTime] = useState(0);
  const [cacheHitRate, setCacheHitRate] = useState(0);

  const triggerClustering = useCallback(
    async (images: ImageData[], settings: ProductIdentitySettings = DEFAULT_SETTINGS) => {
      setIsProcessing(true);
      setError(null);
      setProgress(0);

      try {
        const service = new ProductIdentityService(settings);

        // Simulate progress updates
        const progressInterval = setInterval(() => {
          setProgress(prev => Math.min(prev + 10, 90));
        }, 100);

        const result: GroupingResult = await service.groupImages(images);

        clearInterval(progressInterval);
        setProgress(100);

        setGroups(result.groups);
        setUngroupedImages(result.ungroupedImages);
        setProcessingTime(result.processingTime);
        setCacheHitRate(result.cacheHitRate ?? 0);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Clustering failed');
        console.error('Product identity clustering error:', err);
      } finally {
        setIsProcessing(false);
      }
    },
    []
  );

  const updateGroupName = useCallback((groupId: string, name: string) => {
    setGroups(prev =>
      prev.map(g => g.id === groupId ? { ...g, name } : g)
    );
  }, []);

  const splitGroup = useCallback((groupId: string) => {
    setGroups(prev => {
      const group = prev.find(g => g.id === groupId);
      if (!group || group.imageIds.length < 2) return prev;

      const midpoint = Math.floor(group.imageIds.length / 2);
      const group1: ProductGroup = {
        ...group,
        id: crypto.randomUUID(),
        imageIds: group.imageIds.slice(0, midpoint),
        groupType: 'split',
        metadata: {
          ...group.metadata!,
          memberCount: midpoint,
        },
      };

      const group2: ProductGroup = {
        ...group,
        id: crypto.randomUUID(),
        imageIds: group.imageIds.slice(midpoint),
        groupType: 'split',
        metadata: {
          ...group.metadata!,
          memberCount: group.imageIds.length - midpoint,
        },
      };

      return [...prev.filter(g => g.id !== groupId), group1, group2];
    });
  }, []);

  const mergeGroups = useCallback((groupIds: string[]) => {
    if (groupIds.length < 2) return;

    setGroups(prev => {
      const groupsToMerge = prev.filter(g => groupIds.includes(g.id));
      if (groupsToMerge.length < 2) return prev;

      const mergedImageIds = groupsToMerge.flatMap(g => g.imageIds);
      const avgConfidence =
        groupsToMerge.reduce((sum, g) => sum + g.confidence, 0) / groupsToMerge.length;

      const mergedGroup: ProductGroup = {
        id: crypto.randomUUID(),
        imageIds: mergedImageIds,
        averageSimilarity: avgConfidence,
        confidence: avgConfidence,
        groupType: 'merged',
        metadata: {
          memberCount: mergedImageIds.length,
          minSimilarity: Math.min(...groupsToMerge.map(g => g.metadata?.minSimilarity ?? 0)),
          maxSimilarity: Math.max(...groupsToMerge.map(g => g.metadata?.maxSimilarity ?? 1)),
        },
      };

      return [...prev.filter(g => !groupIds.includes(g.id)), mergedGroup];
    });
  }, []);

  const removeImageFromGroup = useCallback((groupId: string, imageId: string) => {
    setGroups(prev =>
      prev.map(g => {
        if (g.id !== groupId) return g;
        const newImageIds = g.imageIds.filter(id => id !== imageId);
        return {
          ...g,
          imageIds: newImageIds,
          metadata: {
            ...g.metadata!,
            memberCount: newImageIds.length,
          },
        };
      }).filter(g => g.imageIds.length > 0)
    );

    setUngroupedImages(prev => [...prev, imageId]);
  }, []);

  const createManualGroup = useCallback((imageIds: string[], name?: string) => {
    const manualGroup: ProductGroup = {
      id: crypto.randomUUID(),
      imageIds,
      averageSimilarity: 1.0,
      confidence: 1.0,
      groupType: 'manual',
      name,
      metadata: {
        memberCount: imageIds.length,
        minSimilarity: 1.0,
        maxSimilarity: 1.0,
      },
    };

    setGroups(prev => [...prev, manualGroup]);
    setUngroupedImages(prev => prev.filter(id => !imageIds.includes(id)));
  }, []);

  const reset = useCallback(() => {
    setGroups([]);
    setUngroupedImages([]);
    setError(null);
    setProgress(0);
    setProcessingTime(0);
    setCacheHitRate(0);
  }, []);

  return {
    groups,
    ungroupedImages,
    isProcessing,
    error,
    progress,
    processingTime,
    cacheHitRate,
    triggerClustering,
    updateGroupName,
    splitGroup,
    mergeGroups,
    removeImageFromGroup,
    createManualGroup,
    reset,
  };
}
