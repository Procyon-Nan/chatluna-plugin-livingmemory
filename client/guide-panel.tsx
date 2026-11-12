import { useTranslate } from '@chatluna/ui-client/client'
import { Button } from '@chatluna/ui-kit'

const chapters = [
    { key: 'start', topics: ['models', 'rules', 'check'] },
    { key: 'timing', topics: ['overheard', 'interval'] },
    { key: 'context', topics: ['sharing', 'profiles'] },
    { key: 'dream', topics: ['dream.auto', 'dream.manual', 'dream.result'] }
]

function goToChapter(key: string) {
    const heading = document.getElementById(`livingmemory-guide-${key}`)
    if (!heading) return
    heading.focus({ preventScroll: true })
    heading.scrollIntoView({ block: 'start' })
}

export function GuidePanel({ onOpenSettings }: { onOpenSettings(): void }) {
    const t = useTranslate('livingmemory')
    return (
        <div className="@container w-full">
            <div className="mx-auto grid max-w-5xl gap-y-7 pb-12 pt-3 @3xl:grid-cols-[minmax(0,1fr)_11rem] @3xl:gap-x-12 @3xl:pt-6">
                <header className="@3xl:col-start-1">
                    <h1 className="text-3xl font-bold tracking-tight">{t('tab.guide')}</h1>
                    <p className="mt-3 max-w-prose leading-7 text-muted-foreground">{t('guide.intro')}</p>
                </header>
                <nav aria-label={t('guide.contents')} className="border-l border-border pl-4 @3xl:sticky @3xl:top-5 @3xl:col-start-2 @3xl:row-span-2 @3xl:row-start-1 @3xl:self-start">
                    <p className="mb-2 text-sm font-semibold">{t('guide.contents')}</p>
                    <ul className="flex flex-wrap gap-x-4 gap-y-1 @3xl:flex-col">
                        {chapters.map(({ key }) => (
                            <li key={key}>
                                <button type="button" onClick={() => goToChapter(key)} className="block py-1 text-left text-sm text-muted-foreground hover:text-foreground hover:underline">
                                    {t(`guide.${key}`)}
                                </button>
                            </li>
                        ))}
                    </ul>
                </nav>
                <article className="min-w-0 space-y-9 @3xl:col-start-1">
                    {chapters.map(({ key, topics }) => (
                        <section key={key} className="border-t border-border pt-6">
                            <h2 id={`livingmemory-guide-${key}`} tabIndex={-1} className="scroll-mt-5 text-xl font-semibold tracking-tight">
                                {t(`guide.${key}`)}
                            </h2>
                            {key === 'dream' && <p className="mt-3 leading-7">{t('guide.dream.intro')}</p>}
                            {topics.map((topic, index) => (
                                <div key={topic} className="mt-5">
                                    <h3 className="font-semibold">
                                        {key === 'start' && <span className="mr-2 text-muted-foreground">{index + 1}.</span>}
                                        {t(`guide.${topic}.title`)}
                                    </h3>
                                    <p className="mt-1.5 leading-7">{t(`guide.${topic}.text`)}</p>
                                    {topic === 'models' && <Button variant="outline" className="mt-3" onClick={onOpenSettings}>{t('guide.openSettings')}</Button>}
                                </div>
                            ))}
                            {key === 'timing' && (
                                <aside className="mt-5 rounded-lg bg-muted px-5 py-4">
                                    <h3 className="font-semibold">{t('guide.buffer.title')}</h3>
                                    <p className="mt-1.5 leading-7">{t('guide.buffer.text')}</p>
                                </aside>
                            )}
                        </section>
                    ))}
                </article>
            </div>
        </div>
    )
}
