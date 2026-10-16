# dsh-session-move

侧栏**工作区文件夹**（分组）与**会话移动**（DSH Web 插件，宿主侧 + 客户端侧）。

> **English**: a [DeepSeek Harness](https://github.com/deepseek-ai) plugin that adds a *virtual folder* layer above workspaces — folders nest, hold any number of workspaces (and sessions placed under them), and never touch the disk — plus *move a session into another workspace* by rewriting the session log header's `cwd` (byte-verified, automatic rollback on failure).

## 安装

1. clone 或下载本仓库到任意目录；
2. 装进你的 DSH profile：`dsh plugin --profile <你的 profile> add <本目录>`（附：桌面版 profile 由应用独占管理，如果命令被拒绝，就在插件页里装，或手工把 `dsh-session-move` 加进该 profile `package.json` 的 `dsh.profile.bundles`）；
3. **完全退出 DSH 再打开**（宿主侧与客户端侧都必须重启才生效）。

## 开发注意（这几个坑都是实际踩过的）

- **改了客户端文件也要重启 DSH**：宿主按内容哈希发布客户端模块（`public, max-age=31536000, immutable`），只刷新页面会拿着旧版本号去取、被宿主按规则拒绝，表现出来可能是「插件加载失败」甚至「应用无法启动」；
- **不要直读没 inject 的 `ctx.xxx`**：Cordis 里访问未声明的服务属性会直接抛异常，请一律用 `ctx.get("xxx")` 取可选服务；
- **所有"消费类"调用都要自带 try/catch**（路由注册、快捷键注册、槽位注册）：客户端插件激活失败会让 DSH 判定 `entry did not activate`，直接弹启动失败并提示禁用第三方插件；
- 平台不允许第二个 entry 再声明 `sidebar.workspaces` 已声明过的子槽位，所以本插件**不新注册占用者**，而是就地包裹官方 entry 的 component（见下文）。

## 工作区文件夹

官方侧栏只有“工作区（目录）”这一层，本插件在它上面加了一层纯虚拟的**文件夹**：

- 侧栏右上「＋」→ **新增文件夹**：随便建，不需要选本地目录，磁盘上不产生任何东西；
- 文件夹可以**套文件夹**、可以放**任意多个工作区**；工作区不能当父级（不存在这种容器）；
- 工作区行的「…」→ **移入文件夹…**（或“不放入文件夹（顶层）”）；文件夹行的「…」有新建子文件夹 / 重命名 / 移入其它文件夹 / 删除（删除只是解散，里面的东西上移到父层）；
- 「＋」→ **新增工作区（选择本地目录）** 仍是官方的目录选择流程；文件夹行的「…」里也有
  **新建工作区（选目录后放进这里）**，建完自动放进该文件夹；
- 展开状态记在浏览器本地（localStorage）：文件夹与工作区都默认展开，点行即收/放；
- 会话可见性照搬官方规则：**已归档的会话默认隐藏**（工作区「…」→「显示已归档的会话」可切换，
  这个开关和官方 / 归档管理插件共用同一个 viewStore 状态）、子代理会话不显示、非当前选中项的空会话不显示；
- 没归入任何工作区的会话放在末尾的「未分组」组里（官方同款）；
- **会话也可以直接放进文件夹**（侧栏分组，不动工作目录）：会话「…」→ 移动到工作区 / 文件夹…，
  在文件夹那一行点「把会话放这里」即可；放进去之后它只在文件夹下显示一次（不再重复出现在所属工作区里），
  想放回去就选「移出文件夹」。
  - 两种目标的区别：选**工作区** = 真的把会话搬过去（会改它的工作目录）；选**文件夹** = 只改侧栏分组。

实现要点：平台不允许第二个 entry 再声明 sidebar.workspaces 已经声明过的子槽位，所以本插件
**不新注册占用者**，而是像 dsh-im-connect 那样把官方 entry 的 component 就地包一层（渲染出错时
自动回落到官方侧栏）：渲染器仍然把官方 entry 自己的 props 交给这层，于是
sidebar.workspaces.session.menu.item 里所有插件贡献的菜单项（置顶 / 重命名 / fork / 归档 /
删除会话 / 移动到工作区…）照常出现在本插件的会话行里，官方动作（打开会话、新建会话、重命名 /
删除工作区、目录选择器）也全部沿用。

## 它解决什么问题

DSH 里“会话属于哪个工作区”是由**会话自己的工作目录 cwd**决定的：

- `workspaceRegistry.attachSession()` 会拿会话头部 cwd 与工作区路径比对，不一致就拒绝；
- 会话日志在磁盘上的位置也由 cwd 推导，位置与头部 cwd 不符会被判为损坏日志；
- 内核没有“移动会话”的接口，归档管理类插件也没法用公开 API 做到。

本插件把这件事拆成两步，并在宿主进程内一次完成：

1. **数据手术**：重写会话日志第 1 个 zstd 帧（头部）里的 `cwd`，并把会话目录搬到新 cwd 对应的项目目录；事件帧逐字节保留，写完立刻自检，失败即回滚。
2. **归属记账**：以“恢复一次会话”的方式让宿主按磁盘现状重新读取它，调用官方 `Workspace.attachSession()` 挂到目标工作区，再从旧工作区 `detachSession()`，随后立即释放刚恢复的会话（不会把它长期留在内存里）。

整个过程**不需要重启 DSH**，也不需要手工改 `workspace.json`（归属由宿主自己持久化）。

## 用法

1. 侧栏会话行右侧「…」菜单 → **移动到工作区…**（文件夹里的会话同样可用）
2. 在弹出的列表里选目标工作区（当前所在的工作区已置灰），或者填一个新目录（会自动登记为工作区）；
3. 点「移动」。完成后这条会话就出现在目标工作区下。

同一条会话可以反复移动。已是目标工作区、会话正在运行、子代理会话、目标目录不存在等情况都会给出明确提示，不会改坏数据。

## 接口

宿主侧只注册一条同源路由（不替换任何官方服务）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-session-move?sessionId=<id>` | 工作区列表 + 这条会话的当前归属 |
| POST | `/api/dsh-session-move` | `{ action: "move", sessionId, workspaceId 或 targetPath, title? }` |

写请求只接受本机同源调用（校验 `Origin`/`Host` 与 `Sec-Fetch-Site`）。

## 配置

`package.json` 的 `dsh.client` 声明客户端半；`cordis.patch.yml` 只做一条 `insert`，不 disable 官方任何入口。

```yaml
- insert:
    - id: dsh-session-move
      name: 'dsh-session-move'
```

## 冷会话与“打开着”的会话

DSH 只要**打开过**一条会话（在对话页看过、聊过），宿主里就会留下一个常驻 agent，它持有这条会话日志的写入句柄；内核没有提供关闭它的接口（AgentHandle 只在创建者手里）。所以：

- **冷会话**（本次运行里没打开过）：点一下立刻完成，不用重启。
- **打开着的空闲会话**：不能改写日志，插件会把这次移动**登记成待办**，下次 DSH 启动时（此刻所有会话都是冷的）自动完成 —— 界面提示“完全退出并重开 DSH 后自动完成”。登记文件是 <DSH 数据目录>/storages/session-move-pending.json，连续失败 3 次才放弃。
- **正在运行的会话**（有回合在跑）：直接拒绝，先结束后再移动。

## 已知边界

- 移动会**改变会话的工作目录**：之后在这条会话里执行的工具调用都在新目录下，历史记录里的旧路径不会改写。
- 正在运行（有回合在跑）的会话会被拒绝；请先结束后再移动。
- 只处理官方 JSONL 存储（`session-persistence-jsonl`，日志格式 v4）；其他后端会因 `locate()` 不可用而拒绝。
- 移动一条**已经归档**的会话是允许的（归档集合按 id 全局保存），但它在侧栏里仍然处于归档状态。
- 恢复会话时宿主会追加一条 `session/end-seed` 事件，这是官方的恢复标记，不影响历史内容。

## 卸载

从 profile 的 `dsh.profile.bundles` 里删掉 `dsh-session-move` 这一项，再执行
`dsh plugin --profile <name> remove dsh-session-move`，重启 DSH 即可。
