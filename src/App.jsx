import { Component, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, History, LogOut, TrendingDown } from "lucide-react";
import { apiGet } from "./api";
import Dashboard from "./components/Dashboard.jsx";
import ProjectWorkspace from "./components/ProjectWorkspace.jsx";
import ProjectPerformance from "./components/ProjectPerformance.jsx";
import Directory from "./components/Directory.jsx";
import Manage from "./components/Manage.jsx";
import { BrandLogo } from "./components/Ui.jsx";
import { formatDateTime } from "./format";
import { canOpenManage, hasPermission } from "./permissions";

function getRoute() {
  const path = window.location.pathname;
  if (path === "/project" || path === "/client") return "project";
  if (path === "/project-performance" || path === "/performance") return "performance";
  if (path === "/directory") return "directory";
  if (path === "/manage") return "manage";
  return "dashboard";
}

function navigate(path) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

class WorkspaceErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Workspace render failed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-block workspace-render-error" role="alert">
        <strong>This page could not be displayed</strong>
        <p>{this.state.error.message || "An unexpected browser error occurred."}</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}><span>Reload page</span></button>
      </div>
    );
  }
}

/**
 * The rail answers "what should I look at?", which filters cannot: you would
 * have to already know to look. Collapses to icons when the width is wanted.
 */
function AttentionRail({ collapsed, onToggle, dashboard, onOpenProject, onOpenDashboard }) {
  const [showHighRiskProjects, setShowHighRiskProjects] = useState(false);
  const now = Date.now();
  const overdue = (dashboard?.openIssues || []).filter(
    (issue) => issue.dueAt && new Date(issue.dueAt).getTime() < now
  );
  const awaiting = (dashboard?.openCycles || []).filter((cycle) => cycle.awaitingReplyCount !== 0);
  const highRisk = (dashboard?.projects || []).filter((project) => project.riskLevel === "High");
  const latestActivity = (dashboard?.responseTracker || [])
    .filter((item) => item.latestClientReplyAt || item.lastClientResponseAt)
    .sort((left, right) => new Date(right.latestClientReplyAt || right.lastClientResponseAt || 0).getTime()
      - new Date(left.latestClientReplyAt || left.lastClientResponseAt || 0).getTime())
    .slice(0, 5);
  const activityStatus = {
    partial: "Partial response",
    completed: "Completed",
    stopped: "Stopped",
    awaiting: "Awaiting first reply"
  };
  const activityStatusLabel = (item) => {
    if (item.cycleType !== "quick_checkin") return activityStatus[item.responseStatus] || item.responseStatus;
    if (item.responseStatus === "completed" && item.quickCheckinOutcome === "no_response") return "Closed without response";
    if (item.responseStatus === "completed" && item.quickCheckinOutcome === "awaiting_details_expired") return "Closed without details";
    if (item.quickCheckinState === "quick_checkin_window") return "Quick check-in response received";
    if (item.quickCheckinState === "quick_checkin_detail") return "Waiting for feedback details";
    return activityStatus[item.responseStatus] || "Quick check-in";
  };
  function openHighRisk() {
    if (highRisk.length === 1) {
      onOpenProject(highRisk[0].key);
      return;
    }
    setShowHighRiskProjects((current) => collapsed || !current);
    if (collapsed) onToggle();
  }

  if (collapsed) {
    return (
      <aside className="rail collapsed">
        <button type="button" className="rail-toggle" onClick={onToggle} aria-label="Expand attention rail">
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <button type="button" className="rail-icon weak" title={`${overdue.length} issues overdue`} aria-label="Go to Open Issues" onClick={() => onOpenDashboard("dashboard-open-issues")}><AlertTriangle size={16} aria-hidden="true" /></button>
        <button type="button" className="rail-icon watch" title={`${awaiting.length} cycles awaiting reply`} aria-label="Go to Open Cycles" onClick={() => onOpenDashboard("dashboard-open-cycles")}><Clock size={16} aria-hidden="true" /></button>
        <button type="button" className="rail-icon weak" title={`${highRisk.length} projects at high risk`} aria-label="View high-risk projects" disabled={!highRisk.length} onClick={openHighRisk}><TrendingDown size={16} aria-hidden="true" /></button>
        <span className="rail-icon" title={`${latestActivity.length} recent client replies`}><History size={16} aria-hidden="true" /></span>
      </aside>
    );
  }

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="rail-head-top">
          <BrandLogo />
          <button type="button" className="rail-toggle" onClick={onToggle} aria-label="Collapse attention rail">
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="rail-brand">
          <p className="eyebrow">Client pulse</p>
          <h1>CSAT Command Centre</h1>
        </div>
      </div>

      <p className="rail-label">Needs attention</p>
      <button type="button" className="rail-stat weak" aria-label="Go to Open Issues" onClick={() => onOpenDashboard("dashboard-open-issues")}>
        <strong>{overdue.length}</strong>
        <span>{overdue.length === 1 ? "issue past SLA" : "issues past SLA"}</span>
      </button>
      <button type="button" className="rail-stat watch" aria-label="Go to Open Cycles" onClick={() => onOpenDashboard("dashboard-open-cycles")}>
        <strong>{awaiting.length}</strong>
        <span>{awaiting.length === 1 ? "cycle awaiting reply" : "cycles awaiting reply"}</span>
      </button>
      <button type="button" className="rail-stat weak" aria-label="View high-risk projects" disabled={!highRisk.length} aria-expanded={highRisk.length > 1 ? showHighRiskProjects : undefined} aria-controls={highRisk.length > 1 ? "rail-high-risk-projects" : undefined} onClick={openHighRisk}>
        <strong>{highRisk.length}</strong>
        <span>{highRisk.length === 1 ? "project at high risk" : "projects at high risk"}</span>
      </button>

      {highRisk.length && showHighRiskProjects ? (
        <>
          <p className="rail-label">At high risk</p>
          <div id="rail-high-risk-projects" className="rail-high-risk-projects" role="region" aria-label="High-risk projects">
          {highRisk.map((project) => (
            <button key={project.key} type="button" className="rail-link" aria-label={`Open ${project.name} workspace`} onClick={() => onOpenProject(project.key)}>
              <strong>{project.name}</strong>
              <span>{project.focusSignal || "No focus area yet"}</span>
            </button>
          ))}
          </div>
        </>
      ) : null}

      <p className="rail-label">Latest feedback activity</p>
      {latestActivity.map((item) => (
        <button
          key={`${item.id || item.clientPocId}-${item.latestClientReplyAt || item.lastClientResponseAt}`}
          type="button"
          className="rail-link quiet"
          onClick={() => onOpenProject(item.projectKey, {
            cycleId: item.cycleId,
            sessionId: item.id,
            section: "tracker"
          })}
        >
          <strong>{item.pocName}</strong>
          <span>{item.projectName} · {activityStatusLabel(item)}</span>
          <small>{formatDateTime(item.latestClientReplyAt || item.lastClientResponseAt)}</small>
        </button>
      ))}
      {!latestActivity.length ? <p className="rail-empty">No client replies yet.</p> : null}
    </aside>
  );
}

