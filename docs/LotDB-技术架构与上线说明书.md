# LotDB 技术架构、功能规格与编译上线说明书

> 产品：LotDB 1.0.0。一款轻量的 macOS 桌面数据库客户端，支持 MySQL 和 PostgreSQL。
> 文档日期：2026-10-24。本文取代以前的 `plan.md`、`打包上线方案.md` 和 `2026-10-22-复审报告.md`。
> 内容按当前 `main` 分支的代码整理。代码和文档不一致时，以代码为准，并更新本文。

本文分三部分：

- 第一部分：技术架构。
- 第二部分：功能规格。
- 第三部分：编译与上线。

---

# 第一部分 技术架构

## 1. 总体结构

LotDB 基于 Tauri v2。前端运行在系统自带的 WKWebView 里，后端是同一个进程里的 Rust 代码，两者通过 Tauri IPC 通信。数据库驱动、SSH 隧道、文件读写和钥匙串访问都在 Rust 侧完成，前端只负责界面和状态。

```
┌──────────────────────── LotDB.app（单进程）────────────────────────┐
│                                                                    │
│  WKWebView：React 19 + TypeScript                                  │
│  ├─ components/   界面（侧栏、对象树、SQL 编辑器、数据网格…）       │
│  ├─ stores/       Zustand 状态（工作区标签、草稿、偏好、最近记录）  │
│  ├─ hooks/        TanStack Query 封装的数据读取                    │
│  └─ services/tauri-commands.ts   全部 IPC 调用的唯一入口           │
│                    │ invoke(cmd, args)        ▲ emit(progress)     │
│  ──────────────────┼──────────────────────────┼─────────────────── │
│                    ▼                          │                    │
│  Rust（tokio 异步运行时）                                          │
│  ├─ commands/   Tauri 命令（连接、查询、对象、数据、传输、管理…）   │
│  ├─ db/         连接池、SSH 隧道、方言、值转换、本地 SQLite         │
│  ├─ utils/      SQL 拆分与只读判定、钥匙串、文本文件编码            │
│  └─ error.rs    统一错误 AppError {code, message}                  │
│        │                 │                    │                    │
└────────┼─────────────────┼────────────────────┼────────────────────┘
         ▼                 ▼                    ▼
   MySQL / PostgreSQL   macOS 钥匙串      ~/Library/Application Support/
   （直连或经 SSH 隧道）  （密码）          com.lotdb.app/lotdb.db（元数据）
                                           外部工具：mysqldump / mysql /
                                           pg_dump / psql（备份恢复）
```

设计上的几个原则：

- **密码不出钥匙串**：数据库密码、SSH 密码和私钥口令只存在 macOS 钥匙串里。SQLite 和 `get_connections` 的返回值都不含密码。
- **SQL 由后端生成**：标识符引用、字面量转义和占位符都由 `db/dialect.rs` 统一处理。前端只在 DDL 预览和变更预览中生成 SQL 给用户看，执行前仍交给后端。
- **大数据走流式**：查询结果有行数上限；导出、批量导出和跨库传输都按行流处理，不把整张表读进内存。
- **长任务可取消**：查询、导入、导出、传输、备份和恢复都可以中途取消。

## 2. 技术栈

### 2.1 前端

| 技术 | 版本 | 用途 |
|------|------|------|
| React | 19.2 | UI 框架 |
| TypeScript | 6.0 | 开发语言 |
| Vite | 8 | 开发服务器与构建，端口 1420 |
| TailwindCSS | 4.2 | 样式，主题令牌定义在 `src/index.css` |
| Radix UI（shadcn/ui 风格封装） | 1.4 | 对话框、菜单、下拉、提示等基础组件，见 `src/components/ui/` |
| CodeMirror | 6 | SQL 编辑器，用 `@codemirror/lang-sql` 实现方言高亮和补全 |
| TanStack Table / Virtual | 8 / 3 | 数据网格与虚拟滚动 |
| TanStack Query | 5 | IPC 数据缓存、重试和加载状态 |
| Zustand | 5 | 全局状态，部分持久化到 localStorage |
| sql-formatter | 15 | SQL 格式化 |
| lucide-react | 1.8 | 图标 |
| @tauri-apps/plugin-dialog | 2.7 | 系统原生的打开和保存面板 |

`react-router-dom` 仍在依赖里，但代码没有用到，以后可以删除。

### 2.2 后端

| 技术 | 用途 |
|------|------|
| Tauri 2.10 | 桌面壳、IPC、窗口与打包 |
| tokio | 异步运行时 |
| sqlx 0.8（mysql / postgres / sqlite，native-tls） | 数据库驱动、连接池，以及本地元数据库 |
| russh 0.60 | 纯 Rust 实现的 SSH 隧道，不依赖系统的 OpenSSH |
| security-framework | macOS 钥匙串（只在 macOS 上编译，其他平台是空实现，方便 CI 在 Linux 上测试） |
| rust_xlsxwriter | 导出 Excel |
| encoding_rs | 导入时识别 GBK、GB18030、Big5、Shift_JIS、UTF-16LE 等编码 |
| dashmap | 连接池表、查询会话表等并发映射 |
| thiserror / anyhow | 错误类型 |
| tauri-plugin-dialog 2.7 | 原生文件面板 |

### 2.3 工具链

pnpm 10、Node 22、Rust stable（本机 1.94）、ESLint 10 + Prettier 3、clippy + rustfmt、Vitest 4（jsdom）、GitHub Actions、tauri-action。

## 3. 代码结构

