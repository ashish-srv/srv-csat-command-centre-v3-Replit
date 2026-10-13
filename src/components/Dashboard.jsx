import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Power, RefreshCw, X } from "lucide-react";
import { apiGet, apiWriteWithAdminPin } from "../api";
import { cycleInRange, DateRange, FilterBar, MultiSelect } from "./Filters.jsx";
import {
  formatCycleCoverage, formatCycleType, formatDate, formatDateTime,
  formatScore, riskClass, scoreClass
} from "../format";
import { Button, EmptyState, LoadingBlock, MetricCard, Panel, StatusPill } from "./Ui.jsx";
import ReportDownloads from "./ReportDownloads.jsx";
import { hasPermission } from "../permissions";

const RISK_OPTIONS = ["High", "Watch", "Low", "Not scored"];
const RESPONSE_LABELS = {
  awaiting: "Awaiting First Reply",
  partial: "Partial Response",
  completed: "Completed",
  stopped: "Stopped"
};

const SCHEDULE_STATUS_LABELS = {
  upcoming: "Upcoming",
  upcoming_manual: "Upcoming · manual send",
  due: "Due now",
  manual_required: "Manual send required",
  blocked: "Blocked / skipped",
  automatic_off: "Automatic sending off",
  open: "Cycle open",
  requested: "Already requested"
};

function scheduleStatusLabel(value) {
  return SCHEDULE_STATUS_LABELS[value] || value || "Unknown";
}

function scheduleStatusTone(value) {
  if (["blocked", "manual_required", "automatic_off"].includes(value)) return "weak";
  if (["due", "upcoming_manual"].includes(value)) return "watch";
  if (["open", "requested"].includes(value)) return "strong";
  return "neutral";
}

function responseLabel(value) {
  return RESPONSE_LABELS[value] || "Awaiting First Reply";
}

function responseFilterLabel(value) {
  return value === "partial" ? "Responded / Partial" : responseLabel(value);
}

function responseTone(value) {
  if (value === "completed") return "strong";
  if (value === "partial") return "watch";
  if (value === "stopped") return "neutral";
  return "weak";
}

function responseDisplayLabel(session, status = session.responseStatus) {
  if (session.cycleType !== "quick_checkin") return responseLabel(status);
  if (status === "stopped") return "Stopped";
  if (status === "completed") {
    if (session.quickCheckinOutcome === "no_response") return "Closed · No Response";
    if (session.quickCheckinOutcome === "awaiting_details_expired") return "Closed · No Details";
    return "Completed";
  }
  if (session.quickCheckinState === "quick_checkin_detail") return "Awaiting Feedback Details";
  if (session.quickCheckinState === "quick_checkin_window") return "Response Received";
  return "Awaiting First Reply";
}

function responseLifecycle(session) {
  if (session.cycleType === "quick_checkin") {
    if (session.responseStatus === "stopped") {
      return session.lastClientResponseAt ? "Stopped · response preserved" : "Stopped · no response received";
    }
    if (session.responseStatus === "completed") {
      if (session.quickCheckinOutcome === "no_response") return "Closed without a response";
      if (session.quickCheckinOutcome === "awaiting_details_expired") return "Closed · feedback details not received";
      return "Quick check-in response window closed";
    }
    if (session.quickCheckinState === "quick_checkin_detail") {
      return "Waiting for feedback details";
    }
    if (session.quickCheckinState === "quick_checkin_window") {
      return `Response received${session.reminderDueAt ? ` · window closes ${formatDateTime(session.reminderDueAt)}` : ""}`;
    }
    return "Waiting for quick check-in response";
  }
  if (session.responseStatus === "stopped") {
    return session.lastClientResponseAt ? "Stopped · feedback preserved" : "Stopped · no response received";
  }
  if (session.reminderExhausted) {
    return session.lastClientResponseAt ? "Closed after reminder limit" : "Closed without a response";
  }
  if (session.responseStatus === "completed") return `Completed ${formatDateTime(session.completedAt)}`;
  const count = Number(session.reminderCount) || 0;
  return `${count} of 3 reminders sent${session.reminderDueAt ? ` · next ${formatDateTime(session.reminderDueAt)}` : ""}`;
}

/** Risk as it should read to a human: no score and no cycle means not scored. */
function riskLabel(project, cycles) {
  if (project.csatScore === null || project.csatScore === undefined) {
    if (!cycles.length) return "Not scored";
    if (!project.riskLevel) return "Not scored";
  }
  return project.riskLevel || "Not scored";
}

function ProjectRow({ project, cycles, sessions, expanded, onToggle, onOpenProject }) {
  const risk = riskLabel(project, cycles);
  const latest = cycles[0] || null;
  const cycleById = new Map(cycles.map((cycle) => [cycle.id, cycle]));
  // `sessions` has already passed the dashboard filters. It intentionally also
  // contains quick check-ins, while `cycles` remains rating-only for CSAT KPIs.
  const pocRows = sessions;

  return (
    <>
      <div className={`ptable-row ${riskClass(risk)}`}>
        <button type="button" className="ptable-expand" onClick={onToggle} aria-expanded={expanded} aria-label={expanded ? "Hide POC sessions" : "Show POC sessions"}>
          {cycles.length || pocRows.length ? (expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />) : null}
        </button>
        <div className="ptable-name">
          <strong>{project.name}</strong>
          <span>{project.clusterName || "No cluster"}</span>
        </div>
        <span>{project.clientName || "--"}</span>
        <span>{latest ? formatCycleType(latest.cycleType, project.feedbackIntervalDays) : "No cycle yet"}</span>
        <span>{latest ? formatDate(latest.startedAt) : "--"}</span>
        <span>{latest && latest.closedAt ? formatDate(latest.closedAt) : "Open"}</span>
        <span>{formatDate(project.endDate)}</span>
        <b className={scoreClass(project.csatScore)}>{formatScore(project.csatScore)}</b>
        <span className={`risk-text ${riskClass(risk)}`}>{risk}</span>
        <button type="button" className="row-link" onClick={() => onOpenProject(project.key)}>Open</button>
      </div>

      {expanded ? pocRows.map((session) => {
        const cycle = cycleById.get(session.cycleId);
        const status = session.responseStatus || (
          session.completionStatus === "completed" ? "completed"
            : session.lastClientResponseAt ? "partial" : "awaiting"
        );
        return (
        <div key={session.id} className={`ptable-subrow poc-session-subrow ${responseTone(status)}`}>
          <span />
          <span className="subrow-label">{session.pocName || "POC"}</span>
          <span><StatusPill value={responseDisplayLabel(session, status)} tone={responseTone(status)} /></span>
          <span>{formatCycleType(cycle?.cycleType || session.cycleType, project.feedbackIntervalDays)}</span>
          <span>{formatDate(session.startedAt || session.cycleStartedAt)}</span>
          <span>{session.closedAt ? formatDate(session.closedAt) : "Open"}</span>
          <span>{session.cycleType === "quick_checkin" ? "Quick check-in" : `${Number(session.reminderCount) || 0} / 3 reminders`}</span>
          <b className={scoreClass(session.csatScore)}>{formatScore(session.csatScore)}</b>
          <span className="poc-session-lifecycle">{responseLifecycle(session)}</span>
          <button type="button" className="row-link" onClick={() => onOpenProject(project.key)}>Open</button>
        </div>
        );
      }) : null}
    </>
  );
}

