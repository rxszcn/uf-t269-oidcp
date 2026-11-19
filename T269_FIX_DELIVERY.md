# T269 并发授权恢复会话串号修复 — 交付说明

## 1. 根因

统一认证门户的 OP 会话由服务端会话行支撑，浏览器多标签页共享同一 OP 会话 cookie。
授权恢复（`GET /auth/:uid`，`lib/actions/authorization/resume.js`）在装载既有会话后会调用
`session.resetIdentifier()`：把会话行主键 `jti` 轮换为新值（`oldId -> 新 jti`）并在保存时
销毁旧 `jti` 行，而会话的稳定标识 `uid` 保持不变。

同秒窗口内两个授权恢复请求并发到达时，原实现没有任何以 `uid` 为界的互斥：

1. 两个请求各自 `Session.get()` 装载到同一逻辑会话的两份独立副本；
2. 各自 `resetIdentifier()` 生成不同新 `jti`，各自 `save()`；
3. 同一 `uid` 被拆成多行互相覆盖。

由此产生题目描述的全部后果：

- 一个标签页注销后另一标签页仍持登录态，残留活会话行使已退出终端在审计侧仍显示登录中；
- 接入 `uid` 唯一索引适配器的部署，后到的 `upsert` 命中唯一约束，原始异常未被捕获，经
  `authorization_error_handler` 以 500 收场；
- 会话串号污染注销完整性判定。

模型层确定性实测（无协调并发 `save`）：同 `uid` 会话行从 1 行被拆成 **2 行**
（`ROWS_AFTER_B_uncoordinated = 2`），坐实根因，而非把冲突固化成常态失败。

## 2. 修复设计与时序取舍

采用「**进程内会话级互斥锁 + 稳定标识权威装载 + 账户级注销注册表 + 唯一约束可重试收束**」
四层组合，全部落在题目指定的“授权恢复动作的会话装载与标识符维护路径”内。

### 2.1 临界区串行化（消除拆分窗口）

- 会话请求先以 cookie 中的 `jti` 为键取入门锁；装载到真实持久化会话（带 `exp`）后升级到
  生命周期内不变的 `uid` 锁。`jti` 轮换前后的请求因此都在同一 `uid` 临界区内串行执行
  “装载 → 变更 → 保存/销毁”，从根上消除同 `uid` 拆多行的窗口。
- 无 cookie 的全新会话彼此无需互斥，不加锁，不影响无关请求吞吐。
- 锁条目在无排队者时自动回收，不随会话标识无限增长。

### 2.2 稳定标识权威装载（处理锁等待期间的轮换）

- 请求在 `uid` 锁等待期间，前一个持锁请求可能已轮换并销毁 cookie 指向的旧 `jti`。进入临界
  区后按 `uid` 重新回读权威会话行（`reconcileByUid`），不拿过期 `jti` 副本再写一行。
- cookie `jti` 失效时 `Session.get()` 返回的是空会话（`instantiate({})`，无 `exp` 但构造器
  仍生成新 `uid`）。授权恢复据此用「是否带 `exp`」精确区分：
  - 空会话（无 `exp`）= 并发轮换场景，按交互记录的稳定 `uid` 回读并重新挂接权威会话
    （`reattachByUid`），恢复以重定向正常收束；
  - 另一个已持久化会话（有 `exp`，如用户在交互期间重新登录）= 安全场景，**维持既有**
    `interaction session and authentication session mismatch` 错误，不被挂接绕过。
- 会话 Proxy 直接以真实会话对象为 target，重新挂接时重建 Proxy 并替换 `ctx.oidc.session`，
  `instanceof`、`Object.keys`、属性描述符等元属性与原对象完全一致。

### 2.3 唯一约束可重试收束（唯一索引适配器契约）

- `Session.save()` 捕获适配器抛出的唯一约束冲突（按 Postgres `23505`、MySQL `ER_DUP_ENTRY`/
  `1062`、SQLite `SQLITE_CONSTRAINT_UNIQUE`、Mongo `11000`/`E11000` 等特征保守识别）。
