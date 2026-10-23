# Radar 插件路线图（v1.1 + v2）

> 基于对 `tui.tsx` / `model.ts` / `format.ts` 的逐行审读，以及对
> `@opencode/plugin` SDK（`dist/tui/context.d.ts`）与 `@opencode/client` 的 API 验证。
> 工作量口径：S ≤ 半天，M = 1–2 天，L = 3 天以上（均含验证）。

## 进度（2026-10-23）

**v1.1 已完成**：1.1（memo/时钟拆分）✅ · 1.2（幽灵行治理）✅ · 1.3（OverviewBar 空态+宽度）✅ ·
1.4（DetailView 宽度自适应 + last tool 行）✅ · 1.5（同步中空态 `synced` 信号）✅ ·
1.7（权限跟踪收敛：requestID 精确匹配 + reconcile 代际号）✅ ·
1.9（排序切换 `s`、idle/running 区分、`ToolAction.at` 用于明细、shortModel 注释对齐）✅
另有焦点调查新增项：`escape` 关闭面板绑定 + footer 提示 `ctrl+x ←` 返回 prompt ✅

**v2 已完成**：2.1（完成通知：toast + 系统通知 + 去重，仅子会话）✅ · 2.2（树状视图：任意深度后代、
`h/l` 折叠、深度缩进卡片、孤儿挂回根、折叠箭头在卡片标题栏）✅ · 2.3（中断 subagent：`x` →
确认对话框 → client.session.interrupt，仅 running/waiting/stale 可中断）✅ · 2.6（偏好持久化
`storage.store` + `/radar notify|sound on|off` + `/radar status`，slash `arguments: true`）✅ ·
2.7（scanTools 缓存：末消息指纹 + 仅对最后一个工具构建摘要；未变化会话跳过重扫）✅ ·
卡片化 UI（用户需求：rounded 边框 + 边框标题栏 + 状态色边框）✅

**上下文进度条 contextbar**：✅ 已实现并验证（`.opencode/plugins/contextbar/`，2026-10-23）。
单包双端：server 钩子测量 system/tools/instructions chars → RPC 事件推送（v2.1.3 实测
HTTP RPC method 与插件注册表隔离，事件流正常）→ TUI 在输入框上方渲染分段进度条。
详见 `docs/contextbar-design.md` 与插件 README。

**未做**：1.6（窄屏列裁剪，需窄终端目测校准）、1.8（长列表窗口化，待实测宿主滚动行为）、
2.4（footer 摘要）、2.5（明细增强）、2.8（发布）

---

## 一、发现的问题清单

### 正确性 / 资源

| # | 位置 | 问题 | 严重度 |
|---|------|------|--------|
| P1 | `tui.tsx:230-247` | **`views` memo 依赖 `now()`（`sortViews(..., now())` 在 line 246）**，`useNow` 每秒触发 → 整个 memo 每秒重算，`collectChildren` + `scanTools` 每秒对全部子会话全量重扫（O(会话数×消息数×parts)）。事件节流 250ms 之上还叠加 1Hz 常驻重扫，长会话下是最大性能热点 | 高 |
| P2 | `tui.tsx:125,234-244` | `ghosts` Map（根会话 → 桶）**跨会话永不清理**：TTL 剪枝只作用于"当前面板附着会话"的桶；切过多少个会话就留下多少桶。且 `setup` 清理函数（503-508）清了 `pendingPermissions` 却**不清 `ghosts`**，不一致 | 中 |
| P3 | `tui.tsx:236` | 在 `createMemo` 内部执行 `bucket.set(...)` 副作用（写 ghosts 快照）。Solid 反模式：memo 可能重放/丢弃，副作时机不可靠。应移到 `createEffect` 或事件侧 | 中 |
| P4 | `tui.tsx:110-122,459-472` | 权限栈只对 `permission.asked/replied/rejected` 做栈式 push/pop：**任意会话**（含与 radar 无关的会话）的事件都会写入 `pendingPermissions`，且只有面板重新附着时的 reconcile 才能纠偏。无关条目常驻、pop 语义在多请求并发时可能错位 | 中 |
| P5 | `tui.tsx:136-164` | `reconcilePermissions` 对整个 family 并发发起多个 async sync，**无取消**：面板已切到别的会话后 `.then` 仍会写入旧会话的 `pendingPermissions`（时序竞态，靠下一次 reconcile 自愈） | 低 |
| P6 | `model.ts:187` | 导出的 `vanished` Set 是**死代码**——全仓库无任何 `vanished.add()`。真实幽灵机制在 `tui.tsx` 的 ghosts Map。两套"消失"概念并存易误导 | 低 |
| P7 | `model.ts:158-180` | `scanTools` 每次全量遍历所有消息的所有 part，无缓存（与 P1 叠加放大）。树状视图（孙会话）上线后会成倍恶化 | 中 |