```
lotdb/
├── index.html                  # 入口 HTML，引用 /favicon.png
├── public/                     # app-icon.png（欢迎页 Logo）、favicon.png
├── src/                        # 前端
│   ├── App.tsx / main.tsx
│   ├── components/
│   │   ├── layout/             # 应用布局、侧栏、标签栏、主内容区、偏好设置、快捷键帮助、应用内对话框
│   │   ├── connection/         # 连接对话框、连接配置导入导出
│   │   ├── explorer/           # 对象树、表结构面板、DDL 查看、序列/枚举管理、对象搜索
│   │   ├── editor/             # 查询标签、SQL 编辑器、结果面板、执行计划、历史、片段、参数输入
│   │   ├── grid/               # 数据网格、表数据标签、单元格查看器、变更预览
│   │   ├── designer/           # 表设计器、索引/外键编辑、DDL 预览与对比
│   │   ├── transfer/           # 导出、批量导出、导入、跨库传输、备份、恢复、任务状态栏
│   │   ├── admin/              # 新建数据库、用户管理、活跃查询、磁盘占用、结构对比
│   │   └── ui/                 # 基础组件
│   ├── hooks/                  # use-connections、use-objects、use-cli-task、use-global-shortcuts…
│   ├── lib/                    # 纯逻辑：DDL 生成、变更 SQL、语句拆分、执行计划解析、错误、文件面板…
│   ├── services/tauri-commands.ts
│   ├── stores/                 # workspace、editor、preferences、recent、task、theme、app-dialog、connection
│   └── types/
├── src-tauri/
│   ├── tauri.conf.json         # 产品名、版本、标识符、窗口、CSP、打包配置
│   ├── entitlements.plist      # Hardened Runtime 权限
│   ├── capabilities/default.json
│   ├── icons/                  # 图标源图和生成的全套图标
│   ├── src/
│   │   ├── lib.rs              # 应用启动、状态注册、命令注册
│   │   ├── error.rs            # AppError / ErrorCode / ResultExt
│   │   ├── models/connection.rs
│   │   ├── db/
│   │   │   ├── pool.rs         # PoolManager：连接池、按库分池、只读标志、凭据
│   │   │   ├── ssh_tunnel.rs   # SSH 隧道：主机密钥校验、心跳、Drop 时关闭
│   │   │   ├── dialect.rs      # 方言：标识符、字面量、占位符、清空表
│   │   │   ├── value.rs        # 数据库值 → JSON 的统一转换
│   │   │   └── local_store.rs  # 本地 SQLite 初始化与迁移
│   │   ├── commands/           # connection、query、schema、objects、table_ops、data、
│   │   │                       # transfer、admin、backup、groups、history、snippets
│   │   └── utils/              # sql.rs（拆分、只读判定、密码屏蔽）、keychain.rs、text_file.rs
│   └── tests/integration.rs    # 真实 MySQL / PG / SSH 集成测试（按环境变量启用）
├── .github/workflows/          # ci.yml、release.yml
└── docs/                       # 本文
```

## 4. 后端设计

### 4.1 启动

`lib.rs` 的 `run()`：

1. 注册 `tauri-plugin-dialog`。
2. 托管三个全局状态：`PoolManager`（连接池）、`QueryRegistry`（查询会话和运行中的查询）、`TransferRegistry`（可取消的导入、导出和传输任务）。
3. 在 `setup` 里**同步**初始化本地 SQLite（`block_on`）后再 `manage`。打包后的应用加载很快，前端一挂载就会调用 `get_connections`，异步初始化会出现竞态。
4. 调试构建会自动打开 DevTools。
5. 用 `generate_handler!` 注册全部命令（见 4.8）。

### 4.2 本地元数据库

位置：`~/Library/Application Support/com.lotdb.app/lotdb.db`。用 `filename()` 打开，不用 `sqlite:` URL，因为路径里的空格会导致 URL 解析出错。连接池上限 1，busy timeout 5 秒。

| 表 | 内容 |
|----|------|
| `connections` | 连接配置（不含密码），以及 SSH/SSL 配置的 JSON、`group_id`、`readonly`、颜色 |
| `connection_groups` | 连接分组 |
| `snippets` | SQL 片段 |
| `query_history` | 执行历史，带索引 `(connection_id, id)`。只保留最近 5000 条，保存前屏蔽密码字面量 |

迁移写在 `init_local_db` 里，都是幂等的（`CREATE TABLE IF NOT EXISTS`，`ALTER TABLE ADD COLUMN` 时忽略“列已存在”的报错）。

前端的工作区状态（打开的标签、SQL 草稿、最近关闭的查询、偏好、最近记录）存在 WebView 的 localStorage 里，键名以 `lotdb-` 开头。

### 4.3 连接与连接池

- `PoolManager` 用 `DashMap<连接 ID, ActiveConnection>` 保存打开的连接。每个连接持有 `DbPool::MySQL | DbPool::Postgres`、可选的 SSH 隧道、只读标志和凭据。
- 连接参数按字段构建 `MySqlConnectOptions` / `PgConnectOptions`，不经过 URL，所以密码里有 `#`、`/`、`?`、`%` 也能正常连接。
- 每个连接池最多 5 个连接。PostgreSQL 不能跨库查询，访问其他库时按 `(连接, 库)` 再建一个子池（最多 3 个连接），删库前会先关闭这个子池。
- MySQL 会话设置 `.timezone(None)` 和 `.pipes_as_concat(false)`，行为和 mysql 命令行一致，`NOW()` 返回服务器本地时间，`||` 仍是逻辑或。
- 访问连接池时，先从 DashMap 克隆出池再 await，不在 await 期间持有读锁。这样慢查询执行中也能随时断开或重连。
- SSL：支持 CA 和客户端证书（native-tls）。
- SSH 隧道（`ssh_tunnel.rs`）：支持密码、私钥和带口令的私钥（OpenSSH / PEM / PPK 格式），RSA 密钥按服务器能力选用 SHA-2 签名。主机密钥先和连接配置里的指纹比对，没填指纹就查 `~/.ssh/known_hosts`，未知主机直接拒绝。连接超时 15 秒，心跳 30 秒一次，3 次无响应即断开。`SshTunnel` 被 Drop 时会关闭监听端口和 SSH 会话。

### 4.4 查询执行

