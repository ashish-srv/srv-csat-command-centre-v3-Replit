import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Bell, Check, CheckCircle2, Power, RefreshCw, RotateCcw, Send, Users } from "lucide-react";
import { apiGet, apiPost, apiPut } from "../api";
import { SearchableSelect, cycleInRange, DateRange, FilterBar, MultiSelect, SingleSelect } from "./Filters.jsx";
import {
  formatCycleCoverage, formatCycleStatus, formatCycleType, formatDate, formatDateTime,
  formatConfidence, confidenceClass, formatGuardrail, formatNps, formatNpsBasis, npsClass, formatPocLevel, formatPocWeightShare, formatResolutionTime, formatScore,
  formatSessionOutcome, riskClass, scoreClass
} from "../format";
import { Button, EmptyState, LoadingBlock, MetricCard, Panel, StatusPill, TonePill } from "./Ui.jsx";
import ReportDownloads from "./ReportDownloads.jsx";
import ProjectConfiguration from "./ProjectConfiguration.jsx";
import { hasPermission } from "../permissions";

const COMPLETION_OPTIONS = [
  { value: "", label: "Any completion" },
  { value: "completed", label: "Completed only" },
  { value: "pending", label: "Not completed" }
];

const QUICK_CHECKIN_OUTCOMES = [
  { value: "awaiting_response", label: "Awaiting response" },
  { value: "needs_improvement", label: "Awaiting details" },
  { value: "all_good", label: "All good" },
  { value: "feedback_shared", label: "Feedback shared" },
  { value: "no_response", label: "No response" },
  { value: "awaiting_details_expired", label: "Details not received" }
];

function sessionCanBeStopped(session) {
  if (!session || session.completionStatus === "completed" || ["completed", "opted_out"].includes(session.status)) return false;
  const state = session.conversationState || {};
  return !["completed", "opted_out", "handed_off"].includes(state.state)
    && !state.reminderExhausted
    && !state.stoppedByAdmin;
}

function sessionCanReceiveReminder(session) {
  if (!session || session.completionStatus === "completed" || session.sessionType === "quick_checkin" || ["completed", "opted_out"].includes(session.status)) return false;
  const state = session.conversationState || {};
  if (["completed", "opted_out", "handed_off"].includes(state.state) || state.reminderExhausted || state.stoppedByAdmin) {
    return false;
  }
  return (Number(session.reminderCount) || 0) < 3;
}

/**
 * Same sentence, ignoring case, punctuation and a leading "Service: " prefix.
 * The fallback issue path writes identical text into title and rootCause, and
 * showing it twice reads as a rendering bug rather than as detail.
 */
/**
 * Does this text read as a complaint, whatever a sentiment flag says?
 *
 * A guard, not a classifier. It exists because "your designs are not that
 * great... looks like it was made in the 1990s" appeared under Appreciations,
 * which is worse than not showing it at all — a team would be told a
 * complaint was praise.
 */
function readsAsComplaint(text) {
  return /\b(not (that )?(great|good)|needs? to (improve|be better)|should (be|improve)|poor|bad|weak|issue|issues|problem|late|slow|missing|1990s|disappoint\w*|inaccurate|not working)\b/i
    .test(String(text || ""));
}

function readsAsExplicitAppreciation(text) {
  return /\b(?:appreciat\w*|kudos|praise|commend\w*|well done|(?:great|good) job|fantastic|excellent|amazing|outstanding|exceptional|impressed|love(?:d)?|very happy|delighted)\b/i
    .test(String(text || ""));
}

