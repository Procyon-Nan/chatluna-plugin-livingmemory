import type { Context } from 'cordis'
import type { Session } from 'koishi'
import type {} from 'koishi'
import type { LivingMemoryAdminService } from './admin_service.ts'
import { formatLogScope } from '../logging/logger.ts'

const COMMAND_AUTHORITY = 3

/**
 * `/livingmemory` 命令：按文本或用户归档记忆、删除用户画像。
 * 归档和删除前通过 session.prompt 等待确认；超时取消。
 */
export const livingMemoryCommands = (ctx: Context, admin: LivingMemoryAdminService) => {
    const command = ctx
        .command(
            'livingmemory <preset:string> [operation:string] [filter:string] [value:text]',
            '管理指定预设下的记忆与用户画像',
            { authority: COMMAND_AUTHORITY }
        )
        .option('delete', '-d 删除记忆或用户画像')
        .option('text', '-t <value:text> 按文本匹配记忆')
        .option('user', '-u <value:string> 按用户 ID 匹配记忆')
        .option('profile', '-p <value:string> 按用户 ID 匹配画像')

    command.action(
        async (
            argv,
            preset: string,
            operation: string | undefined,
            filter: string | undefined,
            value: string | undefined
        ) => {
            const session = argv.session
            if (session === undefined) {
                return '该命令只能在会话中使用。'
            }
            const options = argv.options ?? {}
            const selectedFilters = [
                ['text', options.text],
                ['user', options.user],
                ['profile', options.profile]
            ].filter(([, item]) => item != null) as [string, string][]
            const resolvedOperation = options.delete === true ? 'delete' : operation
            const [resolvedFilter, resolvedValue] =
                selectedFilters[0] ?? [filter, value]

            if (
                resolvedOperation !== 'delete' ||
                (resolvedFilter !== 'text' &&
                    resolvedFilter !== 'user' &&
                    resolvedFilter !== 'profile') ||
                resolvedValue == null ||
                selectedFilters.length > 1
            ) {
                return [
                    '命令格式：livingmemory <预设名> delete <text|user|profile> <匹配值>',
                    '简写：livingmemory <预设名> -d -<t|u|p> <匹配值>'
                ].join('\n')
            }

            if (resolvedFilter === 'profile') {
                const profileId = await admin.findUserProfileIdByUser(
                    preset,
                    session.platform,
                    resolvedValue
                )
                if (profileId == null) return '未查询到该用户画像'
                if (!(await confirm(session, '查询到该用户的画像'))) {
                    return '操作取消'
                }
                await admin.deleteUserProfile(profileId)
                return '已删除用户画像'
            }

            const memoryIds =
                resolvedFilter === 'text'
                    ? await admin.findActiveMemoryIdsByText(
                          preset,
                          resolvedValue
                      )
                    : await admin.findActiveMemoryIdsByUser(
                          preset,
                          session.platform,
                          resolvedValue
                      )
            if (memoryIds.length === 0) {
                return '未查询到满足删除条件的记忆'
            }
            if (
                !(await confirm(
                    session,
                    `查询到 ${memoryIds.length} 条满足删除条件的记忆`
                ))
            ) {
                return '操作取消'
            }
            const result = await admin.archiveMemories(preset, memoryIds)
            ctx.logger.info(
                'livingmemory archived by command: %s; archived=%d',
                formatLogScope({ presetId: preset }),
                result.archived
            )
            return `已归档 ${result.archived} 条记忆`
        }
    )
}

/** 发送确认提示并等待回复；非 `ok` 或超时都按取消处理。 */
async function confirm(session: Session, message: string) {
    await session.send(`${message}，输入“ok”以确认删除`)
    const reply = await session.prompt(
        (item: Session) => item.content,
        { timeout: 60_000 }
    )
    return reply === 'ok'
}