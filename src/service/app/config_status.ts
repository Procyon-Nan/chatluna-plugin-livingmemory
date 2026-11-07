import type { LivingMemoryConfig, MemoryConfigWarning, MemoryServiceStatus } from '../../contracts/workflows.ts'
import type { MemoryVectorIndexStatus } from '../../contracts/vector_index.ts'
import { isModelConfigured } from '../shared/utils.ts'

/** 实例状态只检查模型；自动工作流的开关按每次对话匹配。 */
export const validateLivingMemoryConfig = (
    config: LivingMemoryConfig
): MemoryConfigWarning[] => {
    const warnings: MemoryConfigWarning[] = []

    if (!isModelConfigured(config.subModel)) {
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
    if (!isModelConfigured(config.mainModel)) {
        warnings.push({
            code: 'extract-model-missing',
            field: 'mainModel',
            message:
                '未配置 mainModel；启用自动提取的对话将跳过提取。'
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