function isSameText(a, b) {
  const normalise = (value) => String(value || "")
    .replace(/^[^:]{1,40}:\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const left = normalise(a);
  const right = normalise(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function isSamePoint(a, b) {
  if (isSameText(a, b)) return true;
  const tokens = (value) => new Set(String(value || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
    .filter((token) => token.length > 2));
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return false;
  const shared = [...left].filter((token) => right.has(token)).length;
  return shared >= 3 && shared / Math.min(left.size, right.size) >= 0.6;
}

function pushProject(projectKey) {
  window.history.pushState({}, "", `/project?project=${encodeURIComponent(projectKey)}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function IssueNoteModal({ action, onCancel, onSubmit }) {
  const [note, setNote] = useState("");
  const isClose = action === "close";
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="modal-panel" role="dialog" aria-modal="true">
        <h3>{isClose ? "Close issue" : "Reopen issue"}</h3>
        <p>{isClose ? "Add a resolution note. It is saved in the issue history." : "Add a reason for reopening. It is saved in the issue history."}</p>
        <textarea className="note-input" value={note} rows={4} onChange={(event) => setNote(event.target.value)} autoFocus
          placeholder={isClose ? "Spoke to the client and shared a revised plan." : "Client raised the same concern again."} />
        <div className="modal-actions">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => onSubmit(note.trim())}>{isClose ? "Close issue" : "Reopen issue"}</Button>
        </div>
      </div>
    </div>
  );
}

export default function ProjectWorkspace({ dashboard, locationTick, onReload, currentUser }) {
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cycleId, setCycleId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState(null);
  const [toast, setToast] = useState("");
  const [issueModal, setIssueModal] = useState(null);
  const [showAllIssues, setShowAllIssues] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [bulkAction, setBulkAction] = useState("");
  const [selectedActionPocIds, setSelectedActionPocIds] = useState([]);
  const [showAllFeedback, setShowAllFeedback] = useState(false);
  const [feedbackPocId, setFeedbackPocId] = useState("");
  const [manualWhatsappText, setManualWhatsappText] = useState("");
  const [manualWhatsappSending, setManualWhatsappSending] = useState(false);
  const [automationSaving, setAutomationSaving] = useState("");
  const timelineRef = useRef(null);
  const conversationRef = useRef(null);
  const issuesRef = useRef(null);
  const workspaceRequestRef = useRef(0);
  const messageRequestRef = useRef(0);
  const appliedNavigationRef = useRef(-1);
  const scrolledNavigationRef = useRef(-1);
  const navigationRef = useRef(null);

  const [cluster, setCluster] = useState("");
  const [client, setClient] = useState("");
  const [cycleTypes, setCycleTypes] = useState([]);
  const [quickOutcomes, setQuickOutcomes] = useState([]);
  const [completion, setCompletion] = useState("");
  const [range, setRange] = useState({ from: "", to: "", basis: "started" });

  const allProjects = useMemo(() => dashboard?.projects
    || (workspace?.project ? [workspace.project] : []), [dashboard, workspace?.project]);
  const messagingEnabled = dashboard?.messaging?.enabled !== false;

  const projectKey = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("project") || params.get("client") || allProjects[0]?.key || "";
  }, [allProjects, locationTick]);

  const params = new URLSearchParams(window.location.search);
  const requestedCycleId = params.get("cycle") || "";
  const requestedSessionId = params.get("session") || "";
  const requestedSection = params.get("section") || "";
  navigationRef.current = { projectKey, cycleId: requestedCycleId, sessionId: requestedSessionId, locationTick };

  // A selected project has one client and one cluster. Keep those filters in
  // sync so the bar never says "All clients" while showing a single project's
  // workspace. Users can still clear or change them to navigate elsewhere.
  useEffect(() => {
    const project = allProjects.find((item) => item.key === projectKey);
    if (!project) return;
    setCluster(project.clusterName || "");
    setClient(project.clientName || "");
  }, [allProjects, projectKey]);

  // Cluster and client narrow which projects are selectable.
  const selectableProjects = useMemo(() => allProjects.filter((project) => {
    if (cluster && project.clusterName !== cluster) return false;
    if (client && project.clientName !== client) return false;
    return true;
  }), [allProjects, cluster, client]);

  const clusterProjects = useMemo(
    () => allProjects.filter((project) => !cluster || project.clusterName === cluster),
    [allProjects, cluster]
  );

  function selectCluster(nextCluster) {
    const candidate = allProjects.find((project) => project.clusterName === nextCluster);
    if (!candidate) {
      showToast("No project is configured under that cluster.");
      return;
    }
    setCluster(nextCluster);
    setClient(candidate.clientName || "");
    if (candidate.key !== projectKey) pushProject(candidate.key);
  }

  function selectClient(nextClient) {
    const candidate = allProjects.find((project) => (
      (!cluster || project.clusterName === cluster) && project.clientName === nextClient
    ));
    if (!candidate) {
      showToast(`No project for ${nextClient} belongs to ${cluster || "the selected cluster"}.`);
      return;
    }
    setClient(nextClient);
    if (candidate.key !== projectKey) pushProject(candidate.key);
  }

  // selectCluster/selectClient navigate explicitly. An effect must not push
  // the previous filter's first project while a sidebar link is synchronizing
  // these filters to a different client.

  function showToast(message) {
    setToast(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(""), 4000);
  }

  async function loadWorkspace(key = projectKey) {
    if (!key) { setLoading(false); return; }
    const requestId = workspaceRequestRef.current + 1;
    workspaceRequestRef.current = requestId;
    messageRequestRef.current += 1;
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet(`/api/projects/${encodeURIComponent(key)}/workspace`);
      // Project/filter changes can start another request before this one
      // finishes. Ignore a late response instead of putting the previous
      // client's POCs, cycles and scores back on screen.
      if (requestId !== workspaceRequestRef.current || navigationRef.current.projectKey !== key) return;
      if (data.project?.key !== key) throw new Error("The server returned a different project workspace.");
      setWorkspace(data);
      applyWorkspaceNavigation(data);
    } catch (loadError) {
      if (requestId === workspaceRequestRef.current) setError(loadError);
    } finally {
      if (requestId === workspaceRequestRef.current) setLoading(false);
    }
  }

  async function loadMessages(id) {
    if (!id) return [];
    const data = await apiGet(`/api/sessions/${encodeURIComponent(id)}`);
    return data.messages || [];
  }

  async function loadConversation(id, data = null) {
    const requestId = messageRequestRef.current + 1;
    messageRequestRef.current = requestId;
    setMessagesError(null);
    if (!id || (data?.latestSession?.id === id && Array.isArray(data.messages))) {
      setMessages(id ? data.messages : []);
      setMessagesLoading(false);
      return;
    }
    setMessages([]);
    setMessagesLoading(true);
    try {
      const nextMessages = await loadMessages(id);
      if (requestId === messageRequestRef.current) setMessages(nextMessages);
    } catch (loadError) {
      if (requestId === messageRequestRef.current) setMessagesError(loadError);
    } finally {
      if (requestId === messageRequestRef.current) setMessagesLoading(false);
    }
  }

  function applyWorkspaceNavigation(data, useEmbeddedMessages = true) {
    const target = navigationRef.current;
    const availableCycles = data.cycles || [];
    const targetCycle = availableCycles.find((cycle) =>
      (cycle.sessions || []).some((session) => session.id === target.sessionId))
      || availableCycles.find((cycle) => cycle.id === target.cycleId)
      || availableCycles[0];
    const targetSession = targetCycle
      ? (targetCycle.sessions || []).find((session) => session.id === target.sessionId)
        || (targetCycle.sessions || [])[0]
      : data.latestSession;
    appliedNavigationRef.current = target.locationTick;
    if (target.cycleId || target.sessionId) {
      // A reply link must remain visible even after a previous date/type/POC
      // filter excluded its cycle or its author.
      setCycleTypes([]);
      setQuickOutcomes([]);
      setCompletion("");
      setRange({ from: "", to: "", basis: "started" });
      setFeedbackPocId("");
    }
    setCycleId(targetCycle?.id || "");
    setSessionId(targetSession?.id || "");
    loadConversation(targetSession?.id || "", useEmbeddedMessages ? data : null);
  }

  useEffect(() => {
    loadWorkspace(projectKey);
    return () => {
      workspaceRequestRef.current += 1;
      messageRequestRef.current += 1;
    };
  }, [projectKey]);

  useEffect(() => {
    if (loading || workspace?.project?.key !== projectKey
      || appliedNavigationRef.current === locationTick) return;
    applyWorkspaceNavigation(workspace, false);
  }, [workspace, projectKey, locationTick, requestedCycleId, requestedSessionId, loading]);

  useEffect(() => {
    setFeedbackPocId("");
    setSelectedActionPocIds([]);
  }, [projectKey]);

  useEffect(() => {
    setManualWhatsappText("");
  }, [sessionId]);

  useEffect(() => {
    if (loading || workspace?.project?.key !== projectKey
      || appliedNavigationRef.current !== locationTick
      || scrolledNavigationRef.current === locationTick) return;
    const target = requestedSection === "issues" ? issuesRef.current
      : ["tracker", "conversation"].includes(requestedSection) ? conversationRef.current : null;
    if (!target) return;
    const timer = window.setTimeout(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      scrolledNavigationRef.current = locationTick;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, workspace, projectKey, locationTick, requestedSection, cycleId, sessionId]);


  // Land on the newest reply, not the opening question.
  useEffect(() => {
    const node = timelineRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const cycles = useMemo(() => {
    const list = workspace?.cycles || [];
    return list.filter((cycle) => {
      // Compare on the stored value, not the rendered label — the label now
      // varies by project interval, and matching on it would break the filter.
      if (cycleTypes.length && !cycleTypes.includes(cycle.cycleType)) return false;
      if (quickOutcomes.length && !(cycle.sessions || []).some((session) =>
        quickOutcomes.includes(session.conversationState?.quickCheckinOutcome)
      )) return false;
      if (completion === "completed" && cycle.status !== "closed") return false;
      if (completion === "pending" && cycle.status === "closed") return false;
      return cycleInRange(cycle, range);
    });
  }, [workspace, cycleTypes, quickOutcomes, completion, range]);

  const selectedCycle = cycles.find((cycle) => cycle.id === cycleId) || cycles[0] || null;
  const selectedIsQuickCheckin = selectedCycle?.cycleType === "quick_checkin";

  // A filter can hide the cycle currently being read. Move to the newest one
  // still in range, so the conversation below always matches the filters above.
  useEffect(() => {
    if (loading || !workspace) return;
    if (!cycles.length) {
      if (cycleId) { setCycleId(""); setSessionId(""); setMessages([]); }
      return;
    }
    if (!cycles.some((cycle) => cycle.id === cycleId)) selectCycle(cycles[0].id);
  }, [cycles, cycleId, loading, workspace]);
  const cycleSessions = selectedCycle ? selectedCycle.sessions || [] : [];
  const workspacePocs = workspace?.pocs || [];
  const cyclePocIds = new Set(cycleSessions.map((session) => session.clientPocId));
  const feedbackPocOptions = workspacePocs.filter((poc) => cyclePocIds.has(poc.id));
  const feedbackSessions = feedbackPocId
    ? cycleSessions.filter((session) => session.clientPocId === feedbackPocId)
    : cycleSessions;

  useEffect(() => {
    if (!feedbackPocId || feedbackPocOptions.some((poc) => poc.id === feedbackPocId)) return;
    setFeedbackPocId("");
  }, [feedbackPocId, feedbackPocOptions]);

  const selectedSession = feedbackSessions.find((session) => session.id === sessionId) || feedbackSessions[0] || null;
  const selectedSessionClosed = Boolean(selectedSession && (
    selectedCycle?.status === "closed"
    || ["completed", "opted_out"].includes(selectedSession.status)
    || ["completed", "opted_out", "handed_off"].includes(selectedSession.conversationState?.state)
    || selectedSession.conversationState?.reminderExhausted
  ));
  const actionPocs = (workspace?.pocs || []).filter((poc) => selectedActionPocIds.includes(poc.id));
  const actionPocIdSet = new Set(actionPocs.map((poc) => poc.id));
  const selectedCycleSessions = cycleSessions.filter((session) => actionPocIdSet.has(session.clientPocId));
  const reminderTargets = selectedCycleSessions.filter(sessionCanReceiveReminder);
  const stoppableTargets = selectedCycleSessions.filter(sessionCanBeStopped);
  const finalResponseWindowActive = selectedCycleSessions.some((session) => {
    const state = session.conversationState || {};
    return !["completed", "opted_out", "handed_off"].includes(state.state)
      && !state.reminderExhausted
      && !state.stoppedByAdmin
      && (Number(session.reminderCount) || 0) >= 3;
  });

  function toggleActionPoc(pocId) {
    setSelectedActionPocIds((current) => (
      current.includes(pocId)
        ? current.filter((id) => id !== pocId)
        : [...current, pocId]
    ));
  }

  async function selectCycle(id) {
    setCycleId(id);
    const cycle = cycles.find((item) => item.id === id);
    const sessions = cycle ? (cycle.sessions || []) : [];
    const matchingPocSession = feedbackPocId
      ? sessions.find((item) => item.clientPocId === feedbackPocId) || null
      : null;
    if (feedbackPocId && !matchingPocSession) setFeedbackPocId("");
    const first = matchingPocSession || sessions[0] || null;
    setSessionId(first ? first.id : "");
    await loadConversation(first?.id || "");
  }

  async function selectSession(id) {
    setSessionId(id);
    await loadConversation(id);
  }

  async function selectFeedbackPoc(id) {
    setFeedbackPocId(id);
    if (!id) return;
    const session = cycleSessions.find((item) => item.clientPocId === id) || null;
    if (session) {
      await selectSession(session.id);
    } else {
      setSessionId("");
      setMessages([]);
    }
  }

  function changeCycleTypes(nextCycleTypes) {
    setCycleTypes(nextCycleTypes);
    if (nextCycleTypes.length && !nextCycleTypes.includes("quick_checkin")) setQuickOutcomes([]);
  }

  async function requestFeedback(cycleType) {
    if (!messagingEnabled) { showToast("WhatsApp messaging is paused. Email notifications remain active."); return; }
    const project = workspace?.project;
    if (!project) return;
    const projectEndStarted = Boolean(project.endFeedbackRequestedAt)
      || (workspace?.cycles || []).some((cycle) => cycle.cycleType === "project_end");
    if (cycleType !== "project_end" && projectEndStarted) {
      showToast("Monthly feedback and quick check-ins are closed because project-end feedback has already been sent.");
      return;
    }
    if (!actionPocs.length) { showToast("Select at least one POC first."); return; }
    const unavailable = actionPocs.filter((poc) => !poc.active || !poc.contactWhatsapp);
    if (unavailable.length) {
      showToast(`Cannot send to: ${unavailable.map((poc) => poc.name).join(", ")}. Each selected POC must be active and have a WhatsApp number.`);
      return;
    }
    const label = cycleType === "quick_checkin"
      ? "quick check-in"
      : cycleType === "project_end" ? "project-end" : `${project.feedbackIntervalDays || 30}-day`;
    if (!window.confirm(`Send the ${label} request for ${project.name}?\n\n${actionPocs.length} selected POC(s): ${actionPocs.map((poc) => poc.name).join(", ")}`)) return;
    setBulkAction(cycleType);
    try {
      const data = await apiPost(`/api/projects/${encodeURIComponent(project.key)}/request-feedback`, {
        cycleType,
        clientPocIds: actionPocs.map((poc) => poc.id)
      });
      showToast(`Cycle started for ${data.dispatched.length} POC(s).`);
      await loadWorkspace(project.key);
      onReload();
    } catch (requestError) {
      showToast(requestError.message);
    } finally {
      setBulkAction("");
    }
  }

  async function changeAutomaticSending(field, enabled) {
    const project = workspace?.project;
    if (!project || automationSaving) return;
    const isFeedback = field === "automaticFeedbackEnabled";
    const label = isFeedback
      ? `automatic ${project.feedbackIntervalDays || 30}-day feedback`
      : "automatic quick check-ins";
    const effect = enabled
      ? isFeedback
        ? `The next automatic cycle will be scheduled ${project.feedbackIntervalDays || 30} days from now. Missed cycles will not be sent.`
        : "The project will be eligible on the next 11th or 21st. Missed check-ins will not be sent."
      : "Future automatic sends will stop. Existing cycles and conversations will continue, and manual send buttons will remain available.";
    if (!window.confirm(`${enabled ? "Turn on" : "Turn off"} ${label} for ${project.name}?\n\n${effect}\n\nPOC status and influence percentages will not change.`)) return;

    setAutomationSaving(field);
    try {
      const data = await apiPut(`/api/projects/${encodeURIComponent(project.key)}/automation-settings`, {
        [field]: enabled
      });
      setWorkspace((current) => current ? { ...current, project: data.project } : current);
      showToast(data.message || "Automatic sending setting updated.");
      await onReload?.();
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setAutomationSaving("");
    }
  }

  async function sendReminder() {
    if (!messagingEnabled) { showToast("WhatsApp messaging is paused. Email notifications remain active."); return; }
    if (!actionPocs.length) {
      showToast("Select at least one POC first.");
      return;
    }
    if (!selectedCycle) {
      showToast("Select a feedback cycle first.");
      return;
    }
    if (!reminderTargets.length) {
      showToast(finalResponseWindowActive
        ? "The selected POC(s) have used all 3 reminders and are in the final 24-hour response window."
        : "None of the selected POCs has an eligible open session in this cycle.");
      return;
    }
    const skipped = actionPocs.length - reminderTargets.length;
    const lines = reminderTargets.map((target) => `${target.pocName || "POC"}: reminder ${(Number(target.reminderCount) || 0) + 1} of 3`);
    if (!window.confirm(
      `Send manual reminders in ${formatCycleType(selectedCycle.cycleType, workspace.project.feedbackIntervalDays)}?\n\n${lines.join("\n")}`
      + (skipped ? `\n\n${skipped} selected POC(s) cannot be reminded in this cycle and will be skipped.` : "")
      + "\n\nEach sent reminder counts toward that POC's limit and starts a new 24-hour response window."
    )) return;
    setBulkAction("reminder");
    try {
      const results = await Promise.allSettled(reminderTargets.map((target) => (
        apiPost(`/api/sessions/${encodeURIComponent(target.id)}/reminder`, {})
      )));
      const sent = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - sent;
      await loadWorkspace(workspace.project.key);
      showToast(`${sent} reminder${sent === 1 ? "" : "s"} queued.${failed ? ` ${failed} could not be sent; refresh and check eligibility.` : ""}`);
    } finally {
      setBulkAction("");
    }
  }

  async function stopSelectedSessions() {
    if (!actionPocs.length) {
      showToast("Select at least one POC first.");
      return;
    }
    if (!selectedCycle) {
      showToast("Select a feedback cycle first.");
      return;
    }
    if (!stoppableTargets.length) {
      showToast("None of the selected POCs has an open feedback session that can be stopped in this cycle.");
      return;
    }
    const cycleLabel = selectedCycle
      ? `${formatCycleType(selectedCycle.cycleType, workspace.project.feedbackIntervalDays)} started ${formatDate(selectedCycle.startedAt)}`
      : "this cycle";
    const skipped = actionPocs.length - stoppableTargets.length;
    if (!window.confirm(
      `Stop feedback for ${stoppableTargets.length} selected POC(s) in ${cycleLabel}?\n\n`
      + `${stoppableTargets.map((session) => session.pocName || "POC").join(", ")}`
      + (skipped ? `\n\n${skipped} selected POC(s) already closed or have no session in this cycle and will be skipped.` : "")
      + "\n\nPending reminders will be cancelled. Existing feedback is preserved and future cycles are unaffected."
    )) return;

    setBulkAction("stop");
    try {
      const results = await Promise.allSettled(stoppableTargets.map((session) => (
        apiPost(`/api/sessions/${encodeURIComponent(session.id)}/stop`, {})
      )));
      const stopped = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - stopped;
      await loadWorkspace(workspace.project.key);
      onReload();
      showToast(`${stopped} POC session${stopped === 1 ? "" : "s"} stopped.${failed ? ` ${failed} could not be stopped; refresh and check status.` : ""}`);
    } finally {
      setBulkAction("");
    }
  }

  // Scoring can fail when the model is rate-limited. This runs it later, and
  // is idempotent — a session that already has a score is left alone, so the
  // same conversation can never produce two different numbers.
  async function scoreSession() {
    if (!selectedSession) return;
    setScoring(true);
    try {
      const result = await apiPost(`/api/sessions/${encodeURIComponent(selectedSession.id)}/score`, {});
      showToast(
        result.unscored
          ? result.reason
          : result.alreadyScored
            ? result.reason
            : selectedSessionClosed
              ? "Conversation scored. The completed session and closed cycle remain unchanged."
              : "Conversation scored. This POC's feedback session remains open."
      );
      await loadWorkspace(workspace.project.key);
      onReload();
    } catch (scoreError) {
      showToast(scoreError.message);
    } finally {
      setScoring(false);
    }
  }

  async function sendManualWhatsappMessage() {
    if (!selectedSession) return;
    const text = manualWhatsappText.trim();
    if (!text) {
      showToast("Write a WhatsApp message first.");
      return;
    }
    const targetPoc = (workspace?.pocs || []).find((item) => item.id === selectedSession.clientPocId);
    if (!targetPoc) {
      showToast("The selected client POC could not be found.");
      return;
    }
    if (!window.confirm(
      `Send this WhatsApp message to ${targetPoc.name}?\n\n${text}\n\nThis will be sent immediately and stored in this conversation.`
    )) return;

    setManualWhatsappSending(true);
    try {
      const requestId = globalThis.crypto?.randomUUID?.()
        || `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await apiPost(
        `/api/sessions/${encodeURIComponent(selectedSession.id)}/manual-whatsapp-message`,
        { text, requestId }
      );
      setManualWhatsappText("");
      const nextMessages = await loadMessages(selectedSession.id);
      setMessages(nextMessages);
      showToast(`WhatsApp message sent to ${targetPoc.name}.`);
    } catch (sendError) {
      showToast(sendError.message);
    } finally {
      setManualWhatsappSending(false);
    }
  }

  async function updateIssue(note) {
    if (!issueModal) return;
    try {
      await apiPost(`/api/issues/${encodeURIComponent(issueModal.issueId)}/${issueModal.action}`, { note, actorName: "SRV Team" });
      showToast(issueModal.action === "close" ? "Issue closed." : "Issue reopened.");
      setIssueModal(null);
      await loadWorkspace(workspace.project.key);
      onReload();
    } catch (issueError) {
      showToast(issueError.message);
    }
  }

  if (error) {
    return (
      <div className="error-block">
        <strong>Could not load this project</strong>
        <p>{error.message}</p>
        <Button icon={RefreshCw} variant="primary" onClick={() => loadWorkspace(projectKey)}>Try again</Button>
      </div>
    );
  }
  if (loading || (workspace?.project?.key && workspace.project.key !== projectKey)) {
    return <LoadingBlock label="Loading project workspace" />;
  }
  if (!workspace?.project) return <EmptyState title="No project selected" text="Choose a project from the filter above." />;

  const { project } = workspace;
  const pocs = workspacePocs;
  const services = workspace.services || [];
  const issues = workspace.issues || [];
  // The table shows the SAME cycles as the dropdown. It previously read the
  // unfiltered list, so a date range changed the dropdown and left the table
  // showing everything — the two disagreed about the same project.
  const allCycles = workspace.cycles || [];
  const projectEndFeedbackLocked = Boolean(project.endFeedbackRequestedAt)
    || allCycles.some((cycle) => cycle.cycleType === "project_end");
  const canManageAutomaticSending = hasPermission(currentUser, "messaging_controls");
  const automaticFeedbackOn = !projectEndFeedbackLocked && project.automaticFeedbackEnabled !== false;
  const automaticQuickCheckinOn = !projectEndFeedbackLocked && project.automaticQuickCheckinEnabled !== false;
  // Feedback with no owner and no SLA: billing, a named person, a process.
  // It cannot be an issue, but dropping it loses real feedback — a client told
  // us his invoices were wrong and it went nowhere.
  // Observations and appreciations belong to the PROJECT, not to one cycle.
  // Scoping them to the selected cycle made a client's billing complaint
  // disappear the moment you looked at a different month.
  const cycleSessionIdSet = new Set(cycleSessions.map((item) => item.id));
  const cyclePocIdSet = new Set(cycleSessions.map((item) => item.clientPocId));
  const cycleWeightPocs = pocs.filter((poc) => cyclePocIdSet.has(poc.id));
  const scopeToCycle = Boolean(selectedCycle) && !showAllFeedback;
  const inScope = (item) => !scopeToCycle || cycleSessionIdSet.has(item.sessionId);
  const matchesPoc = (item) => !feedbackPocId || item.clientPocId === feedbackPocId;
  const pocNameById = new Map(pocs.map((poc) => [poc.id, poc.name]));

  const observations = (workspace.observations || [])
    .filter((item) => item.sentiment !== "positive")
    .filter(inScope)
    .filter(matchesPoc);

  // Praise deserves the same visibility as a complaint. It arrives two ways:
  // as positive sentiment on a service, and as a positive observation about
  // something we do not own as a service ("fantastic job with the videos").
  const observationAppreciations = (workspace.observations || [])
      .filter((item) => item.sentiment === "positive")
      .filter((item) => readsAsExplicitAppreciation(`${item.topic || ""} ${item.detail || ""}`))
      .filter(inScope)
      .filter(matchesPoc)
      .map((item) => ({
        key: `obs-${item.id}`,
        subject: item.topic,
        detail: item.detail,
        when: item.createdAt,
        clientPocId: item.clientPocId,
        pocName: pocNameById.get(item.clientPocId) || "Unknown POC"
      }));
  const appreciationSessions = scopeToCycle ? cycleSessions : (workspace.sessions || []);
  const serviceAppreciations = appreciationSessions
    .filter((session) => !feedbackPocId || session.clientPocId === feedbackPocId)
    .flatMap((session) => Object.values(session.conversationState?.mentionedServices || {})
      // A sentiment flag alone is not enough. "Designs look like the 1990s"
      // was shown under Appreciations because the service happened to be
      // marked positive — praise has to actually read as praise.
      .filter((svc) => svc.explicitAppreciation === true
        && svc.reasonText && !readsAsComplaint(svc.reasonText)
        && readsAsExplicitAppreciation(svc.reasonText))
      .filter((svc) => !observationAppreciations.some((item) => isSamePoint(item.detail, svc.reasonText)))
      .map((svc) => ({
        key: `svc-${session.id}-${svc.serviceKey}`,
        subject: svc.serviceName,
        detail: svc.reasonText,
        when: session.completedAt || session.startedAt,
        clientPocId: session.clientPocId,
        pocName: session.pocName || pocNameById.get(session.clientPocId) || "Unknown POC"
      })));
  const appreciations = [...observationAppreciations, ...serviceAppreciations];

  // NPS is a proportion, so the number is meaningless without knowing how many
  // people it came from: one respondent can only ever produce -100, 0 or +100.
  // Both figures, side by side. A predicted score must never be presented as
  // one the client gave — and where the two disagree, that gap is the most
  // interesting thing on this page.
  // The stated card was blank for a completed cycle: csatSource lives on the
  // session, so with a cycle selected and no session picked it fell through to
  // the cycle score and then got hidden. Read the session where there is one,
  // and fall back to the cycle otherwise.
  const sessionForScore = selectedSession
    || (cycleSessions.length === 1 ? cycleSessions[0] : null);
  const selectedPocStatedScore = sessionForScore
    ? (sessionForScore.csatSource === "predicted" ? null : sessionForScore.csatScore)
    : null;
  const statedScore = selectedCycle ? selectedCycle.csatScore : project.csatScore;
  const predictedScore = sessionForScore ? sessionForScore.predictedCsat : null;
  const scoreGap = selectedPocStatedScore !== null && selectedPocStatedScore !== undefined
    && predictedScore !== null && predictedScore !== undefined
    ? Math.abs(Number(selectedPocStatedScore) - Number(predictedScore))
    : null;

  const npsResponses = (selectedCycle
    ? cycleSessions
    : allCycles.flatMap((cycle) => cycle.sessions || [])
  ).filter((item) => item.npsScore !== null && item.npsScore !== undefined).length;
  const cycleFiltersActive = Boolean(range.from || range.to || cycleTypes.length || quickOutcomes.length || completion);
  const selectedConversationPoc = selectedSession
    ? pocs.find((poc) => poc.id === selectedSession.clientPocId) || null
    : null;
  const latestClientMessage = [...messages].reverse().find((message) => message.side === "client");
  const latestClientAt = Date.parse(latestClientMessage?.createdAt || selectedSession?.lastClientResponseAt || "");
  const whatsappWindowOpen = Number.isFinite(latestClientAt)
    && Date.now() - latestClientAt < 24 * 60 * 60 * 1000;
  const manualWhatsappBlockedReason = !messagingEnabled
    ? "WhatsApp messaging is paused from the Dashboard. Email notifications remain active."
    : !selectedSession
    ? "Select a POC conversation first."
    : !selectedConversationPoc?.contactWhatsapp
      ? "This POC has no WhatsApp number."
      : selectedConversationPoc.active === false
        ? "This POC is inactive."
        : selectedSession.conversationState?.optedOut
          || selectedSession.conversationState?.handoffReason === "wrong_person"
          ? "Messaging is blocked because the client opted out or the number was identified as the wrong person."
          : !whatsappWindowOpen
            ? "Free-text WhatsApp replies are available for 24 hours after the client's latest message. Send an approved template first if this window has closed."
            : "";

  // project_services.score is the LAST KNOWN score across all time, so a cycle
  // where only SEO was rated still showed stale numbers for every other
  // service. service_feedback is per session, so this is cycle-accurate.
  const cycleServices = (selectedCycle && workspace.serviceFeedbackByCycle
    ? workspace.serviceFeedbackByCycle[selectedCycle.id]
    : null) || [];

  // Issues belong to a session, and a session to a cycle, so selecting a cycle
  // scopes the list. "Show all" brings back the project's full history.
  const cycleSessionIds = new Set(cycleSessions.map((item) => item.id));

  // Two independent narrowings. The cycle scope answers "what came out of this
  // conversation"; the date range is a page-level filter and applies even with
  // "show all" on, or picking dates would silently do nothing here.
  const inDateRange = (issue) => {
    if (!range.from && !range.to) return true;
    const raised = String(issue.createdAt || "").slice(0, 10);
    if (!raised) return false;
    if (range.from && raised < range.from) return false;
    if (range.to && raised > range.to) return false;
    return true;
  };

  const scopedIssues = (selectedCycle && !showAllIssues
    ? issues.filter((issue) => cycleSessionIds.has(issue.sessionId))
    : issues
  ).filter(inDateRange).filter(matchesPoc);

  const openIssues = scopedIssues.filter((issue) => issue.status !== "closed");
  const closedIssues = scopedIssues.filter((issue) => issue.status === "closed");
  const intervalLabel = `${project.feedbackIntervalDays || 30}-day`;
  const quickOutcomeCounts = cycleSessions.reduce((counts, session) => {
    const outcome = session.conversationState?.quickCheckinOutcome || "awaiting_response";
    counts[outcome] = (counts[outcome] || 0) + 1;
    return counts;
  }, {});
  const quickResponses = cycleSessions.filter((session) => Boolean(session.lastClientResponseAt)).length;
  const filtersActive = Boolean(cycleTypes.length || quickOutcomes.length || completion || range.from || range.to || feedbackPocId);

  async function buildProjectReport() {
    const reportSessions = cycles.flatMap((cycle) => (cycle.sessions || [])
      .filter((session) => !feedbackPocId || session.clientPocId === feedbackPocId)
      .map((session) => ({ ...session, reportCycle: cycle })));
    const conversationGroups = await Promise.all(reportSessions.map(async (session) => ({
      session,
      messages: await loadMessages(session.id)
    })));
    const reportPocs = feedbackPocId ? pocs.filter((poc) => poc.id === feedbackPocId) : pocs;
    const cycleServiceRows = cycles.flatMap((cycle) => (
      workspace.serviceFeedbackByCycle?.[cycle.id] || []
    ).map((service) => ({
      cycle: formatCycleType(cycle.cycleType, project.feedbackIntervalDays),
      cycleStarted: formatDate(cycle.startedAt),
      service: service.serviceName || service.name || service.serviceKey,
      score: service.score,
      source: service.source === "predicted" ? "Read from chat" : "Client rating",
      owner: services.find((item) => item.serviceKey === service.serviceKey)?.managerName
        || services.find((item) => item.serviceKey === service.serviceKey)?.ownerName
        || "Not set"
    })));
    const serviceRows = cycleServiceRows.length ? cycleServiceRows : services.map((service) => ({
      cycle: "Latest known",
      cycleStarted: "--",
      service: service.name,
      score: service.score,
      source: service.score === null || service.score === undefined ? "Not scored" : "Latest recorded",
      owner: service.managerName || service.ownerName || "Not set"
    }));
    const filterText = (values, fallback = "All") => values.length ? values.map((value) => (
      value === "pulse" || value === "project_end" || value === "quick_checkin"
        ? formatCycleType(value, project.feedbackIntervalDays)
        : value
    )).join(", ") : fallback;

    return {
      title: `${project.name} CSAT report`,
      subtitle: `${project.clientName || "Client"} · ${project.clusterName || "No cluster"} · Client / POC / Service detail`,
      generatedAt: new Date().toISOString(),
      filters: [
        { label: "Cluster", value: project.clusterName || "No cluster" },
        { label: "Client", value: project.clientName || "--" },
        { label: "Project", value: project.name },
        { label: "Cycle type", value: filterText(cycleTypes) },
        { label: "Quick check-in result", value: filterText(quickOutcomes) },
        { label: "Completion", value: completion || "Any completion" },
        { label: "Date range", value: range.from || range.to ? `${range.from || "Any"} to ${range.to || "Any"}` : "All dates" },
        { label: "Feedback by", value: feedbackPocId ? pocs.find((poc) => poc.id === feedbackPocId)?.name || "Selected POC" : "All POCs" }
      ],
      metrics: [
        { label: selectedCycle ? "Selected cycle CSAT" : "Latest CSAT", value: formatScore(statedScore) },
        { label: "Predicted CSAT", value: formatScore(predictedScore) },
        { label: "NPS", value: formatNps(selectedCycle ? selectedCycle.npsScore : project.npsScore) },
        { label: "Active POCs", value: pocs.filter((poc) => poc.active !== false).length },
        { label: "Filtered cycles", value: cycles.length },
        { label: "Open issues", value: openIssues.length }
      ],
      sections: [
        {
          title: "Project details",
          sheetName: "Project",
          columns: [
            { key: "client", label: "Client", width: 24 },
            { key: "project", label: "Project", width: 28 },
            { key: "projectId", label: "Project ID", width: 22 },
            { key: "status", label: "Status", width: 12 },
            { key: "start", label: "Start", width: 14 },
            { key: "end", label: "End", width: 14 },
            { key: "interval", label: "Cycle interval", width: 16 },
            { key: "nextDue", label: "Next pulse due", width: 16 },
            { key: "csat", label: "Latest CSAT", width: 12, numberFormat: "0.0" },
            { key: "risk", label: "Risk", width: 12 }
          ],
          rows: [{
            client: project.clientName || "--",
            project: project.name,
            projectId: project.key,
            status: project.activeStatus,
            start: formatDate(project.startDate),
            end: formatDate(project.endDate),
            interval: `${project.feedbackIntervalDays || 30} days`,
            nextDue: formatDate(project.nextCycleDueAt),
            csat: project.csatScore,
            risk: project.riskLevel || "Not scored"
          }]
        },
        {
          title: "Client POCs",
          sheetName: "Client POCs",
          columns: [
            { key: "name", label: "POC", width: 24 },
            { key: "designation", label: "Designation", width: 24 },
            { key: "whatsapp", label: "WhatsApp", width: 18 },
            { key: "email", label: "Email", width: 28 },
            { key: "status", label: "Status", width: 12 },
            { key: "level", label: "Level", width: 14 },
            { key: "influence", label: "Influence", width: 12 }
          ],
          rows: reportPocs.map((poc) => ({
            name: poc.name,
            designation: poc.designation || "--",
            whatsapp: poc.contactWhatsapp || "--",
            email: poc.contactEmail || "--",
            status: poc.active === false ? "Inactive" : "Active",
            level: formatPocLevel(poc),
            influence: `${Number(poc.weightPercentage) || 0}%`
          }))
        },
        {
          title: "Service feedback",
          sheetName: "Service feedback",
          note: cycleServiceRows.length ? "Scores captured in cycles matching the current workspace filters." : "Latest known project service scores.",
          columns: [
            { key: "cycle", label: "Cycle", width: 20 },
            { key: "cycleStarted", label: "Cycle started", width: 14 },
            { key: "service", label: "Service", width: 26 },
            { key: "score", label: "Score", width: 10, numberFormat: "0.0" },
            { key: "source", label: "Score source", width: 18 },
            { key: "owner", label: "Internal owner", width: 26 }
          ],
          rows: serviceRows
        },
        {
          title: "Feedback cycles",
          sheetName: "Feedback cycles",
          columns: [
            { key: "cycle", label: "Cycle", width: 22 },
            { key: "started", label: "Started", width: 18 },
            { key: "closed", label: "Closed", width: 18 },
            { key: "status", label: "Status", width: 14 },
            { key: "pocs", label: "POCs", width: 10 },
            { key: "responded", label: "Responded", width: 12 },
            { key: "csat", label: "CSAT", width: 10, numberFormat: "0.0" },
            { key: "nps", label: "NPS", width: 10, numberFormat: "0.0" }
          ],
          rows: cycles.map((cycle) => ({
            cycle: formatCycleType(cycle.cycleType, project.feedbackIntervalDays),
            started: formatDateTime(cycle.startedAt),
            closed: cycle.closedAt ? formatDateTime(cycle.closedAt) : "Open",
            status: formatCycleStatus(cycle),
            pocs: cycle.pocTotal || (cycle.sessions || []).length,
            responded: cycle.pocResponded || (cycle.sessions || []).filter((session) => session.lastClientResponseAt).length,
            csat: cycle.csatScore,
            nps: cycle.npsScore
          }))
        },
        {
          title: "POC session outcomes",
          sheetName: "POC sessions",
          columns: [
            { key: "cycle", label: "Cycle", width: 20 },
            { key: "poc", label: "POC", width: 24 },
            { key: "outcome", label: "Outcome", width: 22 },
            { key: "started", label: "Started", width: 18 },
            { key: "completed", label: "Completed", width: 18 },
            { key: "reminders", label: "Reminders", width: 12 },
            { key: "statedCsat", label: "Stated CSAT", width: 12, numberFormat: "0.0" },
            { key: "predictedCsat", label: "Predicted CSAT", width: 14, numberFormat: "0.0" },
            { key: "nps", label: "NPS", width: 10, numberFormat: "0.0" }
          ],
          rows: reportSessions.map((session) => ({
            cycle: formatCycleType(session.reportCycle.cycleType, project.feedbackIntervalDays),
            poc: session.pocName || pocNameById.get(session.clientPocId) || "--",
            outcome: formatSessionOutcome(session),
            started: formatDateTime(session.startedAt),
            completed: session.completedAt ? formatDateTime(session.completedAt) : "--",
            reminders: Number(session.reminderCount) || 0,
            statedCsat: session.csatSource === "predicted" ? null : session.csatScore,
            predictedCsat: session.predictedCsat,
            nps: session.npsScore
          }))
        },
        {
          title: "Issues",
          sheetName: "Issues",
          columns: [
            { key: "status", label: "Status", width: 12 },
            { key: "service", label: "Service", width: 22 },
            { key: "issue", label: "Issue", width: 50 },
            { key: "rootCause", label: "Root cause / detail", width: 50 },
            { key: "severity", label: "Severity", width: 12 },
            { key: "raisedBy", label: "Raised by", width: 22 },
            { key: "raised", label: "Raised", width: 18 },
            { key: "closed", label: "Closed", width: 18 },
            { key: "resolution", label: "Resolution note", width: 45 }
          ],
          rows: scopedIssues.map((issue) => ({
            status: issue.status || "open",
            service: issue.serviceName || "--",
            issue: issue.title,
            rootCause: issue.rootCause && !isSameText(issue.rootCause, issue.title) ? issue.rootCause : "--",
            severity: issue.severity || "--",
            raisedBy: pocNameById.get(issue.clientPocId) || "Unknown POC",
            raised: formatDateTime(issue.createdAt),
            closed: issue.closedAt ? formatDateTime(issue.closedAt) : "--",
            resolution: issue.resolutionNote || "--"
          }))
        },
        {
          title: "Appreciations",
          sheetName: "Appreciations",
          columns: [
            { key: "subject", label: "Subject", width: 26 },
            { key: "poc", label: "POC", width: 22 },
            { key: "when", label: "Date", width: 18 },
            { key: "detail", label: "Appreciation", width: 70 }
          ],
          rows: appreciations.map((item) => ({
            subject: item.subject,
            poc: item.pocName,
            when: item.when ? formatDateTime(item.when) : "--",
            detail: item.detail
          }))
        },
        {
          title: "Other feedback",
          sheetName: "Other feedback",
          columns: [
            { key: "topic", label: "Topic", width: 26 },
            { key: "poc", label: "POC", width: 22 },
            { key: "sentiment", label: "Sentiment", width: 14 },
            { key: "when", label: "Date", width: 18 },
            { key: "detail", label: "Feedback", width: 70 }
          ],
          rows: observations.map((item) => ({
            topic: item.topic,
            poc: pocNameById.get(item.clientPocId) || "Unknown POC",
            sentiment: item.sentiment || "neutral",
            when: formatDateTime(item.createdAt),
            detail: item.detail
          }))
        },
        {
          title: "Conversation transcripts",
          sheetName: "Conversations",
          note: "Saved WhatsApp messages for every POC session matching the current cycle, date and POC filters.",
          columns: [
            { key: "cycle", label: "Cycle", width: 20 },
            { key: "poc", label: "POC", width: 22 },
            { key: "time", label: "Time", width: 20 },
            { key: "side", label: "Side", width: 12 },
            { key: "speaker", label: "Speaker", width: 24 },
            { key: "message", label: "Message", width: 85 },
            { key: "interpretation", label: "Interpretation", width: 24 }
          ],
          rows: conversationGroups.flatMap(({ session, messages: sessionMessages }) => sessionMessages.map((message) => ({
            cycle: formatCycleType(session.reportCycle.cycleType, project.feedbackIntervalDays),
            poc: session.pocName || pocNameById.get(session.clientPocId) || "--",
            time: formatDateTime(message.createdAt),
            side: message.side === "client" ? "Client" : "SRV",
            speaker: message.speaker || "Unknown",
            message: message.body || "",
            interpretation: [
              message.metadata?.interpretedIntent ? `Read as ${message.metadata.interpretedIntent}` : "",
              message.metadata?.manualOutbound ? "Sent manually" : "",
              message.metadata?.fallbackReason || ""
            ].filter(Boolean).join(" · ") || "--"
          })))
        }
      ]
    };
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h2>Project workspace</h2>
          <p className="topbar-sub">{project.clientName || "Client"} · {project.clusterName || "No cluster"} · {project.name}</p>
        </div>
        <div className="button-row workspace-controls">
          <ReportDownloads
            getReport={buildProjectReport}
            fileName={`csat-${project.key}-${new Date().toISOString().slice(0, 10)}`}
            onError={showToast}
          />
          <Button icon={RefreshCw} onClick={() => loadWorkspace(project.key)}>Refresh</Button>
        </div>
      </div>

      <FilterBar
        showReset={filtersActive}
        onReset={() => { setCycleTypes([]); setQuickOutcomes([]); setCompletion(""); setFeedbackPocId(""); setRange({ from: "", to: "", basis: "started" }); }}
      >
        <SingleSelect label="Cluster" value={cluster} placeholder="" allowClear={false} onChange={selectCluster}
          options={[...new Set(allProjects.map((item) => item.clusterName).filter(Boolean))].sort()
            .map((name) => ({ value: name, label: name }))} />
        <SingleSelect label="Client" value={client} placeholder="" allowClear={false} onChange={selectClient}
          options={[...new Set(clusterProjects.map((item) => item.clientName).filter(Boolean))].sort()
            .map((name) => ({ value: name, label: name }))} />
        <SingleSelect label="Project" value={project.key} placeholder="" allowClear={false} onChange={pushProject}
          options={selectableProjects.map((item) => ({ value: item.key, label: item.name }))} />
        <SingleSelect label="Cycle" value={selectedCycle ? selectedCycle.id : ""} placeholder={cycles.length ? "" : "No cycle"} allowClear={false}
          onChange={selectCycle}
          options={cycles.map((cycle) => ({
            value: cycle.id,
            label: `${formatCycleType(cycle.cycleType, project.feedbackIntervalDays)} · ${formatDate(cycle.startedAt)}${cycle.status === "closed" ? " · closed" : ""}`
          }))} />
        <MultiSelect label="Cycle type" allLabel="All types" selected={cycleTypes} onChange={changeCycleTypes}
          options={["pulse", "project_end", "quick_checkin"]}
          renderOption={(value) => formatCycleType(value, project.feedbackIntervalDays)} />
        <MultiSelect label="Quick check-in result" allLabel="All results" selected={quickOutcomes} onChange={setQuickOutcomes}
          options={QUICK_CHECKIN_OUTCOMES.map((option) => option.value)}
          renderOption={(value) => QUICK_CHECKIN_OUTCOMES.find((option) => option.value === value)?.label || value} />
        <SingleSelect label="Completion" value={completion} placeholder="" onChange={setCompletion}
          options={COMPLETION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />
        <DateRange range={range} onChange={setRange} />
        <SingleSelect label="Feedback by" value={feedbackPocId} placeholder="All POCs" onChange={selectFeedbackPoc}
          options={feedbackPocOptions.map((poc) => ({ value: poc.id, label: poc.name }))} />
      </FilterBar>

      {(range.from || range.to || cycleTypes.length || quickOutcomes.length || completion) && !cycles.length ? (
        <div className="filter-empty-note">
          No cycle on this project matches these filters. Clear them to see the full history.
        </div>
      ) : null}

      <ProjectConfiguration
        workspace={workspace}
        currentUser={currentUser}
        onRefresh={() => loadWorkspace(project.key)}
        onReload={onReload}
        showToast={showToast}
      />

      <section className="project-automation-controls" aria-labelledby="project-automation-title">
        <div className="project-automation-heading">
          <div>
            <span className="eyebrow">Project sending controls</span>
            <h3 id="project-automation-title">Automatic feedback delivery</h3>
          </div>
          <span className="project-automation-note">Manual send buttons remain available when automatic sending is off.</span>
        </div>
        <div className="project-automation-grid">
          <article className={`project-automation-card ${automaticFeedbackOn ? "on" : "off"}`}>
            <div className="project-automation-copy">
              <Power size={20} aria-hidden="true" />
              <div>
                <strong>Automatic {project.feedbackIntervalDays || 30}-Day Feedback</strong>
                <span>{projectEndFeedbackLocked
                  ? "Closed after project-end feedback"
                  : automaticFeedbackOn ? `Next due ${formatDate(project.nextCycleDueAt)}` : "Automatic sending off"}</span>
              </div>
            </div>
            <button
              type="button"
              className={`automation-toggle ${automaticFeedbackOn ? "on" : "off"}`}
              onClick={() => changeAutomaticSending("automaticFeedbackEnabled", project.automaticFeedbackEnabled === false)}
              disabled={!canManageAutomaticSending || projectEndFeedbackLocked || Boolean(automationSaving)}
              aria-pressed={automaticFeedbackOn}
              title={!canManageAutomaticSending
                ? "Only an Admin or Super Admin with Messaging controls can change this setting."
                : projectEndFeedbackLocked ? "Project-end feedback has already closed recurring feedback." : undefined}
            >
              {automationSaving === "automaticFeedbackEnabled" ? "Saving…" : projectEndFeedbackLocked ? "CLOSED" : automaticFeedbackOn ? "ON" : "OFF"}
            </button>
          </article>
          <article className={`project-automation-card ${automaticQuickCheckinOn ? "on" : "off"}`}>
            <div className="project-automation-copy">
              <Power size={20} aria-hidden="true" />
              <div>
                <strong>Automatic Quick Check-ins</strong>
                <span>{projectEndFeedbackLocked
                  ? "Closed after project-end feedback"
                  : automaticQuickCheckinOn ? "Next eligible 11th or 21st" : "Automatic sending off"}</span>
              </div>
            </div>
            <button
              type="button"
              className={`automation-toggle ${automaticQuickCheckinOn ? "on" : "off"}`}
              onClick={() => changeAutomaticSending("automaticQuickCheckinEnabled", project.automaticQuickCheckinEnabled === false)}
              disabled={!canManageAutomaticSending || projectEndFeedbackLocked || Boolean(automationSaving)}
              aria-pressed={automaticQuickCheckinOn}
              title={!canManageAutomaticSending
                ? "Only an Admin or Super Admin with Messaging controls can change this setting."
                : projectEndFeedbackLocked ? "Project-end feedback has already closed recurring feedback." : undefined}
            >
              {automationSaving === "automaticQuickCheckinEnabled" ? "Saving…" : projectEndFeedbackLocked ? "CLOSED" : automaticQuickCheckinOn ? "ON" : "OFF"}
            </button>
          </article>
        </div>
        {projectEndFeedbackLocked ? (
          <p className="project-automation-locked">Project-end feedback has already been sent, so recurring automatic delivery stays closed.</p>
        ) : null}
      </section>

      <div className="metric-row">
        <MetricCard
          label={selectedIsQuickCheckin ? "Responses" : selectedCycle ? "Cycle CSAT (weighted)" : "Latest CSAT (weighted)"}
          value={selectedIsQuickCheckin ? `${quickResponses} / ${cycleSessions.length}` : formatScore(statedScore)}
          caption={selectedIsQuickCheckin
            ? "quick check-in replies"
            : statedScore === null || statedScore === undefined
              ? "no rating given"
              : selectedCycle
                ? `${selectedCycle.pocResponded || 0} POC rating(s); configured group percentages applied`
                : "latest weighted project score"}
          tone={selectedIsQuickCheckin ? (quickResponses === cycleSessions.length ? "strong" : "watch") : scoreClass(statedScore)}
        />
        <MetricCard
          label={selectedIsQuickCheckin ? "All good" : "CSAT (predicted)"}
          value={selectedIsQuickCheckin ? (quickOutcomeCounts.all_good || 0) : formatScore(predictedScore)}
          caption={selectedIsQuickCheckin
            ? "closed immediately"
            : predictedScore === null || predictedScore === undefined
              ? "not scored yet"
              : formatConfidence(selectedSession && selectedSession.predictedConfidence)}
          tone={selectedIsQuickCheckin ? "strong" : confidenceClass(selectedSession && selectedSession.predictedConfidence)}
        />
        <MetricCard
          label={selectedIsQuickCheckin ? "Feedback shared" : "NPS"}
          value={selectedIsQuickCheckin ? (quickOutcomeCounts.feedback_shared || 0) : formatNps(selectedCycle ? selectedCycle.npsScore : project.npsScore)}
          tone={selectedIsQuickCheckin ? ((quickOutcomeCounts.feedback_shared || 0) ? "watch" : "neutral") : npsClass(selectedCycle ? selectedCycle.npsScore : project.npsScore)}
          caption={selectedIsQuickCheckin
            ? `${quickOutcomeCounts.needs_improvement || 0} awaiting details`
            : selectedCycle && selectedCycle.cycleType !== "project_end"
              ? "project-end cycles only"
              : npsResponses
                ? formatNpsBasis(npsResponses)
                : "after the project ends"
          }
        />
        <MetricCard label="POCs" value={pocs.filter((poc) => poc.active !== false).length} caption="active contacts" />
        <MetricCard label="Open issues" value={openIssues.length} tone={openIssues.length ? "weak" : "strong"}
          caption="click to view" title="Go to open issues"
          onClick={() => issuesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />
      </div>

      {!selectedIsQuickCheckin && selectedSession && selectedSession.predictedReasoning ? (
        <div className={`prediction-strip ${confidenceClass(selectedSession.predictedConfidence)}`}>
          <div className="prediction-head">
            <strong>How this conversation reads</strong>
            <span>{formatConfidence(selectedSession.predictedConfidence)}</span>
          </div>
          <p>{selectedSession.predictedReasoning}</p>
          {(selectedSession.predictedSignals || []).length ? (
            <div className="signal-row">
              {selectedSession.predictedSignals.map((signal) => (
                <span key={signal} className="signal-chip">{signal}</span>
              ))}
            </div>
          ) : null}
          {scoreGap !== null && scoreGap >= 2 ? (
            <p className="prediction-gap">
              This POC rated it {formatScore(selectedPocStatedScore)}, but the conversation reads
              closer to {formatScore(predictedScore)}.
            </p>
          ) : null}
        </div>
      ) : null}

      {!selectedIsQuickCheckin && selectedSession
        && (selectedSession.predictedCsat === null || selectedSession.predictedCsat === undefined)
        && messages.some((message) => message.side === "client") ? (
          <div className="prediction-strip watch">
            <div className="prediction-head">
              <strong>{selectedSessionClosed ? "This closed conversation has not been scored" : "This conversation has not been scored"}</strong>
              <Button onClick={scoreSession} disabled={scoring}>
                {scoring ? "Scoring…" : selectedSessionClosed ? "Retry scoring" : "Score it now"}
              </Button>
            </div>
            <p>
              {selectedSessionClosed
                ? "Retry the saved conversation. A successful prediction will be added without reopening this POC session or its cycle."
                : "Score the feedback shared so far without ending this POC's session. Greetings, acknowledgements and postponements remain unscored."}
            </p>
          </div>
        ) : null}

      {selectedSession && selectedSession.toneReason ? (
        <div className={`tone-strip ${selectedSession.tone}`}>
          <TonePill tone={selectedSession.tone} reason={selectedSession.toneReason} />
          <span><b>Conversation tone — separate from the stated CSAT:</b> {selectedSession.toneReason}</span>
        </div>
      ) : null}

      <Panel
        title="Schedule and client POCs"
        badge={selectedCycle ? formatCycleCoverage(selectedCycle) : "No cycle yet"}
        className="span-12"
        action={<span className="panel-note">Next pulse due {formatDate(project.nextCycleDueAt)}</span>}
      >
        <div className="schedule-strip">
          <div><span>Project start</span><strong>{formatDate(project.startDate)}</strong></div>
          <div><span>Project end</span><strong>{formatDate(project.endDate)}</strong></div>
          <div><span>Cycle interval</span><strong>{project.feedbackIntervalDays ? `${project.feedbackIntervalDays} days` : "Not set"}</strong></div>
          <div><span>Cycle started</span><strong>{selectedCycle ? formatDate(selectedCycle.startedAt) : "--"}</strong></div>
          <div><span>Cycle end</span><strong>{selectedCycle && selectedCycle.closedAt ? formatDate(selectedCycle.closedAt) : "Open"}</strong></div>
        </div>

        <div className="cycles-table-wrap">
          <p className="subsection-label">
            {cycleFiltersActive
              ? `Cycles in this range (${cycles.length} of ${allCycles.length})`
              : `All cycles on this project (${allCycles.length})`}
          </p>
          <div className="dtable cycles-table">
            <div className="dtable-head">
              <span>Cycle</span>
              <span>Started</span>
              <span>Ended</span>
              <span>CSAT</span>
              <span>Coverage</span>
              <span>Status</span>
            </div>
            {cycles.map((cycle) => (
              <div
                key={cycle.id}
                className={`dtable-row cycle-line ${cycle.id === (selectedCycle && selectedCycle.id) ? "selected" : ""}`}
                role="button"
                tabIndex={0}
                aria-pressed={cycle.id === (selectedCycle && selectedCycle.id)}
                onClick={() => selectCycle(cycle.id)}
                onKeyDown={(event) => { if (event.key === "Enter") selectCycle(cycle.id); }}
              >
                <strong className="cycle-name-cell">
                  {formatCycleType(cycle.cycleType, project.feedbackIntervalDays)}
                  {cycle.id === (selectedCycle && selectedCycle.id) ? (
                    <span className="cycle-selected-mark"><Check size={12} aria-hidden="true" />Selected</span>
                  ) : null}
                </strong>
                <span>{formatDate(cycle.startedAt)}</span>
                <span>{cycle.closedAt ? formatDate(cycle.closedAt) : "--"}</span>
                <b className={scoreClass(cycle.csatScore)}>{formatScore(cycle.csatScore)}</b>
                <span>{formatCycleCoverage(cycle)}</span>
                <span className={cycle.status === "closed" ? "" : "missing"}>
                  {formatCycleStatus(cycle)}
                </span>
              </div>
            ))}
            {!cycles.length ? (
              <EmptyState
                title={cycleFiltersActive ? "No cycle in this range" : "No cycle yet"}
                text={cycleFiltersActive
                  ? "Clear the date range or cycle filters to see the full history."
                  : "Start one with the buttons below, or wait for the schedule."}
              />
            ) : null}
          </div>
        </div>

        <div className="bulk-selection-context">
          <div>
            <CheckCircle2 size={17} aria-hidden="true" />
            <span>
              <b>Selected cycle for reminders and stopping:</b>{" "}
              {selectedCycle
                ? `${formatCycleType(selectedCycle.cycleType, project.feedbackIntervalDays)} · ${formatDate(selectedCycle.startedAt)} · ${formatCycleStatus(selectedCycle)}`
                : "No cycle selected"}
            </span>
          </div>
          <div>
            <Users size={17} aria-hidden="true" />
            <span><b>Selected POCs for manual actions:</b> {actionPocs.length ? actionPocs.map((poc) => poc.name).join(", ") : "None"}</span>
          </div>
        </div>

        <div className="bulk-poc-toolbar">
          <div>
            <strong>Select POCs for manual actions</strong>
            <span>{actionPocs.length} of {pocs.length} selected</span>
          </div>
          <div className="cleanup-select-actions">
            <button type="button" onClick={() => setSelectedActionPocIds(pocs.map((poc) => poc.id))} disabled={!pocs.length}>Select all</button>
            <button type="button" onClick={() => setSelectedActionPocIds([])} disabled={!actionPocs.length}>Clear</button>
          </div>
        </div>

        <div className="poc-grid">
          {pocs.map((poc) => {
            const session = cycleSessions.find((item) => item.clientPocId === poc.id) || null;
            const viewing = session && selectedSession && session.id === selectedSession.id;
            const selectedForAction = selectedActionPocIds.includes(poc.id);
            const reminderCount = Math.max(0, Math.min(3, Number(session?.reminderCount) || 0));
            const cycleIsOpen = selectedCycle && selectedCycle.status !== "closed";
            return (
              <button
                key={poc.id}
                type="button"
                className={`poc-card ${session ? riskClass(session.status) : "neutral"} ${viewing ? "active" : ""} ${selectedForAction ? "bulk-selected" : ""}`}
                onClick={() => {
                  toggleActionPoc(poc.id);
                  if (session) selectSession(session.id);
                }}
                aria-pressed={selectedForAction}
                title={session
                  ? "Click to select or clear this POC for bulk actions and view this cycle's conversation."
                  : "Click to select or clear this POC for a new monthly or project-end send. No session exists in the selected cycle."}
              >
                <div className="poc-card-head">
                  <strong>{poc.name}</strong>
                  <div className="poc-card-badges">
                    {selectedForAction ? <b className="bulk-selected-mark"><Check size={12} aria-hidden="true" />Selected</b> : null}
                    {poc.active === false ? <b className="weight-pill">inactive</b> : null}
                    <b className={`weight-pill ${String(poc.levelName || "").toLowerCase() === "important" ? "important" : ""}`}>{formatPocLevel(poc)}</b>
                  </div>
                </div>
                <span>{poc.designation || "Designation not set"}</span>
                {session && cycleIsOpen && !selectedIsQuickCheckin ? (
                  <div className={`poc-reminder-status ${reminderCount >= 3 ? "exhausted" : ""}`}>
                    <Bell size={13} aria-hidden="true" />
                    <span>Reminders sent</span>
                    <b>{reminderCount} / 3</b>
                  </div>
                ) : null}
                <div className="poc-card-foot">
                  <em>{session ? formatSessionOutcome(session) : "No session in this cycle"}</em>
                  <i className="poc-weight">
                    {formatPocWeightShare(
                      poc,
                      session ? cycleWeightPocs : pocs,
                      { includeInactive: Boolean(session) }
                    )} influence
                  </i>
                  <b>{session ? formatScore(session.csatScore) : "--"}</b>
                </div>
                {session && session.tone ? (
                  <div className="poc-card-tone">
                    <TonePill tone={session.tone} reason={session.toneReason} />
                  </div>
                ) : null}
              </button>
            );
          })}
          {!pocs.length ? <EmptyState title="No POC on this project" text="Add client POCs so a cycle can be sent." /> : null}
        </div>

        <div className="bulk-action-status">
          <span>{actionPocs.length} selected</span>
          <span>{reminderTargets.length} reminder-eligible in selected cycle</span>
          <span>{stoppableTargets.length} can be stopped in selected cycle</span>
        </div>

        <div className="button-row bulk-action-buttons">
          <Button
            icon={Send}
            variant="primary"
            onClick={() => requestFeedback("pulse")}
            disabled={projectEndFeedbackLocked || !messagingEnabled || !actionPocs.length || Boolean(bulkAction)}
            title={projectEndFeedbackLocked
              ? "Monthly feedback is closed because project-end feedback has already been sent."
              : undefined}
          >
            {bulkAction === "pulse" ? "Starting…" : `Send ${intervalLabel} feedback to ${actionPocs.length} POC${actionPocs.length === 1 ? "" : "s"}`}
          </Button>
          <Button
            icon={CheckCircle2}
            onClick={() => requestFeedback("project_end")}
            disabled={!messagingEnabled || !actionPocs.length || Boolean(bulkAction)}
          >
            {bulkAction === "project_end" ? "Starting…" : `Send project-end feedback to ${actionPocs.length} POC${actionPocs.length === 1 ? "" : "s"}`}
          </Button>
          <Button
            icon={Send}
            onClick={() => requestFeedback("quick_checkin")}
            disabled={projectEndFeedbackLocked || !messagingEnabled || !actionPocs.length || Boolean(bulkAction)}
            title={projectEndFeedbackLocked
              ? "Quick check-ins are closed because project-end feedback has already been sent."
              : undefined}
          >
            {bulkAction === "quick_checkin" ? "Starting..." : `Send quick check-in to ${actionPocs.length} POC${actionPocs.length === 1 ? "" : "s"}`}
          </Button>
          <Button
            icon={Bell}
            onClick={sendReminder}
            disabled={!messagingEnabled || !reminderTargets.length || Boolean(bulkAction)}
            title={finalResponseWindowActive
              ? "Some selected POCs have used all 3 reminders; only eligible selected POCs will be reminded."
              : !reminderTargets.length ? "No selected POC has an open session eligible for a reminder in this cycle." : undefined}
          >
            {bulkAction === "reminder" ? "Sending reminders…" : `Remind ${reminderTargets.length} eligible POC${reminderTargets.length === 1 ? "" : "s"}`}
          </Button>
          <Button
            icon={Ban}
            variant="danger"
            disabled={!stoppableTargets.length || Boolean(bulkAction)}
            onClick={stopSelectedSessions}
            title={!stoppableTargets.length ? "No selected POC has an open session that can be stopped in this cycle." : undefined}
          >
            {bulkAction === "stop" ? "Stopping…" : `Stop ${stoppableTargets.length} POC${stoppableTargets.length === 1 ? "" : "s"} in selected cycle`}
          </Button>
        </div>
        <p className="form-note">
          Monthly, project-end and quick check-in buttons create a new cycle for exactly the selected POCs. Quick check-ins do not ask for a rating and do not use reminders. Reminder and stop buttons
          use the clearly selected cycle above. Stopping preserves existing feedback and affects only those POCs in
          that cycle; if every remaining open session is stopped, the cycle closes automatically.
        </p>
        {projectEndFeedbackLocked ? (
          <p className="form-note">
            Project-end feedback has been sent. Monthly feedback and quick check-ins are permanently disabled for
            this project; project-end feedback can still be resent manually when required.
          </p>
        ) : null}
        {finalResponseWindowActive ? (
          <p className="form-note">
            One or more selected POCs are in the final 24-hour response window after reminder 3. They cannot receive
            a fourth reminder and will close automatically if they do not respond.
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Service feedback"
        badge={selectedCycle ? "this cycle" : "latest known"}
        className="span-12"
      >
        <div className="svc-table">
          <div className="svc-head">
            <span>Service</span>
            <span>Score</span>
            <span>Owner (service manager)</span>
          </div>
          {services.map((service) => {
            // With a cycle selected, show ONLY what that cycle captured.
            // project_services.score is the last known value across all time,
            // so an unrated service was showing a stale number.
            const captured = cycleServices.find((item) => item.serviceKey === service.serviceKey);
            const score = selectedCycle ? (captured ? captured.score : null) : service.score;
            const predicted = captured && captured.source === "predicted";
            return (
              <div key={service.serviceKey} className={`svc-row ${scoreClass(score)}`}>
                <strong>{service.name}</strong>
                <div className="svc-score">
                  <b className={scoreClass(score)}>{formatScore(score)}</b>
                  {/* A read of the conversation is not a number the client
                      gave. Saying which is which keeps the figure honest. */}
                  {predicted ? <span className="score-source">read from the chat</span> : null}
                </div>
                <span>{service.managerName || service.ownerName || "Not set"}</span>
              </div>
            );
          })}
          {!services.length ? <EmptyState title="No services mapped" text="Map project services to route feedback." /> : null}
        </div>
      </Panel>

      <div ref={conversationRef} className="section-anchor" id="project-conversation">
      <Panel
        title="Conversation"
        badge={selectedSession ? formatSessionOutcome(selectedSession) : "No session"}
        className="span-12"
        action={
          // The cycle picker also lives here: reading a reply without knowing
          // which cycle it belongs to is useless, and the filter bar is far away.
          <div className="convo-controls">
            {selectedSession && selectedSession.tone ? (
              <TonePill tone={selectedSession.tone} reason={selectedSession.toneReason} />
            ) : null}
            <SearchableSelect
              value={selectedCycle ? selectedCycle.id : ""}
              onChange={(event) => selectCycle(event.target.value)}
              aria-label="Feedback cycle"
            >
              {cycles.length ? null : <option value="">No cycle</option>}
              {cycles.map((cycle) => (
                <option key={cycle.id} value={cycle.id}>
                  {formatCycleType(cycle.cycleType, project.feedbackIntervalDays)} · {formatDate(cycle.startedAt)}
                </option>
              ))}
            </SearchableSelect>
            <SearchableSelect
              value={selectedSession ? selectedSession.id : ""}
              onChange={(event) => selectSession(event.target.value)}
              aria-label="Client POC"
            >
              {cycleSessions.length ? null : <option value="">No POC replied</option>}
              {cycleSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.pocName || "POC"} · {formatSessionOutcome(session)}
                </option>
              ))}
            </SearchableSelect>
          </div>
        }
      >
        {messagesLoading ? <LoadingBlock label="Loading conversation" /> : messagesError ? (
          <div className="error-block" role="alert">
            <strong>Could not load this conversation</strong>
            <p>{messagesError.message}</p>
            <Button icon={RefreshCw} onClick={() => loadConversation(sessionId)}>Try again</Button>
          </div>
        ) : messages.length ? (
          <div className="message-timeline wide" ref={timelineRef}>
            {messages.map((message) => (
              <div key={message.id} className={`message ${message.side || "srv"}`}>
                <strong>{message.speaker || "Unknown"}</strong>
                <p>{message.body || ""}</p>
                <span>
                  {formatDateTime(message.createdAt)}
                  {message.metadata?.guardrail ? <b className="guardrail-tag">{formatGuardrail(message.metadata.guardrail)}</b> : null}
                   {message.metadata?.provider === "gemini" ? <b className="ai-tag">rephrased</b> : null}
                   {message.metadata?.manualOutbound ? <b className="manual-message-tag">sent manually</b> : null}
                  {message.metadata?.interpretedIntent ? (
                    <b className="ai-tag">read as {message.metadata.interpretedIntent}</b>
                  ) : null}
                  {message.metadata?.fallbackReason ? (
                    <b className="fallback-tag" title="Gemini was not used for this reply">
                      {message.metadata.fallbackReason}
                    </b>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
         ) : (
           <EmptyState title="No conversation yet" text="Pick a POC above, or wait for the client to reply." />
         )}
        {selectedSession ? (
          <div className="manual-whatsapp-composer">
            <div className="manual-whatsapp-heading">
              <div>
                <strong>Reply on WhatsApp</strong>
                <span>
                  {selectedConversationPoc
                    ? `${selectedConversationPoc.name} · ${selectedConversationPoc.contactWhatsapp || "No WhatsApp number"}`
                    : "Selected client POC"}
                </span>
              </div>
              <span className={whatsappWindowOpen ? "window-open" : "window-closed"}>
                {whatsappWindowOpen ? "24-hour reply window open" : "Free-text window closed"}
              </span>
            </div>
            <textarea
              rows={4}
              maxLength={4096}
              value={manualWhatsappText}
              onChange={(event) => setManualWhatsappText(event.target.value)}
              placeholder="Write the message that should be sent to this client POC…"
              disabled={Boolean(manualWhatsappBlockedReason) || manualWhatsappSending}
            />
            <div className="manual-whatsapp-actions">
              <span>{manualWhatsappText.length} / 4096</span>
              <Button
                icon={Send}
                variant="primary"
                onClick={sendManualWhatsappMessage}
                disabled={Boolean(manualWhatsappBlockedReason) || !manualWhatsappText.trim() || manualWhatsappSending}
              >
                {manualWhatsappSending ? "Sending…" : "Send WhatsApp message"}
              </Button>
            </div>
            <p className={manualWhatsappBlockedReason ? "manual-whatsapp-warning" : "form-note"}>
              {manualWhatsappBlockedReason
                || "This sends immediately through n8n using the existing Meta credential. A clearly worded overall-rating question will make the client's next 0–10 reply the active rating answer; a project-end recommendation question does the same for NPS. Other manual messages remain contextual and do not change scores, reminders or cycle status."}
            </p>
          </div>
        ) : null}
      </Panel>
      </div>

      <div ref={issuesRef} className="section-anchor">
      <Panel
        title="Open issues"
        badge={range.from || range.to
          ? `${openIssues.length} raised in range`
          : `${openIssues.length} open`}
        className="span-12"
        action={selectedCycle ? (
          <button type="button" className="row-link" onClick={() => setShowAllIssues((value) => !value)}>
            {showAllIssues ? "Show this cycle only" : "Show all issues"}
          </button>
        ) : null}
      >
        <div className="issue-list">
          {openIssues.map((issue) => (
            <div key={issue.id} className={`issue-card ${riskClass(issue.severity)}`}>
              <div className="issue-card-head">
                <div>
                  <strong>{issue.title}</strong>
                  <span>{issue.serviceName || "Service"}</span>
                </div>
                <StatusPill value={issue.status || "open"} />
              </div>
              {/* The fallback path writes the same text into both fields. Showing
                  it twice reads as a rendering bug rather than detail. */}
              {issue.rootCause && !isSameText(issue.rootCause, issue.title) ? (
                <p>{issue.rootCause}</p>
              ) : null}
              <div className="issue-meta">
                <span>Raised {formatDateTime(issue.createdAt)}</span>
                <span>By {pocNameById.get(issue.clientPocId) || "Unknown POC"}</span>
                <span>Severity {issue.severity || "watch"}</span>
                {issue.reopenedAt ? (
                  <span>Reopened {formatDateTime(issue.reopenedAt)}</span>
                ) : null}
              </div>
              {issue.reopenReason ? (
                <p className="issue-note">Reopened because: {issue.reopenReason}</p>
              ) : null}
              <div className="button-row">
                <Button icon={CheckCircle2} variant="primary"
                  onClick={() => setIssueModal({ issueId: issue.id, action: "close" })}>
                  Close issue
                </Button>
              </div>
            </div>
          ))}
          {!openIssues.length ? (
            <EmptyState
              title="Nothing open"
              text={range.from || range.to
                ? "No open issue was raised in this date range."
                : selectedCycle && !showAllIssues
                  ? "No open issue from this cycle."
                  : "An issue needs a reported problem with a reason."}
            />
          ) : null}
        </div>
      </Panel>
      </div>

      <Panel
        title="Appreciations"
        badge={`${appreciations.length} ${scopeToCycle ? "this cycle" : "on this project"}`}
        className="span-12"
        action={selectedCycle ? (
          <button type="button" className="row-link" onClick={() => setShowAllFeedback((value) => !value)}>
            {showAllFeedback ? "Show this cycle only" : "Show all for this project"}
          </button>
        ) : null}
      >
        <div className="observation-list">
          {appreciations.map((item) => (
            <div key={item.key} className="appreciation-card">
              <div className="observation-head">
                <strong>{item.subject}</strong>
                <span>{item.pocName} · {item.when ? formatDate(item.when) : ""}</span>
              </div>
              <p>{item.detail}</p>
            </div>
          ))}
          {!appreciations.length ? (
            <EmptyState
              title="Nothing yet"
              text="When a client praises a service or a team, it appears here — good work should reach people as reliably as complaints do."
            />
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Other feedback"
        badge={`${observations.length} ${scopeToCycle ? "this cycle" : "on this project"}`}
        className="span-12"
        action={selectedCycle ? (
          <button type="button" className="row-link" onClick={() => setShowAllFeedback((value) => !value)}>
            {showAllFeedback ? "Show this cycle only" : "Show all for this project"}
          </button>
        ) : null}
      >
        <div className="observation-list">
          {observations.map((item) => (
            <div key={item.id} className={`observation-card ${riskClass(item.severity)}`}>
              <div className="observation-head">
                <strong>{item.topic}</strong>
                <span>{pocNameById.get(item.clientPocId) || "Unknown POC"} · {formatDate(item.createdAt)}</span>
              </div>
              <p>{item.detail}</p>
            </div>
          ))}
          {!observations.length ? (
            <EmptyState
              title="Nothing else raised"
              text="Anything a client mentions that is not one of your services — billing, a named person, a process — is captured here and emailed to the team."
            />
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Resolved issues"
        badge={range.from || range.to
          ? `${closedIssues.length} raised in range`
          : `${closedIssues.length} closed`}
        className="span-12"
      >
        <div className="dtable resolved-issues">
          <div className="dtable-head">
            <span>Issue</span>
            <span>Service</span>
            <span>Raised by</span>
            <span>Raised</span>
            <span>Closed</span>
            <span>Time to resolve</span>
            <span>Resolution note</span>
            <span />
          </div>
          {closedIssues.map((issue) => (
            <div key={issue.id} className="dtable-row">
              <strong>{issue.title}</strong>
              <span>{issue.serviceName || "--"}</span>
              <span>{pocNameById.get(issue.clientPocId) || "Unknown POC"}</span>
              <span>{formatDate(issue.createdAt)}</span>
              <span>{formatDate(issue.closedAt)}</span>
              <span>{formatResolutionTime(issue.createdAt, issue.closedAt)}</span>
              <span>{issue.resolutionNote || "No note recorded"}</span>
              <button type="button" className="icon-button" aria-label={`Reopen ${issue.title}`}
                onClick={() => setIssueModal({ issueId: issue.id, action: "reopen" })}>
                <RotateCcw size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
          {!closedIssues.length ? (
            <EmptyState title="Nothing closed yet" text="Closed issues appear here with their resolution note." />
          ) : null}
        </div>
      </Panel>

      {toast ? <div className="toast visible">{toast}</div> : null}
      {issueModal ? <IssueNoteModal action={issueModal.action} onCancel={() => setIssueModal(null)} onSubmit={updateIssue} /> : null}
    </>
  );
}
