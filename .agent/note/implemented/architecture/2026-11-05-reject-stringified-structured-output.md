# Agent Note: 由模型纠正字符串化的数组

Status: implemented

## Problem

记忆提取要求模型调用 `living_memory_extraction_result`，在 `memories` 参数中提交数组。把整个数组放在引号中会得到字符串，无法通过参数校验。

## Decision

将格式错误和正确示例作为工具结果反馈给模型，让它重新调用工具并提交数组。同一次提取最多调用模型三次；参数和业务校验通过后就采用。模型请求本身失败时由调用方处理。

## Alternatives considered

**接受数组和字符串，再解析字符串。** 向模型声明两种格式会把错误写法变成允许的输入，也失去了指出具体错误的机会。

## Consequences

连续三次未通过校验时，提取器记录解析错误，不写入这批记忆。`tests/extraction-prompt.spec.ts` 覆盖正确输出、纠正提示和多次失败。
