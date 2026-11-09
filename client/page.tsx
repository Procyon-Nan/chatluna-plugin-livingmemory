import * as React from 'react'
import {
    Badge,
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Field,
    FieldLabel,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    Tooltip,
    TooltipContent,
    TooltipTrigger
} from '@chatluna/ui-kit'
import {
    apiErrorMessage,
    callAction,
    toast,
    useLive,
    useTranslate
} from '@chatluna/ui-client/client'
import type { Translate } from '@chatluna/ui-client/client'
import { PresetActions } from './preset-actions.tsx'
import { SettingsPanel } from './settings-panel.tsx'
import { MemoryEntryEditor } from './memory-entry-editor.tsx'
import { MemoryDeletionDialog, type DeleteMemoriesTarget } from './memory-deletion-dialog.tsx'
import type { MemoryListFilter } from '../src/contracts/rpc.ts'
import type {
    LivingMemoryEntryView,
    LivingMemoryJobView,
    LivingMemoryPersonaView,
    LivingMemoryProfileView,
    LivingMemorySearchHitView,
    LivingMemorySnapshotView
} from '../src/contracts/webui.ts'
import {
    memoryEntryTypes,
    type MemoryEntryRecord
} from '../src/contracts/memory.ts'

const LOCALE_NS = 'livingmemory'
const PAGE_SIZE = 20

const useT = (): Translate => useTranslate(LOCALE_NS)

const report = (error: unknown) => toast.error(apiErrorMessage(error))

const formatTime = (at: number | null | undefined) => {
    if (at == null) return '—'
    const date = new Date(at)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

type StatusFilter = 'active' | 'archived' | 'all'
type Tab =
    | 'entries'
    | 'profiles'
    | 'personas'
    | 'snapshots'
    | 'jobs'
    | 'search'
    | 'settings'

/** 管理页：记忆检索与编辑、任务列表、人设卡片、预设导入导出。 */
export function LivingMemoryPage() {
    const t = useT()
    const status = useLive('livingmemory.status')
    const presets = status.data?.presets ?? []
    const [selection, setSelection] = React.useState<{ presetId: string | undefined; status: StatusFilter; revision: number }>({
        presetId: undefined, status: 'active', revision: 0
    })
    const [creating, setCreating] = React.useState(false)
    const [clearTarget, setClearTarget] = React.useState<string>()
    const [tab, setTab] = React.useState<Tab>('entries')

    const active = selection.presetId ?? presets[0]

    function selectPreset(presetId?: string, status: StatusFilter = 'active') {
        setSelection(previous => ({ presetId, status, revision: previous.revision + 1 }))
    }

    function renderPanel() {
        if (tab === 'settings') return null
        if (active === undefined) return (
            <div className="flex flex-col items-center gap-3">
                <EmptyState title={t('empty.noPreset')} />
                {tab === 'entries' && <Button onClick={() => setCreating(true)}>{t('entries.create')}</Button>}
            </div>
        )
        switch (tab) {
            case 'entries':
                return <EntriesPanel key={`${selection.revision}:${active}`} presetId={active} initialStatus={selection.status}
                    onCreate={() => setCreating(true)} />
            case 'profiles':
                return <ProfilesPanel presetId={active} />
            case 'personas':
                return <PersonaPanel key={active} presetId={active} />
            case 'snapshots':
                return <SnapshotsPanel presetId={active} />
            case 'jobs':
                return <JobsPanel presetId={active} />
            case 'search':
                return <SearchPanel presetId={active} />
        }
    }

    return (
        <div className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
            <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-2">
                <nav className="flex max-w-full items-center gap-1 overflow-x-auto" aria-label={t('tab.navigation')}>
                    {(['entries', 'profiles', 'personas', 'snapshots', 'jobs', 'search', 'settings'] as const).map(key => (
                        <button key={key} type="button" aria-current={tab === key ? 'page' : undefined}
                            className="shrink-0 border-b-2 border-transparent px-2 py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-ring focus-visible:-outline-offset-2 aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                            onClick={() => setTab(key)}>
                            {t(`tab.${key}`)}
                        </button>
                    ))}
                </nav>
                {tab !== 'settings' && <div className="flex flex-wrap items-center gap-2">
                    <PresetPicker presets={presets} value={active} onChange={selectPreset} />
                    <PresetActions presetId={active} onClear={setClearTarget} />
                </div>}
            </header>
            {creating && (
                <MemoryEntryEditor presetId={active ?? ''} presets={presets}
                    onClose={() => setCreating(false)}
                    onSaved={({ presetId, status }) => {
                        selectPreset(presetId, status)
                        setCreating(false)
                        setTab('entries')
                    }} />
            )}
            {clearTarget !== undefined && (
                <MemoryDeletionDialog target={{ kind: 'preset', presetId: clearTarget }}
                    onClose={() => setClearTarget(undefined)}
                    onDeleted={() => {
                        setClearTarget(undefined)
                        selectPreset()
                        setTab('entries')
                    }} />
            )}
            <Warnings warnings={status.data?.warnings ?? []} />
            {renderPanel()}
            <React.Activity mode={tab === 'settings' ? 'visible' : 'hidden'}>
                <SettingsPanel />
            </React.Activity>
        </div>
    )
}

function PresetPicker({
    presets,
    value,
    onChange
}: {
    presets: string[]
    value: string | undefined
    onChange(presetId: string): void
}) {
    const t = useT()
    return (
        <Select value={value ?? null} onValueChange={(next) => { if (next !== null) onChange(next) }}>
            <SelectTrigger className="w-40" aria-label={t('field.preset')}>
                <SelectValue placeholder={t('preset.placeholder')}>{value}</SelectValue>
            </SelectTrigger>
            <SelectContent>
                {presets.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                        {preset}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}

function Warnings({
    warnings
}: {
    warnings: readonly { code: string; message: string }[]
}) {
    if (warnings.length === 0) return null
    return (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
            ))}
        </ul>
    )
}

