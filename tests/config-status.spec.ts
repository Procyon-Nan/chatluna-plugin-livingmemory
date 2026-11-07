import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../src/service.ts'
import {
    createMemoryServiceStatus,
    validateLivingMemoryConfig
} from '../src/service/app/config_status.ts'
import type { MemoryVectorIndexStatus } from '../src/contracts/vector_index.ts'

const configured = {
    ...DEFAULT_CONFIG,
    mainModel: 'provider/model-main',
    subModel: 'provider/model-sub',
    embeddingModel: 'provider/embedding'
}

it('reports no warning when every enabled workflow has its model', () => {
    assert.deepEqual(validateLivingMemoryConfig(configured), [])
})

it('reports the missing recall model at instance level', () => {
    const warnings = validateLivingMemoryConfig({
        ...configured,
        subModel: '  '
    })
    assert.deepEqual(
        warnings.map((warning) => warning.code),
        ['recall-model-missing']
    )
    assert.equal(warnings[0]?.field, 'subModel')
})

it('always requires an embedding model', () => {
    const warnings = validateLivingMemoryConfig({
        ...configured,
        embeddingModel: '无'
    })
    assert.deepEqual(
        warnings.map((warning) => warning.code),
        ['embedding-model-missing']
    )
})

it('reports the missing extraction model at instance level', () => {
    const enabled = validateLivingMemoryConfig({
        ...configured,
        mainModel: ''
    })
    assert.deepEqual(
        enabled.map((warning) => warning.code),
        ['extract-model-missing']
    )
})

it('lists every missing model in one status payload', () => {
    const vectorIndex: MemoryVectorIndexStatus = {
        state: 'idle',
        manifest: null,
        presets: [],
        currentJobId: null,
        lastError: null
    }
    const status = createMemoryServiceStatus(
        { ...DEFAULT_CONFIG, mainModel: '无', subModel: '无', embeddingModel: '无' },
        vectorIndex
    )

    assert.deepEqual(
        status.warnings.map((warning) => warning.code),
        ['recall-model-missing', 'embedding-model-missing', 'extract-model-missing']
    )
    assert.equal(status.vectorIndex, vectorIndex)
})