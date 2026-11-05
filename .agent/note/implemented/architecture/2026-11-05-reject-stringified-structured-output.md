# Agent Note: 拒绝字符串化的结构化输出，改由模型重写

Status: implemented

## Problem

v1 的 `structured_output.ts` 在 schema 校验前会先做一次 `normalizeStringifiedArrayField`：若模型把数组字段序列化成 JSON 字符串传回（例如 `{"memories":"[{\"type\":\"fact\"}]"}`），v1 先 `JSON.parse` 该字段，解析结果为数组时用解码值替换，再走 schema 校验。这类输出在 v1 的第一次调用就被接受，本批提取正常完成。

v2 改用 `ctx.chatluna.extract(schema, …)`，schema 校验在框架内部完成，未通过时抛 `ProtocolError`。插件拿不到模型的原始输出，无从解码；字符串化结果进入纠正重试，三次后记 `parseError`，整批丢弃。`tests/extraction-prompt.spec.ts` 中「接受字符串化数组」的用例因此无法按原样迁移。

## Proposal

删除容错解码路径，字符串化输出一律按格式错误处理，回给模型重写。

- `invokeStructuredOutput` 不做任何字段解码；`stringifiedArrayField` 只用于在纠正提示中点名该字段，并给出正确与错误的写法对照。
- schema 校验失败进入纠正重试，上限沿用 v1 的三次；三次仍不合格时记解析失败，本批提取不落库。
- `tests/extraction-prompt.spec.ts` 断言改为：字符串化结果被拒绝并产生纠正提示；三次字符串化后整批丢弃且 `parseError` 非空。

## Alternatives considered

**保留解码（严格优先、失败后宽松重试）**：第一次用严格 schema，失败后用接受数组或字符串的宽松 schema 再调一次，解码后按严格 schema 校验。能完全对齐 v1 行为，对正常模型无影响。否决原因：这是为「模型会输出坏格式」预留的兜底，与项目「契约被破坏时暴露具体错误，用默认值或静默兜底掩盖问题」的规则冲突；而且错误结果一旦被解码接受，就不再产生任何纠正信号，模型的不良习惯不会被纠正。

**始终用宽松 schema 接收**：实现最简单，但宣传给模型的 JSON Schema 会变成 `oneOf: [array, string]`，等于告诉模型传字符串也可以，比 v1 更容易触发字符串化。否决。

## Acceptance criteria

- 模型传字符串化数组时，第一次调用被判为格式错误，纠正提示里包含「必须直接传 JSON 数组」与正确/错误写法对照。
- 连续三次字符串化后，`extract` 返回空结果且 `parseError` 非空；这批消息按 v1 的失败语义处理，不落库。
- 正常数组输出的行为与 schema 宣传不变：调用一次即接受，无额外模型调用。
- `tests/extraction-prompt.spec.ts` 覆盖上述三条路径，并保留 v1 的字段缺失与字段越界拒绝断言。

## Risks

- 与 v1 存在一处有意差异：v1 能救回的字符串化批次在 v2 会失败。失败后按既有语义等待下一次正常触发，代价是一批记忆延迟或丢失。
- 若实际模型频繁出现字符串化，纠正提示是唯一反馈渠道。三次上限与 v1 相同，没有为该场景单独放宽。
- 该差异记录在 `doc/migration-plan.md` 的已确认事项中，S8 与 v1 行为对照时按此判定，不计为回归。