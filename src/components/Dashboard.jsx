import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import { cycleInRange, DateRange, FilterBar, MultiSelect } from "./Filters.jsx";
import {
  formatCycleCoverage, formatCycleType, formatDate, formatDateTime,
  formatScore, riskClass, scoreClass
} from "../format";
import { EmptyState, LoadingBlock, MetricCard, Panel, StatusPill } from "./Ui.jsx";

const RISK_OPTIONS = ["High", "Watch", "Low", "Not scored"];
const ROW_STEP = 15;
const RESPONSE_LABELS = {
  awaiting: "Awaiting First Reply",
  partial: "Partial Response",
  completed: "Completed",
  stopped: "Stopped"
};

function responseLabel(value) {
  return RESPONSE_LABELS[value] || "Awaiting First Reply";
}

function responseTone(value) {
  if (value === "completed") return "strong";
  if (value === "partial") return "watch";
  if (value === "stopped") return "neutral";
  return "weak";
}

function responseLifecycle(session) {
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

function ProjectRow({ project, cycles, expanded, onToggle, onOpenProject }) {
  const risk = riskLabel(project, cycles);
  const latest = cycles[0] || null;

  return (
    <>
      <div className={`ptable-row ${riskClass(risk)}`}>
        <button type="button" className="ptable-expand" onClick={onToggle} aria-expanded={expanded} aria-label={expanded ? "Hide cycles" : "Show cycles"}>
          {cycles.length ? (expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />) : null}
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

      {expanded ? cycles.map((cycle) => (
        <div key={cycle.id} className="ptable-subrow">
          <span />
          <span className="subrow-label">{formatCycleType(cycle.cycleType, cycle.feedbackIntervalDays)}</span>
          <span>{formatCycleCoverage(cycle)}</span>
          <span>{cycle.status === "closed" ? "Closed" : "Open"}</span>
          <span>{formatDate(cycle.startedAt)}</span>
          <span>{cycle.closedAt ? formatDate(cycle.closedAt) : "--"}</span>
          <span />
          <b className={scoreClass(cycle.csatScore)}>{formatScore(cycle.csatScore)}</b>
          <span className={`risk-text ${riskClass(cycle.riskLevel)}`}>{cycle.riskLevel || "--"}</span>
          <span />
        </div>
      )) : null}
    </>
  );
}

export default function Dashboard({ dashboard, onReload, onOpenProject }) {
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
  const [visibleRows, setVisibleRows] = useState(ROW_STEP);
  const [responseFilter, setResponseFilter] = useState("all");

  const allProjects = dashboard?.projects || [];
  const allCycles = dashboard?.cycles || [];

  const cyclesByProject = useMemo(() => {
    const map = new Map();
    for (const cycle of allCycles) {
      if (!cycleInRange(cycle, range)) continue;
      if (!map.has(cycle.projectId)) map.set(cycle.projectId, []);
      map.get(cycle.projectId).push(cycle);
    }
    return map;
  }, [allCycles, range]);

  const statusOptions = useMemo(
    () => [...new Set(allProjects.map((project) => project.activeStatus).filter(Boolean))],
    [allProjects]
  );

  const visibleProjects = useMemo(() => {
    const rangeActive = Boolean(range.from || range.to);
    return allProjects.filter((project) => {
      if (clusters.length && !clusters.includes(project.clusterName)) return false;
      if (clients.length && !clients.includes(project.clientName)) return false;
      if (projectNames.length && !projectNames.includes(project.name)) return false;
      if (statuses.length && !statuses.includes(project.activeStatus)) return false;
      if (risks.length && !risks.includes(riskLabel(project, cyclesByProject.get(project.id) || []))) return false;
      // With a range set, a project only counts if it has a cycle inside it.
      if (rangeActive && !(cyclesByProject.get(project.id) || []).length) return false;
      return true;
    });
  }, [allProjects, clusters, clients, projectNames, statuses, risks, range, cyclesByProject]);

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
  const responseTracker = (dashboard.responseTracker || dashboard.responseQueue || [])
    .filter((session) => visibleIds.has(session.projectId))
    .filter((session) => cycleInRange({
      startedAt: session.cycleStartedAt || session.startedAt,
      closedAt: session.cycleClosedAt || session.closedAt
    }, range));
  const responseCounts = responseTracker.reduce((counts, session) => {
    const key = session.responseStatus || (
      session.completionStatus === "completed" ? "completed"
        : session.lastClientResponseAt ? "partial" : "awaiting"
    );
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, { awaiting: 0, partial: 0, completed: 0, stopped: 0 });
  const filteredResponseTracker = responseFilter === "all"
    ? responseTracker
    : responseTracker.filter((session) => session.responseStatus === responseFilter);

  const statusIsDefault = statuses.length === 1 && statuses[0] === "active";
  const filtersActive = Boolean(
    clusters.length || clients.length || projectNames.length || risks.length
    || !statusIsDefault || range.from || range.to
  );

  function resetFilters() {
    setClusters([]); setClients([]); setProjectNames([]); setRisks([]); setStatuses(["active"]);
    setRange({ from: "", to: "", basis: "started" });
  }

  function showResponses(filter = "all") {
    setResponseFilter(filter);
    window.setTimeout(() => {
      document.getElementById("response-tracker")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  const rows = visibleProjects.slice(0, visibleRows);

  return (
    <>
      <div className="topbar">
        <div>
          <h2>Client feedback overview</h2>
          {filtersActive ? (
            <p className="topbar-sub">
              Showing {visibleProjects.length} of {allProjects.length}{" "}
              {allProjects.length === 1 ? "project" : "projects"}
              {range.from || range.to
                ? ` · ${rangeCycles.length} ${rangeCycles.length === 1 ? "cycle" : "cycles"} in range, ${completedCycles.length} completed`
                : ""}
            </p>
          ) : null}
        </div>
        <button type="button" className="button primary" onClick={onReload}>
          <RefreshCw size={16} aria-hidden="true" /><span>Refresh</span>
        </button>
      </div>

      <FilterBar onReset={resetFilters} showReset={filtersActive}>
        <MultiSelect
          label="Cluster" allLabel="All clusters" selected={clusters} onChange={setClusters}
          options={[...new Set(allProjects.map((project) => project.clusterName).filter(Boolean))].sort()}
        />
        <MultiSelect
          label="Client" allLabel="All clients" selected={clients} onChange={setClients}
          options={[...new Set(allProjects.map((project) => project.clientName).filter(Boolean))].sort()}
        />
        <MultiSelect
          label="Project" allLabel="All projects" selected={projectNames} onChange={setProjectNames}
          options={allProjects.map((project) => project.name).sort()}
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
          No project has a cycle in this range. Clear the dates to see everything again.
        </div>
      ) : null}

      <div className="metric-row four">
        <MetricCard label="Projects" value={visibleProjects.length} />
        <MetricCard
          label="Avg CSAT"
          value={formatScore(avgCsat)}
          caption={`${scored.length} of ${visibleProjects.length} projects rated`}
          tone={scoreClass(avgCsat)}
        />
        <MetricCard label="Cycles completed" value={completedCycles.length} caption={range.from || range.to ? "in range" : "all time"} />
        <MetricCard label="At risk" value={atRisk} tone={atRisk ? "weak" : "strong"} />
      </div>

      <div className="metric-row six response-summary">
        <MetricCard
          label="Cycles sent"
          value={rangeCycles.length}
          caption="click to view their POC sessions"
          onClick={() => showResponses("all")}
          title="Show all feedback-cycle POC sessions"
        />
        <MetricCard
          label="POC sessions sent"
          value={responseTracker.length}
          caption="individual feedback requests"
          onClick={() => showResponses("all")}
          active={responseFilter === "all"}
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
          label="Partial Response"
          value={responseCounts.partial}
          caption="client replied; feedback incomplete"
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

      <Panel title="Cluster scorecards" badge={`${clusterCards.length} clusters`} className="span-12">
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

      <Panel title="Projects" badge={`${visibleProjects.length} shown`} className="span-12">
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
          {rows.map((project) => (
            <ProjectRow
              key={project.key}
              project={project}
              cycles={cyclesByProject.get(project.id) || []}
              expanded={Boolean(expanded[project.id])}
              onToggle={() => setExpanded((state) => ({ ...state, [project.id]: !state[project.id] }))}
              onOpenProject={onOpenProject}
            />
          ))}
          {!visibleProjects.length ? <EmptyState title="No project matches these filters" text="Reset a filter to see more." /> : null}
        </div>
        {visibleProjects.length > rows.length ? (
          <button type="button" className="show-more" onClick={() => setVisibleRows((value) => value + ROW_STEP)}>
            Show {Math.min(ROW_STEP, visibleProjects.length - rows.length)} more
          </button>
        ) : null}
      </Panel>

      <div className="dashboard-grid">
        <Panel
          title="Open cycles"
          badge={range.from || range.to ? `${openCycles.length} started in range` : `${openCycles.length} open`}
          className="span-6"
        >
          <div className="session-list">
            {openCycles.map((cycle) => (
              <button key={cycle.id} type="button" className={`session-row ${riskClass(cycle.riskLevel)}`} onClick={() => cycle.projectKey && onOpenProject(cycle.projectKey)}>
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
          title="Open issues"
          badge={range.from || range.to ? `${openIssues.length} raised in range` : `${openIssues.length} open`}
          className="span-6"
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
          title="Feedback cycle & POC response tracker"
          badge={`${filteredResponseTracker.length} of ${responseTracker.length} POC sessions shown`}
          className="span-12"
          action={responseFilter !== "all" ? (
            <button type="button" className="filter-reset" onClick={() => setResponseFilter("all")}>
              Clear {responseLabel(responseFilter)} filter <X size={12} aria-hidden="true" />
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
                  <span><StatusPill value={responseLabel(status)} tone={responseTone(status)} /></span>
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
                title={`No ${responseFilter === "all" ? "feedback sessions" : responseLabel(responseFilter).toLowerCase()}`}
                text="Choose another response card or adjust the dashboard filters."
              />
            ) : null}
          </div>
        </Panel>
      </div>
    </>
  );
}
