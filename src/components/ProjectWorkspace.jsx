import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Bell, Check, CheckCircle2, RefreshCw, RotateCcw, Send, Users } from "lucide-react";
import { apiGet, apiPost } from "../api";
import { cycleInRange, DateRange, FilterBar, MultiSelect, SingleSelect } from "./Filters.jsx";
import {
  formatCycleCoverage, formatCycleStatus, formatCycleType, formatDate, formatDateTime,
  formatConfidence, confidenceClass, formatGuardrail, formatNps, formatNpsBasis, npsClass, formatPocLevel, formatPocWeightShare, formatResolutionTime, formatScore,
  formatSessionOutcome, riskClass, scoreClass
} from "../format";
import { Button, EmptyState, LoadingBlock, MetricCard, Panel, StatusPill, TonePill } from "./Ui.jsx";

const COMPLETION_OPTIONS = [
  { value: "", label: "Any completion" },
  { value: "completed", label: "Completed only" },
  { value: "pending", label: "Not completed" }
];

function sessionCanBeStopped(session) {
  if (!session || ["completed", "opted_out"].includes(session.status)) return false;
  const state = session.conversationState || {};
  return !["completed", "opted_out", "handed_off"].includes(state.state)
    && !state.reminderExhausted
    && !state.stoppedByAdmin;
}