- 查询标签用标签 ID 作为 `session_id`，后端为 `(连接, session_id)` 固定一条物理连接（`QueryRegistry.sessions`）。所以 `USE db`、`SET search_path`、显式事务和会话变量在同一个标签里一直有效。
- 每次调用只执行一条语句。多条语句由前端的 `lib/split-statements.ts` 拆分（会跳过字符串、注释和 dollar-quote 里的分号），再按顺序逐条调用，结果区为每条语句显示一个结果标签。
- 行数上限（偏好设置，默认 1000，0 表示不限）：达到上限后，MySQL 对该会话执行 `KILL QUERY` 并读完剩余数据，会话和事务都保留；PostgreSQL 发送取消请求，在用户事务里用保存点保护，事务不会进入 aborted 状态。
- 取消查询：执行前记下会话 ID（`CONNECTION_ID()` / `pg_backend_pid()`），然后通过另一条连接发送 `KILL QUERY` / `pg_cancel_backend`。
- 语句分类：SELECT、SHOW、EXPLAIN 等读取结果集，其余语句取影响行数。
- 参数化查询：`?`（MySQL）或 `$1`（PG）占位，参数绑定失败时报错，不会静默忽略。
- 只读连接：`utils/sql.rs` 的 `readonly_sql` 根据语句动词和结构判断，不是在全文里搜关键字，在 `execute_query` 和 `execute_statements` 两处都会检查。

### 4.5 值转换

`db/value.rs` 把查询结果统一转换为 JSON，查询、表数据和导出都用这一套：

- DECIMAL、BIGINT UNSIGNED 按字符串返回，避免丢失精度。
- MySQL 的 `TINYINT(1)` 和 `BIT` 显示为数字。TIMESTAMP、YEAR、零日期和超过 24 小时的 TIME 都能正确显示。BINARY 排序规则的列中，可读的 UTF-8 显示为文本，其他内容显示为 `\x` 十六进制。
- PG 的 uuid、jsonb、数组、enum、inet、interval 等类型转为字符串。
- 导出、Excel 和跨库传输走文本协议（`raw_sql`），PG 的任意类型都能原样搬运。遇到无法无损表示的值时直接报错中止，不写占位文本。
- 已知限制：表格浏览和带参数的查询走二进制协议，少数 PG 类型（tsvector、range、几何类型、domain）在表格里会显示为占位文本，导出和传输不受影响。

### 4.6 方言

`db/dialect.rs` 中的 `Dialect` 负责标识符引用（`` ` `` 或 `"`，内部的同类引号会转义）、表引用、列清单、占位符、字符串和二进制字面量，以及在事务里清空表。导入、传输、表数据、管理命令都用它生成 SQL。各库的元数据查询差别太大，仍按库分别实现。

### 4.7 错误模型

- 所有命令返回 `Result<T, AppError>`，序列化为 `{ code: "connection" | "sql" | "io", message }`。
- `ResultExt::ctx("前缀")` 给错误加上上下文，同时保留 sqlx 错误的分类。
- 前端的 `invoke` 包装把错误统一转换为 `DbError`（`lib/error.ts`）。`connection` 类错误在结果面板、数据网格和对象树里会显示“重新连接”按钮，重连时会重建整个连接池和 SSH 隧道。

### 4.8 IPC 命令

命令都注册在 `lib.rs`，前端封装都在 `src/services/tauri-commands.ts`。

| 模块 | 命令 |
|------|------|
| 连接 | `create_connection`、`get_connections`、`update_connection`、`delete_connection`、`test_connection`、`import_connections`、`export_connections` |
| 连接池与查询 | `open_connection`、`close_connection`、`get_active_connections`、`execute_query`、`execute_query_with_params`、`cancel_query`、`close_query_session`、`configure_query_session` |
| 结构 | `list_databases`、`list_schemas`、`list_objects`、`get_table_columns`、`get_table_indexes`、`get_table_foreign_keys`、`search_objects`、`get_completion_schema` |
| 对象 | `get_view_ddl`、`get_function_ddl`、`list_triggers`、`get_trigger_ddl`、`drop_trigger`、`list_sequences`、`create_sequence`、`restart_sequence`、`drop_sequence`、`list_enums`、`create_enum_type`、`add_enum_value`、`drop_enum_type` |
| 对象维护 | `drop_object`、`truncate_table`、`rename_table`、`copy_table` |
| 分组、历史、片段 | `list_groups`、`create_group`、`rename_group`、`delete_group`；`save_history`、`get_history`、`delete_history`、`clear_history`；`get_snippets`、`create_snippet`、`update_snippet`、`delete_snippet` |
| 表数据 | `get_table_data`、`execute_statements` |
| 导入导出与传输 | `export_table_data`、`export_query_result`、`batch_export_tables`、`preview_import_file`、`import_table_data`、`transfer_table_data`、`cancel_transfer` |
| 管理 | `create_database`、`drop_database`、`list_users`、`get_user_grants`、`create_user`、`drop_user`、`grant_privilege`、`revoke_privilege`、`list_processes`、`kill_process`、`get_disk_usage`、`get_table_sizes`、`explain_query` |
| 备份恢复 | `backup_database`、`restore_database` |

后端主动推送的进度事件：`export-progress`、`export-batch-progress`、`import-progress`、`transfer-progress`、`backup-progress`。前端用 `listen` 订阅，任务结束后取消订阅。

### 4.9 导入、导出、传输与备份

- **导出**：所有格式（CSV、JSON、SQL INSERT、Excel）共用一个行流 `text_rows` 和一个按格式写文件的 `ExportWriter`。CSV 可以选择是否带 BOM。
- **导入**：先校验列映射，再修改表。每批 500 行（不超过 512 KB）合成一条多行 INSERT。勾选“导入前清空表”时，清空和导入在同一个事务里，失败或取消就整体回滚；不清空时每批一个事务，某批失败后逐行重试，找出出错的行。CSV 用 `utils/text_file.rs` 自带的读取器，能区分带引号的 `""`（空字符串）和未加引号的空字段（默认导入为 NULL），支持多种编码和分隔符。
- **跨库传输**：支持列映射、清空目标表、WHERE 和 LIMIT。后台先用统计信息估算源表行数，再用 `COUNT(*)` 取精确值，界面显示百分比和预计剩余时间。
- **备份恢复**：以异步子进程调用 `mysqldump` / `mysql` / `pg_dump` / `psql`，可以取消。MySQL 的密码写进权限 0600 的临时 `--defaults-extra-file`，用完即删，不会出现在进程参数里。psql 恢复加 `-X -v ON_ERROR_STOP=1 --single-transaction` 并检查退出码。工具从 PATH 和常见的 Homebrew 安装目录中查找。

