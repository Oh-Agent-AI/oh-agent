import { STUDIO_NAVIGATION, studioRouteTitle, type StudioRoute } from "./studioRoute";

export function StudioNavigation(props: Readonly<{
  route: StudioRoute;
  projectTitle?: string;
  onNavigate: (route: StudioRoute) => void;
}>) {
  const { route, projectTitle, onNavigate } = props;
  return <header className="studio-navigation">
    <div className="studio-route-heading"><span className="sidebar-kicker">CREATOR STUDIO</span><h1>{studioRouteTitle(route)}</h1>{route.section === "workspace" && projectTitle && <span className="header-project">{projectTitle}</span>}</div>
    <nav className="studio-top-nav" aria-label="Studio 主导航">{STUDIO_NAVIGATION.map(item => <button key={item.route.section} className={route.section === item.route.section ? "active" : ""} aria-pressed={route.section === item.route.section} onClick={() => onNavigate(item.route)}>{item.label}</button>)}</nav>
  </header>;
}