- 命中后先回收本次轮换产生的孤儿行，再抛出 `SessionNotFound`
  （`invalid_request`，400，可重试错误，带原始 `cause`），经授权错误处理器以**重定向或可
  重试错误**收束，绝不让原始约束冲突冒泡成未捕获 500。这是进程内锁在多进程部署下的兜底。

### 2.4 账户级注销全终结 + 隔离语义

- 新增进程内 `accountId -> Set(uid)` 注册表：会话带 `accountId` 落库即登记，销毁即摘除。
  不新增任何适配器接口契约，不影响自定义适配器实现。
- 完整注销（`logout=yes`）先按 `uid` 清扫同浏览器拆分行（`destroySiblings`），再以
  `accountId` 为界枚举终结该用户标识下全部逻辑会话（`destroyAccountSessions`，含其他浏览器
  会话）。清扫范围严格限定在本 `accountId` 的 `uid` 集合，**不触碰其他用户标识的会话行**。
- 注册表中已过期或被并发销毁的 `uid` 在回读为空时安静跳过并摘除，使注销与在途授权恢复交叠
  时也能收束而不抛错。

### 2.5 既有行为保留

- 串行场景下 `destroySiblings` 无残留行、`destroyAccountSessions` 只终结当前行，不产生额外
  适配器调用；注销确认后的会话标识符轮换（非完整注销分支的 `resetIdentifier()`）路径未改动，
  既有 `end_session` 50 项测试全绿即为佐证。

### 2.6 能力边界（如实说明）

进程内锁与注册表覆盖单进程（含 Node 异步并发）下的全部题目场景，这也是测试快照环境的部署
形态。多进程/多实例水平扩展时，跨进程的同 `uid` 竞争由 2.3 的唯一约束可重试收束兜底（不 500、
可重试）；跨进程的账户级全终结枚举受进程内注册表边界限制，规模化部署应配合共享存储的按
`accountId` 索引或后端级行锁，本次未改变适配器接口契约。

## 3. 逐文件改动登记与需求落点

| 文件 | 改动面 | 对应需求落点 |
| --- | --- | --- |
| `lib/helpers/session_lock.js`（新增） | 通用进程内 Promise 链式互斥锁，导出 `acquire(key)` 与默认 `withSessionLock(key, work)`，锁条目自动回收 | 并发后单行存活：同 `uid` 请求串行进入装载/保存临界区 |
| `lib/helpers/session_registry.js`（新增） | `accountId -> Set(uid)` 进程内注册表，含 `registerSession`/`unregisterSession`/`listSessionUids`，账户级临界区保护、固定锁序防死锁 | 注销全终结 + 不波及其他用户标识 |
| `lib/models/session.js`（修改） | ① 新增 `isUniqueConstraintError` 并在 `save()` 捕获唯一约束、回收孤儿行后转抛 `SessionNotFound`；② `save()` 成功后登记注册表，`destroy()` 摘除；③ 新增 `reconcileByUid`、`reattachByUid`、`destroySiblings`、静态 `destroyAccountSessions` | 唯一索引契约（非 500、可重试）；并发权威装载；注销全终结与隔离 |
| `lib/shared/session.js`（修改） | ① 会话中间件接入 `jti` 入门锁 → `uid` 临界区升级，锁内按 `uid` 权威回读；② 以 `exp` 区分空会话与持久化会话；③ 抽出 `createSessionProxy`，新增 `ctx.oidc.attachSession` 支持重新挂接，保留原 Proxy 的 touched/destroyed/accountId 语义 | 并发后单行存活；与在途恢复交叠的收束；隔离语义 |
| `lib/actions/authorization/resume.js`（修改） | `uid` 不匹配分支：空会话（无 `exp`）按交互记录 `uid` 重新挂接权威会话；持久化替换会话（有 `exp`）维持既有不匹配安全错误 | 并发恢复以重定向收束；不放宽既有安全校验 |
| `lib/actions/end_session.js`（修改） | 完整注销分支在销毁当前行前依次 `destroySiblings()` → `Session.destroyAccountSessions(accountId)` → 标记 `destroyed` | 任一入口注销后该用户标识会话行全部终结；不波及其他用户 |
| `test/sessions/session_concurrency.config.js`（新增） | 可枚举存储 + 可注入 `uid` 唯一约束（23505）的 `TrackingSessionAdapter`，按模型名缓存实例 | 支撑三类断言的零外部依赖测试基础设施 |
| `test/sessions/session_concurrency.test.js`（新增） | 四类断言用例（见第 4 节），并发恢复与注销交叠时序，20 轮重复，含模型层唯一约束确定性用例 | 三类契约断言随修复交付 |