### UI / 布局

| # | 位置 | 问题 | 严重度 |
|---|------|------|--------|
| P8 | `tui.tsx:325-341` | `OverviewBar` 无 subagent 时仍渲染两行（"0 tracked · 0 active · 0 done" + "0↓ 0↑ · $0 · 0 calls"），与下方 EmptyState 重复、噪音；且两行字符串**不按 `panel.width` 截断**，窄面板溢出/换行 | 中 |
| P9 | `tui.tsx:415` | DetailView 分隔线写死 `"─".repeat(8)`，与面板宽度无关；无标题头；内容行（含完整 `session <长ID>`）也不按宽度截断 | 低 |
| P10 | `tui.tsx:349` | 行头固定列宽（agent 9 列 + model 20 列），`budget = max(20, width-2)`：窄面板下截断保留左侧（agent/model），**右侧最动态的 tokens/时间信息最先丢失**；无窄屏列裁剪策略 | 中 |
| P11 | `tui.tsx:296-322,316-318` | 列表无滚动/窗口化：子代理多于面板高度时行为未验证（可能裁剪）；DetailView 渲染在**全部行之后**而非选中行下方，长列表时展开的明细可能落在可视区外 | 中（需验证） |
| P12 | `tui.tsx:423-434` | EmptyState 无法区分"数据尚未 sync 完"与"确实没有子代理"：切换会话附着后先闪一下 "No subagents yet" 再弹出真实数据 | 低 |
| P13 | `model.ts:280-286` | `sortViews` 每 tick 按状态+时间重排，行会随状态变化实时跳动；无"按时间排序"模式切换 | 低 |
| P14 | `model.ts:274-277` | `deriveStatus`：idle 且无 outcome 的会话 fallback 返回 "running"（◉），把"刚空闲"显示为"运行中"，语义略失真 | 低 |

### 死代码 / 注释不符

| # | 位置 | 问题 | 严重度 |
|---|------|------|--------|
| P15 | `model.ts:175` + `tui.tsx:367-375` | `ToolAction.at` 字段计算后从未在 UI 使用 | 低 |
| P16 | `format.ts:120-124` | `shortModel` 注释说 "claude-sonnet-4-6 → sonnet-4-6; keeps provider when short"，实现只按长度 28 截断，**从不剥 provider 前缀**，注释与实现不符 | 低 |
| P17 | `package.json` | `private: true`、无 README、无 lint/test 脚本；`tsconfig` 无测试配置 | 低（发布前必办） |

---

## 二、v1.1 —— 快赢（打磨 + 修复，全部低风险，无新 API 依赖）

### 1.1 拆分数据 memo 与时钟（修 P1）— S ⭐ 首选
- **做什么**：`views` 只依赖 `tick()`；`sortViews` 的 `now` 参数与行内 elapsed 移到独立的轻量 memo / `AgentRow` 内部（`deriveStatus(view, now)` 本来就在 Row 里按秒重算）。顺带把 P3 的 `bucket.set` 副作用移入 `createEffect(on(...))`。
- **为什么**：消除 1Hz 全量重扫，是其余一切（树状视图、明细增强）的性能地基。
- **改动**：`tui.tsx`（RadarView/views/AgentRow）。
- **API**：无新增。
- **风险**：低；注意 ghost 快照写入时机变化后，TTL 语义保持不变（用单测/手动验证 30min 逻辑可先做成常量注入）。