## 5. 前端设计

### 5.1 布局与标签

`AppLayout` = 侧栏（连接列表 + 对象树，宽度可拖动）+ 标签栏 + 主内容区。`workspace-store` 管理标签，`addTab` 会去重，同一个 ID 的标签已经打开时只切换过去。标签类型包括查询、表数据、表结构、设计器、DDL、序列管理、枚举管理和各个管理页。非活动的标签只隐藏、不卸载，所以编辑器状态和结果都会保留。

### 5.2 状态

| Store | 内容 | 持久化 |
|-------|------|--------|
| `workspace-store` | 打开的标签、当前标签、最近关闭的查询（最多 20 条） | localStorage `lotdb-workspace` |
| `editor-store` | 每个查询标签的 SQL 草稿 | localStorage `lotdb-editor-drafts` |
| `preferences-store` | 编辑器字体和字号、表格字号、分页大小、是否保存历史、DML 确认、查询行数上限 | localStorage `lotdb-preferences` |
| `recent-store` | 最近打开的表和查询 | localStorage `lotdb-recent` |
| `theme-store` | 浅色、深色、跟随系统 | localStorage `lotdb-theme` |
| `task-store` | 后台任务（导入导出、传输、备份）状态 | 不持久化 |
| `app-dialog-store` | 应用内确认、输入和提示对话框 | 不持久化 |

服务端数据（连接、对象树、表结构、历史、片段）都用 TanStack Query 管理。

### 5.3 WKWebView 的限制

Tauri 使用的 wry 没有实现 WKWebView 的 JS 弹窗委托，在打包后的应用里：

- `window.confirm` 永远返回 false，`prompt` 永远返回 null，`alert` 不显示。
- `<a download>` 会被取消，不会生成文件。

所以：

- 确认、输入和提示一律用 `stores/app-dialog-store.ts` 的 `confirmDialog` / `promptDialog` / `alertDialog`。ESLint 规则禁止使用原生弹窗。
- 保存文件一律用 `lib/file-dialog.ts`（`pickSavePath` / `pickOpenPath` / `pickDirectory`）选择路径，再由后端写文件。

## 6. 安全

| 方面 | 做法 |
|------|------|
| 凭据 | 存在钥匙串里，service 为 `com.lotdb.app`。数据库密码的账户名是连接 ID，SSH 密码或口令的账户名是 `{连接 ID}:ssh`。连接配置导出时不含任何密码 |
| SQL 注入 | 筛选值用参数绑定；标识符用 `quote_ident_*` 引用；建用户、授权和建库都统一转义；导出的 WHERE 片段不能夹带第二条语句 |
| 只读连接 | 后端拦截写语句，前端禁用危险菜单项 |
| 历史记录 | 屏蔽 `IDENTIFIED BY`、`PASSWORD '…'` 等密码字面量 |
| SSH | 必须校验主机密钥（指纹或 known_hosts） |
| WebView | 生产环境设置了 CSP：`default-src 'self'`，脚本只允许 `'self'`，样式允许 inline（CodeMirror 需要），IPC 走 `ipc:` 和 `http://ipc.localhost`。开发模式下 `devCsp: null` |
| Capability | 只开放 `core:default`、关闭窗口、解析目录、`dialog:allow-open`、`dialog:allow-save` |
| 进程权限 | 不开沙盒。Hardened Runtime 的 entitlements 只有 `allow-jit`、`network.client`、`files.user-selected.read-write` |

**不要修改 `identifier`（`com.lotdb.app`）**。它同时是钥匙串的 service 名，改了以后，已有用户保存的密码会全部读不到。

## 7. 测试

| 层级 | 位置 | 运行方式 |
|------|------|----------|
| 前端单测 | `src/**/__tests__/*.test.ts(x)`，18 个文件、106 项 | `pnpm test` |
| Rust 单测 | 各模块内的 `#[cfg(test)]`，50 项 | `cd src-tauri && cargo test --lib` |
| 集成测试 | `src-tauri/tests/integration.rs`，13 组，用真实的 MySQL、PG 和 SSH 服务器 | 设置 `LOTDB_TEST_*` 环境变量后运行 `cargo test`，没设置的组会自动跳过 |

集成测试覆盖：值转换精度、DML 影响行数、行数上限、取消、筛选防注入、只读模式、导入导出往返、编码、传输、对象维护、执行计划、SSH 隧道的生命周期等。

还没有 E2E 测试。以下内容需要在打包后的应用里手动验证：原生文件面板、右键菜单、钥匙串、备份恢复子进程和 CSP。

---

# 第二部分 功能规格

“状态”一列：✅ 已实现；⚠️ 部分实现或有限制；❌ 未实现。

## 1. 连接管理

| 功能 | 状态 | 说明 |
|------|------|------|
| 新建、编辑、删除连接 | ✅ | MySQL / PostgreSQL。删除前需要确认，会先关闭已打开的连接池，并删除钥匙串里的密码 |
| 测试连接 | ✅ | 测试结束后会关闭隧道和端口 |
| SSH 隧道 | ✅ | 密码、私钥、带口令的私钥；主机指纹或 known_hosts 校验；有心跳和超时 |
| SSL / TLS | ✅ | CA 和客户端证书 |
| 连接分组 | ✅ | 新建、重命名、删除分组，在连接对话框里选择分组 |
| 只读连接 | ✅ | 拦截写语句，侧栏显示锁图标 |
| 凭据存储 | ✅ | macOS 钥匙串 |
| 连接配置导入导出 | ✅ | 用原生保存面板，导出内容不含任何密码 |
| 断线重连 | ✅ | 连接类错误会显示“重新连接”按钮，同时重建连接池和隧道 |

