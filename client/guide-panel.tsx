import { Button } from '@chatluna/ui-kit'
import { useTranslate } from '@chatluna/ui-client/client'

export function GuidePanel({ onOpenSettings }: { onOpenSettings(): void }) {
    const t = useTranslate('livingmemory')
    return (
        <article className="mx-auto w-full max-w-3xl space-y-8 pb-6">
            <section>
                <h2 className="text-lg font-semibold">{t('guide.start')}</h2>
                <ol className="mt-3 list-decimal space-y-4 pl-6 marker:font-semibold marker:text-primary">
                    {['models', 'rules', 'check'].map(step => (
                        <li key={step} className="pl-1">
                            <h3 className="font-medium">{t(`guide.${step}.title`)}</h3>
                            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t(`guide.${step}.text`)}</p>
                            {step === 'models' && <Button variant="outline" className="mt-2" onClick={onOpenSettings}>{t('guide.openSettings')}</Button>}
                        </li>
                    ))}
                </ol>
            </section>
            <section>
                <h2 className="text-lg font-semibold">{t('guide.dream.title')}</h2>
                <p className="mt-2 text-sm leading-relaxed">{t('guide.dream.intro')}</p>
                <dl className="mt-4 space-y-3">
                    {['auto', 'manual', 'result'].map(topic => (
                        <div key={topic}>
                            <dt className="font-medium">{t(`guide.dream.${topic}.title`)}</dt>
                            <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{t(`guide.dream.${topic}.text`)}</dd>
                        </div>
                    ))}
                </dl>
            </section>
            <section>
                <h2 className="text-lg font-semibold">{t('guide.questions')}</h2>
                <dl className="mt-1 divide-y divide-border">
                    {['interval', 'overheard', 'sharing', 'profiles'].map(topic => (
                        <div key={topic} className="py-3">
                            <dt className="font-medium">{t(`guide.${topic}.title`)}</dt>
                            <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{t(`guide.${topic}.text`)}</dd>
                        </div>
                    ))}
                </dl>
            </section>
        </article>
    )
}