## 4. 验收

### 4.1 验收命令

- 全量：`npm test`（题目指定验收口径）
- 并发专项：本仓库测试需经 `test/suite.js` 先建立全局 HTTP server，专项复跑使用等价的
  `node:test` 运行器（预加载全局 server），命令与辅助脚本仅位于 `.t269/`，**不在交付的
  `lib/`、`test/` 改动面内**。

### 4.2 构造输入（零外部依赖，快照环境内可重复）

- 并发授权恢复：同一 OP 会话 cookie 克隆出两个标签页 agent，各自发起独立授权并产生独立
  待恢复交互，再在同一秒窗口 `Promise.all` 并发 `GET /auth/:uid` 恢复。
- 注销交叠：上述两个并发恢复与同窗口内的 `end_session` init + confirm（`logout=yes`）
  通过 `Promise.allSettled` 交叠执行。
- 唯一索引形态：`TrackingSessionAdapter.enforceUidUnique = true`，对同 `uid` 第二个不同
  `jti` 的 `upsert` 抛 Postgres 风格 `23505`。

### 4.3 实测读数

并发专项（`test/sessions/session_concurrency.test.js`）连续多轮复跑，最近一次：

```
✔ concurrent resumes of the same user leave exactly one live session row (471.9766ms)
✔ logout terminates every session row of the user identifier and isolates others (15.3758ms)
✔ unique-index adapter: overlapping resume and logout never surfaces an uncaught constraint 500 (416.2996ms)
✔ unique-index adapter: a raw constraint conflict is contained as a retryable error, never a 500 (1.4335ms)
ℹ pass 4   ℹ fail 0
```

- 用例一内部循环 **20 轮**，每轮终态断言该用户标识会话行存活行数恒为 1，
  `assert.deepEqual(readings, Array(20).fill(1))` 通过——**20 轮实测读数全部为 `[1 × 20]`**。
- 用例二：目标用户注销后存活行数 `0`，另一用户标识存活行数保持 `1`（隔离）。
- 用例三内部循环 **20 轮**，每轮所有交叠请求状态码均不为 500，终态存活行数 ∈ {0,1}。
- 用例四（模型层确定性）：HTTP 路径上的 `uid` 锁使同 `uid` 写入串行化，唯一约束分支在正常
  请求中本就不触发；该用例绕过 HTTP 锁直接并发 `save`，实测适配器 `upsert` 命中一次
  `23505`（`constraintHits >= 1`），且被收束为 `SessionNotFound` 而非冒泡 500，确定性覆盖
  多进程兜底分支，避免“约束收束代码从未被实测”的伪修复。

### 4.4 全量回归

`npm test` 结果：**3706 项测试，3703 通过，1 项失败**。

唯一失败为 `test/tools/type_contracts.test.js:524` 的 checked-in 文档
（`docs/events.md`）行尾快照断言，本机 `git config core.autocrlf=true` 使工作区文件为
CRLF，而断言按 LF 比对。已两次证实与本修复无关：

1. `git stash` 还原为不含任何本次改动的干净检出，该测试同样失败（21 pass / 1 fail）；
2. 仅把 `docs/events.md` 临时转为 LF（随即还原），该文件所在套件即 22 pass / 0 fail。

除该环境性 CRLF 快照外，本次改动相关套件全部通过：`sessions` 3/0、`session_concurrency`
4/0、`end_session` 50/0、`interaction` 34/0、`session_bound_tokens` 4/0、
`memory_adapter` 11/0、`base_token` 12/0、`backchannel_logout` 11/0、`oauth` 25/0、
`authorization_code` 合计 31/0。`npm run lint`（biome，446 文件）零问题。