## 2. 对象浏览

| 功能 | 状态 | 说明 |
|------|------|------|
| 对象树 | ✅ | 连接 → 库 → Schema（PG）→ 表、视图、函数、触发器、序列（PG）、枚举（PG）。MySQL 的系统库收进“系统库”文件夹 |
| 树内过滤 | ✅ | 按名称过滤库和对象，匹配的文件夹自动展开并显示“匹配数/总数” |
| 对象搜索 | ✅ | ⌘K |
| 表结构 | ✅ | 列、索引、外键（PG 复合外键显示正确） |
| 视图、函数 | ⚠️ | 可以查看 DDL；点“编辑执行”会把 DDL 带入查询标签修改。没有可视化的创建向导 |
| 触发器 | ⚠️ | 可以浏览、查看 DDL、删除，新建需要在 SQL 编辑器里写 |
| 序列、枚举（PG） | ✅ | 新建、重置或加值、删除 |
| 右键菜单 | ✅ | 表：打开数据、查看结构、设计器、重命名、复制表（仅结构或连同数据）、清空、删除；视图和函数：查看定义、删除；库：在此库新建查询、刷新、备份、恢复、删除。危险操作在最后，红色显示，只读连接上会禁用 |

## 3. SQL 编辑器

| 功能 | 状态 | 说明 |
|------|------|------|
| 多标签 | ✅ | 每个标签固定一条会话；关闭后草稿进入“最近关闭的查询”，⌘⇧T 可以恢复 |
| 语法高亮、补全 | ✅ | 区分 MySQL 和 PG 方言，补全表名和列名 |
| 执行 | ✅ | 执行选中部分或全部（⌘↩）；多条语句逐条执行，结果按语句分标签显示 |
| 结果行数上限 | ✅ | 默认 1000，超出时提示“已截断”，不会传输整张表 |
| 取消查询 | ✅ | 停止按钮 |
| 显式事务 | ✅ | 进入事务后显示“提交 / 回滚”和事务状态 |
| 切换库或 Schema | ✅ | MySQL 用 `USE`；PG 把所选 schema 加到 `search_path` 最前面 |
| 格式化 | ✅ | ⇧⌥F |
| 执行计划 | ✅ | EXPLAIN / ANALYZE（⌘⇧E），有表格、文本和图形三种视图。图形视图按耗时或成本占比着色，标出全表扫描，估算行数偏差较大时会提示 |
| 历史记录 | ✅ | 可以搜索和重新执行，密码会被屏蔽 |
| 片段 | ✅ | 浏览片段，或把当前 SQL 存为片段 |
| 参数化查询 | ✅ | `?` / `$1`，执行时弹出参数输入框 |
| DML 确认 | ✅ | 在偏好设置中开启 |

## 4. 数据网格

| 功能 | 状态 | 说明 |
|------|------|------|
| 分页、排序、列筛选 | ✅ | 分页大小可选 50、100、200、500；筛选支持 `=`、`!=`、LIKE、IN、IS NULL 等，值都用参数绑定 |
| 统计总行数 | ✅ | 按需统计 |
| 行内编辑、新增行、删除行 | ✅ | 提交前预览 SQL（⌘S 提交，Esc 回滚）。新增行可以选“使用默认值”“设为 NULL”或“设为空字符串” |
| 乐观锁校验 | ✅ | 提交前检查行是否被别人改过，浮点数按值比较 |
| 选区与键盘 | ✅ | 单击选中，Shift 或拖动扩展选区，⌘A 全选，方向键、Tab、Home、End、PageUp、PageDown 移动；Enter 或 F2 编辑；Delete 把选区暂存为 NULL |
| 复制 | ✅ | ⌘C 按 TSV 复制，可以连同列名一起复制；也可以复制为 INSERT、CSV、JSON、Markdown |
| 右键菜单 | ✅ | 复制、查看值、编辑、设为 NULL、按此值筛选、排除此值、删除所选行 |
| 列宽 | ✅ | 按内容估算（60–360px，中日韩字符按全角计算），双击拖柄重新适应；可以拖动调整列顺序，翻页时保留 |
| 单元格查看器 | ✅ | 大文本、JSON、二进制内容 |
| NULL 和空字符串 | ✅ | 显示上明确区分 |

## 5. 表设计器

| 功能 | 状态 | 说明 |
|------|------|------|
| 可视化建表、改表 | ✅ | 列、类型（MySQL 和 PG 分别有类型列表）、默认值、可空、注释 |
| 列改名 | ✅ | 按列 ID 跟踪，生成 `RENAME COLUMN`，不会丢数据（MySQL 需要 8.0+） |
| 保留未建模的属性 | ✅ | 字符集、排序规则、生成列、ON UPDATE、INVISIBLE、SRID 等，在 `MODIFY COLUMN` 时原样带上 |
| 索引、外键 | ✅ | 新建、编辑、删除 |
| DDL 预览与对比 | ✅ | 所有变更执行前都会预览 |

## 6. 导入导出

| 功能 | 状态 | 说明 |
|------|------|------|
| 导出 | ✅ | CSV（可选带 BOM）、JSON、SQL、Excel；可以选择列、WHERE 和 LIMIT；流式写出 |
| 批量导出 | ✅ | 选择多张表导出到一个目录 |
| 查询结果导出 | ✅ | CSV 等格式，用系统保存面板 |
| 导入 | ✅ | CSV、TSV、JSON、SQL；支持列映射、多种编码、分隔符、NULL 标记；可以取消；可选“导入前清空表”，这时导入全有或全无 |
| 进度 | ✅ | 显示行数、速度、百分比和预计剩余时间；后台任务显示在状态栏 |

## 7. 数据库管理