export default function App({ onLogout, currentUser = null }) {
  const [route, setRoute] = useState(getRoute);
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [locationTick, setLocationTick] = useState(0);
  const dashboardRequestRef = useRef(null);
  const routeAccess = useMemo(() => ({
    dashboard: hasPermission(currentUser, "dashboard"),
    project: hasPermission(currentUser, "project_workspace"),
    directory: hasPermission(currentUser, "directory"),
    performance: hasPermission(currentUser, "project_performance"),
    manage: canOpenManage(currentUser)
  }), [currentUser]);
  const firstAllowedRoute = Object.keys(routeAccess).find((key) => routeAccess[key]) || "performance";
  const activeRoute = routeAccess[route] ? route : firstAllowedRoute;
  const showAttentionRail = routeAccess.dashboard;
  const needsDashboardData = routeAccess.dashboard || routeAccess.project;

  async function loadDashboard() {
    if (dashboardRequestRef.current) return dashboardRequestRef.current;
    const request = (async () => {
      setError(null);
      try {
        setDashboard(await apiGet("/api/dashboard"));
      } catch (loadError) {
        setError(loadError);
      } finally {
        dashboardRequestRef.current = null;
      }
    })();
    dashboardRequestRef.current = request;
    return request;
  }

  useEffect(() => {
    const initialRoute = getRoute();
    if (!routeAccess[initialRoute]) navigate(firstAllowedRoute === "performance" ? "/project-performance" : `/${firstAllowedRoute}`);
    if (needsDashboardData) loadDashboard();
    const listener = () => {
      const nextRoute = getRoute();
      if (!routeAccess[nextRoute]) {
        navigate(firstAllowedRoute === "performance" ? "/project-performance" : `/${firstAllowedRoute}`);
        return;
      }
      setRoute(nextRoute);
      setLocationTick((value) => value + 1);
      // Opening a reply needs only its workspace. Refresh aggregate data on
      // return to Dashboard; focus and write actions also keep the rail fresh.
      if (needsDashboardData && nextRoute === "dashboard") loadDashboard();
    };

    // A conversation can finish while the tab sits open. Refresh on return
    // rather than showing numbers from an hour ago.
    const onFocus = () => { if (needsDashboardData && !document.hidden) loadDashboard(); };

    window.addEventListener("popstate", listener);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("popstate", listener);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [firstAllowedRoute, needsDashboardData, routeAccess]);

  const projects = useMemo(() => dashboard?.projects || [], [dashboard]);

  function openProject(key, options = {}) {
    const params = new URLSearchParams({ project: key });
    if (options.section) params.set("section", options.section);
    if (options.issueId) params.set("issue", options.issueId);
    if (options.cycleId) params.set("cycle", options.cycleId);
    if (options.sessionId) params.set("session", options.sessionId);
    navigate(`/project?${params.toString()}`);
  }

  return (
    <div className={`app-shell ${!showAttentionRail ? "project-user-shell rail-collapsed" : collapsed ? "rail-collapsed" : ""}`}>
      {showAttentionRail ? <AttentionRail
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        dashboard={dashboard}
        onOpenProject={openProject}
        onOpenDashboard={(section) => navigate(`/dashboard?section=${encodeURIComponent(section)}`)}
      /> : null}

      <main className="workspace">
        <nav className="tabbar">
          {routeAccess.dashboard ? <button
            type="button"
            className={`tab ${activeRoute === "dashboard" ? "active" : ""}`}
            onClick={() => navigate("/dashboard")}
          >
            Dashboard
          </button> : null}
          {routeAccess.project ? <button
            type="button"
            className={`tab ${activeRoute === "project" ? "active" : ""}`}
            onClick={() => openProject(projects[0]?.key || "")}
          >
            Project workspace
          </button> : null}
          {routeAccess.directory ? <button
            type="button"
            className={`tab ${activeRoute === "directory" ? "active" : ""}`}
            onClick={() => navigate("/directory")}
          >
            Directory
          </button> : null}
          {routeAccess.performance ? <button
            type="button"
            className={`tab ${activeRoute === "performance" ? "active" : ""}`}
            onClick={() => navigate("/project-performance")}
          >
            Project Performance
          </button> : null}
          {routeAccess.manage ? <button
            type="button"
            className={`tab ${activeRoute === "manage" ? "active" : ""}`}
            onClick={() => navigate("/manage")}
          >
            Manage
          </button> : null}
          <span className="tabbar-spacer" aria-hidden="true" />
          <button type="button" className="tab logout-tab" onClick={onLogout}>
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </nav>

        {routeAccess.dashboard && dashboard?.messaging?.enabled === false ? (
          <div className="messaging-paused-banner" role="status">
            <strong>WhatsApp messaging is paused.</strong>
            <span>No WhatsApp messages or automated replies will be sent. Email notifications remain active.</span>
          </div>
        ) : null}

        {error ? (
          <div className="error-block">
            <strong>Could not load data</strong>
            <p>{error.message}</p>
            <button type="button" className="button primary" onClick={loadDashboard}><span>Try again</span></button>
          </div>
        ) : activeRoute === "directory" ? (
          <Directory onOpenProject={openProject} />
        ) : activeRoute === "manage" ? (
          <WorkspaceErrorBoundary key={`manage-${locationTick}`}>
            <Manage onReload={loadDashboard} currentUser={currentUser} />
          </WorkspaceErrorBoundary>
        ) : activeRoute === "performance" ? (
          <ProjectPerformance currentUser={currentUser} />
        ) : activeRoute === "project" ? (
          <ProjectWorkspace dashboard={dashboard} locationTick={locationTick} onReload={loadDashboard} currentUser={currentUser} />
        ) : (
          <Dashboard dashboard={dashboard} locationTick={locationTick} onReload={loadDashboard} onOpenProject={openProject} currentUser={currentUser} />
        )}
      </main>
    </div>
  );
}
