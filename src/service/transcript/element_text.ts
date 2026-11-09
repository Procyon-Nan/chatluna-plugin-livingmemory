import type { ChatBlock } from '@chatluna/message'

/**
 * 将聊天内容转为模型可读文本，使用占位说明表示非文本内容。
 */
export function blocksToLogText(blocks: readonly ChatBlock[]): string {
  return blocks.map(describeBlock).filter((part) => part.length > 0).join('').trim()
}

function describeBlock(block: ChatBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return ''
    case 'file':
      return describeFile(block)
    case 'envelope':
      return block.kind === 'message' ? blocksToLogText(block.content) : ''
    case 'native':
      return describeNative(block)
    case 'source':
      return ''
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
  return name === undefined || name.length === 0 ? `[${kind}]` : `[${kind}:${name}]`
}

/** 平台特有的非文本内容；`kind` 决定占位措辞，其余字段不进入历史。 */
function describeNative(block: Extract<ChatBlock, { type: 'native' }>): string {
  const name = typeof block.data['name'] === 'string' ? block.data['name'] : undefined
  const label = NATIVE_LABELS[block.kind] ?? '非文本消息'
  return name === undefined || name.length === 0 ? `[${label}]` : `[${label}:${name}]`
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
  quote: '回复',
  unknown: '非文本消息'
}