| 功能 | 状态 | 说明 |
|------|------|------|
| 新建、删除数据库 | ✅ | MySQL 可选字符集和排序规则；PG 可选编码、区域设置和所有者 |
| 用户与权限 | ⚠️ | 基础功能：列出用户、查看授权、新建、删除、授权、撤权 |
| 活跃查询 | ✅ | 进程列表，可以 KILL |
| 磁盘占用 | ✅ | 库、表、索引的大小 |
| 锁信息、慢查询日志 | ❌ | 只能在“活跃查询”里按执行时间查看 |

## 8. 传输、对比与备份

| 功能 | 状态 | 说明 |
|------|------|------|
| 跨连接数据传输 | ✅ | 支持列映射、清空目标表、WHERE、LIMIT，显示进度和预计剩余时间 |
| 单表结构对比 | ✅ | 按目标库的方言生成同步 SQL |
| 整库结构对比 | ⚠️ | 只比较表（列、索引、外键），不比较视图、函数和触发器。可以勾选表生成同步 SQL，DROP 默认不勾选 |
| 备份、恢复 | ⚠️ | 依赖本机的 `mysqldump` / `mysql` / `pg_dump` / `psql`，可以取消并显示进度；PG 恢复是单事务的 |
| 复制表 | ⚠️ | 不复制外键和触发器 |

## 9. 体验

| 功能 | 状态 | 说明 |
|------|------|------|
| 主题 | ✅ | 浅色、深色、跟随系统 |
| 快捷键 | ⚠️ | 有一套固定的快捷键，按 `?` 查看帮助；不支持自定义 |
| 最近记录 | ✅ | 显示在首页，包括最近打开的表和查询，以及最近关闭的查询 |
| 偏好设置 | ✅ | 编辑器字体和字号、表格字号、分页大小、查询行数上限、历史记录、DML 确认 |
| 品牌 | ✅ | 应用图标和欢迎页 Logo 都是“透透”形象 |
| 多窗口 | ❌ | 只有一个主窗口，用多个标签工作 |
| 自动更新 | ❌ | 需要到 GitHub Release 下载新版本 |

## 10. 运行环境与范围

- 系统：macOS 12 或更高。默认构建 Apple Silicon（aarch64）版本，也可以构建 Universal 版本。
- 数据库：MySQL 8.x（集成测试用 8.2；列改名需要 8.0+，图形执行计划需要 8.0.16+）和 PostgreSQL（集成测试用 16 和 18）。MySQL 5.7、MariaDB 和更早的 PG 版本没有系统测试过。
- 不在规划内：MongoDB、ClickHouse、Mac App Store、Windows、Linux。在非 macOS 平台上，钥匙串只是空实现。

---

# 第三部分 编译与上线

## 1. 开发环境

| 依赖 | 要求 | 说明 |
|------|------|------|
| macOS | 12+ | 打包和签名必须在 macOS 上进行 |
| Xcode Command Line Tools | 必需 | `xcode-select --install`。签名和公证建议装完整的 Xcode |
| Node.js | 22 | 和 CI 一致 |
| pnpm | 10.33 | `packageManager` 字段已锁定版本，可用 `corepack enable` 安装 |
| Rust | stable | `rustup`；构建 Universal 版本还需要 `x86_64-apple-darwin` target |
| Docker | 可选 | 运行集成测试时启动临时的 MySQL 和 PG |
| 数据库客户端工具 | 可选 | 测试备份恢复：`brew install mysql-client postgresql@16` |

首次准备：

```bash
pnpm install --frozen-lockfile
```

## 2. 日常开发

```bash
pnpm tauri dev        # 启动 Vite（1420 端口）和 Tauri 调试窗口，会自动打开 DevTools
pnpm dev              # 只启动前端，不能调用 IPC
```

## 3. 质量门

提交和发版前都要全部通过。CI 会执行同样的检查。

```bash
pnpm lint             # ESLint，必须 0 错误
pnpm format:check     # Prettier（修复：pnpm format）
npx tsc -b            # 类型检查
pnpm test             # Vitest

cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --lib
cd ..
```

### 3.1 集成测试

不要对日常使用的数据库运行集成测试，测试会建库、删库、建用户。先启动临时容器：

```bash
docker run -d --rm --name lotdb-it-mysql -e MYSQL_ROOT_PASSWORD=root -p 13306:3306 mysql:8.2.0
docker run -d --rm --name lotdb-it-pg -e POSTGRES_PASSWORD=pg -p 15432:5432 postgres:18.6

export LOTDB_TEST_MYSQL_URL=mysql://root:root@127.0.0.1:13306/mysql
export LOTDB_TEST_PG_URL=postgres://postgres:pg@127.0.0.1:15432/postgres

pnpm vite build                       # build.rs 需要 dist/
cd src-tauri && cargo test
```

SSH 测试还需要设置 `LOTDB_TEST_SSH`、`LOTDB_TEST_SSH_FINGERPRINT`、`LOTDB_TEST_SSH_USER`、`_PASSWORD`、`_KEY`、`_PASSPHRASE`、`LOTDB_TEST_SSH_DB_HOST`，说明见 `tests/integration.rs`。

## 4. 本地打包

```bash
pnpm package
```

- 构建当前架构的 `.app` 和 `.dmg`，会复用 Rust 的编译缓存。Tauri 会先执行 `pnpm build`（`tsc -b && vite build`）。
- 默认使用 `/Library/Developer/CommandLineTools`；如果已经设置了 `DEVELOPER_DIR`，就沿用它。
- 产物位置：
  - `src-tauri/target/release/bundle/macos/LotDB.app`
  - `src-tauri/target/release/bundle/dmg/LotDB_<版本>_aarch64.dmg`
- `pnpm open:app` 可以直接打开构建好的 `.app`。

其他命令：

