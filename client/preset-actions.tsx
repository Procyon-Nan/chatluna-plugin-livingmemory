import * as React from 'react'
import {
    Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger
} from '@chatluna/ui-kit'
import { apiErrorMessage, callAction, toast, useTranslate } from '@chatluna/ui-client/client'

type MemoryExportFile = {
    version: number
    sourcePresetId: string
    entries: unknown[]
    userProfiles: unknown[]
    presetSpeakers: unknown[]
}

function parseExportFile(text: string): MemoryExportFile | undefined {
    let data
    try {
        data = JSON.parse(text)
    } catch {
        return
    }
    if (data && [1, 2, 3, 4, 5].includes(data.version) &&
        typeof data.sourcePresetId === 'string' && data.sourcePresetId.trim() &&
        Array.isArray(data.entries) && Array.isArray(data.userProfiles) && Array.isArray(data.presetSpeakers)) {
        return data
    }
}

function downloadExportFile(presetId: string, data: unknown) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `livingmemory-${presetId.replace(/[<>:"/\\|?*]/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function PresetActions({ presetId, onClear }: { presetId: string | undefined; onClear(id: string): void }) {
    const t = useTranslate('livingmemory')
    const input = React.useRef<HTMLInputElement>(null)
    const [busy, setBusy] = React.useState(false)
    const [pending, setPending] = React.useState<{ data: MemoryExportFile; target: string }>()

    async function exportFile() {
        if (!presetId) return
        setBusy(true)
        try {
            const { data } = await callAction('livingmemory.exportPreset', { presetId })
            downloadExportFile(presetId, data)
        } catch (error) {
            toast.error(apiErrorMessage(error))
        } finally {
            setBusy(false)
        }
    }

    async function selectFile(event: React.ChangeEvent<HTMLInputElement>) {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (!file) return
        setBusy(true)
        try {
            const data = parseExportFile(await file.text())
            if (!data) return toast.error(t('transfer.invalid'))
            setPending({ data, target: presetId ?? data.sourcePresetId })
        } catch (error) {
            toast.error(apiErrorMessage(error))
        } finally {
            setBusy(false)
        }
    }

    async function confirmImport() {
        if (!pending) return
        setBusy(true)
        try {
            const result = await callAction('livingmemory.importPreset', { presetId: pending.target, data: pending.data })
            setPending(undefined)
            toast.success(t('transfer.imported', { target: pending.target, entries: result.entries, profiles: result.userProfiles, speakers: result.presetSpeakers }))
        } catch (error) {
            toast.error(apiErrorMessage(error))
        } finally {
            setBusy(false)
        }
    }

    return <>
        <input ref={input} type="file" hidden accept=".json,application/json" onChange={selectFile} />
        <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
                {t('preset.actions')} <span aria-hidden="true">▾</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={busy} onClick={() => input.current?.click()}>{t('transfer.import')}</DropdownMenuItem>
                <DropdownMenuItem disabled={busy || !presetId} onClick={exportFile}>{t('transfer.export')}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={busy || !presetId} variant="destructive"
                    onClick={() => { if (presetId) onClear(presetId) }}>{t('deletion.clearPreset')}</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
        {pending && <Dialog open onOpenChange={open => { if (!open && !busy) setPending(undefined) }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('transfer.confirmTitle', { target: pending.target })}</DialogTitle>
                    <DialogDescription>{t('transfer.preview', {
                        source: pending.data.sourcePresetId, entries: pending.data.entries.length,
                        profiles: pending.data.userProfiles.length, speakers: pending.data.presetSpeakers.length
                    })}</DialogDescription>
                </DialogHeader>
                <p className="text-sm">{t('transfer.merge')}</p>
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" disabled={busy} onClick={() => setPending(undefined)}>{t('common.cancel')}</Button>
                    <Button disabled={busy} onClick={confirmImport}>{t('transfer.confirm')}</Button>
                </div>
            </DialogContent>
        </Dialog>}
    </>
}