function sessionCanReceiveReminder(session) {
  if (!session || ["completed", "opted_out"].includes(session.status)) return false;
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

export default function ProjectWorkspace({ dashboard, locationTick, onReload }) {
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cycleId, setCycleId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState([]);
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
  const timelineRef = useRef(null);
  const issuesRef = useRef(null);
  const workspaceRequestRef = useRef(0);
  const messageRequestRef = useRef(0);

  const [clusters, setClusters] = useState([]);
  const [clients, setClients] = useState([]);
  const [cycleTypes, setCycleTypes] = useState([]);
  const [completion, setCompletion] = useState("");
  const [range, setRange] = useState({ from: "", to: "", basis: "started" });

  const allProjects = dashboard?.projects || [];

  const projectKey = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("project") || params.get("client") || allProjects[0]?.key || "";
  }, [allProjects, locationTick]);

  // Cluster and client narrow which projects are selectable.
  const selectableProjects = useMemo(() => allProjects.filter((project) => {
    if (clusters.length && !clusters.includes(project.clusterName)) return false;
    if (clients.length && !clients.includes(project.clientName)) return false;
    return true;
  }), [allProjects, clusters, clients]);

  // Cluster/client selection is navigation, not only dropdown decoration. The
  // old project used to remain loaded when it fell outside the chosen client,
  // so its CSAT, POCs and conversations appeared under the new filter.
  useEffect(() => {
    const projectFiltersActive = Boolean(clusters.length || clients.length);
    const currentAllowed = selectableProjects.some((project) => project.key === projectKey);
    if (!selectableProjects.length) {
      if (projectFiltersActive) {
        workspaceRequestRef.current += 1;
        messageRequestRef.current += 1;
        setWorkspace(null);
        setCycleId("");
        setSessionId("");
        setMessages([]);
        setLoading(false);
      }
      return;
    }
    if (!currentAllowed) {
      pushProject(selectableProjects[0].key);
      return;
    }
  }, [clusters, clients, projectKey, selectableProjects]);

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
      const params = new URLSearchParams(window.location.search);
      const requestedCycleId = params.get("cycle");
      const requestedSessionId = params.get("session");
      const requestedCycle = (data.cycles || []).find((cycle) =>
        cycle.id === requestedCycleId
        || (cycle.sessions || []).some((session) => session.id === requestedSessionId)
      );
      const firstCycle = requestedCycle || (data.cycles || [])[0];
      const firstSession = firstCycle
        ? (firstCycle.sessions || []).find((session) => session.id === requestedSessionId)
          || (firstCycle.sessions || [])[0]
        : (data.latestSession || null);
      const firstMessages = firstSession ? await loadMessages(firstSession.id) : [];
      // Project/filter changes can start another request before this one
      // finishes. Ignore a late response instead of putting the previous
      // client's POCs, cycles and scores back on screen.
      if (requestId !== workspaceRequestRef.current) return;
      if (data.project?.key !== key) throw new Error("The server returned a different project workspace.");
      setWorkspace(data);
      setCycleId(firstCycle ? firstCycle.id : "");
      setSessionId(firstSession ? firstSession.id : "");
      setMessages(firstMessages);
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

  useEffect(() => { loadWorkspace(projectKey); }, [projectKey]);

  useEffect(() => {
    setFeedbackPocId("");
    setSelectedActionPocIds([]);
  }, [projectKey]);

  useEffect(() => {
    setManualWhatsappText("");
  }, [sessionId]);

  useEffect(() => {
    if (loading || !workspace) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("section") !== "issues") return;
    window.setTimeout(() => issuesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }, [loading, workspace, locationTick]);


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
      if (completion === "completed" && cycle.status !== "closed") return false;
      if (completion === "pending" && cycle.status === "closed") return false;
      return cycleInRange(cycle, range);
    });
  }, [workspace, cycleTypes, completion, range]);

  const selectedCycle = cycles.find((cycle) => cycle.id === cycleId) || cycles[0] || null;

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
  const feedbackSessions = feedbackPocId
    ? cycleSessions.filter((session) => session.clientPocId === feedbackPocId)
    : cycleSessions;
  const selectedSession = feedbackSessions.find((session) => session.id === sessionId) || feedbackSessions[0] || null;
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
    const first = feedbackPocId
      ? sessions.find((item) => item.clientPocId === feedbackPocId) || null
      : sessions[0] || null;
    setSessionId(first ? first.id : "");
    const requestId = messageRequestRef.current + 1;
    messageRequestRef.current = requestId;
    const nextMessages = first ? await loadMessages(first.id) : [];
    if (requestId === messageRequestRef.current) setMessages(nextMessages);
  }

  async function selectSession(id) {
    setSessionId(id);
    const requestId = messageRequestRef.current + 1;
    messageRequestRef.current = requestId;
    const nextMessages = await loadMessages(id);
    if (requestId === messageRequestRef.current) setMessages(nextMessages);
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

  async function requestFeedback(cycleType) {
    const project = workspace?.project;
    if (!project) return;
    if (!actionPocs.length) { showToast("Select at least one POC first."); return; }
    const unavailable = actionPocs.filter((poc) => !poc.active || !poc.contactWhatsapp);
    if (unavailable.length) {
      showToast(`Cannot send to: ${unavailable.map((poc) => poc.name).join(", ")}. Each selected POC must be active and have a WhatsApp number.`);
      return;
    }
    const label = cycleType === "project_end" ? "project-end" : `${project.feedbackIntervalDays || 30}-day`;
    if (!window.confirm(`Send the ${label} feedback request for ${project.name}?\n\n${actionPocs.length} selected POC(s): ${actionPocs.map((poc) => poc.name).join(", ")}`)) return;
    setBulkAction(cycleType === "project_end" ? "project_end" : "pulse");
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

  async function sendReminder() {
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

  if (
    loading
    || !dashboard
    || (workspace?.project?.key && workspace.project.key !== projectKey)
  ) return <LoadingBlock label="Loading project workspace" />;
  if (error) {
    return (
      <div className="error-block">
        <strong>Could not load this project</strong>
        <p>{error.message}</p>
        <Button icon={RefreshCw} variant="primary" onClick={() => loadWorkspace(projectKey)}>Try again</Button>
      </div>
    );
  }
  if (!workspace?.project) return <EmptyState title="No project selected" text="Choose a project from the filter above." />;

  const { project } = workspace;
  const pocs = workspace.pocs || [];
  const services = workspace.services || [];
  const issues = workspace.issues || [];
  // The table shows the SAME cycles as the dropdown. It previously read the
  // unfiltered list, so a date range changed the dropdown and left the table
  // showing everything — the two disagreed about the same project.
  const allCycles = workspace.cycles || [];
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
  const cycleFiltersActive = Boolean(range.from || range.to || cycleTypes.length || completion);
  const selectedConversationPoc = selectedSession
    ? pocs.find((poc) => poc.id === selectedSession.clientPocId) || null
    : null;
  const latestClientMessage = [...messages].reverse().find((message) => message.side === "client");
  const latestClientAt = Date.parse(latestClientMessage?.createdAt || selectedSession?.lastClientResponseAt || "");
  const whatsappWindowOpen = Number.isFinite(latestClientAt)
    && Date.now() - latestClientAt < 24 * 60 * 60 * 1000;
  const manualWhatsappBlockedReason = !selectedSession
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
  const filtersActive = Boolean(clusters.length || clients.length || cycleTypes.length || completion || range.from || range.to || feedbackPocId);

  return (
    <>
      <div className="topbar">
        <div>
          <h2>Project workspace</h2>
          <p className="topbar-sub">{project.clientName || "Client"} · {project.clusterName || "No cluster"} · {project.name}</p>
        </div>
        <Button icon={RefreshCw} onClick={() => loadWorkspace(project.key)}>Refresh</Button>
      </div>

      <FilterBar
        showReset={filtersActive}
        onReset={() => { setClusters([]); setClients([]); setCycleTypes([]); setCompletion(""); setFeedbackPocId(""); setRange({ from: "", to: "", basis: "started" }); }}
      >
        <MultiSelect label="Cluster" allLabel="All clusters" selected={clusters} onChange={setClusters}
          options={[...new Set(allProjects.map((item) => item.clusterName).filter(Boolean))].sort()} />
        <MultiSelect label="Client" allLabel="All clients" selected={clients} onChange={setClients}
          options={[...new Set(allProjects.map((item) => item.clientName).filter(Boolean))].sort()} />
        <SingleSelect label="Project" value={project.key} placeholder="" onChange={pushProject}
          options={selectableProjects.map((item) => ({ value: item.key, label: item.name }))} />
        <SingleSelect label="Cycle" value={selectedCycle ? selectedCycle.id : ""} placeholder={cycles.length ? "" : "No cycle"}
          onChange={selectCycle}
          options={cycles.map((cycle) => ({
            value: cycle.id,
            label: `${formatCycleType(cycle.cycleType, project.feedbackIntervalDays)} · ${formatDate(cycle.startedAt)}${cycle.status === "closed" ? " · closed" : ""}`
          }))} />
        <MultiSelect label="Cycle type" allLabel="All types" selected={cycleTypes} onChange={setCycleTypes}
          options={["pulse", "project_end"]}
          renderOption={(value) => formatCycleType(value, project.feedbackIntervalDays)} />
        <SingleSelect label="Completion" value={completion} placeholder="" onChange={setCompletion}
          options={COMPLETION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />
        <DateRange range={range} onChange={setRange} />
        <SingleSelect label="Feedback by" value={feedbackPocId} placeholder="All POCs" onChange={selectFeedbackPoc}
          options={pocs.map((poc) => ({ value: poc.id, label: poc.name }))} />
      </FilterBar>

      {(range.from || range.to || cycleTypes.length || completion) && !cycles.length ? (
        <div className="filter-empty-note">
          No cycle on this project matches these filters. Clear them to see the full history.
        </div>
      ) : null}

      <div className="metric-row">
        <MetricCard
          label={selectedCycle ? "Cycle CSAT (weighted)" : "Latest CSAT (weighted)"}
          value={formatScore(statedScore)}
          caption={statedScore === null || statedScore === undefined
            ? "no rating given"
            : selectedCycle
              ? `${selectedCycle.pocResponded || 0} POC rating(s); configured group percentages applied`
              : "latest weighted project score"}
          tone={scoreClass(statedScore)}
        />
        <MetricCard
          label="CSAT (predicted)"
          value={formatScore(predictedScore)}
          caption={predictedScore === null || predictedScore === undefined
            ? "not scored yet"
            : formatConfidence(selectedSession && selectedSession.predictedConfidence)}
          tone={confidenceClass(selectedSession && selectedSession.predictedConfidence)}
        />
        <MetricCard
          label="NPS"
          value={formatNps(selectedCycle ? selectedCycle.npsScore : project.npsScore)}
          tone={npsClass(selectedCycle ? selectedCycle.npsScore : project.npsScore)}
          caption={
            selectedCycle && selectedCycle.cycleType !== "project_end"
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

      {selectedSession && selectedSession.predictedReasoning ? (
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

      {selectedSession
        && (selectedSession.predictedCsat === null || selectedSession.predictedCsat === undefined)
        && messages.some((message) => message.side === "client") ? (
          <div className="prediction-strip watch">
            <div className="prediction-head">
              <strong>This conversation has not been scored</strong>
              <Button onClick={scoreSession} disabled={scoring}>
                {scoring ? "Scoring…" : "Score it now"}
              </Button>
            </div>
            <p>
              Score the feedback shared so far without ending this POC's session. Greetings,
              acknowledgements and postponements remain unscored.
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
            disabled={!actionPocs.length || Boolean(bulkAction)}
          >
            {bulkAction === "pulse" ? "Starting…" : `Send ${intervalLabel} feedback to ${actionPocs.length} POC${actionPocs.length === 1 ? "" : "s"}`}
          </Button>
          <Button
            icon={CheckCircle2}
            onClick={() => requestFeedback("project_end")}
            disabled={!actionPocs.length || Boolean(bulkAction)}
          >
            {bulkAction === "project_end" ? "Starting…" : `Send project-end feedback to ${actionPocs.length} POC${actionPocs.length === 1 ? "" : "s"}`}
          </Button>
          <Button
            icon={Bell}
            onClick={sendReminder}
            disabled={!reminderTargets.length || Boolean(bulkAction)}
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
          Monthly and project-end buttons create a new cycle for exactly the selected POCs. Reminder and stop buttons
          use the clearly selected cycle above. Stopping preserves existing feedback and affects only those POCs in
          that cycle; if every remaining open session is stopped, the cycle closes automatically.
        </p>
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
            <select
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
            </select>
            <select
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
            </select>
          </div>
        }
      >
        {messages.length ? (
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
                || "This sends immediately through n8n using the existing Meta credential. It will appear in this transcript but will not change the feedback checklist, scores, reminders or cycle status. Gemini will read it as context when the client replies."}
            </p>
          </div>
        ) : null}
      </Panel>

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