### 1.2 幽灵行治理（修 P2 + P6）— S
- **做什么**：① setup 清理函数同时清 `ghosts`；② 桶级清理：根会话桶内全部条目过期后删除桶（或根会话本身消失时删除）；③ 监听 `session.deleted` 事件（schema 已确认，payload 带 `sessionID`）即时标记幽灵，替代"下次 diff 时才发现"；④ 删除 `model.ts:187` 死 Set。
- **改动**：`tui.tsx`（ghosts 生命周期、事件 switch）、`model.ts`（删死代码）。
- **API**：`context.data.listen` 中新增 `session.deleted` 分支（已有，零新依赖）。
- **风险**：低；`session.deleted` 需冒烟验证 TUI 数据层确实转发该事件类型名。

### 1.3 OverviewBar 空态与宽度（修 P8）— S
- **做什么**：`total === 0` 时只留标题行（或整条隐藏）；两行统一走 `truncateColumns(width)`。
- **改动**：`tui.tsx` OverviewBar。
- **风险**：无。

### 1.4 DetailView 宽度自适应（修 P9）— S
- **做什么**：分隔线 `repeat(width)`；加一行标题头（agent 名 + 状态 icon）；所有行 `truncateColumns(width)`；session id 提供 `…` 截断。
- **改动**：`tui.tsx` DetailView。
- **风险**：无。

### 1.5 空态 vs 同步中（修 P12）— S
- **做什么**：面板附着后、family/permission sync 完成前显示 "syncing…"；用 `reconcilePermissions` 的 Promise.all 完成信号翻转 `synced` 信号（按根会话 ID 记忆，短 TTL 防闪烁）。
- **改动**：`tui.tsx`（reconcile + EmptyState 分支）。
- **风险**：低；sync 失败路径要回落到"无子代理"文案。

### 1.6 窄屏列裁剪（修 P10）— M
- **做什么**：按 `panel.width` 分档：≥80 全列；60–79 隐 model 列；<60 再隐 title 或 tail 缩短（`in→out` 只显示总量）。
- **改动**：`tui.tsx` AgentRow、可能加 `format.ts` helper。
- **风险**：低；分档阈值用真实窄终端（分屏 40/60/80 列）目测校准。

### 1.7 权限跟踪收敛（修 P4/P5）— S
- **做什么**：事件侧只记录"当前已知 family 成员"的权限；`reconcilePermissions` 用 `Promise.allSettled` + 附着代际号（generation counter）丢弃过期回调；周期性（如 30s）对当前 family 对账。
- **改动**：`tui.tsx` 事件处理 + reconcile。
- **风险**：低；注意别把"尚未收录进 family 的新子会话"的 asked 事件丢掉（可先记，成员判定时再过滤）。

### 1.8 长列表与选中可见性（修 P11）— M（含验证）
- **做什么**：先验证 session.panel 对超高内容的实际行为（裁剪/滚动/撑破）。若无滚动：做简单窗口化（只渲染选中±N 行）；DetailView 改为渲染在选中行正下方（`For` 内条件渲染）或展开时自动滚到可见。
- **为什么**：并行 subagent 一多（>面板高度），当前结构必然破。
- **风险**：**需先验证宿主滚动行为**（未知项）；窗口化会与"detail 在选中行下方"耦合，一起设计。

### 1.9 小项打包（修 P13/P14/P15/P16）— S
- 排序切换：`s` 键在 status 优先 / 最近更新 两种排序间切换（`sortViews` 加 mode 参数）。
- `deriveStatus` 增加 `idle`（近期无活动且无 outcome）与 running 区分，或至少把 fallback 改为更诚实的 ◔ 图标（可选，需用户确认观感）。
- 删 `ToolAction.at` 或在行内显示"该工具已运行 Ns"（更有用，二选一）。
- `shortModel` 实现对齐注释（按 `/` 取尾段，超长再截断）。

**v1.1 合计约 3–5 个工作日。**

---

## 三、v2 —— 特性（按优先级排序）

