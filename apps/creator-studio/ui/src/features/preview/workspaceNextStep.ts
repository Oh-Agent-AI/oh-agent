import { canAcceptCandidate, type ProjectCandidate } from "../../contracts/candidate";

export type WorkspaceAction = "mount" | "draft" | "settings" | "create" | "test" | "release" | "details" | "refresh";
export type WorkspaceStep = { status: string; evidence?: string; action?: WorkspaceAction; label?: string };

export function workspaceNextStep(input: Readonly<{
  readOnly: boolean;
  hasProject: boolean;
  hasLayout: boolean;
  dirty: boolean;
  hasMounts: boolean;
  browserPreview: boolean;
  candidate: ProjectCandidate | null;
  candidateRead: "loading" | "ready" | "unavailable";
  published: boolean;
}>): WorkspaceStep {
  if (input.readOnly) return { status: "只读场景预览" };
  if (!input.hasProject) return { status: "尚未打开项目" };
  if (!input.hasLayout) return { status: "缺少 City 布局", action: "settings", label: "查看项目设置" };
  if (input.dirty) return { status: "有未保存修改", action: "draft", label: "查看未保存修改" };
  if (!input.hasMounts) return { status: "玩法场地待配置", action: "mount", label: "配置场地" };
  if (input.browserPreview) return { status: "场地已保存", evidence: "浏览器场景预览 · 合成数据", action: "details", label: "查看试玩准备" };

  const candidate = input.candidate;
  const evidence = candidate?.latestRun?.evidenceSource === "host-verified" ? "Host 按输入 Trace 复算"
    : candidate?.latestRun?.evidenceSource === "city-client-reported" ? "City 客户端回报" : undefined;
  switch (candidate?.status) {
    case "created": return { status: "候选待试玩", action: "test", label: "开始试玩" };
    case "testing": return { status: candidate.latestRun?.status === "claimed" ? "City 正在试玩" : "正在准备试玩", action: "details", label: "查看进度" };
    case "test-failed": return { status: "上次试玩未完成", evidence, action: "test", label: "重新试玩" };
    case "tested": return { status: canAcceptCandidate(candidate) ? "试玩完成 · 待复核" : "已有试玩结果", evidence, action: "details", label: "查看试玩结果" };
    case "unknown": return { status: "候选状态未知", action: "refresh", label: "重新读取试玩状态" };
  }
  if (input.published) return { status: "当前修订已发布", evidence, action: "release", label: "试玩正式版" };
  if (input.candidateRead === "loading") return { status: "正在读取试玩状态" };
  if (input.candidateRead === "unavailable" || candidate?.status === "accepted") {
    return { status: "试玩状态暂不可用", action: "refresh", label: "重新读取试玩状态" };
  }
  return { status: "场地已保存 · 尚未试玩", action: "create", label: "创建试玩候选" };
}
