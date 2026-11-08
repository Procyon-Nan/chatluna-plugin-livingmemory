import * as React from 'react'
import {
    Button, Dialog, DialogContent, DialogHeader, DialogTitle, Field, FieldLabel,
    Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea
} from '@chatluna/ui-kit'
import { apiErrorMessage, callAction, toast, useLive, useTranslate } from '@chatluna/ui-client/client'
import { MAX_MEMORY_KEYWORDS, memoryEntryTypes, type MemoryEntryStatus } from '../src/contracts/memory.ts'
import type { LivingMemoryEntryView } from '../src/contracts/webui.ts'

type SavedEntry = { presetId: string; status: MemoryEntryStatus }

interface EditorProps {
    presetId: string
    presets?: readonly string[]
    entry?: LivingMemoryEntryView
    onSaved(result: SavedEntry): void
    onClose(): void
}

export function MemoryEntryEditor({ presetId, presets = [], entry, onSaved, onClose }: EditorProps) {
    const t = useTranslate('livingmemory')
    const [target, setTarget] = React.useState(presetId)
    const [summary, setSummary] = React.useState(entry?.summary ?? '')
    const [content, setContent] = React.useState(entry?.content ?? '')
    const [type, setType] = React.useState(entry?.type ?? 'fact')
    const [status, setStatus] = React.useState(entry?.status ?? 'active')
    const [sentiment, setSentiment] = React.useState(entry?.sentiment ?? '')
    const [importance, setImportance] = React.useState(entry?.importance?.toString() ?? '')
    const [keywords, setKeywords] = React.useState(entry?.keywords.join('\n') ?? '')
    const [speakerKeys, setSpeakerKeys] = React.useState(entry?.speakerKeys ?? [])
    const [saving, setSaving] = React.useState(false)
    const targetId = target.trim()
    const words = [...new Set(keywords.split('\n').map((word) => word.trim()).filter(Boolean))]
    const weight = importance === '' ? null : Number(importance)
    const requiredSummary = !entry || !!entry.summary
    const requiredSentiment = !entry || !!entry.sentiment
    const requiredImportance = !entry || entry.importance !== null
    const requiredKeywords = !entry || entry.keywords.length > 0
    const valid = targetId !== '' &&
        content.trim() !== '' &&
        (!requiredSummary || summary.trim() !== '') &&
        (!requiredSentiment || sentiment.trim() !== '') &&
        (!requiredKeywords || words.length > 0) &&
        words.length <= MAX_MEMORY_KEYWORDS &&
        (weight === null ? !requiredImportance : weight >= 0 && weight <= 1)

    async function save(event: React.FormEvent) {
        event.preventDefault()
        if (!valid || saving) return
        setSaving(true)
        try {
            const fields = {
                content: content.trim(),
                status,
                keywords: words,
                speakerKeys,
                ...(summary.trim() ? { summary: summary.trim() } : {}),
                ...(sentiment.trim() ? { sentiment: sentiment.trim() } : {}),
                ...(weight !== null ? { importance: weight } : {})
            }
            if (entry) {
                await callAction('livingmemory.update', { id: entry.id, ...fields, ...(type === entry.type ? {} : { type }) })
            } else {
                await callAction('livingmemory.create', { presetId: targetId, type, ...fields })
            }
            toast.success(t(entry ? 'entries.saved' : 'entries.created'))
            onSaved({ presetId: targetId, status })
        } catch (error) {
            toast.error(apiErrorMessage(error))
        } finally {
            setSaving(false)
        }
    }

    return (
        <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t(entry ? 'entries.editTitle' : 'entries.create')}</DialogTitle>
                </DialogHeader>
                <form className="flex flex-col gap-4" onSubmit={save} noValidate>
                    {!entry && (
                        <Field>
                            <EditorLabel required htmlFor="memory-preset">{t('field.preset')}</EditorLabel>
                            <Input id="memory-preset" list="memory-preset-options" value={target} required
                                placeholder={t('entries.choosePreset')} onChange={(event) => {
                                    if (targetId !== event.target.value.trim()) setSpeakerKeys([])
                                    setTarget(event.target.value)
                                }} />
                            <datalist id="memory-preset-options">
                                {presets.map((preset) => <option key={preset} value={preset} />)}
                            </datalist>
                        </Field>
                    )}
                    <Field>
                        <EditorLabel required={requiredSummary} htmlFor="memory-summary">{t('field.summary')}</EditorLabel>
                        <Textarea id="memory-summary" rows={2} value={summary} required={requiredSummary}
                            onChange={(event) => setSummary(event.target.value)} />
                    </Field>
                    <Field>
                        <EditorLabel required htmlFor="memory-content">{t('field.content')}</EditorLabel>
                        <Textarea id="memory-content" rows={5} value={content} required
                            onChange={(event) => setContent(event.target.value)} />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field>
                            <FieldLabel htmlFor="memory-type">{t('field.type')}</FieldLabel>
                            <Select value={type} onValueChange={(value) => { if (value !== null) setType(value) }}>
                                <SelectTrigger id="memory-type"><SelectValue>{t(`type.${type}`)}</SelectValue></SelectTrigger>
                                <SelectContent>
                                    {memoryEntryTypes.map((item) => <SelectItem key={item} value={item}>{t(`type.${item}`)}</SelectItem>)}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="memory-status">{t('field.status')}</FieldLabel>
                            <Select value={status} onValueChange={(value) => { if (value !== null) setStatus(value) }}>
                                <SelectTrigger id="memory-status"><SelectValue>{t(`status.${status}`)}</SelectValue></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="active">{t('status.active')}</SelectItem>
                                    <SelectItem value="archived">{t('status.archived')}</SelectItem>
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field>
                            <EditorLabel required={requiredSentiment} htmlFor="memory-sentiment">{t('field.sentiment')}</EditorLabel>
                            <Input id="memory-sentiment" value={sentiment} required={requiredSentiment}
                                onChange={(event) => setSentiment(event.target.value)} />
                        </Field>
                        <Field>
                            <EditorLabel required={requiredImportance} htmlFor="memory-importance">{t('field.importance')}</EditorLabel>
                            <Input id="memory-importance" type="number" min={0} max={1} step={0.05} placeholder="0–1"
                                value={importance} required={requiredImportance} onChange={(event) => setImportance(event.target.value)} />
                        </Field>
                    </div>
                    <Field>
                        <EditorLabel required={requiredKeywords} htmlFor="memory-keywords">{t('field.keywords', { max: MAX_MEMORY_KEYWORDS })}</EditorLabel>
                        <Textarea id="memory-keywords" rows={2} value={keywords} required={requiredKeywords}
                            onChange={(event) => setKeywords(event.target.value)} />
                    </Field>
                    {(entry || presets.includes(targetId)) && (
                        <SpeakerPicker key={targetId} presetId={targetId} value={speakerKeys} onChange={setSpeakerKeys} />
                    )}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
                        <Button type="submit" disabled={!valid || saving}>{t(entry ? 'common.save' : 'entries.create')}</Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}

