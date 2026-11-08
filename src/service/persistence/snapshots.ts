import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type {
    AgenticMemorySnapshotItem,
    MemoryScope,
    MemorySnapshotRecord
} from '../../contracts/memory.ts'
import type { SnapshotRepository } from '../../contracts/workflows.ts'

export class LivingMemorySnapshotRepository implements SnapshotRepository {
    constructor(private readonly ctx: Context) {}

    /** 驱动就绪后才有 `database` 服务；仓储实例只在驱动加载后创建。 */
    private get database() {
        return this.ctx.get('database')!
    }

    async getLatestSnapshotByScope(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ) {
        const sorted = await this.loadSortedSnapshotsByScope(scope)
        return sorted[0]
    }

    async listSnapshotsByPreset(
        presetId: string
    ): Promise<MemorySnapshotRecord[]> {
        const snapshots = await this.database.get(
            'living_memory_snapshot',
            {
                presetId
            }
        )

        return snapshots.sort(
            (left, right) => +right.createdAt - +left.createdAt
        )
    }

    async upsertSnapshot(
        scope: MemoryScope,
        query: string,
        items: AgenticMemorySnapshotItem[]
    ) {
        const createdAt = new Date()
        const sorted = await this.loadSortedSnapshotsByScope(scope)
        const latest = sorted[0]

        if (latest != null) {
            await this.database.set(
                'living_memory_snapshot',
                { id: latest.id },
                {
                    query,
                    items,
                    createdAt
                }
            )

            const staleIds = sorted.slice(1).map((snapshot) => snapshot.id)
            if (staleIds.length > 0) {
                await this.database.remove('living_memory_snapshot', {
                    id: {
                        $in: staleIds
                    }
                })
            }

            return
        }

        const snapshot: MemorySnapshotRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            query,
            items,
            createdAt
        }

        await this.database.create('living_memory_snapshot', snapshot)
    }

    private async loadSortedSnapshotsByScope(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ): Promise<MemorySnapshotRecord[]> {
        const snapshots = await this.database.get(
            'living_memory_snapshot',
            {
                presetId: scope.presetId,
                conversationId: scope.conversationId
            }
        )

        return snapshots.sort(
            (left, right) => +right.createdAt - +left.createdAt
        )
    }

    async deleteSnapshot(
        snapshotId: string
    ): Promise<MemorySnapshotRecord | undefined> {
        const snapshot = (
            await this.database.get('living_memory_snapshot', {
                id: snapshotId
            })
        )[0]

        if (snapshot == null) {
            return undefined
        }

        await this.database.remove('living_memory_snapshot', {
            id: snapshotId
        })

        return snapshot
    }

    async deleteSnapshotsByConversation(
        conversationId: string
    ): Promise<MemorySnapshotRecord[]> {
        const snapshots = await this.database.get(
            'living_memory_snapshot',
            {
                conversationId
            }
        )

        if (snapshots.length === 0) {
            return []
        }

        await this.database.remove('living_memory_snapshot', {
            id: {
                $in: snapshots.map((snapshot) => snapshot.id)
            }
        })

        return snapshots
    }

    async deleteSnapshotsByPreset(presetId: string) {
        await this.database.remove('living_memory_snapshot', { presetId })
    }
}
