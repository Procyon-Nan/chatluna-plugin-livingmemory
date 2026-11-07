import assert from 'node:assert/strict'
import { blocksToLogText } from '../src/service/transcript/element_text.ts'
import type { ChatBlock } from '@chatluna/message'

const text = (value: string): ChatBlock => ({ type: 'text', text: value })

describe('blocksToLogText', () => {
    it('joins text blocks and trims the result', () => {
        assert.equal(blocksToLogText([text(' 你好 '), text('世界')]), '你好 世界')
    })

    it('returns empty without content', () => {
        assert.equal(blocksToLogText([]), '')
        assert.equal(blocksToLogText([text('   ')]), '')
    })

    it('renders file placeholders and keeps available names', () => {
        assert.equal(
            blocksToLogText([
                { type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'a.jpg' } },
                { type: 'file', mediaType: 'audio/silk', data: { type: 'url', url: 'b.silk' } },
                { type: 'file', mediaType: 'video/mp4', data: { type: 'url', url: 'c.mp4' } },
                {
                    type: 'file',
                    mediaType: 'application/pdf',
                    filename: '报告.pdf',
                    data: { type: 'url', url: 'd.pdf' }
                },
                { type: 'file', mediaType: 'application/octet-stream', data: { type: 'reference', reference: 'e' } }
            ]),
            '[图片][语音][视频][文件:报告.pdf][文件]'
        )
    })

    it('drops reasoning, tool and source blocks', () => {
        assert.equal(
            blocksToLogText([
                text('可见'),
                { type: 'reasoning', text: '思考过程' },
                { type: 'tool-call', toolCallId: 'c-1' as never, toolName: 'look', input: null },
                {
                    type: 'tool-result',
                    toolCallId: 'c-1' as never,
                    toolName: 'look',
                    output: { type: 'text', value: '结果' }
                },
                { type: 'source', sourceType: 'web', id: 's-1' }
            ]),
            '可见'
        )
    })

    it('flattens envelope content', () => {
        assert.equal(
            blocksToLogText([
                {
                    type: 'envelope',
                    kind: 'message',
                    id: 'e-1',
                    externalId: 'm-1',
                    time: 1_000,
                    content: [text('合并消息')]
                }
            ]),
            '合并消息'
        )
    })

    it('renders native placeholders with the platform-specific label', () => {
        assert.equal(
            blocksToLogText([
                { type: 'native', provider: 'onebot', kind: 'face', data: { name: '得意' } },
                { type: 'native', provider: 'onebot', kind: 'face', data: {} },
                { type: 'native', provider: 'onebot', kind: 'forward', data: {} },
                { type: 'native', provider: 'onebot', kind: 'json', data: {} },
                { type: 'native', provider: 'onebot', kind: 'future-widget', data: {} }
            ]),
            '[表情:得意][表情][聊天记录][卡片消息][非文本消息]'
        )
    })

    it('excludes notices and recursively describes media inside message envelopes', () => {
        assert.equal(blocksToLogText([
            { type: 'envelope', kind: 'notice', id: 'notice', time: 1_000, content: [text('系统信息')] },
            { type: 'envelope', kind: 'message', id: 'real', time: 2_000, content: [
                text('图片'),
                { type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'a.png' } },
                { type: 'reasoning', text: '隐藏推理' }
            ] }
        ]), '图片[图片]')
    })
})
