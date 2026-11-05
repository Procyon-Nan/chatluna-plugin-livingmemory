import assert from 'node:assert/strict'
import type { MemoryJobRecord } from '../src/contracts/memory.ts'
import { LivingMemoryJobSurface } from '../src/service/app/job_surface.ts'
import { toNativeJob } from '../src/service/app/job_view.ts'
import { logger } from './workflow-test-utils.ts'

const createRecord = (
    overrides: Partial<MemoryJobRecord> = {}
): MemoryJobRecord => {
    const createdAt = new Date('2026-11-05T00:00:00.000Z')
    return {
        id: 'job-1',
        presetId: 'preset-1',
        conversationId: 'dream:manual:preset-1',
        kind: 'dream',
        status: 'completed',
        input: 'manual:preset-1',
        detail: 'checked 10',
        error: null,
        createdAt,
        startedAt: createdAt,
        finishedAt: new Date('2026-11-05T00:01:00.000Z'),
        updatedAt: new Date('2026-11-05T00:01:00.000Z'),
        ...overrides
    }
}

it('projects a job row onto the native MemoryJob shape', () => {
    const job = toNativeJob(createRecord())

    assert.equal(job.id, 'job-1')
    assert.equal(job.kind, 'dream')
    assert.equal(job.status, 'completed')
    assert.equal(job.trigger, 'manual')
    assert.deepEqual(job.scope, {
        presetId: 'preset-1',
        conversationId: 'dream:manual:preset-1'
    })
    assert.equal(job.startedAt, Date.parse('2026-11-05T00:00:00.000Z'))
    assert.equal(job.finishedAt, Date.parse('2026-11-05T00:01:00.000Z'))
    assert.equal(job.error, undefined)
    assert.deepEqual(job.stats, {})
})

it('falls back to the creation time for a job that has not started yet', () => {
    const job = toNativeJob(
        createRecord({ status: 'pending', startedAt: null, finishedAt: null })
    )
    assert.equal(job.startedAt, Date.parse('2026-11-05T00:00:00.000Z'))
    assert.equal(job.finishedAt, undefined)
})

it('maps extraction, recall and index jobs onto their native triggers', () => {
    assert.equal(
        toNativeJob(createRecord({ kind: 'extract', input: 'chat text' }))
            .trigger,
        'window'
    )
    assert.equal(
        toNativeJob(createRecord({ kind: 'recall', input: 'query' })).trigger,
        'window'
    )
    assert.equal(
        toNativeJob(createRecord({ kind: 'index', input: 'rebuild: manual' }))
            .trigger,
        'manual'
    )
    assert.equal(
        toNativeJob(
            createRecord({ input: 'post-extraction:preset-1' })
        ).trigger,
        'window'
    )
})

it('keeps the cancel reason and status visible to the native page', () => {
    const job = toNativeJob(
        createRecord({ status: 'cancelled', error: 'cancel requested' })
    )
    assert.equal(job.status, 'cancelled')
    assert.equal(job.error, 'cancel requested')
})

it('cancels through the injected handler and reports the terminal record', async () => {
    const records = [createRecord({ status: 'running' })]
    const surface = new LivingMemoryJobSurface({
        repository: {
            listJobsByPreset: async () => records,
            getJob: async (id) => records.find((job) => job.id === id),
            watchJobs: () => () => {}
        },
        cancelJob: async (id) => {
            const record = records.find((job) => job.id === id)
            if (record === undefined) return undefined
            Object.assign(record, { status: 'cancelled', error: 'cancel requested' })
            return record
        },
        logger
    })

    assert.deepEqual((await surface.list('preset-1')).map((job) => job.id), [
        'job-1'
    ])
    const cancelled = await surface.cancel('job-1')
    assert.equal(cancelled?.status, 'cancelled')
    assert.equal(cancelled?.error, 'cancel requested')
})

it('reports undefined when the injected handler has nothing to cancel', async () => {
    const surface = new LivingMemoryJobSurface({
        repository: {
            listJobsByPreset: async () => [],
            getJob: async () => undefined,
            watchJobs: () => () => {}
        },
        cancelJob: async () => undefined,
        logger
    })
    assert.equal(await surface.cancel('missing'), undefined)
    assert.equal(await surface.get('missing'), undefined)
})

it('forwards job row changes to native page subscribers', () => {
    let emit!: (job: MemoryJobRecord) => void
    const received: string[] = []
    const surface = new LivingMemoryJobSurface({
        repository: {
            listJobsByPreset: async () => [],
            getJob: async () => undefined,
            watchJobs: (listener) => {
                emit = listener
                return () => {}
            }
        },
        cancelJob: async () => undefined,
        logger
    })
    surface.watch((job) => received.push(`${job.id}:${job.status}`))
    emit(createRecord({ status: 'running' }))
    emit(createRecord({ status: 'completed' }))

    assert.deepEqual(received, ['job-1:running', 'job-1:completed'])
})