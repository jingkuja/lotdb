Check out this lightweight DB tool I built with vibe coding! It’s usable now, supports MySQL & PostgreSQL, and is fully extensible. See plan.md for the full story.

## macOS 打包

安装项目依赖、Rust 和 Xcode Command Line Tools 后，日常打包只需：

```bash
pnpm package
```

默认构建当前 Mac 架构的 `.app` 和 `.dmg`，复用 Rust 编译缓存。脚本默认使用 `/Library/Developer/CommandLineTools`；如果已设置 `DEVELOPER_DIR`，则沿用该设置。Tauri 会自动执行前端构建，无需手动清理 `dist`。

```bash
# 修改 src-tauri/icons/app-icon-source.png 后，重新生成全套图标并打包
pnpm package:icons

# 只重新生成图标
pnpm icons

# 同时支持 Intel 和 Apple Silicon（自动补齐两个 Rust target）
pnpm package:universal

# 排查构建缓存问题时，从零重新打包（会删除 src-tauri/target 和 dist）
pnpm package:clean
```

普通构建产物位于 `src-tauri/target/release/bundle/`，Universal 构建产物位于 `src-tauri/target/universal-apple-darwin/release/bundle/`。Universal 需要编译两种架构，通常更耗时；不必在每次本地验证时使用。
