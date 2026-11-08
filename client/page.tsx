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
    Textarea
} from '@chatluna/ui-kit'
import {
    apiErrorMessage,
    callAction,
    toast,
    useLive,
    useTranslate
} from '@chatluna/ui-client/client'
import type { Translate } from '@chatluna/ui-client/client'
import { MemoryImportExport } from './memory-import-export.tsx'
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
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

type StatusFilter = 'active' | 'archived' | 'all'
type Tab =
    | 'entries'
    | 'profiles'
    | 'personas'
    | 'snapshots'
    | 'jobs'
    | 'search'

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

    return (
        <div className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                <div className="flex flex-wrap gap-1">
                    {(['entries', 'profiles', 'personas', 'snapshots', 'jobs', 'search'] as const).map(key => (
                        <Button key={key} size="sm" variant={tab === key ? 'default' : 'ghost'}
                            aria-pressed={tab === key} onClick={() => setTab(key)}>
                            {t(`tab.${key}`)}
                        </Button>
                    ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <PresetPicker presets={presets} value={active} onChange={selectPreset} />
                    <Button size="sm" onClick={() => setCreating(true)}>{t('entries.create')}</Button>
                    <MemoryImportExport presetId={active} />
                    <Button size="sm" variant="outline" disabled={!active} onClick={() => setClearTarget(active)}>
                        {t('deletion.clearPreset')}
                    </Button>
                </div>
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
            {active === undefined ? (
                <EmptyState title={t('empty.noPreset')} />
            ) : tab === 'entries' ? (
                <EntriesPanel key={`${selection.revision}:${active}`} presetId={active} initialStatus={selection.status} />
            ) : tab === 'profiles' ? (
                <ProfilesPanel presetId={active} />
            ) : tab === 'snapshots' ? (
                <SnapshotsPanel presetId={active} />
            ) : tab === 'jobs' ? (
                <JobsPanel presetId={active} />
            ) : tab === 'search' ? (
                <SearchPanel presetId={active} />
            ) : (
                <PersonasPanel />
            )}
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
            <SelectTrigger className="w-56">
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

function EntriesPanel({ presetId, initialStatus }: { presetId: string; initialStatus: StatusFilter }) {
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
                    className="w-56"
                    value={keyword}
                    placeholder={t('entries.search')}
                    onChange={(event) => setKeyword(event.target.value)}
                />
                <Select
                    value={status}
                    onValueChange={(next) => setStatus(next as StatusFilter)}
                >
                    <SelectTrigger className="w-32">
                        <SelectValue>{t(`status.${status}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="active">{t('status.active')}</SelectItem>
                        <SelectItem value="archived">{t('status.archived')}</SelectItem>
                        <SelectItem value="all">{t('status.all')}</SelectItem>
                    </SelectContent>
                </Select>
                <Select value={type} onValueChange={(next) => setType(next as string)}>
                    <SelectTrigger className="w-32">
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
    const [selected, setSelected] = React.useState(() => new Set<string>())
    const [selecting, setSelecting] = React.useState(false)
    const [deletion, setDeletion] = React.useState<DeleteMemoriesTarget>()
    const entries = useLive('livingmemory.entries', { ...filter, page, pageSize: PAGE_SIZE })
    const items = entries.data?.entries ?? []
    const total = entries.data?.total
    React.useEffect(() => {
        if (total !== undefined) setPage(current => Math.min(current, Math.max(1, Math.ceil(total / PAGE_SIZE))))
    }, [total])

    function selectIds(ids: string[], checked: boolean) {
        setSelected(previous => {
            const next = new Set(previous)
            for (const id of ids) {
                if (checked) next.add(id)
                else next.delete(id)
            }
            return next
        })
    }

    async function selectMatches() {
        setSelecting(true)
        try {
            setSelected(new Set(await callAction('livingmemory.listMemoryIds', filter)))
        } catch (error) {
            report(error)
        } finally {
            setSelecting(false)
        }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={selecting || items.length === 0}
                    onClick={() => selectIds(items.map(entry => entry.id), true)}>{t('deletion.selectPage')}</Button>
                <Button size="sm" variant="outline" disabled={selecting || !total}
                    onClick={() => void selectMatches()}>{t('deletion.selectAll')}</Button>
                {selected.size > 0 && <>
                    <Button size="sm" variant="ghost" disabled={selecting}
                        onClick={() => setSelected(new Set())}>{t('deletion.deselect')}</Button>
                    <Button size="sm" variant="destructive" disabled={selecting}
                        onClick={() => setDeletion({ kind: 'entries', presetId, ids: [...selected] })}>
                        {t('deletion.deleteSelected', { count: selected.size })}
                    </Button>
                </>}
                <span className="ml-auto text-sm opacity-70">{t('entries.total', { count: total ?? 0 })}</span>
            </div>
            {items.length === 0 ? (
                <EmptyState title={t('entries.empty')} />
            ) : (
                <ul className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(min(100%,28rem),1fr))] content-start gap-4 overflow-y-auto">
                    {items.map(entry => (
                        <MemoryCard key={entry.id} entry={entry} names={names}
                            selected={selected.has(entry.id)} selecting={selecting}
                            onSelect={checked => selectIds([entry.id], checked)}
                            onEdit={() => setEditing(entry)}
                            onArchive={() => void callAction('livingmemory.update', { id: entry.id, status: 'archived' })
                                .then(() => selectIds([entry.id], false)).catch(report)}
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
                    onSaved={() => setEditing(undefined)} onClose={() => setEditing(undefined)} />
            )}
            {deletion && (
                <MemoryDeletionDialog target={deletion} onClose={() => setDeletion(undefined)}
                    onDeleted={() => {
                        selectIds(deletion.ids, false)
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
    const source = entry.sourceLabel || entry.sourceConversationId
    const speakers = entry.speakerKeys.map(key => names.get(key) ?? key).join(', ')

    return (
        <li data-selected={selected}
            className="flex min-w-0 flex-col rounded-xl border border-border bg-card text-card-foreground data-[selected=true]:border-primary">
            <div className="flex flex-col gap-3 p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox aria-label={t('deletion.selectEntry', { label: entry.summary || entry.content })}
                        disabled={selecting} checked={selected} onCheckedChange={onSelect} />
                    <Badge variant="secondary">{t(`type.${entry.type}`)}</Badge>
                    <span>{t(`status.${entry.status}`)}</span>
                    <span className="ml-auto">{t('field.createdAt')} {formatTime(entry.createdAt)}</span>
                </div>
                <div className="space-y-2 [overflow-wrap:anywhere]">
                    {entry.summary && <h2 className="text-base font-semibold leading-snug">{entry.summary}</h2>}
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{entry.content}</p>
                </div>
                {entry.keywords.length > 0 && (
                    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {entry.keywords.map(word => <li key={word} className="min-w-0 [overflow-wrap:anywhere]">#{word}</li>)}
                    </ul>
                )}
                <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 border-t border-border pt-3 text-xs leading-relaxed [overflow-wrap:anywhere]">
                    <dt className="text-muted-foreground">{t('field.importance')}</dt>
                    <dd>{entry.importance ?? '—'}</dd>
                    {entry.sentiment && <>
                        <dt className="text-muted-foreground">{t('field.sentiment')}</dt>
                        <dd>{entry.sentiment}</dd>
                    </>}
                    <dt className="text-muted-foreground">{t('field.speakers')}</dt>
                    <dd>{speakers || t('entries.noSpeakers')}</dd>
                    {source && <>
                        <dt className="text-muted-foreground">{t('field.source')} ·</dt>
                        <dd>{source}</dd>
                    </>}
                </dl>
            </div>
            <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t border-border bg-muted/30 px-4 py-2">
                <span className="text-xs text-muted-foreground">{t('field.updatedAt')} {formatTime(entry.updatedAt)}</span>
                <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={onEdit}>{t('entries.edit')}</Button>
                    {entry.status === 'active' && <Button size="sm" variant="ghost" onClick={onArchive}>{t('entries.archive')}</Button>}
                    <Button size="sm" variant="ghost" onClick={onDelete}>{t('entries.purge')}</Button>
                </div>
            </footer>
        </li>
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
    return (
        <li className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm">
            <div className="flex items-center gap-2">
                <span className="font-medium">
                    {snapshot.query || t('snapshots.noQuery')}
                </span>
                <Badge variant="outline">
                    {t('snapshots.items', { count: snapshot.itemCount })}
                </Badge>
                <span className="ml-auto text-xs opacity-60">
                    {formatTime(snapshot.createdAt)}
                </span>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                        void callAction('livingmemory.deleteSnapshot', {
                            id: snapshot.id
                        }).catch(report)
                    }
                >
                    {t('common.delete')}
                </Button>
            </div>
            <span className="text-xs opacity-60">{snapshot.conversationId}</span>
        </li>
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
            {hits === undefined ? null : hits.length === 0 ? (
                <EmptyState title={t('search.empty')} />
            ) : (
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

function JobsPanel({ presetId }: { presetId: string }) {
    const t = useT()
    const jobs = useLive('livingmemory.jobs', { presetId })
    const items = jobs.data ?? []
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex gap-2">
                <Button
                    size="sm"
                    onClick={() =>
                        void callAction('livingmemory.dream', { presetId }).catch(report)
                    }
                >
                    {t('jobs.dream')}
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                        void callAction('livingmemory.rebuildIndex', {
                            presetId
                        }).catch(report)
                    }
                >
                    {t('jobs.rebuildIndex')}
                </Button>
            </div>
            {items.length === 0 ? (
                <EmptyState title={t('jobs.empty')} />
            ) : (
                <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                    {items.map((job) => (
                        <JobRow key={job.id} job={job} />
                    ))}
                </ul>
            )}
        </div>
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

function PersonasPanel() {
    const t = useT()
    const personas = useLive('livingmemory.personas')
    const items = personas.data ?? []
    const [editing, setEditing] = React.useState<LivingMemoryPersonaView>()
    if (items.length === 0) return <EmptyState title={t('personas.empty')} />
    return (
        <>
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {items.map((persona) => (
                    <li
                        key={persona.presetId}
                        className="flex items-center gap-2 rounded-md border border-border p-3"
                    >
                        <span className="font-medium">{persona.presetId}</span>
                        <Badge variant="outline">{t(`persona.source.${persona.source}`)}</Badge>
                        {persona.stale && (
                            <Badge variant="secondary">{t('personas.stale')}</Badge>
                        )}
                        <span className="ml-auto text-xs opacity-60">
                            {formatTime(persona.updatedAt)}
                        </span>
                        <Button size="sm" variant="outline" onClick={() => setEditing(persona)}>
                            {t('common.edit')}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                                void callAction('livingmemory.resetPersona', {
                                    presetId: persona.presetId
                                }).catch(report)
                            }
                        >
                            {t('personas.reset')}
                        </Button>
                    </li>
                ))}
            </ul>
            {editing !== undefined && (
                <PersonaDialog
                    persona={editing}
                    onClose={() => setEditing(undefined)}
                />
            )}
        </>
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
