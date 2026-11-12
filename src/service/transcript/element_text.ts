import type { ChatBlock } from '@chatluna/message'
import type { ObservedMessage } from '@chatluna/chat-observer'

type ObservedContent = Pick<ObservedMessage, 'content' | 'quote'>

export function hasTranscriptText({ content, quote }: ObservedContent): boolean {
  return !!quote || content.some(block => describeBlock(block).trim() !== '')
}

export function observedMessageText({ content, quote }: ObservedContent, assistantLabel: string): string {
  const body = blocksToLogText(content, assistantLabel)
  if (!quote) return body
  const author = quote.name?.trim() || quote.user
  const text = blocksToLogText(quote.content ?? [], assistantLabel)
  const citation = `[引用${author ? ' ' + author : ''}${text ? '：' + text : ''}]`
  return body ? `${citation}\n${body}` : citation
}

/**
 * 将聊天内容转为模型可读文本，使用占位说明表示非文本内容。
 */
export function blocksToLogText(blocks: readonly ChatBlock[], assistantLabel?: string): string {
  return blocks.map(block => describeBlock(block, assistantLabel)).join('').trim()
}

// @ 可以紧贴中文，也可以连续出现（@123@self）。链接按原文保留。
const linkOrSelfMention = /https?:\/\/[^\s<>"「」，。！？、]+|(?:(?<![\w./%+-])|(?<=@[\w-]+))@self(?![\w-]|\.\w)/gu

function describeBlock(block: ChatBlock, assistantLabel?: string): string {
  switch (block.type) {
    case 'text':
      if (!assistantLabel || !block.text.includes('@self')) return block.text
      return block.text.replace(linkOrSelfMention, match => match === '@self' ? '@' + assistantLabel : match)
    case 'file':
      return describeFile(block)
    case 'envelope':
      return block.kind === 'message' ? blocksToLogText(block.content, assistantLabel) : ''
    case 'native':
      return describeNative(block)
    case 'reasoning':
    case 'source':
    case 'tool-call':
    case 'tool-result':
      return ''
  }
}

function describeFile(block: Extract<ChatBlock, { type: 'file' }>): string {
  const name = block.filename?.trim()
  const kind = block.mediaType.startsWith('image/')
    ? '图片'
    : block.mediaType.startsWith('audio/')
      ? '语音'
      : block.mediaType.startsWith('video/')
        ? '视频'
        : '文件'
  const label = name ? `${kind}:${name}` : kind
  const description = block.alt?.trim()
  return description ? `[${label}：${description}]` : `[${label}]`
}

/** 平台特有的非文本内容；`kind` 决定占位措辞，其余字段不进入历史。 */
function describeNative(block: Extract<ChatBlock, { type: 'native' }>): string {
  const name = typeof block.data['name'] === 'string' ? block.data['name'] : undefined
  const label = NATIVE_LABELS[block.kind] ?? '非文本消息'
  return name ? `[${label}:${name}]` : `[${label}]`
}

const NATIVE_LABELS: Readonly<Record<string, string>> = {
  at: '@',
  face: '表情',
  emoji: '表情',
  mface: '表情包',
  forward: '聊天记录',
  json: '卡片消息',
  xml: '卡片消息',
  share: '分享',
  location: '位置',
  contact: '联系人',
  dice: '骰子',
  rps: '猜拳',
  quote: '回复'
}