### 2.1 完成通知（attention.notify + toast）— M ⭐ 用户价值最大
- **做什么**：监听 `session.execution.succeeded / failed / interrupted`（schema 已确认 payload 带 `sessionID`），对"当前根会话的子会话"发通知：`attention.notify({ message, sound: { name: "subagent_done" | "error" }, notification: { when: "blurred" } })` + `ui.toast.show({ message, sessionID })`（toast 带 sessionID 时宿主自动提供"打开该会话"入口）。失败/中断可用不同音效与 `when: "always"`。用 `storage.store` 做去重（已通知的 sessionID+outcome）+ 偏好（总开关、音效开关、通知时机 focused/blurred），跨 TUI 实例天然同步。
- **为什么**：subagent 并行跑时用户最痛点是"不知道谁完了/谁炸了"；这是 radar 存在的核心理由之一。
- **改动**：`tui.tsx`（事件处理 + 通知模块）、`model.ts`（family 归属判断）；新增 `notify.ts` 更干净。
- **API**：`context.attention.notify`（音效名 `subagent_done` 已在 SDK 枚举中确认）、`context.ui.toast`（`sessionID` 字段已确认）、`context.storage.store`。
- **风险/验证**：① 事件里无 parentID，需要用 `data.session.get(id).parentID` 判定归属（子会话记录应已缓存，若未缓存需 await `session.sync`）；② 通知别对"根会话自身"和自己触发的事件重复（宿主可能已有 subagent_done 内置提示，需实测是否双响，必要时只补 toast/系统通知）；③ `when: blurred` 的焦点判定在 tmux 下的行为需实测。

### 2.2 树状视图（孙会话层级 + 折叠）— M/L
- **做什么**：`collectChildren` 放宽为按 `parentID` 建树（`family()` 本就返回全家族，数据层零新增）；行缩进表示层级，父行显示聚合（子代 tokens/计数）；`space`/`l` 展开折叠（`enter` 保持明细），折叠状态存 `storage.memory`（热重载存活）；概览聚合可选"仅直接子代/全树"。
- **为什么**：v1 明确的范围缺口；workflow/并行派生的场景下孙会话是真实需求。
- **改动**：`model.ts`（`collectChildren` → `collectTree`、`aggregate` 层级化）、`tui.tsx`（缩进行渲染、折叠键位、选中在树上的 j/k 语义——平铺遍历 vs 跳子级）。
- **API**：无新增（纯数据重组）+ `storage.memory`。
- **风险/验证**：① 深树的 j/k 导航语义要先出设计（建议：j/k 走"可见行序列"，`h/l` 收起/展开）；② `family()` 对深层的返回内容冒烟验证；③ 性能：全树 `scanTools` 每 tick 扫描量大，**前置依赖 2.7 的扫描缓存**（或先只对折叠状态不扫描、展开才扫）。

### 2.3 中断 subagent — S/M
- **做什么**：`x` 键中断选中行：`ui.dialog.confirm({ title: "Interrupt subagent", message, label: { confirm: "Interrupt" } })` 确认后调 `context.client.session.interrupt({ sessionID })`（client API 已在 `@opencode/client` 类型中确认，入参 `{ sessionID, resume? }`）。幽灵行不可中断；等待权限的会话先中断再观察能否清掉 pending。
- **为什么**：跑偏的 subagent 目前只能去对应 tab 里手动 Esc；"看得到管不着"是 v1 第二大缺口。
- **改动**：`tui.tsx`（键位 + confirm + 调用 + 结果 toast）；`TuiContext` 结构类型补 `client`。
- **API**：`context.client.session.interrupt`、`context.ui.dialog.confirm`、`ui.toast`。
- **风险/验证**：① interrupt 对 child session 是否级联中断其孙会话（语义未文档化，需实验）；② 中断权限等待中的会话的实际表现；③ 失败错误路径（SessionNotFound 等）要 toast 兜底。

### 2.4 Footer 常驻摘要 — M
- **做什么**：`ui.slot({ append/prepend: "prompt.footer.status", render })` 在会话 footer 显示一行微型摘要，如 `⦿ 2◉ 1⚠ 3✓ · 45k↓ · $0.42`（有子会话才渲染）；点击/键位不可行则纯展示 + 数值带色。`prompt.footer.status` 的 input 带 `sessionID`（已确认），无需额外状态。备选 `home.footer.status`（input 无 sessionID，需 `ui.router.current()` 反应式取当前会话，复杂一档）。
- **为什么**：不开面板也能感知子代理状态，"雷达"从面板变成环境感知；对标 statusline 类插件。
- **改动**：`tui.tsx`（新增 slot claim + 微型组件，复用 `aggregate` 与 `format`）。
- **API**：`context.ui.slot`（`prompt.footer.status`）、现有 data 层。
- **风险/验证**：① 与其他 footer 插件的共存/宽度挤占（footer 是共享行，需短摘要 + 宽度探测）；② 该 slot 对 `prepend/append` 的宿主渲染顺序实测；③ 面板未开时事件节流是否够（可能要把 tick 降频到 1s 定时 + 事件合并）。