function EditorLabel({ htmlFor, required, children }: { htmlFor: string; required: boolean; children: React.ReactNode }) {
    return (
        <FieldLabel htmlFor={htmlFor}>
            {children}
            {required && <span aria-hidden="true" className="text-destructive">*</span>}
        </FieldLabel>
    )
}

function SpeakerPicker({ presetId, value, onChange }: {
    presetId: string
    value: string[]
    onChange(keys: string[]): void
}) {
    const t = useTranslate('livingmemory')
    const speakers = useLive('livingmemory.speakers', { presetId })
    const names = new Map(speakers.data?.map((speaker) => [speaker.speakerKey, speaker.speakerLabel]))
    for (const key of value) if (!names.has(key)) names.set(key, key)
    return (
        <Field>
            <FieldLabel htmlFor="memory-speakers">{t('field.speakers')}</FieldLabel>
            <Select multiple value={value} onValueChange={onChange} disabled={names.size === 0}>
                <SelectTrigger id="memory-speakers">
                    <SelectValue>{value.map((key) => names.get(key)).join(', ') || t('entries.noSpeakers')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {Array.from(names, ([key, name]) => <SelectItem key={key} value={key}>{name}</SelectItem>)}
                </SelectContent>
            </Select>
            {speakers.error && <p role="alert" className="text-sm text-destructive">{speakers.error}</p>}
        </Field>
    )
}