| 命令 | 用途 |
|------|------|
| `pnpm package:universal` | 同时支持 Intel 和 Apple Silicon（自动安装两个 Rust target），耗时约为两倍，产物在 `src-tauri/target/universal-apple-darwin/release/bundle/` |
| `pnpm package:clean` | 删除 `src-tauri/target` 和 `dist` 后从零打包，用于排查缓存问题 |
| `pnpm icons` | 用源图重新生成全套图标 |
| `pnpm package:icons` | 重新生成图标并打包 |
| `pnpm tauri build --debug --bundles app` | 只构建调试版 `.app`，速度快，会自动打开 DevTools，方便检查 CSP 和界面 |

本地构建的包**没有签名**。发给别人时，对方第一次打开需要右键选择“打开”，或在“系统设置 → 隐私与安全性”里允许。这样的包只适合自己用或小范围测试。

### 4.1 不影响真实数据地验证打包结果

应用的数据存在 `~/Library/Application Support/com.lotdb.app/` 和 WebKit 的 localStorage 里。验证时可以把 `HOME` 指向一个临时目录：

```bash
mkdir -p /tmp/lotdb-home
HOME=/tmp/lotdb-home CFFIXED_USER_HOME=/tmp/lotdb-home \
  src-tauri/target/release/bundle/macos/LotDB.app/Contents/MacOS/lotdb
```

`HOME` 和 `CFFIXED_USER_HOME` 都要设置，只设 `HOME` 无法隔离 WebKit 的数据。钥匙串仍然是当前用户的。

### 4.2 图标

| 文件 | 用途 |
|------|------|
| `src-tauri/icons/app-icon-source.png` | 1024×1024 源图。圆角方块按 macOS 图标网格放置（824px 圆角块，四周留 100px 透明边，带阴影），内容是粉色底上的“透透 · 比个心”形象 |
| `src-tauri/icons/icon.icns`、`icon.ico`、`*.png`、`ios/`、`android/` | 由 `pnpm icons` 生成，`tauri.conf.json` 的 `bundle.icon` 会引用 |
| `public/app-icon.png`（256px） | 欢迎页 Logo |
| `public/favicon.png`（64px） | 窗口和开发模式下的 favicon |

更换图标：只替换源图，然后运行 `pnpm package:icons`。如果 Finder 或 Dock 仍然显示旧图标，可以运行 `killall Dock` 刷新缓存。

### 4.3 用户机器上的运行时依赖

LotDB 没有内置 dump 工具。需要备份恢复的用户要自己安装客户端工具：

```bash
brew install mysql-client postgresql@16
which mysqldump mysql pg_dump psql
```

## 5. 版本号

以下三处必须一致，发版流水线会检查：

```
package.json                 "version"
src-tauri/Cargo.toml         version
src-tauri/tauri.conf.json    "version"     ← Finder“关于”和 DMG 文件名使用的是这个
```

升级版本时三处一起改，`Cargo.lock` 会在下次构建时自动更新。

## 6. 签名与公证

对外分发的 macOS 应用必须经过 **Developer ID 签名 → 提交公证 → staple 公证票据** 这个流程，否则 Gatekeeper 会拦截。代码和配置都已经准备好（`entitlements.plist` 和 `release.yml`），还缺 Apple 账号和证书。

### 6.1 账号与证书（需要账号所有者操作）