export default function Dashboard({ dashboard, onReload, onOpenProject, currentUser = null }) {
  const [clusters, setClusters] = useState([]);
  const [clients, setClients] = useState([]);
  const [projectNames, setProjectNames] = useState([]);
  const [risks, setRisks] = useState([]);
  // Defaults to active: a project closed four months ago should not drag the
  // current average. It is a normal multi-select, so any combination can be
  // chosen, or cleared to see everything.
  const [statuses, setStatuses] = useState(["active"]);
  const [range, setRange] = useState({ from: "", to: "", basis: "started" });
  const [expanded, setExpanded] = useState({});
  const [responseFilter, setResponseFilter] = useState("all");
  const [responseCycleScope, setResponseCycleScope] = useState("all");
  const [scheduleTypes, setScheduleTypes] = useState([]);
  const [scheduleStatuses, setScheduleStatuses] = useState([]);
  const [messagingPrompt, setMessagingPrompt] = useState(false);
  const [messagingPin, setMessagingPin] = useState("");
  const [messagingError, setMessagingError] = useState("");
  const [messagingSaving, setMessagingSaving] = useState(false);
  const [reportError, setReportError] = useState("");

  const allProjects = dashboard?.projects || [];
  const allCycles = dashboard?.cycles || [];
  const allResponseSessions = dashboard?.responseTracker || dashboard?.responseQueue || [];
  const messagingEnabled = dashboard?.messaging?.enabled !== false;
  const canControlMessaging = hasPermission(currentUser, "messaging_controls");

  async function changeMessagingStatus() {
    setMessagingSaving(true);
    setMessagingError("");
    try {
      await apiWriteWithAdminPin("/api/admin/messaging", { enabled: !messagingEnabled }, "PATCH", messagingPin);
      setMessagingPrompt(false);
      setMessagingPin("");
      await onReload();
    } catch (changeError) {
      setMessagingError(changeError.message);
    } finally {
      setMessagingSaving(false);
    }
  }

  const cyclesByProject = useMemo(() => {
    const map = new Map();
    for (const cycle of allCycles) {
      if (!cycleInRange(cycle, range)) continue;
      if (!map.has(cycle.projectId)) map.set(cycle.projectId, []);
      map.get(cycle.projectId).push(cycle);
    }
    return map;
  }, [allCycles, range]);

  const responseSessionProjectIdsInRange = useMemo(() => new Set(
    allResponseSessions
      .filter((session) => cycleInRange({
        startedAt: session.cycleStartedAt || session.startedAt,
        closedAt: session.cycleClosedAt || session.closedAt
      }, range))
      .map((session) => session.projectId)
  ), [allResponseSessions, range]);

  const statusOptions = useMemo(
    () => [...new Set(allProjects.map((project) => project.activeStatus).filter(Boolean))],
    [allProjects]
  );

  const clusterOptions = useMemo(
    () => [...new Set(allProjects.map((project) => project.clusterName).filter(Boolean))].sort(),
    [allProjects]
  );
  const clientOptions = useMemo(
    () => [...new Set(allProjects
      .filter((project) => !clusters.length || clusters.includes(project.clusterName))
      .map((project) => project.clientName)
      .filter(Boolean))].sort(),
    [allProjects, clusters]
  );
  const projectOptions = useMemo(
    () => [...new Set(allProjects
      .filter((project) => !clusters.length || clusters.includes(project.clusterName))
      .filter((project) => !clients.length || clients.includes(project.clientName))
      .map((project) => project.name)
      .filter(Boolean))].sort(),
    [allProjects, clusters, clients]
  );

  // Parent filters must not leave an invisible child selection behind. That
  // combination used to produce an empty dashboard even though each dropdown
  // appeared valid on its own.
  useEffect(() => {
    const validClients = new Set(clientOptions);
    setClients((current) => current.filter((name) => validClients.has(name)));
  }, [clientOptions]);

  useEffect(() => {
    const validProjects = new Set(projectOptions);
    setProjectNames((current) => current.filter((name) => validProjects.has(name)));
  }, [projectOptions]);

  const visibleProjects = useMemo(() => {
    const rangeActive = Boolean(range.from || range.to);
    return allProjects.filter((project) => {
      if (clusters.length && !clusters.includes(project.clusterName)) return false;
      if (clients.length && !clients.includes(project.clientName)) return false;
      if (projectNames.length && !projectNames.includes(project.name)) return false;
      if (statuses.length && !statuses.includes(project.activeStatus)) return false;
      if (risks.length && !risks.includes(riskLabel(project, cyclesByProject.get(project.id) || []))) return false;
      // Quick check-ins are excluded from rating-based `cycles`, but they are
      // still real operational activity and must keep their project visible.
      if (rangeActive
        && !(cyclesByProject.get(project.id) || []).length
        && !responseSessionProjectIdsInRange.has(project.id)) return false;
      return true;
    });
  }, [allProjects, clusters, clients, projectNames, statuses, risks, range, cyclesByProject, responseSessionProjectIdsInRange]);

  const visibleProjectIds = useMemo(
    () => new Set(visibleProjects.map((project) => project.id)),
    [visibleProjects]
  );
  const scheduleScope = useMemo(
    () => (dashboard?.feedbackSchedule || []).filter((item) => visibleProjectIds.has(item.projectId)),
    [dashboard, visibleProjectIds]
  );
  const scheduleTypeOptions = useMemo(
    () => [...new Set(scheduleScope.map((item) => item.cycleType).filter(Boolean))].sort(),
    [scheduleScope]
  );
  const scheduleStatusOptions = useMemo(
    () => [...new Set(scheduleScope
      .filter((item) => !scheduleTypes.length || scheduleTypes.includes(item.cycleType))
      .map((item) => item.status)
      .filter(Boolean))].sort(),
    [scheduleScope, scheduleTypes]
  );

  useEffect(() => {
    const validTypes = new Set(scheduleTypeOptions);
    setScheduleTypes((current) => current.filter((value) => validTypes.has(value)));
  }, [scheduleTypeOptions]);

  useEffect(() => {
    const validStatuses = new Set(scheduleStatusOptions);
    setScheduleStatuses((current) => current.filter((value) => validStatuses.has(value)));
  }, [scheduleStatusOptions]);
  const scheduleFiltersActive = Boolean(scheduleTypes.length || scheduleStatuses.length);

  // EVERY hook must sit above the early return below. A hook after it runs on
  // the second render but not the first, which is React error #310 and a blank
  // page in production, where `dashboard` is reliably null on first paint.
  const clusterCards = useMemo(() => {
    const map = new Map();
    for (const project of visibleProjects) {
      const name = project.clusterName || "Unassigned";
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(project);
    }
    return [...map.entries()].map(([name, items]) => {
      const rated = items.filter((item) => item.csatScore !== null && item.csatScore !== undefined);
      return {
        name,
        projectCount: items.length,
        atRisk: items.filter((item) => riskLabel(item, cyclesByProject.get(item.id) || []) === "High").length,
        avgCsat: rated.length
          ? Math.round((rated.reduce((sum, item) => sum + Number(item.csatScore), 0) / rated.length) * 10) / 10
          : null
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [visibleProjects, cyclesByProject]);

  // ---- no hooks below this line ----
  if (!dashboard) return <LoadingBlock />;

  const visibleIds = new Set(visibleProjects.map((project) => project.id));
  const rangeCycles = visibleProjects.flatMap((project) => cyclesByProject.get(project.id) || []);
  const completedCycles = rangeCycles.filter((cycle) => cycle.status === "closed");
  const scored = visibleProjects.filter((project) => project.csatScore !== null && project.csatScore !== undefined);
  const avgCsat = scored.length
    ? Math.round((scored.reduce((sum, project) => sum + Number(project.csatScore), 0) / scored.length) * 10) / 10
    : null;
  const atRisk = visibleProjects.filter((project) => riskLabel(project, cyclesByProject.get(project.id) || []) === "High").length;
  // The date range is a page-level filter: it must narrow the issue and cycle
  // panels too, not just the project table. Issues filter on when they were
  // RAISED, cycles on when they started.
  const raisedInRange = (issue) => {
    if (!range.from && !range.to) return true;
    const raised = String(issue.createdAt || "").slice(0, 10);
    if (!raised) return false;
    if (range.from && raised < range.from) return false;
    if (range.to && raised > range.to) return false;
    return true;
  };

  const openIssues = (dashboard.openIssues || [])
    .filter((issue) => visibleIds.has(issue.projectId))
    .filter(raisedInRange);
  const openCycles = (dashboard.openCycles || [])
    .filter((cycle) => visibleIds.has(cycle.projectId))
    .filter((cycle) => cycleInRange(cycle, range));
  const responseTracker = allResponseSessions
    .filter((session) => visibleIds.has(session.projectId))
    .filter((session) => cycleInRange({
      startedAt: session.cycleStartedAt || session.startedAt,
      closedAt: session.cycleClosedAt || session.closedAt
    }, range));
  const feedbackSchedule = (dashboard.feedbackSchedule || [])
    .filter((item) => visibleIds.has(item.projectId))
    .filter((item) => !scheduleTypes.length || scheduleTypes.includes(item.cycleType))
    .filter((item) => !scheduleStatuses.length || scheduleStatuses.includes(item.status));
  const recentScheduleSkips = (dashboard.scheduleEvents || [])
    .map((event) => ({
      ...event,
      project: allProjects.find((project) => project.key === event.projectKey) || null
    }))
    .filter((event) => event.project && visibleIds.has(event.project.id))
    .filter((event) => !scheduleTypes.length || scheduleTypes.includes(event.cycleType))
    .slice(0, 20);
  const responseCounts = responseTracker.reduce((counts, session) => {
    const key = session.responseStatus || (
      session.completionStatus === "completed" ? "completed"
        : session.lastClientResponseAt ? "partial" : "awaiting"
    );
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, { awaiting: 0, partial: 0, completed: 0, stopped: 0 });
  const scopedResponseTracker = responseCycleScope === "rating"
    ? responseTracker.filter((session) => session.cycleType !== "quick_checkin")
    : responseTracker;
  const filteredResponseTracker = responseFilter === "all"
    ? scopedResponseTracker
    : scopedResponseTracker.filter((session) => session.responseStatus === responseFilter);

  const statusIsDefault = statuses.length === 1 && statuses[0] === "active";
  const filtersActive = Boolean(
    clusters.length || clients.length || projectNames.length || risks.length
    || !statusIsDefault || range.from || range.to
  );

  function resetFilters() {
    setClusters([]); setClients([]); setProjectNames([]); setRisks([]); setStatuses(["active"]);
    setRange({ from: "", to: "", basis: "started" });
  }

  function showResponses(filter = "all", cycleScope = "all") {
    setResponseFilter(filter);
    setResponseCycleScope(cycleScope);
    window.setTimeout(() => {
      document.getElementById("response-tracker")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  function showSection(sectionId) {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function buildDashboardReport() {
    setReportError("");
    const rangeActive = Boolean(range.from || range.to);
    const workspaceResults = await Promise.allSettled(visibleProjects.map(async (project) => ({
      project,
      workspace: await apiGet(`/api/projects/${encodeURIComponent(project.key)}/workspace`)
    })));
    const workspaceRows = workspaceResults
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);

    const clientGroups = new Map();
    for (const project of visibleProjects) {
      const key = project.clientName || "Unassigned";
      if (!clientGroups.has(key)) clientGroups.set(key, []);
      clientGroups.get(key).push(project);
    }
    const clientRows = [...clientGroups.entries()].map(([clientName, projects]) => {
      const projectIds = new Set(projects.map((project) => project.id));
      const ratedProjects = projects.filter((project) => project.csatScore !== null && project.csatScore !== undefined);
      const clientScore = ratedProjects.length
        ? Math.round((ratedProjects.reduce((sum, project) => sum + Number(project.csatScore), 0) / ratedProjects.length) * 10) / 10
        : null;
      return {
        client: clientName,
        cluster: projects[0]?.clusterName || "--",
        projects: projects.length,
        ratedProjects: ratedProjects.length,
        avgCsat: clientScore,
        cycles: rangeCycles.filter((cycle) => projectIds.has(cycle.projectId)).length,
        openIssues: openIssues.filter((issue) => projectIds.has(issue.projectId)).length,
        atRisk: projects.filter((project) => riskLabel(project, cyclesByProject.get(project.id) || []) === "High").length
      };
    });

    const serviceRows = workspaceRows.flatMap(({ project, workspace }) => {
      const cycleRows = cyclesByProject.get(project.id) || [];
      if (rangeActive) {
        return cycleRows.flatMap((cycle) => (workspace.serviceFeedbackByCycle?.[cycle.id] || []).map((service) => ({
          client: project.clientName || "--",
          project: project.name,
          cycle: formatCycleType(cycle.cycleType, project.feedbackIntervalDays),
          cycleStarted: formatDate(cycle.startedAt),
          service: service.serviceName || service.name || service.serviceKey,
          score: service.score,
          source: service.source === "predicted" ? "Read from chat" : "Client rating",
          owner: service.managerName || service.ownerName || "Not set"
        })));
      }
      return (workspace.services || []).map((service) => ({
        client: project.clientName || "--",
        project: project.name,
        cycle: "Latest known",
        cycleStarted: "--",
        service: service.name,
        score: service.score,
        source: service.score === null || service.score === undefined ? "Not scored" : "Latest recorded",
        owner: service.managerName || service.ownerName || "Not set"
      }));
    });

    const filterText = (values, fallback = "All") => values.length ? values.join(", ") : fallback;
    const selectedResponseLabel = [
      responseCycleScope === "rating" ? "Rating feedback cycles" : "All cycle types",
      responseFilter === "all" ? "All responses" : responseFilterLabel(responseFilter)
    ].join(" · ");
    return {
      title: "CSAT dashboard report",
      subtitle: "Filtered client, project, POC and service results from the CSAT Command Centre",
      generatedAt: new Date().toISOString(),
      filters: [
        { label: "Cluster", value: filterText(clusters) },
        { label: "Client", value: filterText(clients) },
        { label: "Project", value: filterText(projectNames) },
        { label: "Risk", value: filterText(risks) },
        { label: "Project status", value: filterText(statuses) },
        { label: "Date range", value: range.from || range.to ? `${range.from || "Any"} to ${range.to || "Any"}` : "All dates" },
        { label: "POC response", value: selectedResponseLabel },
        { label: "Schedule cycle", value: filterText(scheduleTypes) },
        { label: "Schedule status", value: filterText(scheduleStatuses) }
      ],
      metrics: [
        { label: "Projects", value: visibleProjects.length },
        { label: "Average CSAT", value: formatScore(avgCsat), detail: `${scored.length} rated projects` },
        { label: "Rating cycles completed", value: completedCycles.length },
        { label: "At risk", value: atRisk },
        { label: "POC sessions", value: filteredResponseTracker.length },
        { label: "Open issues", value: openIssues.length }
      ],
      sections: [
        {
          title: "Client summary",
          sheetName: "Client summary",
          columns: [
            { key: "client", label: "Client", width: 24 },
            { key: "cluster", label: "Cluster", width: 18 },
            { key: "projects", label: "Projects", width: 12 },
            { key: "ratedProjects", label: "Rated projects", width: 14 },
            { key: "avgCsat", label: "Average CSAT", width: 14, numberFormat: "0.0" },
            { key: "cycles", label: "Rating cycles", width: 14 },
            { key: "openIssues", label: "Open issues", width: 12 },
            { key: "atRisk", label: "At risk", width: 10 }
          ],
          rows: clientRows
        },
        {
          title: "Project scores",
          sheetName: "Project scores",
          note: "Every project shown here matches the dashboard filters above.",
          columns: [
            { key: "cluster", label: "Cluster", width: 18 },
            { key: "client", label: "Client", width: 24 },
            { key: "project", label: "Project", width: 28 },
            { key: "status", label: "Status", width: 12 },
            { key: "cycles", label: "Rating cycles", width: 14 },
            { key: "latestCycle", label: "Latest cycle", width: 18 },
            { key: "latestStarted", label: "Latest started", width: 14 },
            { key: "csat", label: "CSAT", width: 10, numberFormat: "0.0" },
            { key: "risk", label: "Risk", width: 12 }
          ],
          rows: visibleProjects.map((project) => {
            const projectCycles = cyclesByProject.get(project.id) || [];
            const latest = projectCycles[0] || null;
            return {
              cluster: project.clusterName || "--",
              client: project.clientName || "--",
              project: project.name,
              status: project.activeStatus,
              cycles: projectCycles.length,
              latestCycle: latest ? formatCycleType(latest.cycleType, project.feedbackIntervalDays) : "No cycle",
              latestStarted: latest ? formatDate(latest.startedAt) : "--",
              csat: project.csatScore,
              risk: riskLabel(project, projectCycles)
            };
          })
        },
        {
          title: "POC response tracker",
          sheetName: "POC responses",
          columns: [
            { key: "client", label: "Client", width: 22 },
            { key: "project", label: "Project", width: 26 },
            { key: "poc", label: "POC", width: 22 },
            { key: "cycle", label: "Cycle", width: 18 },
            { key: "started", label: "Started", width: 18 },
            { key: "response", label: "Response", width: 20 },
            { key: "reminders", label: "Reminders", width: 12 },
            { key: "csat", label: "CSAT", width: 10, numberFormat: "0.0" },
            { key: "latestReply", label: "Latest client reply", width: 48 }
          ],
          rows: filteredResponseTracker.map((session) => {
            const project = allProjects.find((item) => item.id === session.projectId);
            return {
              client: project?.clientName || "--",
              project: session.projectName || project?.name || "--",
              poc: session.pocName || "--",
              cycle: formatCycleType(session.cycleType, project?.feedbackIntervalDays),
              started: formatDateTime(session.cycleStartedAt || session.startedAt),
              response: responseDisplayLabel(session),
              reminders: Number(session.reminderCount) || 0,
              csat: session.csatScore,
              latestReply: session.latestClientReply || "--"
            };
          })
        },
        {
          title: "Service scores",
          sheetName: "Service scores",
          note: rangeActive ? "Service feedback from cycles inside the selected date range." : "Latest recorded score for each service on the filtered projects.",
          columns: [
            { key: "client", label: "Client", width: 22 },
            { key: "project", label: "Project", width: 26 },
            { key: "cycle", label: "Cycle", width: 18 },
            { key: "cycleStarted", label: "Cycle started", width: 14 },
            { key: "service", label: "Service", width: 24 },
            { key: "score", label: "Score", width: 10, numberFormat: "0.0" },
            { key: "source", label: "Score source", width: 18 },
            { key: "owner", label: "Internal owner", width: 24 }
          ],
          rows: serviceRows
        },
        {
          title: "Open issues",
          sheetName: "Open issues",
          columns: [
            { key: "client", label: "Client", width: 22 },
            { key: "project", label: "Project", width: 26 },
            { key: "service", label: "Service", width: 20 },
            { key: "issue", label: "Issue", width: 52 },
            { key: "severity", label: "Severity", width: 12 },
            { key: "raisedBy", label: "Raised by", width: 20 },
            { key: "raised", label: "Raised", width: 18 }
          ],
          rows: openIssues.map((issue) => {
            const project = allProjects.find((item) => item.id === issue.projectId);
            return {
              client: project?.clientName || "--",
              project: issue.projectName || project?.name || "--",
              service: issue.serviceName || "--",
              issue: issue.title,
              severity: issue.severity || "--",
              raisedBy: issue.raisedBy || "--",
              raised: formatDateTime(issue.createdAt)
            };
          })
        },
        {
          title: "Feedback schedule and delivery",
          sheetName: "Schedule",
          columns: [
            { key: "client", label: "Client", width: 22 },
            { key: "project", label: "Project", width: 26 },
            { key: "cycle", label: "Feedback cycle", width: 20 },
            { key: "due", label: "Due date", width: 14 },
            { key: "pocs", label: "Active POCs", width: 12 },
            { key: "status", label: "Delivery status", width: 20 },
            { key: "reason", label: "Blocked / skipped reason", width: 48 }
          ],
          rows: feedbackSchedule.map((item) => ({
            client: item.clientName || "--",
            project: item.projectName,
            cycle: formatCycleType(item.cycleType),
            due: formatDate(item.dueAt),
            pocs: item.activePocCount,
            status: scheduleStatusLabel(item.status),
            reason: item.blockedReason || "--"
          }))
        },
        {
          title: "Recent skipped attempts",
          sheetName: "Skipped attempts",
          columns: [
            { key: "project", label: "Project", width: 26 },
            { key: "cycle", label: "Feedback cycle", width: 20 },
            { key: "attempted", label: "Attempted", width: 20 },
            { key: "reason", label: "Reason", width: 58 }
          ],
          rows: recentScheduleSkips.map((event) => ({
            project: event.project?.name || event.projectKey,
            cycle: formatCycleType(event.cycleType),
            attempted: formatDateTime(event.attemptedAt),
            reason: event.reason || "The scheduler could not start this cycle."
          }))
        }
      ]
    };
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h2>Client Feedback Overview</h2>
          {filtersActive ? (
            <p className="topbar-sub">
              Showing {visibleProjects.length} of {allProjects.length}{" "}
              {allProjects.length === 1 ? "project" : "projects"}
              {range.from || range.to
                ? ` · ${rangeCycles.length} rating ${rangeCycles.length === 1 ? "cycle" : "cycles"} and ${responseTracker.length} POC ${responseTracker.length === 1 ? "session" : "sessions"} in range`
                : ""}
            </p>
          ) : null}
        </div>
        <div className="button-row dashboard-controls">
          <ReportDownloads
            getReport={buildDashboardReport}
            fileName={`csat-dashboard-${new Date().toISOString().slice(0, 10)}`}
            onError={setReportError}
          />
          {canControlMessaging ? <Button
            icon={Power}
            variant={messagingEnabled ? "success" : "danger"}
            onClick={() => { setMessagingPrompt(true); setMessagingError(""); setMessagingPin(""); }}
          >
            WhatsApp {messagingEnabled ? "ON" : "PAUSED"}
          </Button> : null}
          <button type="button" className="button primary" onClick={onReload}>
            <RefreshCw size={16} aria-hidden="true" /><span>Refresh</span>
          </button>
        </div>
      </div>

      {reportError ? <div className="report-export-error" role="alert">{reportError}</div> : null}

      <nav className="dashboard-section-nav" aria-label="Dashboard sections">
        <button type="button" onClick={() => showSection("dashboard-projects")}>Projects</button>
        <button type="button" onClick={() => showSection("dashboard-feedback-schedule")}>Feedback Schedule &amp; Delivery</button>
        <button type="button" onClick={() => showSection("dashboard-recent-skips")}>Recent Skipped Attempts</button>
        <button type="button" onClick={() => showSection("dashboard-open-cycles")}>Open Cycles</button>
        <button type="button" onClick={() => showSection("dashboard-open-issues")}>Open Issues</button>
        <button type="button" onClick={() => showSection("response-tracker")}>Feedback Cycle &amp; POC Response Tracker</button>
      </nav>

      {canControlMessaging && messagingPrompt ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !messagingSaving) setMessagingPrompt(false);
        }}>
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="messaging-control-title">
            <h3 id="messaging-control-title">{messagingEnabled ? "Pause" : "Resume"} WhatsApp messaging</h3>
            <p>
              {messagingEnabled
                ? "No WhatsApp templates, reminders, quick check-ins, manual messages or bot replies will be sent. Incoming messages will still be stored."
                : "WhatsApp activity will resume. Scheduled items that stayed pending while paused will be checked again by their normal workflows."}
            </p>
            <p><strong>Email notifications and alerts remain active.</strong></p>
            <input
              className="cleanup-pin-input"
              type="password"
              value={messagingPin}
              onChange={(event) => setMessagingPin(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && messagingPin.trim() && !messagingSaving) changeMessagingStatus(); }}
              placeholder="Manage admin PIN"
              autoFocus
            />
            {messagingError ? <p className="pin-error">{messagingError}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setMessagingPrompt(false)} disabled={messagingSaving}>Cancel</Button>
              <Button variant={messagingEnabled ? "danger" : "primary"} onClick={changeMessagingStatus} disabled={!messagingPin.trim() || messagingSaving}>
                {messagingSaving ? "Saving…" : messagingEnabled ? "Pause WhatsApp" : "Resume WhatsApp"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <FilterBar onReset={resetFilters} showReset={filtersActive}>
        <MultiSelect
          label="Cluster" allLabel="All clusters" selected={clusters} onChange={setClusters}
          options={clusterOptions}
        />
        <MultiSelect
          label="Client" allLabel="All clients" selected={clients} onChange={setClients}
          options={clientOptions}
        />
        <MultiSelect
          label="Project" allLabel="All projects" selected={projectNames} onChange={setProjectNames}
          options={projectOptions}
        />
        <MultiSelect label="Risk" allLabel="All risk" selected={risks} onChange={setRisks} options={RISK_OPTIONS} />
        <MultiSelect label="Status" allLabel="All statuses" selected={statuses} onChange={setStatuses} options={statusOptions} />
        <DateRange range={range} onChange={setRange} />
      </FilterBar>

      {filtersActive ? (
        <div className="active-filters">
          {clusters.map((name) => (
            <button key={`cl-${name}`} type="button" className="filter-chip"
              onClick={() => setClusters(clusters.filter((item) => item !== name))}>
              Cluster: {name} <X size={11} aria-hidden="true" />
            </button>
          ))}
          {clients.map((name) => (
            <button key={`cli-${name}`} type="button" className="filter-chip"
              onClick={() => setClients(clients.filter((item) => item !== name))}>
              Client: {name} <X size={11} aria-hidden="true" />
            </button>
          ))}
          {projectNames.map((name) => (
            <button key={`pr-${name}`} type="button" className="filter-chip"
              onClick={() => setProjectNames(projectNames.filter((item) => item !== name))}>
              Project: {name} <X size={11} aria-hidden="true" />
            </button>
          ))}
          {risks.map((name) => (
            <button key={`ri-${name}`} type="button" className="filter-chip"
              onClick={() => setRisks(risks.filter((item) => item !== name))}>
              Risk: {name} <X size={11} aria-hidden="true" />
            </button>
          ))}
          {statuses.map((name) => (
            <button key={`st-${name}`} type="button" className="filter-chip"
              onClick={() => setStatuses(statuses.filter((item) => item !== name))}>
              Status: {name} <X size={11} aria-hidden="true" />
            </button>
          ))}
          {range.from || range.to ? (
            <button type="button" className="filter-chip"
              onClick={() => setRange({ from: "", to: "", basis: range.basis })}>
              {range.from || "any"} to {range.to || "any"} <X size={11} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}

      {filtersActive && !visibleProjects.length ? (
        <div className="filter-empty-note">
          {range.from || range.to
            ? "No project has a feedback cycle in this date range and filter combination. Clear a filter or reset the date range."
            : "No project matches this filter combination. Clear one of the filters or reset them."}
        </div>
      ) : null}

      <div className="metric-row five">
        <MetricCard label="Projects" value={visibleProjects.length} />
        <MetricCard
          label="Avg CSAT"
          value={formatScore(avgCsat)}
          caption={`${scored.length} of ${visibleProjects.length} projects rated`}
          tone={scoreClass(avgCsat)}
        />
        <MetricCard label="Rating Cycles Completed" value={completedCycles.length} caption={range.from || range.to ? "in range" : "all time"} />
        <MetricCard label="At Risk" value={atRisk} tone={atRisk ? "weak" : "strong"} />
        <MetricCard
          label="Open Issues"
          value={openIssues.length}
          caption="click to view"
          tone={openIssues.length ? "weak" : "strong"}
          onClick={() => showSection("dashboard-open-issues")}
          title="Go to Open Issues"
        />
      </div>

      <div className="metric-row six response-summary">
        <MetricCard
          label="Rating Cycles Sent"
          value={rangeCycles.length}
          caption="rating-based cycles; click to view sessions"
          onClick={() => showResponses("all", "rating")}
          title="Show all feedback-cycle POC sessions"
          active={responseCycleScope === "rating" && responseFilter === "all"}
        />
        <MetricCard
          label="POC Sessions Sent"
          value={responseTracker.length}
          caption="individual feedback requests"
          onClick={() => showResponses("all")}
          active={responseCycleScope === "all" && responseFilter === "all"}
        />
        <MetricCard
          label="Awaiting First Reply"
          value={responseCounts.awaiting}
          caption="no client message yet"
          tone="weak"
          onClick={() => showResponses("awaiting")}
          active={responseFilter === "awaiting"}
        />
        <MetricCard
          label="Responded / Partial"
          value={responseCounts.partial}
          caption="client replied; response window or feedback remains open"
          tone="watch"
          onClick={() => showResponses("partial")}
          active={responseFilter === "partial"}
        />
        <MetricCard
          label="Completed"
          value={responseCounts.completed}
          caption="feedback flow completed"
          tone="strong"
          onClick={() => showResponses("completed")}
          active={responseFilter === "completed"}
        />
        <MetricCard
          label="Stopped"
          value={responseCounts.stopped}
          caption="stopped for that POC and cycle"
          onClick={() => showResponses("stopped")}
          active={responseFilter === "stopped"}
        />
      </div>

      <Panel title="Cluster Scorecards" badge={`${clusterCards.length} clusters`} className="span-12">
        <div className="cluster-grid">
          {clusterCards.map((cluster) => (
            <button
              key={cluster.name}
              type="button"
              className={`cluster-card ${cluster.atRisk ? "weak" : scoreClass(cluster.avgCsat)}`}
              onClick={() => setClusters(clusters.includes(cluster.name) ? [] : [cluster.name])}
            >
              <strong>{cluster.name}</strong>
              <span>{cluster.projectCount} projects · {cluster.atRisk} at risk</span>
              <b className={scoreClass(cluster.avgCsat)}>{formatScore(cluster.avgCsat)}</b>
            </button>
          ))}
          {!clusterCards.length ? <EmptyState title="No cluster matches these filters" text="Reset a filter to see more." /> : null}
        </div>
      </Panel>

      <Panel id="dashboard-projects" title="Projects" badge={`${visibleProjects.length} shown`} className="span-12 dashboard-anchor-section">
        <div className="dashboard-projects-scroll" role="region" aria-label="Projects" tabIndex={0}>
          <div className="ptable">
          <div className="ptable-head">
            <span />
            <span>Project</span>
            <span>Client</span>
            <span>Feedback cycle</span>
            <span>Started</span>
            <span>Cycle end</span>
            <span>Project end</span>
            <span>CSAT</span>
            <span>Risk</span>
            <span />
          </div>
          {visibleProjects.map((project) => (
            <ProjectRow
              key={project.key}
              project={project}
              cycles={cyclesByProject.get(project.id) || []}
              sessions={responseTracker.filter((session) => session.projectId === project.id)}
              expanded={Boolean(expanded[project.id])}
              onToggle={() => setExpanded((state) => ({ ...state, [project.id]: !state[project.id] }))}
              onOpenProject={onOpenProject}
            />
          ))}
          {!visibleProjects.length ? <EmptyState title="No project matches these filters" text="Reset a filter to see more." /> : null}
          </div>
        </div>
      </Panel>

      <Panel
        id="dashboard-feedback-schedule"
        title="Feedback Schedule & Delivery"
        badge={`${feedbackSchedule.length} scheduled · ${recentScheduleSkips.length} recent skips`}
        className="span-12 dashboard-anchor-section"
      >
        <div className="schedule-filter-row">
          <MultiSelect
            label="Feedback cycle"
            allLabel="All cycle types"
            selected={scheduleTypes}
            onChange={setScheduleTypes}
            options={scheduleTypeOptions}
            renderOption={(value) => formatCycleType(value)}
          />
          <MultiSelect
            label="Delivery status"
            allLabel="All delivery statuses"
            selected={scheduleStatuses}
            onChange={setScheduleStatuses}
            options={scheduleStatusOptions}
            renderOption={scheduleStatusLabel}
          />
          {scheduleFiltersActive ? (
            <button type="button" className="filter-reset" onClick={() => { setScheduleTypes([]); setScheduleStatuses([]); }}>
              Reset schedule filters
            </button>
          ) : null}
        </div>
        <div className="schedule-table" role="region" aria-label="Upcoming feedback schedule" tabIndex={0}>
          <div className="schedule-table-head">
            <span>Client & project</span>
            <span>Feedback cycle</span>
            <span>Due date</span>
            <span>POCs</span>
            <span>Delivery status</span>
            <span />
          </div>
          {feedbackSchedule.map((item) => (
            <div className={`schedule-table-row ${scheduleStatusTone(item.status)}`} key={item.id}>
              <span><strong>{item.projectName}</strong><small>{item.clientName || "No client"} · {item.clusterName || "No cluster"}</small></span>
              <span>{formatCycleType(item.cycleType)}</span>
              <span>{formatDate(item.dueAt)}</span>
              <span>{item.activePocCount} active</span>
              <span>
                <StatusPill value={scheduleStatusLabel(item.status)} tone={scheduleStatusTone(item.status)} />
                {item.blockedReason ? <small title={item.blockedReason}>{item.blockedReason}</small> : null}
              </span>
              <button type="button" className="row-link" onClick={() => onOpenProject(item.projectKey)}>Open</button>
            </div>
          ))}
          {!feedbackSchedule.length ? <EmptyState title="No scheduled feedback matches" text="Adjust the dashboard or schedule filters." /> : null}
        </div>

        <div id="dashboard-recent-skips" className="schedule-skip-history dashboard-anchor-section">
            <h4>Recent Skipped Attempts</h4>
            {recentScheduleSkips.map((event) => (
              <button type="button" key={event.id} onClick={() => onOpenProject(event.projectKey)}>
                <span><strong>{event.project?.name || event.projectKey}</strong><small>{formatCycleType(event.cycleType)} · {formatDateTime(event.attemptedAt)}</small></span>
                <span>{event.reason || "The scheduler could not start this cycle."}</span>
              </button>
            ))}
            {!recentScheduleSkips.length ? <EmptyState title="No Recent Skipped Attempts" text="Skipped scheduler attempts will appear here." /> : null}
          </div>
      </Panel>

      <div className="dashboard-grid">
        <Panel
          id="dashboard-open-cycles"
          title="Open Cycles"
          badge={range.from || range.to ? `${openCycles.length} started in range` : `${openCycles.length} open`}
          className="span-6 dashboard-anchor-section"
        >
          <div className="session-list">
            {openCycles.map((cycle) => (
              <button key={cycle.id} type="button" className={`session-row ${riskClass(cycle.riskLevel)}`} onClick={() => cycle.projectKey && onOpenProject(cycle.projectKey, { cycleId: cycle.id })}>
                <strong>{cycle.projectName || "Project"}</strong>
                <span>{formatCycleType(cycle.cycleType, cycle.feedbackIntervalDays)} · {formatCycleCoverage(cycle)}</span>
                <em>Started {formatDate(cycle.startedAt)}</em>
              </button>
            ))}
            {!openCycles.length ? (
              <EmptyState
                title="No cycle is open"
                text={range.from || range.to
                  ? "No cycle started in this date range."
                  : "Sends waiting on replies appear here."}
              />
            ) : null}
          </div>
        </Panel>

        <Panel
          id="dashboard-open-issues"
          title="Open Issues"
          badge={range.from || range.to ? `${openIssues.length} raised in range` : `${openIssues.length} open`}
          className="span-6 dashboard-anchor-section"
        >
          <div className="focus-list">
            {openIssues.map((issue) => (
              <button key={issue.id} type="button" className={`focus-row ${riskClass(issue.severity)}`} onClick={() => issue.projectKey && onOpenProject(issue.projectKey, { section: "issues", issueId: issue.id })}>
                <strong>{issue.projectName || "Project"}</strong>
                <span>{issue.serviceName || "Service"}</span>
                <p>{issue.title}</p>
                <em>{issue.raisedBy ? `Raised by ${issue.raisedBy} · ` : ""}{formatDate(issue.createdAt)}</em>
              </button>
            ))}
            {!openIssues.length ? (
              <EmptyState
                title="Nothing open"
                text={range.from || range.to
                  ? "No issue was raised in this date range."
                  : "Issues need a reported problem with a reason."}
              />
            ) : null}
          </div>
        </Panel>

        <Panel
          id="response-tracker"
          title="Feedback Cycle & POC Response Tracker"
          badge={`${filteredResponseTracker.length} of ${responseTracker.length} POC sessions shown`}
          className="span-12 dashboard-anchor-section"
          action={responseFilter !== "all" || responseCycleScope !== "all" ? (
            <button type="button" className="filter-reset" onClick={() => { setResponseFilter("all"); setResponseCycleScope("all"); }}>
              Clear response filter <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        >
          <div
            className="response-tracker-table"
            role="region"
            aria-label="Feedback cycle and POC response tracker"
            tabIndex={0}
          >
            <div className="response-tracker-head">
              <span>Client POC</span>
              <span>Project & cycle</span>
              <span>Response status</span>
              <span>Latest client reply</span>
              <span>Reminder / closure</span>
              <span>Score</span>
            </div>
            {filteredResponseTracker.map((session) => {
              const status = session.responseStatus || (
                session.completionStatus === "completed" ? "completed"
                  : session.lastClientResponseAt ? "partial" : "awaiting"
              );
              const statusLabel = responseDisplayLabel(session, status);
              return (
                <button
                  key={session.id}
                  type="button"
                  className={`response-tracker-row ${responseTone(status)}`}
                  onClick={() => session.projectKey && onOpenProject(session.projectKey, {
                    cycleId: session.cycleId,
                    sessionId: session.id
                  })}
                  title="Open this POC's conversation"
                >
                  <span className="response-poc">
                    <strong>{session.pocName || "Client POC"}</strong>
                    <small>{session.lastClientResponseAt ? `Last replied ${formatDateTime(session.lastClientResponseAt)}` : "No reply received"}</small>
                  </span>
                  <span>
                    <strong>{session.projectName || "Project"}</strong>
                    <small>{formatCycleType(session.cycleType)} · started {formatDate(session.cycleStartedAt || session.startedAt)}</small>
                  </span>
                  <span><StatusPill value={statusLabel} tone={responseTone(status)} /></span>
                  <span className="latest-reply">
                    <span className="reply-preview">{session.latestClientReply || "No client reply yet"}</span>
                    {session.latestClientReplyAt ? <small>{formatDateTime(session.latestClientReplyAt)}</small> : null}
                  </span>
                  <span className="response-lifecycle">{responseLifecycle({ ...session, responseStatus: status })}</span>
                  <span className="response-score">
                    <strong className={scoreClass(session.csatScore)}>{formatScore(session.csatScore)}</strong>
                    <small>{session.csatSource === "predicted" ? "Predicted" : session.csatScore === null || session.csatScore === undefined ? "Not scored" : "Client rating"}</small>
                  </span>
                </button>
              );
            })}
            {!filteredResponseTracker.length ? (
              <EmptyState
                title={`No ${responseFilter === "all" ? "feedback sessions" : responseFilterLabel(responseFilter).toLowerCase()}`}
                text="Choose another response card or adjust the dashboard filters."
              />
            ) : null}
          </div>
        </Panel>
      </div>
    </>
  );
}
