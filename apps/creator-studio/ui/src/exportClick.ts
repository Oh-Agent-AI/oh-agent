export type ExportClickBlock =
  | "creator_export_browser_preview"
  | "creator_export_busy"
  | "creator_export_no_project"
  | "creator_export_city_unavailable"
  | "creator_export_drafts_unsaved"
  | "creator_export_single_mount_required";

/** Why a source-export click must not open a directory dialog. Null means send it. */
export function exportClickBlock(input: {
  browserPreview: boolean;
  busy: boolean;
  hasProject: boolean;
  cityReady: boolean;
  unsaved: boolean;
  mountCount: number;
}): ExportClickBlock | null {
  if (input.browserPreview) return "creator_export_browser_preview";
  if (input.busy) return "creator_export_busy";
  if (!input.hasProject) return "creator_export_no_project";
  if (!input.cityReady) return "creator_export_city_unavailable";
  if (input.unsaved) return "creator_export_drafts_unsaved";
  if (input.mountCount > 1) return "creator_export_single_mount_required";
  return null;
}

export function exportBlockMessage(block: ExportClickBlock): string {
  switch (block) {
    case "creator_export_browser_preview": return "浏览器预览不能打开本机目录选择。请在桌面应用中导出。";
    case "creator_export_busy": return "正在等待目录选择。若没有看到系统对话框，请查看是否被窗口挡住。";
    case "creator_export_no_project": return "先打开项目，再导出源码目录。";
    case "creator_export_city_unavailable": return "项目绑定的城市还没准备好，暂时不能导出。";
    case "creator_export_drafts_unsaved": return "有未保存修改。先保存，再导出源码目录。";
    case "creator_export_single_mount_required": return "当前导出只支持一个玩法场地。";
  }
}
