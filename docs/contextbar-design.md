# contextbar 插件设计（已实现 v0.1，2026-10-23）

> 状态：**已实现并验证**（`.opencode/plugins/contextbar/`）。
> 本文档保留调查结论 + 实现期间的关键发现，供后续维护参考。

## 实现期间的关键发现（推翻了原设计的一部分）

**HTTP RPC 方法调用在 v2.1.3 不可用于插件注册**：`POST /api/rpc/{id}/{method}`
始终返回 `rpc.unavailable`——即使逐字复刻官方文档示例也一样（插件注册表与
HTTP 端点的 Rpc 服务实例隔离；二进制反编译确认注册表按 id 全局查找、挂在
scope 上，HTTP 路径用了不同实例）。**但 RPC 事件正常**：`registration.events.emit`
发布的事件以 `rpc.<id>.<event>` 类型流入公共事件流（SSE 实测验证）。
→ 最终架构：**事件推送**（`measured` 每次模型调用 + `snapshot` 5s 心跳），
TUI 用 `data.on("rpc.contextbar.*")` 接收，零 HTTP 轮询。

## 最终架构

```
contextbar/
  index.ts   server: session.hook("context") 测量 → rpc.contextbar.measured/snapshot 事件
  tui.tsx    TUI: data.on 订阅事件 + 响应式数据层 → session.composer.top 渲染
  core.ts    纯逻辑（参考消息选取/bar 布局/格式化，有冒烟测试）
  rpc.ts     共享事件契约（events-only，无 methods）
```

## 数据来源（最终版）

| 段 | 来源 | 精度 |
|---|---|---|
| messages | 最后一条（压缩后、revert 前）assistant 五项和 | 精确 |
| system prompt | hook `system[0]` chars /4 | chars 精确 |
| system tools | hook `tools` Σ(name+desc+schema) /4 | chars 精确 |
| memory files | `system[1]` chars − skills 估算 | 近似 |
| skills | Σ(id+name+description)（实际注入内容） /4 | 近似 |
| free / 窗口 | `ui.model.current()` → `limit.context` | 精确 |
| autocompact buffer | `client.config.get()` → `compaction.buffer` | 精确 |

chars/4 与服务端 autocompact 判定同口径（二进制实锤：文本 round(chars/4)、
工具 M1 公式、图片 1500/PDF 2000、溢出边际 max(15%, 16k)）。

## 已验证的坑（勿再踩）

1. RPC 契约的 `events` 字段必填（缺省 → OpenCode 内部 Object.entries(undefined) 报错）
2. HTTP RPC method 与插件注册表隔离（见上）
3. RPC 事件 live-only → snapshot 心跳兜底
4. 本地事件流 SSE 认证：Basic auth，用户名必须字面量 `opencode`
5. user 消息无 tokens；SessionInfo.tokens 是累计值；参考消息只匹配 providerID
