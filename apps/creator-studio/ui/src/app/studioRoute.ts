export type StudioRoute = Readonly<{
  section: "home" | "projects" | "stories" | "explore" | "releases" | "workspace";
}>;

export const STUDIO_HOME_ROUTE: StudioRoute = Object.freeze({ section: "home" });
export const STUDIO_WORKSPACE_ROUTE: StudioRoute = Object.freeze({ section: "workspace" });

export const STUDIO_NAVIGATION = Object.freeze([
  Object.freeze({ route: STUDIO_HOME_ROUTE, label: "工作台" }),
  Object.freeze({ route: Object.freeze({ section: "projects" }) as StudioRoute, label: "我的项目" }),
  Object.freeze({ route: Object.freeze({ section: "stories" }) as StudioRoute, label: "Story 编辑" }),
  Object.freeze({ route: Object.freeze({ section: "explore" }) as StudioRoute, label: "探索与素材" }),
  Object.freeze({ route: Object.freeze({ section: "releases" }) as StudioRoute, label: "发布管理" }),
] as const);

export function studioRouteTitle(route: StudioRoute): string {
  if (route.section === "home") return "创作工作台";
  if (route.section === "projects") return "我的项目";
  if (route.section === "stories") return "Story Editor";
  if (route.section === "explore") return "探索与素材";
  if (route.section === "releases") return "发布管理";
  return "作品工作区";
}
