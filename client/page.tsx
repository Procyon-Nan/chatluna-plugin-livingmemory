import * as React from 'react'
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Field,
    FieldLabel,
    Input,
    PageHeader,
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
    const [selection, setSelection] = React.useState<{
        presetId: string
        createdId?: string
        status?: MemoryEntryRecord['status']
    }>()
    const [creating, setCreating] = React.useState(false)
    const [tab, setTab] = React.useState<Tab>('entries')

    const active = selection?.presetId ?? presets[0]

    return (
        <div className="flex h-full flex-col gap-4 p-6">
            <PageHeader
                title={t('title')}
                description={t('description')}
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        <PresetPicker presets={presets} value={active} onChange={(presetId) => setSelection({ presetId })} />
                        <Button size="sm" onClick={() => setCreating(true)}>{t('entries.create')}</Button>
                        <MemoryImportExport presetId={active} />
                    </div>
                }
            />
            {creating && (
                <MemoryEntryEditor presetId={active ?? ''} presets={presets}
                    onClose={() => setCreating(false)}
                    onSaved={({ id, presetId, status }) => {
                        setSelection({ presetId, status, createdId: id })
                        setCreating(false)
                        setTab('entries')
                    }} />
            )}
            <Warnings warnings={status.data?.warnings ?? []} />
            <div className="flex gap-2">
                {(
                    [
                        'entries',
                        'profiles',
                        'personas',
                        'snapshots',
                        'jobs',
                        'search'
                    ] as const
                ).map((key) => (
                    <Button
                        key={key}
                        variant={tab === key ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setTab(key)}
                    >
                        {t(`tab.${key}`)}
                    </Button>
                ))}
            </div>
            {active === undefined ? (
                <EmptyState title={t('empty.noPreset')} />
            ) : tab === 'entries' ? (
                <EntriesPanel key={selection?.createdId ?? active} presetId={active} initialStatus={selection?.status ?? 'active'} />
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
        <Select value={value} onValueChange={(next) => onChange(next as string)}>
            <SelectTrigger className="w-56">
                <SelectValue placeholder={t('preset.placeholder')} />
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
    const [page, setPage] = React.useState(1)
    const [editing, setEditing] = React.useState<LivingMemoryEntryView>()

    const params = React.useMemo(
        () => ({
            presetId,
            page,
            pageSize: PAGE_SIZE,
            status,
            ...(type === 'all'
                ? {}
                : { type: type as MemoryEntryRecord['type'] }),
            ...(keyword.trim().length === 0 ? {} : { keyword: keyword.trim() })
        }),
        [presetId, page, status, type, keyword]
    )
    const entries = useLive('livingmemory.entries', params)
    const speakers = useLive('livingmemory.speakers', { presetId })
    const names = new Map(speakers.data?.map((speaker) => [speaker.speakerKey, speaker.speakerLabel]))
    const items = entries.data?.entries ?? []

    React.useEffect(() => setPage(1), [presetId, status, type, keyword])

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
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="active">{t('status.active')}</SelectItem>
                        <SelectItem value="archived">{t('status.archived')}</SelectItem>
                        <SelectItem value="all">{t('status.all')}</SelectItem>
                    </SelectContent>
                </Select>
                <Select value={type} onValueChange={(next) => setType(next as string)}>
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
                <span className="ml-auto text-sm opacity-70">
                    {t('entries.total', { count: entries.data?.total ?? 0 })}
                </span>
            </div>
            {items.length === 0 ? (
                <EmptyState title={t('entries.empty')} />
            ) : (
                <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                    {items.map((entry) => (
                        <li
                            key={entry.id}
                            className="flex flex-col gap-1 rounded-md border border-border p-3"
                        >
                            <div className="flex flex-wrap items-center gap-2">
                                {entry.summary && <span className="font-medium">{entry.summary}</span>}
                                <Badge variant="outline">{t(`type.${entry.type}`)}</Badge>
                                <Badge variant="secondary">{t(`status.${entry.status}`)}</Badge>
                                {entry.sentiment && <Badge variant="outline">{t('field.sentiment')} · {entry.sentiment}</Badge>}
                            </div>
                            <p className="whitespace-pre-wrap break-words text-sm">{entry.content}</p>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                <span className="inline-flex items-center gap-1">
                                    {t('field.importance')} {entry.importance ?? '—'}
                                    {entry.importance !== null && (
                                        <meter min={0} max={1} value={entry.importance} aria-label={t('field.importance')} />
                                    )}
                                </span>
                                <span>{t('field.speakers')} · {entry.speakerKeys.map((key) => names.get(key) ?? key).join(', ') || t('entries.noSpeakers')}</span>
                                {(entry.sourceLabel || entry.sourceConversationId) && (
                                    <span>{t('field.source')} · {entry.sourceLabel || entry.sourceConversationId}</span>
                                )}
                            </div>
                            {entry.keywords.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                    {entry.keywords.map((word) => <Badge key={word} variant="outline">{word}</Badge>)}
                                </div>
                            )}
                            <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                                <span>{t('field.createdAt')} {formatTime(entry.createdAt)}</span>
                                <span>{t('field.updatedAt')} {formatTime(entry.updatedAt)}</span>
                            </div>
                            <div className="flex gap-2">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setEditing(entry)}
                                >
                                    {t('entries.edit')}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                        void callAction('livingmemory.remove', {
                                            id: entry.id,
                                            purge: entry.status === 'archived'
                                        }).catch(report)
                                    }
                                >
                                    {entry.status === 'archived'
                                        ? t('entries.purge')
                                        : t('entries.archive')}
                                </Button>
                            </div>
                        </li>
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