### 2.5 明细视图增强：工具时间线 + token sparkline — M/L
- **做什么**：① 最近 N 次工具调用时间线（`scanTools` 顺带返回尾部序列即可，渲染 `HH:MM name summary 状态`）；② token 增长 sparkline：事件/秒级采样 `record.tokens` 进 `storage.memory` 环形缓冲（每会话 ~60 点），DetailView 用 block/braille 字符画双线（in/out）。
- **为什么**：判断"这个 subagent 是在稳步推进还是原地打转"靠曲线比靠累计数快得多。
- **改动**：`model.ts`（`scanTools` 返回 tail 序列、采样器）、`format.ts`（sparkline 渲染）、`tui.tsx` DetailView。
- **API**：`storage.memory`（热重载存活，无需持久化）。
- **风险/验证**：① 采样只覆盖 radar 加载之后的时间（无历史 API，需在 UI 上标注"since panel open"）；② 采样定时器与 1.1 的时钟拆分协调，避免重新引入常驻全量扫描；③ braille 字符在 `format.ts` 的宽度表里是 0 宽（0x2800-0x28FF 不在 wide 表，实际占 1 列）——**宽度计算需先修正/实测**，否则截断错位。

### 2.6 偏好持久化 — S（可并入 2.1）
- **做什么**：`storage.store("radar.prefs", { notify, sound, when, ghostTTL, sortMode, defaultExpand })`；提供 `/radar notify off` 等子命令（slash `arguments: true` 已支持）或面板内 `n` 键切换。
- **风险**：无；注意 store 是全实例同步的 JSON，别写大对象。

### 2.7 scanTools 增量缓存（性能前置，服务 2.2/2.5）— S/M
- **做什么**：按 sessionID 缓存 `{ messageCount, lastMessageID, result }`，`message.list` 长度与末条 ID 未变则复用；流式更新只重扫末条消息。
- **为什么**：单层 5 个子代理×200 条消息已是 1000 条/扫；树状视图 ×3。
- **风险**：低；注意消息数组被宿主原地变更（mutation）的可能——用长度+ID 双指纹规避。

### 2.8 发布准备（README + npm 包化）— M
- **做什么**：README（截图、键位表、配置项、已知限制）；`package.json` 去 private、补 files/repository/scripts（`tsc --noEmit` 检查脚本）；可选 GitHub Actions；版本升 1.0 对应 v2 发布。
- **风险/验证**：**OpenCode 插件的分发机制需先确认**（本地 `.opencode/plugins/` 路径加载已验证可用；npm 包名安装/`plugins` 配置引用外部包的方式是未知项，先查文档再定包形态）。

**建议执行顺序：1.1 → 1.2 → 1.3/1.4/1.9 → 2.1(+2.6) → 1.5/1.6/1.7 → 2.3 → 2.7 → 2.2 → 2.4 → 2.5 → 2.8**

（1.8 随时插入：一旦真实使用中出现 >10 个子代理就提前。）

---

## 附：已验证的 API 事实（免二次查证）

- `context.attention.notify({ title?, message, notification?: {when}, sound?: {name, volume, when} })`：`when ∈ always|focused|blurred`，音效枚举含 **`subagent_done`**。
- `ui.toast.show({ message, variant?, duration?, title?, sessionID? })`：带 `sessionID` 且其 family 未打开时，宿主自动给"打开会话"入口。
- `context.client.session.interrupt({ sessionID, resume? })`：存在于 promise 版 OpenCodeClient。
- `ui.slot` 槽位：`home.footer.status`（input 无 sessionID）、`prompt.footer.status`（input 含 sessionID/mode/showDetails）、`sidebar.footer`、`session.composer.top` 等。
- `context.storage`：`store`（持久 JSON、跨 TUI 实例实时同步）与 `memory`（内存、热重载存活）。
- `ui.dialog.confirm/alert/select`、`ui.tabs.open/focus/list/close`、`keymap` slash 支持 `arguments: true`。
- 事件：`session.execution.succeeded/failed/interrupted`、`session.deleted` 均携带 `sessionID`。
- `data.session.family(sessionID)` 返回全家族 ID（不止直接子代）——树状视图不需要新数据源。