function EntriesPanel({ presetId, initialStatus, onCreate }: { presetId: string; initialStatus: StatusFilter; onCreate(): void }) {
    const t = useT()
    const [status, setStatus] = React.useState<StatusFilter>(initialStatus)
    const [type, setType] = React.useState<string>('all')
    const [keyword, setKeyword] = React.useState('')
    const filter: MemoryListFilter = { presetId, status }
    if (type !== 'all') filter.type = type as MemoryEntryRecord['type']
    if (keyword.trim()) filter.keyword = keyword.trim()
    const speakers = useLive('livingmemory.speakers', { presetId })
    const names = new Map(speakers.data?.map((speaker) => [speaker.speakerKey, speaker.speakerLabel]))

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="h-[30px] w-full sm:w-64"
                    value={keyword}
                    placeholder={t('entries.search')}
                    onChange={(event) => setKeyword(event.target.value)}
                />
                <Select
                    value={status}
                    onValueChange={(next) => setStatus(next as StatusFilter)}
                >
                    <SelectTrigger className="w-28">
                        <SelectValue>{t(`status.${status}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="active">{t('status.active')}</SelectItem>
                        <SelectItem value="archived">{t('status.archived')}</SelectItem>
                        <SelectItem value="all">{t('status.all')}</SelectItem>
                    </SelectContent>
                </Select>
                <Select value={type} onValueChange={(next) => setType(next as string)}>
                    <SelectTrigger className="w-28">
                        <SelectValue>{t(`type.${type}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">{t('type.all')}</SelectItem>
                        {memoryEntryTypes.map((item) => (
                            <SelectItem key={item} value={item}>
                                {t(`type.${item}`)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                    <Button variant="outline" onClick={() => void callAction('livingmemory.rebuildIndex', { presetId }).catch(report)}>
                        {t('jobs.rebuildIndex')}
                    </Button>
                    <RunDreamButton presetId={presetId} />
                    <Button onClick={onCreate}>{t('entries.create')}</Button>
                </div>
            </div>
            <EntriesList key={JSON.stringify(filter)} filter={filter} names={names} />
        </div>
    )
}

function EntriesList({ filter, names }: { filter: MemoryListFilter; names: Map<string, string> }) {
    const t = useT()
    const { presetId } = filter
    const [page, setPage] = React.useState(1)
    const [editing, setEditing] = React.useState<LivingMemoryEntryView>()
    const [selected, setSelected] = React.useState(() => new Map<string, MemoryEntryRecord['status']>())
    const [selecting, setSelecting] = React.useState(false)
    const [deletion, setDeletion] = React.useState<DeleteMemoriesTarget>()
    const entries = useLive('livingmemory.entries', { ...filter, page, pageSize: PAGE_SIZE })
    const items = entries.data?.entries ?? []
    const total = entries.data?.total ?? 0
    const selectedOnPage = items.filter(entry => selected.has(entry.id)).length
    const pageSelected = items.length > 0 && selectedOnPage === items.length
    const multiplePages = total > PAGE_SIZE
    const selectPageId = React.useId()
    const activeIds = [...selected].filter(([, status]) => status === 'active').map(([id]) => id)
    React.useEffect(() => {
        if (!entries.data) return
        const { entries: rows, total } = entries.data
        setPage(current => Math.min(current, Math.max(1, Math.ceil(total / PAGE_SIZE))))
        const statuses = new Map(rows.map(row => [row.id, row.status]))
        setSelected(previous => {
            const next = new Map(previous)
            for (const [id, status] of previous) {
                // 当前页包含全部结果时，消失的 ID 才能确认为已移出筛选。
                if ((rows.length === total || statuses.has(id)) && statuses.get(id) !== status) next.delete(id)
            }
            return next.size === previous.size ? previous : next
        })
    }, [entries.data])

    function selectRows(rows: Pick<MemoryEntryRecord, 'id' | 'status'>[], checked: boolean) {
        setSelected(previous => {
            const next = new Map(previous)
            for (const { id, status } of rows) {
                if (checked) next.set(id, status)
                else next.delete(id)
            }
            return next
        })
    }

    async function selectMatches() {
        setSelecting(true)
        try {
            const rows = await callAction('livingmemory.listMemorySelection', filter)
            setSelected(new Map(rows.map(row => [row.id, row.status])))
        } catch (error) {
            report(error)
        } finally {
            setSelecting(false)
        }
    }

    function deselectIds(ids: string[]) {
        setSelected(previous => {
            const next = new Map(previous)
            for (const id of ids) next.delete(id)
            return next
        })
    }

    async function archive(ids: string[]) {
        setSelecting(true)
        try {
            const { archived } = await callAction('livingmemory.archiveMemories', { presetId, ids })
            deselectIds(ids)
            toast.success(t('entries.archivedCount', { count: archived }))
        } catch (error) {
            report(error)
        } finally {
            setSelecting(false)
        }
    }

    return (
        <div className="@container flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 px-3 text-sm">
                <div className="flex items-center gap-2">
                    <Checkbox id={selectPageId} disabled={selecting || !items.length} checked={pageSelected}
                        indeterminate={selectedOnPage > 0 && !pageSelected}
                        className="data-indeterminate:border-primary data-indeterminate:before:h-0.5 data-indeterminate:before:w-2 data-indeterminate:before:bg-primary data-indeterminate:[&>span]:hidden"
                        onCheckedChange={checked => selectRows(items, checked)} />
                    <label htmlFor={selectPageId}>{t(multiplePages ? 'deletion.selectPage' : 'deletion.selectAll')}</label>
                </div>
                {pageSelected && multiplePages && selected.size < total && (
                    <Button size="sm" variant="link" disabled={selecting} onClick={() => void selectMatches()}>
                        {t('deletion.selectMatches', { count: total })}
                    </Button>
                )}
                {selected.size > 0 && <>
                    <span className="text-muted-foreground">{t('deletion.selected', { count: selected.size })}</span>
                    {multiplePages && <Button size="sm" variant="ghost" disabled={selecting}
                        onClick={() => setSelected(new Map())}>{t('deletion.deselect')}</Button>}
                    {activeIds.length > 0 ? (
                        <Button size="sm" variant="outline" disabled={selecting} onClick={() => void archive(activeIds)}>
                            {t('entries.archiveCount', { count: activeIds.length })}
                        </Button>
                    ) : (
                        <Button size="sm" variant="outline" disabled={selecting}
                            onClick={() => setDeletion({ kind: 'entries', presetId, ids: [...selected.keys()] })}>
                            {t('entries.purge')}
                        </Button>
                    )}
                </>}
                <span className="ml-auto text-sm opacity-70">{t('entries.total', { count: total })}</span>
            </div>
            {items.length === 0 ? (
                <EmptyState title={t('entries.empty')} />
            ) : (
                <ul className="grid min-h-0 flex-1 grid-cols-1 content-start gap-3 overflow-y-auto @min-[38rem]:grid-cols-2 @min-[57rem]:grid-cols-3 @min-[76rem]:grid-cols-4">
                    {items.map(entry => (
                        <MemoryCard key={entry.id} entry={entry} names={names}
                            selected={selected.has(entry.id)} selecting={selecting}
                            onSelect={checked => selectRows([entry], checked)}
                            onEdit={() => setEditing(entry)}
                            onArchive={() => void archive([entry.id])}
                            onDelete={() => setDeletion({
                                kind: 'entries', presetId, ids: [entry.id], preview: entry.summary || entry.content
                            })} />
                    ))}
                </ul>
            )}
            <Pager
                page={page}
                pageSize={PAGE_SIZE}
                total={entries.data?.total ?? 0}
                onChange={setPage}
            />
            {editing !== undefined && (
                <MemoryEntryEditor presetId={presetId} entry={editing}
                    onSaved={({ status }) => {
                        if (editing.status !== status) deselectIds([editing.id])
                        setEditing(undefined)
                    }} onClose={() => setEditing(undefined)} />
            )}
            {deletion && (
                <MemoryDeletionDialog target={deletion} onClose={() => setDeletion(undefined)}
                    onDeleted={() => {
                        deselectIds(deletion.ids)
                        setDeletion(undefined)
                    }} />
            )}
        </div>
    )
}

interface MemoryCardProps {
    entry: LivingMemoryEntryView
    names: ReadonlyMap<string, string>
    selected: boolean
    selecting: boolean
    onSelect(checked: boolean): void
    onEdit(): void
    onArchive(): void
    onDelete(): void
}

function MemoryCard({ entry, names, selected, selecting, onSelect, onEdit, onArchive, onDelete }: MemoryCardProps) {
    const t = useT()
    const speakers = entry.speakerKeys.map(key => names.get(key) ?? key).join(', ')

    return (
        <li data-selected={selected}
            className="row-span-4 grid min-w-0 grid-rows-subgrid gap-y-0 rounded-xl border border-border bg-card text-card-foreground data-[selected=true]:border-primary">
            <div className="flex flex-wrap items-center gap-2 px-3 pt-3 pb-2.5 text-xs text-muted-foreground">
                <Checkbox aria-label={t('deletion.selectEntry', { label: entry.summary || entry.content })}
                    disabled={selecting} checked={selected} onCheckedChange={onSelect} />
                <Badge variant="secondary">{t(`type.${entry.type}`)}</Badge>
                <span>{t(`status.${entry.status}`)}</span>
                <span className="ml-auto">{t('field.createdAt')} {formatTime(entry.createdAt)}</span>
            </div>
            {entry.summary && <h2 className="px-3 pb-1.5 text-base font-semibold leading-snug [overflow-wrap:anywhere]">{entry.summary}</h2>}
            <div className="row-start-3 flex flex-col gap-2.5 px-3 pb-3">
                <MemoryBody content={entry.content} />
                {entry.keywords.length > 0 && (
                    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {entry.keywords.map(word => <li key={word} className="min-w-0 [overflow-wrap:anywhere]">#{word}</li>)}
                    </ul>
                )}
                <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5 border-t border-border pt-2 text-xs leading-relaxed [overflow-wrap:anywhere]">
                    <dt className="text-muted-foreground">{t('field.importance')}</dt>
                    <dd>{entry.importance ?? '—'}</dd>
                    {entry.sentiment && <>
                        <dt className="text-muted-foreground">{t('field.sentiment')}</dt>
                        <dd>{entry.sentiment}</dd>
                    </>}
                    <dt className="text-muted-foreground">{t('field.speakers')}</dt>
                    <dd>{speakers || t('entries.noSpeakers')}</dd>
                    {entry.sourceLabel && <>
                        <dt className="text-muted-foreground">{t('field.source')} ·</dt>
                        <dd>{entry.sourceLabel}</dd>
                    </>}
                </dl>
            </div>
            <footer className="row-start-4 flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t border-border bg-muted/30 px-3 py-1.5">
                <span className="text-xs text-muted-foreground">{t('field.updatedAt')} {formatTime(entry.updatedAt)}</span>
                <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={onEdit}>{t('entries.edit')}</Button>
                    {entry.status === 'active' ? (
                        <Button size="sm" variant="outline" disabled={selecting} onClick={onArchive}>{t('entries.archive')}</Button>
                    ) : (
                        <Button size="sm" variant="outline" disabled={selecting} onClick={onDelete}>{t('entries.purge')}</Button>
                    )}
                </div>
            </footer>
        </li>
    )
}

function MemoryBody({ content }: { content: string }) {
    const text = React.useRef<HTMLParagraphElement>(null)
    const popup = React.useRef<HTMLDivElement>(null)
    const [truncated, setTruncated] = React.useState(false)

    function scrollPopup(event: React.KeyboardEvent) {
        const panel = popup.current
        if (!panel || panel.scrollHeight <= panel.clientHeight || event.altKey || event.ctrlKey || event.metaKey) return
        // 键盘焦点保留在触发器，翻页和方向键滚动当前全文。
        switch (event.key) {
            case 'ArrowDown': panel.scrollTop += 24; break
            case 'ArrowUp': panel.scrollTop -= 24; break
            case 'PageDown': panel.scrollTop += panel.clientHeight; break
            case 'PageUp': panel.scrollTop -= panel.clientHeight; break
            case 'Home': panel.scrollTop = 0; break
            case 'End': panel.scrollTop = panel.scrollHeight; break
            default: return
        }
        event.preventDefault()
    }

    React.useLayoutEffect(() => {
        const paragraph = text.current!
        // 观察完整段落，换行或字体变化时都按实际高度判断。
        const measure = () => setTruncated(paragraph.offsetHeight > paragraph.parentElement!.clientHeight)
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(paragraph)
        return () => observer.disconnect()
    }, [content])

    return (
        <div className="grow text-sm leading-6 text-card-foreground/85">
            <Tooltip>
                <TooltipTrigger render={<div />} disabled={!truncated} tabIndex={truncated ? 0 : -1} onKeyDown={scrollPopup}>
                    <div className="max-h-[3lh] overflow-hidden">
                        <p ref={text} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{content}</p>
                    </div>
                    {truncated && <span aria-hidden="true" className="block text-muted-foreground">…</span>}
                </TooltipTrigger>
                {truncated && (
                    <TooltipContent ref={popup} side="bottom" align="start"
                        className="block max-h-[min(55vh,var(--available-height))] max-w-[min(32rem,var(--available-width))] overflow-y-auto whitespace-pre-wrap px-3 py-2 text-sm leading-6 [overflow-wrap:anywhere]">
                        {content}
                    </TooltipContent>
                )}
            </Tooltip>
        </div>
    )
}

function ProfilesPanel({ presetId }: { presetId: string }) {
    const t = useT()
    const [page, setPage] = React.useState(1)
    const [editing, setEditing] = React.useState<LivingMemoryProfileView>()
    const profiles = useLive('livingmemory.profiles', {
        presetId,
        page,
        pageSize: PAGE_SIZE
    })
    const items = profiles.data?.profiles ?? []

    React.useEffect(() => setPage(1), [presetId])

    if (items.length === 0) return <EmptyState title={t('profiles.empty')} />

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {items.map((profile) => (
                    <li
                        key={profile.id}
                        className="flex flex-col gap-1 rounded-md border border-border p-3"
                    >
                        <div className="flex items-center gap-2">
                            <span className="font-medium">
                                {profile.speakerLabel}
                            </span>
                            <Badge variant="outline">
                                {t('profiles.sourceCount', {
                                    count: profile.sourceMemoryIds.length
                                })}
                            </Badge>
                            <span className="ml-auto text-xs opacity-60">
                                {formatTime(profile.updatedAt)}
                            </span>
                        </div>
                        <p className="line-clamp-4 whitespace-pre-wrap text-sm opacity-80">
                            {profile.content}
                        </p>
                        <div className="flex gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setEditing(profile)}
                            >
                                {t('common.edit')}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    void callAction(
                                        'livingmemory.regenerateProfile',
                                        {
                                            presetId,
                                            speakerKey: profile.speakerKey
                                        }
                                    ).catch(report)
                                }
                            >
                                {t('profiles.regenerate')}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    void callAction(
                                        'livingmemory.deleteProfile',
                                        { id: profile.id }
                                    ).catch(report)
                                }
                            >
                                {t('profiles.delete')}
                            </Button>
                        </div>
                    </li>
                ))}
            </ul>
            <Pager
                page={page}
                pageSize={PAGE_SIZE}
                total={profiles.data?.total ?? 0}
                onChange={setPage}
            />
            {editing !== undefined && (
                <ProfileDialog
                    profile={editing}
                    onClose={() => setEditing(undefined)}
                />
            )}
        </div>
    )
}

function ProfileDialog({
    profile,
    onClose
}: {
    profile: LivingMemoryProfileView
    onClose(): void
}) {
    const t = useT()
    const [content, setContent] = React.useState(profile.content)
    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{profile.speakerLabel}</DialogTitle>
                    <DialogDescription>
                        {t('profiles.hint')}
                    </DialogDescription>
                </DialogHeader>
                <Textarea
                    rows={16}
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onClose}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        onClick={() =>
                            void callAction('livingmemory.updateProfile', {
                                id: profile.id,
                                content
                            })
                                .then(onClose)
                                .catch(report)
                        }
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}

function SnapshotsPanel({ presetId }: { presetId: string }) {
    const t = useT()
    const [page, setPage] = React.useState(1)
    const snapshots = useLive('livingmemory.snapshots', {
        presetId,
        page,
        pageSize: PAGE_SIZE
    })
    const items = snapshots.data?.snapshots ?? []

    React.useEffect(() => setPage(1), [presetId])

    if (items.length === 0) return <EmptyState title={t('snapshots.empty')} />

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {items.map((snapshot) => (
                    <SnapshotRow
                        key={snapshot.id}
                        snapshot={snapshot}
                    />
                ))}
            </ul>
            <Pager
                page={page}
                pageSize={PAGE_SIZE}
                total={snapshots.data?.total ?? 0}
                onChange={setPage}
            />
        </div>
    )
}

function SnapshotRow({ snapshot }: { snapshot: LivingMemorySnapshotView }) {
    const t = useT()
    function deleteSnapshot() {
        void callAction('livingmemory.deleteSnapshot', { id: snapshot.id }).catch(report)
    }
    return (
        <li className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-words font-medium">
                    {snapshot.conversationLabel ?? t('snapshots.conversation', { id: snapshot.conversationId })}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                    {formatTime(snapshot.createdAt)}
                </span>
                <Button size="sm" variant="ghost" onClick={deleteSnapshot}>
                    {t('common.delete')}
                </Button>
            </div>
            <p className="whitespace-pre-wrap break-words">{snapshot.content || t('snapshots.noContent')}</p>
            <details className="border-t border-border pt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">{t('snapshots.details')}</summary>
                <div className="mt-3 flex flex-col gap-3">
                    <section>
                        <h4 className="font-medium">{t('snapshots.searchTexts')}</h4>
                        <SnapshotSearchTerms searchTexts={snapshot.searchTexts} searchKeywords={snapshot.searchKeywords} />
                    </section>
                    <section>
                        <h4 className="font-medium">{t('snapshots.matches', { count: snapshot.matchedMemories.length })}</h4>
                        <ol className="list-decimal space-y-1 pl-5">
                            {snapshot.matchedMemories.map((memory, index) => (
                                <li key={index} className="whitespace-pre-wrap break-words">
                                    <Badge variant="outline" className="mr-2">{t(`type.${memory.type}`)}</Badge>{memory.content}
                                </li>
                            ))}
                        </ol>
                    </section>
                </div>
            </details>
        </li>
    )
}

function SnapshotSearchTerms({ searchTexts, searchKeywords }: Pick<LivingMemorySnapshotView, 'searchTexts' | 'searchKeywords'>) {
    const t = useT()
    if (searchTexts.length === 0 && searchKeywords.length === 0) return <p>{t('snapshots.noSearch')}</p>
    return (
        <>
            <ul className="list-disc space-y-1 pl-5">
                {searchTexts.map(text => <li key={text} className="break-words">{text}</li>)}
            </ul>
            {searchKeywords.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                    {searchKeywords.map(word => <Badge key={word} variant="outline">{word}</Badge>)}
                </div>
            )}
        </>
    )
}

function SearchPanel({ presetId }: { presetId: string }) {
    const t = useT()
    const [text, setText] = React.useState('')
    const [keyword, setKeyword] = React.useState('')
    const [type, setType] = React.useState<string>('all')
    const [hits, setHits] = React.useState<LivingMemorySearchHitView[]>()
    const [searching, setSearching] = React.useState(false)

    const run = () => {
        setSearching(true)
        const keywords = keyword
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        void callAction('livingmemory.search', {
            presetId,
            searchTexts: [text],
            ...(keywords.length === 0 ? {} : { searchKeywords: keywords }),
            ...(type === 'all'
                ? {}
                : { memoryTypes: [type as MemoryEntryRecord['type']] })
        })
            .then((result) => setHits(result.hits))
            .catch(report)
            .finally(() => setSearching(false))
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="w-64"
                    value={text}
                    placeholder={t('search.text')}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') run()
                    }}
                />
                <Input
                    className="w-48"
                    value={keyword}
                    placeholder={t('search.keywords')}
                    onChange={(event) => setKeyword(event.target.value)}
                />
                <Select
                    value={type}
                    onValueChange={(next) => setType(next as string)}
                >
                    <SelectTrigger className="w-32">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">{t('type.all')}</SelectItem>
                        {memoryEntryTypes.map((item) => (
                            <SelectItem key={item} value={item}>
                                {t(`type.${item}`)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button
                    disabled={searching || text.trim().length === 0}
                    onClick={run}
                >
                    {t('search.run')}
                </Button>
            </div>
            {hits?.length === 0 && <EmptyState title={t('search.empty')} />}
            {hits && hits.length > 0 && (
                <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                    {hits.map((hit, index) => (
                        <li
                            key={hit.id}
                            className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm"
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-xs opacity-60">
                                    #{index + 1}
                                </span>
                                <Badge variant="outline">
                                    {t(`type.${hit.type}`)}
                                </Badge>
                                <span className="ml-auto text-xs opacity-60">
                                    {t('search.scores', {
                                        cosine: hit.cosineScore.toFixed(4),
                                        keyword: hit.keywordMatchCount,
                                        boosted: hit.boostedScore.toFixed(4)
                                    })}
                                </span>
                            </div>
                            <p className="whitespace-pre-wrap break-words opacity-80">
                                {hit.summary ?? hit.content}
                            </p>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

function RunDreamButton({ presetId }: { presetId: string }) {
    const t = useT()
    const [pending, setPending] = React.useState(false)
    async function run() {
        setPending(true)
        try {
            const result = await callAction('livingmemory.dream', { presetId })
            if (result.started) toast.success(t('jobs.dreamStarted', { preset: presetId }))
            else if (result.reason === 'preset-locked') toast.info(t('jobs.dreamRunning', { preset: presetId }))
            else if (result.reason === 'insufficient-memories') toast.info(t('jobs.dreamInsufficient', { preset: presetId }))
        } catch (error) {
            report(error)
        } finally {
            setPending(false)
        }
    }
    return <Button variant="outline" disabled={pending} onClick={run}>{t('jobs.dream')}</Button>
}

function JobsPanel({ presetId }: { presetId: string }) {
    const t = useT()
    const jobs = useLive('livingmemory.jobs', { presetId })
    const items = jobs.data ?? []
    if (items.length === 0) return <EmptyState title={t('jobs.empty')} />
    return (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {items.map(job => <JobRow key={job.id} job={job} />)}
        </ul>
    )
}

function JobRow({ job }: { job: LivingMemoryJobView }) {
    const t = useT()
    return (
        <li className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm">
            <div className="flex items-center gap-2">
                <Badge variant="outline">{t(`job.kind.${job.kind}`)}</Badge>
                <Badge
                    variant={job.status === 'failed' ? 'destructive' : 'secondary'}
                >
                    {t(`job.status.${job.status}`)}
                </Badge>
                <span className="ml-auto text-xs opacity-60">
                    {formatTime(job.createdAt)}
                </span>
            </div>
            {job.detail.length > 0 && (
                <p className="whitespace-pre-wrap break-words opacity-80">
                    {job.detail}
                </p>
            )}
            {job.error !== null && (
                <p className="text-destructive">{job.error}</p>
            )}
        </li>
    )
}

function PersonaPanel({ presetId }: { presetId: string }) {
    const t = useT()
    const { data, error } = useLive('livingmemory.persona', { presetId })
    const [editing, setEditing] = React.useState(false)

    if (error) return <EmptyState title={error} />
    if (data === undefined) return null
    const { persona } = data
    if (persona === null) return <EmptyState title={t('personas.empty')} />
    return (
        <article className="space-y-4 rounded-md border border-border p-4">
            <header className="flex flex-wrap items-center gap-2">
                <h2 className="font-medium">{presetId}</h2>
                <Badge variant="outline">{t(`persona.source.${persona.source}`)}</Badge>
                {persona.stale && <Badge variant="secondary">{t('personas.stale')}</Badge>}
                <span className="text-xs text-muted-foreground">{formatTime(persona.updatedAt)}</span>
                <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                        {t('common.edit')}
                    </Button>
                    <Button size="sm" variant="outline"
                        onClick={() => void callAction('livingmemory.resetPersona', { presetId }).catch(report)}>
                        {t('personas.reset')}
                    </Button>
                </div>
            </header>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{persona.card}</p>
            {editing && <PersonaDialog persona={persona} onClose={() => setEditing(false)} />}
        </article>
    )
}

function PersonaDialog({
    persona,
    onClose
}: {
    persona: LivingMemoryPersonaView
    onClose(): void
}) {
    const t = useT()
    const [card, setCard] = React.useState(persona.card)
    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{persona.presetId}</DialogTitle>
                    <DialogDescription>{t('personas.hint')}</DialogDescription>
                </DialogHeader>
                <Textarea
                    rows={16}
                    value={card}
                    onChange={(event) => setCard(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onClose}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        onClick={() =>
                            void callAction('livingmemory.savePersona', {
                                presetId: persona.presetId,
                                card
                            })
                                .then(onClose)
                                .catch(report)
                        }
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}

function Pager({
    page,
    pageSize,
    total,
    onChange
}: {
    page: number
    pageSize: number
    total: number
    onChange(page: number): void
}) {
    const t = useT()
    const pages = Math.max(1, Math.ceil(total / pageSize))
    if (pages <= 1) return null
    return (
        <div className="flex items-center justify-end gap-2 text-sm">
            <Button
                size="sm"
                variant="ghost"
                disabled={page <= 1}
                onClick={() => onChange(page - 1)}
            >
                {t('common.prev')}
            </Button>
            <span className="opacity-70">
                {page} / {pages}
            </span>
            <Button
                size="sm"
                variant="ghost"
                disabled={page >= pages}
                onClick={() => onChange(page + 1)}
            >
                {t('common.next')}
            </Button>
        </div>
    )
}
