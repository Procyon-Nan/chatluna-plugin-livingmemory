# Agent Note: 由模型纠正字符串化的数组

Status: implemented

## Problem

记忆提取要求模型按 schema 返回 JSON 数组。把整个数组放在引号中会得到字符串，框架校验无法通过。

## Decision

将格式错误和正确示例反馈给模型，让它在下一次调用时直接返回数组。同一次提取最多调用模型三次；有效数组首次校验通过就采用。模型请求本身失败时由调用方处理。

## Alternatives considered

**接受数组和字符串，再解析字符串。** 向模型声明两种格式会把错误写法变成允许的输入，也失去了指出具体错误的机会。

## Consequences

连续三次未通过校验时，提取器记录解析错误，不写入这批记忆。`tests/extraction-prompt.spec.ts` 覆盖正确输出、纠正提示和多次失败。
