import type { LivingMemoryConfig, MemoryConfigWarning, MemoryServiceStatus } from '../../contracts/workflows.ts'
import type { MemoryVectorIndexStatus } from '../../contracts/vector_index.ts'
import { isModelConfigured } from '../shared/utils.ts'

/**
 * 配置自检。照搬 v1 的三条规则：缺模型不阻止加载，但工作流会跳过对应步骤，
 * 因此把「已开启但缺模型」的组合作废条件显式列出，供管理界面提示。
 */
export const validateLivingMemoryConfig = (
    config: LivingMemoryConfig
): MemoryConfigWarning[] => {
    const warnings: MemoryConfigWarning[] = []

    if (
        config.recallIntervalMessages > 0 &&
        !isModelConfigured(config.subModel)
    ) {
        warnings.push({
            code: 'recall-model-missing',
            field: 'subModel',
            message: '未配置 subModel；记忆召回将被跳过。'
        })
    }
    if (!isModelConfigured(config.embeddingModel)) {
        warnings.push({
            code: 'embedding-model-missing',
            field: 'embeddingModel',
            message: '未配置 embeddingModel；记忆召回将失败。'
        })
    }
    if (
        config.extractionWindowMessages > 0 &&
        !isModelConfigured(config.mainModel)
    ) {
        warnings.push({
            code: 'extract-model-missing',
            field: 'mainModel',
            message:
                '自动记忆提取已启用（extractionWindowMessages > 0），但未配置 mainModel；提取流程将被跳过。'
        })
    }

    return warnings
}

export const createMemoryServiceStatus = (
    config: LivingMemoryConfig,
    vectorIndex: MemoryVectorIndexStatus
): MemoryServiceStatus => ({
    warnings: validateLivingMemoryConfig(config),
    vectorIndex
})