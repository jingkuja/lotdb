/** Central registry of all keyboard shortcuts, used for the help dialog. */

export interface ShortcutDef {
  category: string;
  label: string;
  keys: string[]; // display strings, e.g. ["⌘", "Enter"]
}

export const SHORTCUTS: ShortcutDef[] = [
  // Global
  { category: "全局", label: "新建查询", keys: ["⌘", "N"] },
  { category: "全局", label: "关闭当前标签页", keys: ["⌘", "W"] },
  { category: "全局", label: "切换到上一个标签页", keys: ["⌘", "⇧", "["] },
  { category: "全局", label: "切换到下一个标签页", keys: ["⌘", "⇧", "]"] },
  { category: "全局", label: "搜索数据库对象", keys: ["⌘", "K"] },
  { category: "全局", label: "显示快捷键帮助", keys: ["?"] },
  // SQL Editor
  { category: "SQL 编辑器", label: "执行 SQL（选中或全部）", keys: ["⌘", "↩"] },
  { category: "SQL 编辑器", label: "格式化 SQL", keys: ["⇧", "⌥", "F"] },
  { category: "SQL 编辑器", label: "EXPLAIN 分析", keys: ["⌘", "⇧", "E"] },
  { category: "SQL 编辑器", label: "撤销", keys: ["⌘", "Z"] },
  { category: "SQL 编辑器", label: "重做", keys: ["⌘", "⇧", "Z"] },
  { category: "SQL 编辑器", label: "单行注释", keys: ["⌘", "/"] },
  // Data Grid
  { category: "数据网格", label: "提交变更", keys: ["⌘", "S"] },
  { category: "数据网格", label: "回滚变更", keys: ["Esc"] },
  { category: "数据网格", label: "新增行", keys: ["⌘", "⌥", "N"] },
  // Object Search
  { category: "对象搜索", label: "上/下移动选择", keys: ["↑ / ↓"] },
  { category: "对象搜索", label: "打开选中对象", keys: ["↩"] },
  { category: "对象搜索", label: "关闭", keys: ["Esc"] },
];
