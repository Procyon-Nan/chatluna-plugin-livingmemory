import * as React from 'react'
import {
    Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
    DialogTitle, Field, FieldLabel, Input
} from '@chatluna/ui-kit'
import { apiErrorMessage, callAction, toast, useTranslate } from '@chatluna/ui-client/client'

export type DeleteMemoriesTarget = { kind: 'entries'; presetId: string; ids: string[]; preview?: string }
type Target = DeleteMemoriesTarget | { kind: 'preset'; presetId: string }

export function MemoryDeletionDialog({ target, onClose, onDeleted }: {
    target: Target
    onClose(): void
    onDeleted(): void
}) {
    const t = useTranslate('livingmemory')
    const [input, setInput] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const phrase = t('deletion.phrase', { preset: target.presetId })
    const canConfirm = !busy && (target.kind === 'entries' || input === phrase)

    async function confirm() {
        if (!canConfirm) return
        setBusy(true)
        try {
            if (target.kind === 'preset') {
                await callAction('livingmemory.clearPreset', { presetId: target.presetId })
                toast.success(t('deletion.cleared', { preset: target.presetId }))
            } else {
                const result = await callAction('livingmemory.deleteMemories', { presetId: target.presetId, ids: target.ids })
                toast.success(t('deletion.deleted', { count: result.deleted }))
            }
            onDeleted()
        } catch (error) {
            toast.error(apiErrorMessage(error))
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
            <DialogContent showCloseButton={!busy}>
                <DialogHeader>
                    <DialogTitle>{t(target.kind === 'preset' ? 'deletion.clearPreset' : 'deletion.confirmDelete')}</DialogTitle>
                    <DialogDescription>
                        {target.kind === 'preset'
                            ? t('deletion.clearWarning', { preset: target.presetId })
                            : t('deletion.entryWarning', { preset: target.presetId, count: target.ids.length })}
                    </DialogDescription>
                </DialogHeader>
                {target.kind === 'entries' && target.preview && (
                    <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm">{target.preview}</p>
                )}
                {target.kind === 'preset' && (
                    <Field>
                        <FieldLabel htmlFor="clear-preset-confirmation">{t('deletion.typePhrase')}</FieldLabel>
                        <p id="clear-preset-phrase" className="break-words text-sm font-medium">{phrase}</p>
                        <Input id="clear-preset-confirmation" aria-describedby="clear-preset-phrase" autoComplete="off"
                            disabled={busy} value={input} onChange={(event) => setInput(event.target.value)} />
                    </Field>
                )}
                <DialogFooter>
                    <Button variant="outline" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
                    <Button variant="destructive" disabled={!canConfirm} onClick={() => void confirm()}>
                        {t(target.kind === 'preset' ? 'deletion.confirmClear' : 'deletion.confirmDelete')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
