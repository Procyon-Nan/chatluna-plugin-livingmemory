# Agent Note: 插件自行管理构建入口与配置

Status: implemented

## Problem

插件原构建入口调用上层项目的 Yakumo，服务端和客户端 TypeScript 配置也继承上层文件。构建因此依赖 `external/livingmemory` 的固定目录层级，独立检出仓库的 CI 无法使用同一入口。README 还要求使用者分别执行插件和 Worker 构建。

## Decision

- `yarn build` 在插件目录执行。先由 TypeScript 生成声明，再执行 `scripts/build.mjs`，依次打包服务端、WebUI 和两个 Worker；任何阶段失败都会终止构建。
- 服务端使用现有 Rolldown，运行时依赖保持外部引用；WebUI 使用 `@chatluna/ui-client` 导出的公共构建函数，沿用框架的资源清单、平台模块和样式处理。Worker 继续复用 `scripts/build-workers.mjs`。
- 两份 TypeScript 配置由插件管理，客户端只继承插件自己的服务端配置。构建脚本通过自身文件位置确定插件根目录，不访问上层项目配置。
- `package.json` 声明直接使用的构建工具、客户端组件及类型依赖；`yarn clean` 只清理插件自身的产物和增量编译记录。
- README 只说明环境、执行目录和 `yarn build`，不列出框架维护流程或内部实施进度。

## Alternatives considered

**跨目录调用宿主的构建命令。** 可以复用现有流水线，但要求固定目录层级和宿主配置，独立 CI 仍然无法使用。

**复制一整套 Yakumo 配置到插件。** 可以消除上层配置依赖，但单个插件仍需额外维护任务编排及加载器。现有 TypeScript、Rolldown 和公共 WebUI 构建函数已覆盖所需步骤。

**在 README 分列 Worker 构建命令。** 容易遗漏 Worker，不能让一次插件构建生成完整产物。

## Consequences

构建入口和配置随插件仓库交付，工作区开发与独立检出的 CI 使用同一条命令。CI 需要先安装匹配的 ChatLuna 依赖及其所需补丁；当前框架包通过模板 vendor 提供，框架包的分发不由插件构建脚本处理。

2026-11-06 已安装新增依赖、构建并同步配套框架包，在插件目录执行 `yarn build` 成功（退出码 0）。类型声明、服务端、WebUI 及两个 Worker 均已生成；日志位于 `tmp/build-verification/build.log`。构建仅有依赖中的 `use client` 指令提示。

同步同版本框架包后，TypeScript 增量缓存仍保留旧包的类型诊断；清除插件的 `tsconfig.tsbuildinfo` 后构建通过。独立检出的 CI、自动化测试和运行验收仍待执行，本次成功记录来自当前工作区。