1. 加入 [Apple Developer Program](https://developer.apple.com/programs/)（99 美元/年，新账号审核可能需要 1–2 天）。
2. 在开发者后台创建 **Developer ID Application** 证书（不是 Mac App Store 用的 Apple Distribution），导入到登录钥匙串。
3. 验证：

   ```bash
   security find-identity -v -p codesigning
   # 应该能看到：Developer ID Application: Your Name (TEAMID)
   ```

4. 在 appleid.apple.com 创建 App 专用密码。

### 6.2 本机签名并公证

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="XXXXXXXXXX"

pnpm package
```

Tauri 读到这些环境变量后，会自动开启 Hardened Runtime、签名、提交公证、等待结果并 staple。

自动流程失败时，可以手动补救：

```bash
APP=src-tauri/target/release/bundle/macos/LotDB.app
DMG=$(ls src-tauri/target/release/bundle/dmg/*.dmg)

codesign --verify --deep --strict --verbose=2 "$APP"
xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_PASSWORD" --wait
xcrun stapler staple "$APP"
xcrun stapler staple "$DMG"
spctl --assess --type execute -v "$APP"     # 应该显示 accepted, source=Notarized Developer ID
```

验收标准：把 DMG 拷到一台从没装过 Xcode、也没关闭 Gatekeeper 的 Mac 上，双击安装后能直接打开，不出现“已损坏”或“无法验证开发者”。

### 6.3 不要做的事

- 不要用 ad-hoc 签名（`signingIdentity: "-"`）对外发布。
- 不要把 `.p12` 证书或 App 专用密码提交到 git，它们只放在 GitHub Secrets 里。
- 不要开 App Sandbox：开了以后 SSH、任意路径的文件读写和外部 dump 工具都要重新设计。

## 7. CI 与发版流水线

### 7.1 CI（`.github/workflows/ci.yml`）

推送到 `main` 或提交 PR 时触发，包括三个 job：

| Job | 平台 | 内容 |
|-----|------|------|
| frontend | ubuntu | lint、format:check、tsc、vitest、vite build |
| rust | macOS | cargo fmt --check、clippy -D warnings、cargo test --lib |
| integration | ubuntu + MySQL 8 / Postgres 16 service | `cargo test`（单测 + 集成测试） |

### 7.2 发版（`.github/workflows/release.yml`）

推送 `v*` 标签时触发，在 `macos-14` 上运行：

1. 检查标签和 `tauri.conf.json`、`package.json` 的版本号一致。
2. 运行质量门：lint、format:check、tsc、vitest、Rust 单测。
3. 用 `tauri-action` 构建 `aarch64` 的 DMG，并创建 **draft** Release。
4. 配置了签名 Secrets 时自动签名和公证；没配置时照样出包，但会给出警告，包是未签名的。

需要在仓库中配置的 Secrets：

| Secret | 内容 |
|--------|------|
| `APPLE_CERTIFICATE` | Developer ID `.p12` 的 base64（`base64 -i Certificates.p12 \| pbcopy`） |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 的密码 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)` |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_PASSWORD` | App 专用密码 |
| `APPLE_TEAM_ID` | 10 位的 Team ID |

## 8. 发版流程

```bash
# 1. 在 main 上改好三处版本号，提交并推送，等 CI 全部通过
git commit -am "chore: release v1.0.1"
git push origin main

# 2. 打标签，触发发版流水线
git tag v1.0.1
git push origin v1.0.1
```

3. 下载流水线生成的 draft Release 里的 DMG，在一台干净的 Mac 上安装，按第 9 节的冒烟清单走一遍。
4. 补充 Release Note（模板见第 10 节），然后点 Publish。

### 8.1 发版检查清单

**代码**
- [ ] 三处版本号一致，`identifier` 仍然是 `com.lotdb.app`
- [ ] 第 3 节的质量门全部通过，CI 全绿
- [ ] 在临时容器上跑过带 `LOTDB_TEST_*` 的集成测试

**产品**
- [ ] 在打包后的应用里，用 MySQL 和 PostgreSQL 各走一遍第 9 节的冒烟清单
- [ ] Dock 和 Finder 中显示的是“透透”图标

**签名**
- [ ] `security find-identity` 能看到 Developer ID Application 证书
- [ ] 公证状态是 Accepted，`.app` 和 `.dmg` 都已 staple
- [ ] 在干净的 Mac 上双击 DMG 能直接打开

**发布**
- [ ] Draft Release 里附有 DMG 和 sha256（`shasum -a 256 *.dmg`）
- [ ] Release Note 里写明系统要求、备份恢复依赖的客户端工具和已知限制

## 9. 冒烟清单（打包后手动执行）

1. 新建 MySQL 连接 → 测试 → 打开 → 展开对象树，用过滤框搜索一张表。
2. 打开表数据：修改一格 → 预览 SQL → ⌘S 提交；新增一行、删除一行；⌘C 复制选区。
3. 新建查询：执行 `SELECT`，确认出现截断提示；执行一条慢查询并点“停止”；关闭标签后用 ⌘⇧T 恢复。
4. 在表设计器里改一个列名 → 预览 DDL → 执行，确认数据还在。
5. 导出 CSV（带 BOM）→ 再导入回去；确认原生保存面板和打开面板都能正常弹出。
6. 在有 `mysqldump` 的机器上：备份一个小库，再恢复到测试库。
7. 对 PostgreSQL 重复第 1–5 步，并验证：连接默认库 A，在对象树里进入库 B 做导出和导入。
8. 在只读连接上执行 UPDATE，确认被拒绝；右键菜单中的危险操作是禁用的。
9. 停掉数据库，确认结果区出现“重新连接”，数据库恢复后点击能正常重连。
10. 用 SSH 隧道连接一次，然后断开，确认本地端口已经释放。

## 10. Release Note 模板

```
## LotDB x.y.z

macOS 12+，Apple Silicon。轻量的 MySQL / PostgreSQL 客户端。

### 安装
1. 下载 LotDB_x.y.z_aarch64.dmg
2. 把 LotDB 拖到“应用程序”
3. 第一次打开时，如果询问是否允许访问网络或钥匙串，请选择允许

### 备份 / 恢复
需要本机安装客户端工具：
brew install mysql-client postgresql@16

### 更新内容
- …

### 已知限制
- 没有自动更新，请关注 GitHub Release
- 整库结构对比只比较表
- 复制表不复制外键和触发器
```

## 11. 常见问题

| 现象 | 原因与处理 |
|------|------------|
| `pnpm package` 报 xcrun 或 SDK 错误 | 没装 CLT，或者 `DEVELOPER_DIR` 指向了一个无效的 Xcode。运行 `xcode-select --install`，或者 `export DEVELOPER_DIR=/Library/Developer/CommandLineTools` |
| `cargo test` 报找不到 `frontendDist` | 先运行 `pnpm vite build` 生成 `dist/`，或者设置 `TAURI_CONFIG='{"build":{"frontendDist":"<含 index.html 的目录>"}}'` |
| 打包后弹窗、确认框没有反应 | 代码里用了原生 `confirm`、`alert` 或 `<a download>`，改用应用内对话框和 `lib/file-dialog.ts`（见第一部分 5.3） |
| 打包后页面空白或样式丢失 | 被 CSP 拦截了。用调试版 `.app` 打开 DevTools 查看控制台，再调整 `tauri.conf.json` 的 `security.csp` |
| Dock 中还是旧图标 | 图标缓存问题，运行 `killall Dock`；必要时把 `.app` 重新拷进“应用程序” |
| 别人打开时提示“已损坏”或“无法验证开发者” | 包没有签名或公证，按第 6 节处理 |
| 备份时提示找不到 mysqldump 或 pg_dump | 用户机器上没装客户端工具，见第 4.3 节 |
| SSH 连接提示“未知 SSH 主机” | 先 `ssh` 登录一次，把主机记录到 known_hosts，或者在连接设置里填写已确认的主机指纹 |
| 升级后保存的密码都读不到了 | `identifier` 被改了，请恢复为 `com.lotdb.app` |

## 12. 后续规划（不在 1.0 范围内）

| 项目 | 做法 |
|------|------|
| 签名与公证 | 准备好账号后按第 6 节操作，这是对外发布前唯一剩下的工作 |
| 自动更新 | `tauri-plugin-updater` 加上签名的 `latest.json`。需要单独的 updater 密钥，和 Apple 公证是两回事 |
| E2E 测试 | 用 WebDriver 或 mock IPC 加无头浏览器覆盖主要流程 |
| 多窗口 | 使用 `WebviewWindow`，capability 的 `windows` 不再只限 `main` |
| 自定义快捷键 | 让 `lib/shortcuts.ts` 支持用户配置 |
| 清理依赖 | 删除未使用的 `react-router-dom` |
| Homebrew Cask | 有稳定用户以后再做 |
