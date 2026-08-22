# LotDB - 数据库管理工具

> 类 Navicat 的轻量级数据库管理工具，支持 MySQL / PostgreSQL，macOS 桌面端。

---

## 一、功能规格

### 1. 连接管理

| 功能 | 说明 |
|------|------|
| 新建连接 | 支持 MySQL 和 PostgreSQL，填写 host/port/user/password/database |
| SSH 隧道 | 通过 SSH 跳板机连接远程数据库，支持密码和密钥认证 |
| SSL 连接 | 支持 SSL/TLS 加密连接，可配置 CA/客户端证书 |
| 连接分组 | 按项目/环境对连接进行文件夹分组 |
| 连接测试 | 一键测试连接是否可用 |
| 凭证存储 | 使用 macOS Keychain 安全存储密码 |
| 连接导入/导出 | 支持导出连接配置（不含密码）供团队共享 |

### 2. 数据库对象浏览

| 功能 | 说明 |
|------|------|
| 树形导航 | 连接 → 数据库 → Schema(PG) → 表/视图/函数/存储过程 |
| 表结构查看 | 列名、类型、默认值、约束、注释 |
| 索引管理 | 查看/创建/删除索引 |
| 外键关系 | 查看/编辑外键约束 |
| 视图管理 | 查看/创建/编辑/删除视图 |
| 函数/存储过程 | 查看/创建/编辑/删除 |
| 触发器 | 查看/创建/编辑/删除 |
| 序列(PG) | 查看/管理序列 |
| 枚举类型(PG) | 查看/管理枚举 |
| 对象搜索 | 按名称快速搜索任意数据库对象 |

### 3. 数据查看与编辑

| 功能 | 说明 |
|------|------|
| 数据网格 | 分页展示表数据，支持排序、筛选 |
| 行内编辑 | 直接在网格中修改数据，提交前预览 SQL |
| 新增/删除行 | 在网格中直接新增或删除记录 |
| 数据筛选 | 列级条件筛选（=, !=, LIKE, IN, NULL 等） |
| 列宽/列序调整 | 拖拽调整列宽和列顺序 |
| 单元格查看器 | 大文本/JSON/二进制数据的专用查看编辑器 |
| NULL 值标识 | 明确区分空字符串和 NULL |
| 数据复制 | 复制为 INSERT/CSV/JSON/Markdown |

### 4. SQL 编辑器

| 功能 | 说明 |
|------|------|
| 多标签页 | 同时编辑多个 SQL 文件 |
| 语法高亮 | MySQL/PG 方言感知的语法高亮 |
| 智能补全 | 表名/列名/函数/关键字自动补全 |
| 多语句执行 | 执行选中部分或全部，逐条/批量模式 |
| 执行计划 | EXPLAIN / EXPLAIN ANALYZE 可视化 |
| 结果集 | 多结果集标签，支持导出 |
| SQL 格式化 | 一键美化 SQL |
| SQL 历史 | 记录执行过的 SQL，可搜索复用 |
| 代码片段 | 保存常用 SQL 片段，支持变量占位符 |
| 参数化查询 | 支持 `$1` / `?` 参数绑定执行 |

### 5. 表结构设计

| 功能 | 说明 |
|------|------|
| 可视化建表 | 通过表单式 UI 创建表，自动生成 DDL |
| 修改表结构 | 添加/修改/删除列、修改类型、默认值 |
| DDL 预览 | 任何结构变更在执行前预览完整 DDL |
| DDL 对比 | 对比两个表结构的差异 |

### 6. 数据导入/导出

| 功能 | 说明 |
|------|------|
| 导出格式 | CSV, JSON, SQL (INSERT/COPY), Excel (.xlsx) |
| 导入格式 | CSV, JSON, SQL |
| 导出选项 | 选择列、WHERE 条件过滤、LIMIT |
| 批量导出 | 选择多张表一键导出 |
| 进度显示 | 大数据量导入/导出显示进度和速度 |

### 7. 数据库管理

