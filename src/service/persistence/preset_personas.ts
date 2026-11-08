import type { Context } from 'cordis'
import type {
    PresetPersonaRecord,
    PresetPersonaSource
} from '../../contracts/memory.ts'

export interface PresetPersonaWriteInput {
    presetId: string
    card: string
    rawHash: string
    source: PresetPersonaSource
    totalLines: number
    deletedLines: number
    usedRawFallback: boolean
}

/** 卡片服务按预设串行写入人设卡片，每次更新一行。 */
export class LivingMemoryPresetPersonaRepository {
    constructor(private readonly ctx: Context) {}

    /** 驱动就绪后才有 `database` 服务；仓储实例只在驱动加载后创建。 */
    private get database() {
        return this.ctx.get('database')!
    }

    async getPresetPersona(
        presetId: string
    ): Promise<PresetPersonaRecord | undefined> {
        const rows = await this.database.get(
            'living_memory_preset_persona',
            {
                presetId
            }
        )
        return rows[0]
    }

    async listPresetPersonas(): Promise<PresetPersonaRecord[]> {
        const rows = await this.database.get(
            'living_memory_preset_persona',
            {}
        )
        return rows.sort((left, right) =>
            left.presetId.localeCompare(right.presetId)
        )
    }

    async upsertPresetPersona(input: PresetPersonaWriteInput): Promise<void> {
        await this.database.upsert('living_memory_preset_persona', [
            { ...input, updatedAt: new Date() }
        ])
    }

    async deletePresetPersona(presetId: string): Promise<void> {
        await this.database.remove('living_memory_preset_persona', {
            presetId
        })
    }
}
