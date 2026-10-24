// Native file panels. The webview can't give a real path (`<input type=file>`
// only yields a bare name, `<a download>` is cancelled), so every place that
// reads or writes a file picks its path here.
import { open, save } from "@tauri-apps/plugin-dialog";

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Ask where to save; resolves null when cancelled. The panel itself asks before replacing a file. */
export async function pickSavePath(
  defaultPath: string,
  filters?: FileFilter[],
): Promise<string | null> {
  return (
    (await save({ defaultPath: defaultPath || undefined, filters })) ?? null
  );
}

/** Ask for an existing file; resolves null when cancelled. */
export async function pickOpenPath(
  filters?: FileFilter[],
): Promise<string | null> {
  const path = await open({ multiple: false, directory: false, filters });
  return typeof path === "string" ? path : null;
}

/** Ask for a folder; resolves null when cancelled. */
export async function pickDirectory(
  defaultPath?: string,
): Promise<string | null> {
  const path = await open({
    multiple: false,
    directory: true,
    defaultPath: defaultPath || undefined,
  });
  return typeof path === "string" ? path : null;
}

/** Replace (or add) the extension of a file path or name. */
export function withExtension(path: string, ext: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  const base = dot > slash ? path.slice(0, dot) : path;
  return `${base}.${ext}`;
}