| 功能 | 说明 |
|------|------|
| 创建/删除数据库 | GUI 操作 |
| 用户与权限 | 查看/管理数据库用户和权限(基础) |
| 数据库状态 | 当前连接数、运行中的查询、锁信息 |
| 慢查询 | 查看当前慢查询，支持 KILL |
| 数据库大小 | 表/索引/数据库的磁盘占用统计 |

### 8. 数据传输与同步

| 功能 | 说明 |
|------|------|
| 结构同步 | 对比两个数据库结构差异，生成迁移 SQL |
| 数据传输 | 在不同连接/数据库间传输表数据 |
| 数据库备份 | 调用 mysqldump / pg_dump 执行备份 |
| 数据库恢复 | 从备份文件恢复 |

### 9. 用户体验

| 功能 | 说明 |
|------|------|
| 深色/浅色主题 | 跟随系统或手动切换 |
| 多窗口 | 支持多窗口独立工作 |
| 快捷键 | 常用操作均有快捷键，可自定义 |
| 标签页 | 多标签页管理查询和表 |
| 最近打开 | 快速访问最近的连接和查询 |
| 设置 | 字体、字号、默认行为等偏好设置 |

---

## 二、技术选型

### 核心架构

```
┌─────────────────────────────────────┐
│           Tauri v2 (Rust)           │  ← 应用壳、系统 API、安全
│  ┌───────────────────────────────┐  │
│  │     WebView (前端 UI)         │  │
│  │   React + TypeScript          │  │
│  │   TailwindCSS + shadcn/ui    │  │
│  └──────────┬────────────────────┘  │
│             │ Tauri IPC (invoke)    │
│  ┌──────────▼────────────────────┐  │
│  │     Rust Backend              │  │
│  │   sqlx (MySQL/PG driver)     │  │
│  │   russh (SSH 隧道)            │  │
│  │   serde (序列化)              │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

### 前端

| 技术 | 用途 | 选型理由 |
|------|------|----------|
| **React 19** | UI 框架 | 生态成熟，组件丰富 |
| **TypeScript** | 开发语言 | 类型安全 |
| **TailwindCSS 4** | 样式方案 | 原子化 CSS，开发效率高 |
| **shadcn/ui** | 组件库 | 可定制、无依赖锁定 |
| **TanStack Table** | 数据网格 | 高性能虚拟化表格，可定制性强 |
| **CodeMirror 6** | SQL 编辑器 | 现代架构、扩展丰富、性能好 |
| **TanStack Query** | 异步状态 | 缓存、重试、loading 状态管理 |
| **Zustand** | 全局状态 | 轻量、简洁 |
| **React Router v7** | 路由 | 标签页/面板路由管理 |
| **D3.js** | 可视化 | 执行计划可视化、关系图 |

### 后端 (Rust / Tauri)

| 技术 | 用途 | 选型理由 |
|------|------|----------|
| **Tauri v2** | 桌面框架 | 体积小(~10MB)、内存占用低、原生安全 |
| **sqlx** | 数据库连接 | 异步、纯 Rust、同时支持 MySQL 和 PG |
| **russh** | SSH 隧道 | 纯 Rust SSH 实现，无需系统 OpenSSH |
| **native-tls / rustls** | SSL 连接 | TLS 支持 |
| **security-framework** | 凭证存储 | macOS Keychain 集成 |
| **serde / serde_json** | 序列化 | Rust 标准序列化方案 |
| **tokio** | 异步运行时 | Tauri 底层已依赖，高性能异步 |
| **tauri-plugin-sql** | 本地存储 | SQLite 存储连接配置、历史记录等元数据 |
| **calamine / rust_xlsxwriter** | Excel | 读写 .xlsx 文件 |

### 开发工具链

| 工具 | 用途 |
|------|------|
| **pnpm** | 前端包管理 |
| **Vite** | 前端构建 |
| **Cargo** | Rust 构建 |
| **ESLint + Prettier** | 前端代码规范 |
| **clippy + rustfmt** | Rust 代码规范 |
| **Vitest** | 前端单元测试 |
| **Playwright** | E2E 测试 |
| **GitHub Actions** | CI/CD |
| **tauri-action** | 构建 & 签名 & 分发 DMG |

---

## 三、项目结构

```
lotdb/
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── main.rs
│   │   ├── db/                 # 数据库连接与操作
│   │   │   ├── mod.rs
│   │   │   ├── mysql.rs        # MySQL 特定逻辑
│   │   │   ├── postgres.rs     # PostgreSQL 特定逻辑
│   │   │   ├── pool.rs         # 连接池管理
│   │   │   └── ssh_tunnel.rs   # SSH 隧道
│   │   ├── commands/           # Tauri IPC 命令
│   │   │   ├── mod.rs
│   │   │   ├── connection.rs   # 连接管理命令
│   │   │   ├── query.rs        # SQL 执行命令
│   │   │   ├── schema.rs       # 结构操作命令
│   │   │   ├── data.rs         # 数据操作命令
│   │   │   └── transfer.rs     # 导入/导出/备份命令
│   │   ├── models/             # 数据模型
│   │   └── utils/              # 工具函数
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                        # React 前端
│   ├── components/
│   │   ├── layout/             # 布局组件（侧边栏、标签栏）
│   │   ├── connection/         # 连接管理 UI
│   │   ├── explorer/           # 对象树浏览器
│   │   ├── grid/               # 数据网格
│   │   ├── editor/             # SQL 编辑器
│   │   ├── designer/           # 表结构设计器
│   │   └── common/             # 通用组件
│   ├── hooks/                  # 自定义 Hooks
│   ├── stores/                 # Zustand stores
│   ├── services/               # Tauri IPC 调用封装
│   ├── types/                  # TypeScript 类型定义
│   ├── utils/                  # 工具函数
│   ├── App.tsx
│   └── main.tsx
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── vite.config.ts
└── plan.md
```

---

## 四、开发计划

### Phase 0 — 项目初始化（1 周）

- [x] Tauri v2 + React + TypeScript 项目脚手架
- [x] TailwindCSS + shadcn/ui 集成
- [x] ESLint / Prettier / clippy / rustfmt 配置
- [x] 基础布局：侧边栏 + 标签页 + 主内容区
- [x] CI 流水线搭建

### Phase 1 — 连接管理 + 对象浏览（3 周）

- [x] 连接配置 CRUD（MySQL / PG）
- [x] 连接配置持久化（SQLite 本地存储）
- [x] macOS Keychain 密码存储
- [x] 连接测试功能
- [x] 连接池管理（sqlx Pool）
- [x] SSH 隧道连接
- [x] SSL/TLS 连接
- [x] 树形对象浏览器（数据库/Schema/表/视图/函数...）
- [x] 表结构详情面板（列/索引/外键/约束）
- [x] 对象搜索

### Phase 2 — SQL 编辑器（2 周）

- [x] CodeMirror 6 集成，MySQL/PG 语法高亮
- [x] 表名/列名智能补全（从元数据加载）
- [x] 多标签页 SQL 编辑
- [x] 执行选中 SQL / 全部执行
- [x] 结果集展示（多结果集标签）
- [x] SQL 格式化
- [x] SQL 执行历史记录
- [x] 代码片段管理
- [x] 参数化查询支持

### Phase 3 — 数据网格（3 周）

- [x] TanStack Table 集成，虚拟滚动
- [x] 分页加载 + 排序
- [x]列级筛选器
- [x] 行内编辑（单元格点击编辑）
- [x] 新增行 / 删除行
- [x] 变更预览（显示将执行的 SQL）
- [x] 提交 / 回滚变更
- [x] NULL 值显示与编辑
- [x] 大文本 / JSON 单元格查看器
- [x] 复制为 INSERT / CSV / JSON / Markdown
- [x] 列宽拖拽 / 列序拖拽

### Phase 4 — 表结构设计器（2 周）

- [x]  可视化建表（列定义表单）
- [x]  类型选择器（MySQL/PG 类型映射）
- [x]  索引创建/编辑
- [x] 外键创建/编辑
- [x]修改已有表结构
- [x]DDL 预览（所有变更生成 SQL 预览）
- [x]  DDL 对比

### Phase 5 — 数据导入/导出（2 周）

- [x]导出为 CSV / JSON / SQL
- [x] 导出为 Excel (.xlsx)
- [x] 导出选项（选列、WHERE 过滤、LIMIT）
- [x] 多表批量导出
- [x] CSV / JSON / SQL 文件导入
- [x] 导入字段映射
- [x] 进度条与速度显示
- [x] 后台流式处理大文件

### Phase 6 — 数据库管理（1.5 周）

- [x] 创建/删除数据库
- [x]  用户/权限管理（基础）
- [x]  当前连接数 / 活跃查询列表
- [x]  KILL 查询
- [x]表/索引/数据库磁盘占用统计
- [x] EXPLAIN / EXPLAIN ANALYZE 可视化

### Phase 7 — 数据传输与同步（2 周）

- [x]结构对比（两个连接的同名表结构 diff）
- [x] 结构同步 SQL 生成
- [x] 跨连接数据传输
- [x]mysqldump / pg_dump 备份集成
- [x] 备份恢复

### Phase 8 — 打磨与发布（2 周）

- [x] 深色/浅色主题（跟随系统）
- [x] 快捷键体系完善 + 自定义
- [x] 多窗口支持
- [x] 最近连接/查询快速访问
- [x] 偏好设置（字体/字号/行为）
- [x]  连接配置导入/导出
- [x] 性能优化（大数据集、多连接）
- [x] E2E 测试覆盖核心流程
- [ ] DMG 打包 + 代码签名 + 公证
- [ ] 自动更新（tauri-plugin-updater）

### Phase 9 — 查询执行链路加固（2 周）

> 2026-07 代码审查发现的正确性问题，日常使用必然触发，优先级最高。

- [x] 结果集行数上限：`execute_query` 弃用 `fetch_all` 全量加载，改为流式取前 N 行（默认 1000，偏好设置可调），结果面板提示"已截断"（query.rs）
- [x] 查询取消：执行前记录会话 ID（MySQL `CONNECTION_ID()` / PG `pg_backend_pid()`），前端加"停止"按钮，经独立连接发 `KILL QUERY` / `pg_cancel_backend`
- [x] 修复 DML 影响行数恒为 0：按语句类型分流，SELECT/SHOW/EXPLAIN 走 fetch，其余走 `execute()` 取 `rows_affected()`（query.rs:114/214）
- [x] 统一值转换器，消灭静默 NULL：uuid/jsonb/数组转字符串，bytea/BLOB 显示 hex 或大小占位，DECIMAL / BIGINT UNSIGNED 保留字符串防精度丢失，未知类型显示 `(不支持的类型)` 而非 NULL；合并 query.rs 与 data.rs 两套转换逻辑（统一至 db/value.rs，transfer.rs 一并接入）
- [x] 表数据筛选改参数绑定：`build_where` 的值改 `query_with` 绑定，列名过 `quote_ident`（转义内部反引号/双引号），LIKE 转义 `%`/`_`，MySQL 处理反斜杠（data.rs:25-66；PG 按列类型 `$n::int4` 显式 cast，避免 text 参数与数值列比较报错）
- [x] 参数绑定不吞错误：`bind_*_arg` 的 `.unwrap_or(())` 改为返回 `Result` 上抛，杜绝参数错位（query.rs:121-135）

### Phase 10 — 对象管理补全（2 周）

> 对齐功能规格第 2 节中尚未落地的部分。

- [x] 视图 DDL 查看（`SHOW CREATE VIEW` / `pg_get_viewdef`），只读源码 tab
- [x] 函数/存储过程 DDL 查看（`SHOW CREATE FUNCTION` / `pg_get_functiondef`）与编辑执行（"编辑执行"按钮把 DDL 带入查询标签页）
- [x] 多语句拆分执行：编辑器按分号拆分（跳过字符串/注释/dollar-quote 内的分号），逐条执行，结果区多结果集标签（lib/split-statements.ts + result-panel.tsx 多结果 tab）
- [x] 触发器浏览与查看/删除（对象树 Triggers 分类，MySQL/PG 均支持）
- [x] 序列(PG) 浏览与管理（对象树 Sequences 分类 + 管理 tab：新建/重置/删除）
- [x] 枚举类型(PG) 浏览与管理（对象树 Enums 分类 + 管理 tab：新建/加值/删除）
- [x] 连接分组 UI（模型 `group_id` 字段已预留，connection.rs:70；侧边栏分组渲染/新建/重命名/删除 + 连接对话框分组选择）

### Phase 11 — 工程质量与健壮性（1.5 周）

- [x] Rust 侧单元测试：`build_where`、值转换、DDL 拼接等纯逻辑先补齐（transfer.rs / schema.rs 重点）——25 个单测覆盖 sql_val/csv_cell/build_select_sql/pg_action_code/BLOB 占位/数组引号/错误分类等
- [x] testcontainers 集成测试：真实 MySQL/PG 跑查询链路，接入 CI（tests/integration.rs，env 门控：本地指向容器、CI 用 GitHub Actions services 起 mysql:8/postgres:16；覆盖值转换精度/DML 行数/截断/取消/筛选防注入/只读，共 2 条全链路用例；顺带修了一个真 bug：PG NUMERIC 需 bigdecimal 解码）
- [x] 错误类型化：`Result<_, String>` 改为 `AppError` enum（连接错误/SQL 错误/IO 错误），前端按类别提示（error.rs；查询/数据/连接命令返回 `{code, message}`，其余渐进迁移）
- [x] 断线体验：捕获连接类错误提示"连接已断开"并提供一键重连（关旧池重开）；SSH 隧道断开恢复（重连即重建整池+隧道；结果面板与数据网格均带"重新连接"按钮）
- [x] 连接级只读模式：生产库防误操作，在 `execute_statements` 层拦截 DML/DDL（同时覆盖 SQL 编辑器 `execute_query` 路径；连接对话框开关 + 侧边栏锁图标 + SQLite 迁移）

---

## 五、里程碑

| 里程碑 | 周数 | 交付物 |
|--------|------|--------|
| **M0 - 脚手架** | W1 | 可运行的空壳应用，CI 通过 |
| **M1 - 能连能看** | W4 | 连接数据库，浏览对象树和表结构 |
| **M2 - 能写能查** | W6 | SQL 编辑器完整可用 |
| **M3 - 能编辑数据** | W9 | 数据网格增删改查完整 |
| **M4 - 能建表改表** | W11 | 表结构设计器完整 |
| **M5 - 能导入导出** | W13 | 数据 IO 完整 |
| **M6 - 能管理** | W14.5 | 数据库管理功能完整 |
| **M7 - 能同步备份** | W16.5 | 传输与备份功能完整 |
| **M8 - 可发布** | W18.5 | 主题/快捷键/打包/签名完成，Alpha 发布 |
| **M9 - 查询链路扎实** | W20.5 | 结果截断/取消/类型转换/参数绑定问题清零 |
| **M10 - 对象管理完整** | W22.5 | 视图/函数/触发器/序列/枚举 + 多语句执行 |
| **M11 - 质量加固** | W24 | Rust 测试 + 错误类型化 + 断线恢复 + 只读模式 |

---

## 六、风险与决策记录

| 风险 | 缓解措施 |
|------|----------|
| sqlx 编译期检查需要真实数据库连接 | 使用 `query_as_unchecked` 或运行时动态 SQL |
| 不同 MySQL/PG 版本的 SQL 方言差异 | 抽象 `DatabaseDialect` trait，各数据库实现差异部分 |
| 大数据集渲染性能 | 虚拟滚动 + 分页 + 流式加载 |
| SSH 隧道稳定性 | 心跳检测 + 自动重连 |
| macOS 签名与公证流程复杂 | 使用 tauri-action 自动化，提前申请 Apple Developer |
