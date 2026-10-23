const assert = require("assert");
const path = require("path");
const Module = require("module");
const { SupabaseStore, sessionIsTerminal } = require("../src/lib/supabase-store");

// ---- Stub store implementing the v2 SupabaseStore surface -------------
const project = {
  id: "prj_1",
  clientId: "cl_1",
  key: "acme-ug",
  name: "Acme University UG Admissions",
  feedbackIntervalDays: 30,
  nextCycleDueAt: "2026-11-01T00:00:00.000Z",
  automaticFeedbackEnabled: true,
  automaticQuickCheckinEnabled: true,
  automaticQuickCheckinResumeAt: null,
  services: [
    { id: "svc_ppc", projectId: "prj_1", serviceKey: "ppc", name: "PPC / Media", ownerName: "Riya", managerEmail: "mgr.ppc@srvmedia.com" },
    { id: "svc_website", projectId: "prj_1", serviceKey: "website", name: "Website / SEO", ownerName: "Neha", managerEmail: "mgr.web@srvmedia.com" }
  ],
  pocs: []
};
const poc = { id: "poc_1", projectId: "prj_1", name: "Haranath", salutation: "Haranath sir", contactWhatsapp: "919999999999", levelId: "normal", weightPercentage: 100, active: true };
project.pocs = [poc];

const calls = {
  automation: [], messages: [], analyses: [], patches: [],
  interimAnalyses: [], finalPartialAnalyses: [], stoppedAnalyses: [], observations: [],
  createdProjects: [],
  createdCycleRequests: [],
  createdPocs: [],
  createdServices: [],
  createdCatalogServices: [],
  createdInternalPocs: [],
  deletedServices: [],
  updatedPocLevels: [],
  clearedProjectMessages: [],
  clearedProjectIssues: [],
  deletedProjectCycles: [],
  deletedClientPocs: [],
  removedProjectPocs: [],
  savedPocBatches: [],
  deletedProjects: [],
  deletedClients: [],
  updatedProjects: [],
  deletedClusters: [],
  quickCheckinResponses: [],
  reminderOptions: [],
  inactiveCompletionClaims: [],
  inactiveCompletionFinishes: [],
  inactiveCompletionFailures: [],
  performanceSaves: [],
  serviceChangeRequests: [],
  automationClaims: new Map()
};

const store = {
  request: async (table, options) => { calls.patches.push({ table, options }); return [{ id: "sess_1", status: "needs_attention", reminder_due_at: null }]; },
  listProjects: async () => [project],
  getProject: async (key) => (key === project.key ? project : null),
  getProjectById: async () => project,
  getProjectWorkspace: async (key) => (key === project.key ? { project, services: project.services, pocs: [poc], cycles: [], sessions: [], issues: [], latestSession: null, messages: [] } : null),
  getPocByWhatsapp: async (phone) => (String(phone).replace(/\D/g, "") === poc.contactWhatsapp ? poc : null),
  getClientPocById: async () => poc,
  pocsForProject: async (projectId) => projectId === project.id ? [poc] : [],
  getActiveSessionForPoc: async () => store._session,
  getLatestSessionForPoc: async () => store._session,
  getSession: async () => store._session,
  getSessionDetail: async () => ({ session: store._session, messages: calls.messages, poc, project }),
  clearProjectMessages: async (projectId, cycleIds) => {
    calls.clearedProjectMessages.push({ projectId, cycleIds });
    return { messagesDeleted: 12, sessionsAffected: 3, cyclesAffected: cycleIds.length };
  },
  deleteProjectIssues: async (projectId, issueIds) => {
    calls.clearedProjectIssues.push({ projectId, issueIds });
    return { issuesDeleted: 4, issueEventsDeleted: 7 };
  },
  deleteProjectCycles: async (projectId, cycleIds) => {
    calls.deletedProjectCycles.push({ projectId, cycleIds });
    return {
      cyclesDeleted: cycleIds.length,
      sessionsDeleted: 2,
      messagesDeleted: 9,
      issuesDeleted: 3,
      issueEventsDeleted: 5,
      observationsDeleted: 2,
      serviceFeedbackDeleted: 4
    };
  },
  getMessagesForSession: async (sessionId) => {
    if (
      store._injectRapidRatingMessages
      && !store._rapidRatingMessagesInjected
      && calls.messages.some((message) => message.side === "client" && message.body === "0")
    ) {
      calls.messages.push(
        { id: `msg_${calls.messages.length + 1}`, sessionId, side: "client", speaker: poc.name, body: "Sorry, that was a mistake" },
        { id: `msg_${calls.messages.length + 2}`, sessionId, side: "client", speaker: poc.name, body: "Take 8" }
      );
      store._rapidRatingMessagesInjected = true;
    }
    return calls.messages;
  },
  hasProviderMessage: async (pid) => calls.messages.some((m) => m.providerMessageId === pid),
  addMessage: async (sessionId, message) => { const row = { id: `msg_${calls.messages.length + 1}`, sessionId, ...message }; calls.messages.push(row); return row; },
  addInboundMessage: async (sessionId, message) => {
    if (store._atomicDuplicateIds.has(message.providerMessageId)) return null;
    if (calls.messages.some((m) => m.providerMessageId === message.providerMessageId)) return null;
    return store.addMessage(sessionId, message);
  },
  applyQuickCheckinResponse: async (sessionId, input = {}) => {
    const now = new Date().toISOString();
    const detail = String(input.detail || "").trim();
    const waitingForDetail = input.outcome === "needs_improvement" && !detail;
    const previousState = store._session.conversationState || {};
    const outcome = waitingForDetail
      ? "needs_improvement"
      : detail || input.outcome === "feedback_shared" || previousState.quickCheckinOutcome === "feedback_shared"
        ? "feedback_shared"
        : "all_good";
    const conversationState = {
      ...previousState,
      state: waitingForDetail ? "quick_checkin_detail" : "quick_checkin_window",
      quickCheckinOutcome: outcome,
      quickCheckinDetail: detail || previousState.quickCheckinDetail || null,
      quickCheckinWindowExpiresAt: waitingForDetail ? null : "2099-01-01T00:10:00.000Z"
    };
    store._session = {
      ...store._session,
      status: "partial",
      completionStatus: "partial",
      lastClientResponseAt: now,
      conversationState
    };
    calls.quickCheckinResponses.push({ sessionId, input, session: store._session });
    const issues = (input.interpretation?.concerns || []).map((concern, index) => ({
      id: `quick_issue_${index + 1}`,
      title: concern.title,
      severity: concern.severity === "high" ? "high" : "watch"
    }));
    return {
      session: store._session,
      sentiment: input.interpretation?.sentiment || "neutral",
      service: null,
      issue: issues[0] || null,
      issues
    };
  },
  applyAnalysis: async (sessionId, analysis) => {
    calls.analyses.push(analysis);
    store._session = { ...store._session, conversationState: analysis.conversationState, csatScore: analysis.csatScore, status: analysis.isComplete ? "completed" : "partial" };
    return store._session;
  },
  hasIssueForAnalysis: async () => false,
  hasOpenCycle: async () => false,
  projectIdsWithCycleType: async () => new Set(),
  createCycle: async (projectKey, options) => {
    if (options.automatic === true && options.cycleType === "pulse" && project.automaticFeedbackEnabled === false) {
      throw new Error("Automatic 30-day feedback is turned off for this project");
    }
    if (options.automatic === true && options.cycleType === "quick_checkin" && project.automaticQuickCheckinEnabled === false) {
      throw new Error("Automatic quick check-ins are turned off for this project");
    }
    calls.createdCycleRequests.push({ projectKey, options });
    return {
      cycle: { id: "cyc_1", projectId: project.id, cycleType: options.cycleType, status: "open" },
      sessions: [{ id: "sess_1", cycleId: "cyc_1", clientPocId: poc.id, projectId: project.id, status: "started", reminderDueAt: "2026-08-01T00:00:00Z" }],
      project,
      pocs: [poc]
    };
  },
  markNoResponse: async (sessionId, options = {}) => {
    calls.reminderOptions.push({ sessionId, options });
    const reminderCount = (Number(store._session.reminderCount) || 0) + 1;
    const reminderState = options.askForOverallRating
      ? {
          overallRatingAsked: true,
          finalRatingReminderPending: true,
          pendingQuestionType: "overall_rating",
          pendingServiceKey: null,
          state: "waiting_for_overall_rating"
        }
      : {};
    store._session = {
      ...store._session,
      status: store._session.completionStatus === "partial" ? "partial" : "no_response",
      reminderCount,
      reminderDueAt: "2026-08-02T00:00:00.000Z",
      conversationState: {
        ...(store._session.conversationState || {}),
        reminderCount,
        reminderExhausted: false,
        ...reminderState
      }
    };
    return store._session;
  },
  markClosingTemplateSent: async () => {
    store._session = {
      ...store._session,
      conversationState: {
        ...(store._session.conversationState || {}),
        closingTemplateSentAt: "2026-08-03T00:00:00.000Z"
      }
    };
    return store._session;
  },
  applyInterimAnalysis: async (sessionId, analysis) => {
    calls.interimAnalyses.push(analysis);
    store._session = {
      ...store._session,
      csatScore: analysis.csatScore === undefined ? store._session.csatScore : analysis.csatScore,
      predictedCsat: analysis.predictedCsat === undefined ? store._session.predictedCsat : analysis.predictedCsat,
      predictedConfidence: analysis.predictedConfidence === undefined
        ? store._session.predictedConfidence
        : analysis.predictedConfidence,
      predictedReasoning: analysis.predictedReasoning === undefined
        ? store._session.predictedReasoning
        : analysis.predictedReasoning,
      predictedSignals: analysis.predictedSignals === undefined
        ? store._session.predictedSignals
        : analysis.predictedSignals,
      csatSource: analysis.csatSource === undefined ? store._session.csatSource : analysis.csatSource,
      riskLevel: analysis.riskLevel === undefined ? store._session.riskLevel : analysis.riskLevel
    };
    return store._session;
  },
  applyFinalPartialAnalysis: async (sessionId, analysis) => {
    calls.finalPartialAnalyses.push(analysis);
    store._session = {
      ...store._session,
      csatScore: analysis.csatScore,
      predictedCsat: analysis.predictedCsat,
      predictedConfidence: analysis.predictedConfidence,
      csatSource: analysis.csatSource,
      riskLevel: analysis.riskLevel,
      tone: analysis.tone
    };
    return store._session;
  },
  applyStoppedSessionAnalysis: async (sessionId, analysis) => {
    calls.stoppedAnalyses.push(analysis);
    store._session = {
      ...store._session,
      csatScore: analysis.csatScore,
      predictedCsat: analysis.predictedCsat,
      predictedConfidence: analysis.predictedConfidence,
      predictedReasoning: analysis.predictedReasoning,
      predictedSignals: analysis.predictedSignals,
      csatSource: analysis.csatSource,
      riskLevel: analysis.riskLevel,
      tone: analysis.tone,
      toneReason: analysis.toneReason,
      toneSource: analysis.toneSource
    };
    return store._session;
  },
  recordObservations: async (session, observations, options) => {
    calls.observations.push({ sessionId: session.id, observations, options });
  },
  finalizeReminderLoop: async () => {
    const partial = store._session.completionStatus === "partial";
    store._session = {
      ...store._session,
      status: partial ? "partial" : "no_response",
      reminderDueAt: null,
      conversationState: {
        ...(store._session.conversationState || {}),
        state: "completed",
        reminderExhausted: true,
        closureReason: partial ? "partial_after_three_reminders" : "no_response_after_three_reminders"
      }
    };
    return store._session;
  },
  stopSessionForCycle: async (sessionId, options = {}) => {
    store._session = {
      ...store._session,
      status: "opted_out",
      reminderDueAt: null,
      conversationState: {
        ...(store._session.conversationState || {}),
        state: "completed",
        stoppedByAdmin: true,
        stoppedBy: options.actorName || "Dashboard user",
        stopReason: options.reason || null,
        closureReason: "stopped_by_admin"
      }
    };
    return store._session;
  },
  getDueFeedbackTargets: async () => [{ projectKey: project.key, cycleType: "pulse" }],
  updateProjectAutomationSettings: async (projectId, input) => {
    assert.strictEqual(projectId, project.id);
    if (input.automaticFeedbackEnabled !== undefined) {
      if (input.automaticFeedbackEnabled && project.automaticFeedbackEnabled === false) {
        project.nextCycleDueAt = "2026-11-12T00:00:00.000Z";
      }
      project.automaticFeedbackEnabled = input.automaticFeedbackEnabled;
    }
    if (input.automaticQuickCheckinEnabled !== undefined) {
      if (input.automaticQuickCheckinEnabled && project.automaticQuickCheckinEnabled === false) {
        project.automaticQuickCheckinResumeAt = "2026-11-21T04:30:00.000Z";
      }
      project.automaticQuickCheckinEnabled = input.automaticQuickCheckinEnabled;
    }
    return { ...project };
  },
  getInactiveFinalSweepCandidates: async () => store._inactiveFinalSweepCandidates,
  markInactiveFinalSweepClaimed: async (sessionId, conversationState) => {
    calls.inactiveCompletionClaims.push({ sessionId, conversationState });
    store._session = {
      ...store._session,
      conversationState,
      reminderDueAt: null
    };
    return store._session;
  },
  completeInactiveFinalSweep: async (sessionId, conversationState, completedAt) => {
    calls.inactiveCompletionFinishes.push({ sessionId, conversationState, completedAt });
    store._session = {
      ...store._session,
      status: "completed",
      completionStatus: "completed",
      completedAt,
      reminderDueAt: null,
      conversationState
    };
    return store._session;
  },
  markInactiveFinalSweepDeliveryFailure: async (sessionId, conversationState, reminderDueAt) => {
    calls.inactiveCompletionFailures.push({ sessionId, conversationState, reminderDueAt });
    store._session = { ...store._session, conversationState, reminderDueAt };
    return store._session;
  },
  finalizeExpiredInactiveFinalSweeps: async () => store._expiredInactiveFinalSweeps,
  expireDueQuickCheckins: async () => store._expiredQuickCheckins,
  quickCheckinSessionSummary: async (sessionId) => ({
    cycle: { id: "cyc_quick_summary", projectId: project.id, cycleType: "quick_checkin", status: "closed", csatScore: null },
    project,
    poc,
    sessions: [{ ...store._session, id: sessionId, sessionType: "quick_checkin" }],
    messages: calls.messages.filter((message) => message.sessionId === sessionId),
    issues: [],
    appreciations: [],
    observations: [],
    recipients: []
  }),
  getDueReminderTargets: async () => [{
    session: store._session,
    poc,
    projectKey: project.key,
    projectName: project.name,
    reminderKind: store._session.completionStatus === "partial" ? "complete_partial_feedback" : "no_response",
    reminderAction: (Number(store._session.reminderCount) || 0) >= 3 ? "close_after_grace" : "send_reminder"
  }],
  listProjectCycles: async () => store._projectCycles,
  listProjectSessions: async () => store._projectSessions,
  listProjectIssues: async () => store._projectIssues,
  getIssue: async () => ({ id: "iss_1", status: "open" }),
  updateIssueStatus: async (issueId, action) => ({ id: issueId, status: action === "close" ? "closed" : "open" }),
  getDashboard: async () => ({ projects: [project], metrics: { projectCount: 1 }, clusters: [], clients: [], openIssues: [], openCycles: [] }),
  getProjectPerformanceData: async () => ({
    projects: [{ ...project, team: { amId: "ip_1" }, version: 0, performanceStatus: null, clientSentiment: null, kpis: [], auditHistory: [] }],
    clients: [{ id: "cl_1", key: "test", name: "Test Client", activeStatus: "active" }],
    internalPocs: [{ id: "ip_1", name: "Internal Owner", active: true }],
    serviceCatalog: [{ id: "cat_design", serviceKey: "design", name: "Design", active: true }],
    serviceChangeRequests: store._serviceChangeRequests.map((request) => ({ ...request })),
    referenceValues: {
      client_criticality: [{ value: "Critical" }, { value: "High" }],
      client_group: [],
      project_type: [{ value: "Performance Only" }],
      revenue_category: [{ value: "Below 25 L" }],
      portfolio_type: [{ value: "Portfolio" }],
      currency: [{ value: "INR" }, { value: "USD" }],
      performance_status: [{ value: "On Track" }],
      current_phase: [{ value: "Execution" }],
      campaign_status: [{ value: "LIVE" }],
      client_sentiment: [{ value: "Positive" }],
      relationship_strength: [{ value: "Good" }],
      meeting_cadence: [{ value: "Monthly" }],
      suggestion_frequency: [{ value: "Monthly" }],
      kpi_name: [{ value: "Leads" }]
    },
    financialYears: ["2026-2027"]
  }),
  getAppUserByEmail: async (email) => {
    const normalized = String(email).toLowerCase();
    if (normalized === "employee@srvmedia.com") {
      if (!store._appUserActive) return null;
      return { id: "app_user_1", email: "employee@srvmedia.com", name: "SRV Employee", role: store._appUserRole, internalPocId: "ip_1", active: true };
    }
    const user = store._applicationUsers.find((item) => item.email.toLowerCase() === normalized);
    return user ? { ...user } : null;
  },
  listAppUsers: async () => store._applicationUsers.map((user) => ({ ...user })),
  createAppUser: async (input) => {
    const user = { id: `app_user_${store._applicationUsers.length + 1}`, ...input };
    store._applicationUsers.push(user);
    return { ...user };
  },
  activeSuperAdminCount: async () => store._applicationUsers.filter((user) => user.role === "super_admin" && user.active).length,
  deleteAppUserIfNoHistory: async (id) => {
    const user = store._applicationUsers.find((item) => item.id === id);
    if (!user) return null;
    if (user.hasHistory) return { action: "blocked", reason: "history", hasAuditHistory: true, hasCurrentProjectUpdates: false };
    store._applicationUsers = store._applicationUsers.filter((item) => item.id !== id);
    return { action: "deleted", deleted: 1, user };
  },
  saveProjectPerformance: async (projectId, input) => {
    calls.performanceSaves.push({ projectId, input });
    return { saved: true, projectId, version: 1, changes: { "project.performance_status": { before: null, after: "On Track" } } };
  },
  getMessagingStatus: async () => store._messagingStatus,
  setMessagingStatus: async (enabled, updatedBy) => {
    store._messagingStatus = {
      enabled: Boolean(enabled),
      updatedAt: new Date().toISOString(),
      updatedBy
    };
    return store._messagingStatus;
  },
  recordAutomationEvent: async (event) => { calls.automation.push(event); return event; },
  claimAutomationEvent: async (eventType, payload, dedupeKey) => {
    if (calls.automationClaims.has(dedupeKey)) return null;
    const row = {
      id: `auto_${calls.automationClaims.size + 1}`,
      eventType, payload, dedupeKey, status: "pending"
    };
    calls.automationClaims.set(dedupeKey, row);
    calls.automation.push(row);
    return row;
  },
  completeAutomationEvent: async (eventId, event) => {
    const row = calls.automation.find((item) => item.id === eventId);
    if (row) Object.assign(row, event);
    return row || null;
  },
  getAutomationEventByDedupeKey: async (key) => calls.automationClaims.get(key) || null,
  queueFeedbackSummary: async (sessionId) => {
    if (sessionId === store._session.id) store._session.conversationState.summaryPendingSince ||= new Date().toISOString();
  },
  feedbackSessionSummary: async (sessionId) => {
    const expired = store._expiredQuickCheckins.sessions.find((session) => session.id === sessionId);
    if (expired?.sessionType === "quick_checkin") {
      return { ...(await store.quickCheckinSessionSummary(sessionId)), sessions: [expired] };
    }
    return store._cycleSummary ? { ...store._cycleSummary, poc, sessions: [store._session], messages: calls.messages } : null;
  },
  isCycleComplete: async () => store._cycleComplete,
  cycleSummary: async () => store._cycleSummary,
  getDirectory: async () => ({ clusters: [{ id: "clu_1", name: "Existing" }], clients: [{ id: "cl_1", key: "test", name: "Test Client" }], projects: [project], pocLevels: [{ id: "normal", name: "Normal", weight: 40 }, { id: "important", name: "Important", weight: 60 }], departments: [], subDepartments: [], internalPocs: [] }),
  pocLevels: async () => new Map([
    ["normal", { id: "normal", name: "Normal", weight: 40 }],
    ["important", { id: "important", name: "Important", weight: 60 }]
  ]),
  getClientDetail: async (id) => (id === "cl_1" ? { client: { id: "cl_1", name: "Test Client" }, projects: [project], pocs: [poc], services: project.services } : null),
  updatePocLevelWeights: async (updates) => {
    if (updates.some((item) => !["normal", "important"].includes(item.id))) return { status: "not_found" };
    const normal = updates.find((item) => item.id === "normal")?.weight ?? 1;
    const important = updates.find((item) => item.id === "important")?.weight ?? 2;
    if (important <= normal) return { status: "invalid_order" };
    if (normal + important !== 100) return { status: "invalid_total" };
    calls.updatedPocLevels.push(updates);
    return {
      status: "updated",
      levels: updates.map((item) => ({ id: item.id, name: item.id === "normal" ? "Normal" : "Important", weight: item.weight }))
    };
  },
  projectKeyExists: async (key, exceptId) => String(key).toLowerCase() === "taken2627" && exceptId !== "prj_1",
  whatsappOwner: async (phone, exceptId) => (phone === "919999999999" && exceptId !== "poc_1" ? poc : null),
  whatsappConflict: async (phone, projectId, exceptId) => {
    if (phone !== "919999999999" || exceptId === "poc_1") return null;
    return projectId === "prj_1" ? { kind: "same_project", owner: poc } : null;
  },
  whatsappConflictForClient: async () => null,
  createProject: async (input) => {
    const created = { id: `prj_new_${calls.createdProjects.length + 1}`, ...input };
    calls.createdProjects.push(created);
    return created;
  },
  createCluster: async (input) => ({ id: "clu_new", ...input }),
  internalPocById: async (id) => id === "ip_1"
    ? { id: "ip_1", name: "Internal Owner", email: "owner@srvmedia.com", active: true }
    : store._internalPocs.find((item) => item.id === id) || null,
  internalPocByEmail: async (email) => store._internalPocs.find((item) => item.email?.toLowerCase() === String(email).toLowerCase()) || null,
  createInternalPoc: async (input) => {
    const person = { id: `ip_new_${store._internalPocs.length + 1}`, ...input };
    store._internalPocs.push(person);
    calls.createdInternalPocs.push(person);
    return { ...person };
  },
  updateInternalPoc: async (id, input) => (id === "ip_1" ? { id, ...input } : null),
  deleteInternalPoc: async (id) => id === "ip_1"
    ? { internalPocsDeleted: 1, servicesUnassigned: 2, directReportsUnassigned: 1, appUsersUnlinked: 1, projectTeamAssignmentsCleared: 2 }
    : { internalPocsDeleted: 0, servicesUnassigned: 0, directReportsUnassigned: 0, appUsersUnlinked: 0, projectTeamAssignmentsCleared: 0 },
  createDepartment: async (input) => ({ id: "dep_new", ...input }),
  createSubDepartment: async (input) => ({ id: "sub_new", ...input }),
  deleteDepartment: async (id) => id === "dep_1"
    ? { departmentsDeleted: 1, subDepartmentsDeleted: 2, internalPocsUnassigned: 1 }
    : { departmentsDeleted: 0, subDepartmentsDeleted: 0, internalPocsUnassigned: 0 },
  deleteSubDepartment: async (id) => id === "sub_1"
    ? { subDepartmentsDeleted: 1, internalPocsUnassigned: 1 }
    : { subDepartmentsDeleted: 0, internalPocsUnassigned: 0 },
  managerChainWouldLoop: async (id, managerId) => managerId === "ip_loop",
  subDepartmentBelongsTo: async (subId, deptId) => !(subId === "sub_other" && deptId === "dep_1"),
  createProjectService: async (input) => {
    const created = { id: `svc_new_${calls.createdServices.length + 1}`, ...input };
    calls.createdServices.push(created);
    return created;
  },
  serviceCatalogConflict: async () => false,
  createServiceCatalogItem: async (input) => {
    const created = { id: `catalog_${calls.createdCatalogServices.length + 1}`, ...input };
    calls.createdCatalogServices.push(created);
    return created;
  },
  updateProjectService: async (id, input) => ({ id, ...input }),
  deleteProjectService: async (id) => { calls.deletedServices.push(id); return true; },
  servicesForProject: async (projectId) => project.services.filter((service) => service.projectId === projectId),
  hasOpenFeedbackCycle: async () => Boolean(store._hasOpenFeedbackCycle),
  listServiceChangeRequests: async ({ projectIds = null, status = null } = {}) => store._serviceChangeRequests
    .filter((request) => !projectIds || projectIds.includes(request.projectId))
    .filter((request) => !status || request.status === status)
    .map((request) => ({ ...request })),
  getServiceChangeRequest: async (id) => {
    const request = store._serviceChangeRequests.find((item) => item.id === id);
    return request ? { ...request } : null;
  },
  findPendingServiceChangeRequest: async (input) => store._serviceChangeRequests.find((request) => (
    request.projectId === input.projectId
    && request.status === "pending"
    && request.requestType === input.requestType
    && (!input.serviceCatalogId || request.serviceCatalogId === input.serviceCatalogId)
    && (!input.projectServiceId || request.projectServiceId === input.projectServiceId)
    && (!input.requestedServiceName || request.requestedServiceName?.toLowerCase() === input.requestedServiceName.toLowerCase())
  )) || null,
  createServiceChangeRequest: async (input) => {
    const service = input.projectServiceId
      ? project.services.find((item) => item.id === input.projectServiceId)
      : null;
    const catalog = input.serviceCatalogId === "cat_design" ? { name: "Design" } : null;
    const request = {
      id: `service_request_${store._serviceChangeRequests.length + 1}`,
      ...input,
      projectKey: project.key,
      projectName: project.name,
      clientId: project.clientId,
      clientName: "Test Client",
      serviceName: service?.name || catalog?.name || input.requestedServiceName,
      status: "pending",
      notificationStatus: "pending",
      notificationError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store._serviceChangeRequests.push(request);
    calls.serviceChangeRequests.push(request);
    return { ...request };
  },
  updateServiceChangeRequestNotification: async (id, input) => {
    const request = store._serviceChangeRequests.find((item) => item.id === id);
    if (!request) return null;
    Object.assign(request, {
      notificationStatus: input.status,
      notificationError: input.error || null,
      notifiedAt: input.notifiedAt || null,
      updatedAt: new Date().toISOString()
    });
    return { ...request };
  },
  reviewServiceChangeRequest: async (id, input) => {
    const request = store._serviceChangeRequests.find((item) => item.id === id && item.status === "pending");
    if (!request) return null;
    Object.assign(request, {
      status: input.status,
      reviewedByAppUserId: input.reviewedByAppUserId,
      reviewedByEmail: input.reviewedByEmail,
      reviewNote: input.reviewNote,
      reviewedAt: input.reviewedAt,
      updatedAt: new Date().toISOString()
    });
    return { ...request };
  },
  serviceKeyExists: async (projectId, key, exceptId) => key === "ppc" && exceptId !== "svc_1",
  updateCluster: async (id, input) => (id === "clu_1" ? { id, ...input } : null),
  deleteCluster: async (id) => {
    if (id !== "clu_1") return { clustersDeleted: 0, clientsUnassigned: 0, internalPocsUnassigned: 0 };
    calls.deletedClusters.push(id);
    return { clustersDeleted: 1, clientsUnassigned: 1, internalPocsUnassigned: 2 };
  },
  clusterNameExists: async (name, exceptId) => name === "Existing" && exceptId !== "clu_1",
  createClient: async (input) => ({ id: "cl_new", ...input }),
  updateClient: async (id, input) => (id === "cl_1" ? { id, ...input } : null),
  clientKeyExists: async (key, exceptId) => key === "taken-client" && exceptId !== "cl_1",
  updateProject: async (id, input) => {
    if (id === "nope") return null;
    calls.updatedProjects.push({ id, input });
    return { id, ...input };
  },
  createClientPoc: async (input) => {
    const created = { ...input, id: `poc_new_${calls.createdPocs.length + 1}` };
    calls.createdPocs.push(created);
    return created;
  },
  updateClientPoc: async (id, input) => (id === "poc_1" ? { id, ...input } : null),
  removeProjectPocs: async (projectId, ids) => { calls.removedProjectPocs.push({ projectId, ids }); return ids.length; },
  saveProjectPocBatch: async function (projectId, prepared, removedIds) {
    calls.savedPocBatches.push({ projectId, prepared, removedIds });
    return SupabaseStore.prototype.saveProjectPocBatch.call(this, projectId, prepared, removedIds);
  },
  deleteClientPocs: async (ids) => { calls.deletedClientPocs.push([...ids]); return { pocsDeleted: ids.length, cyclesRecalculated: 1, emptyCyclesDeleted: 0 }; },
  deleteProjects: async (ids) => { calls.deletedProjects.push([...ids]); return { projectsDeleted: ids.length }; },
  deleteClients: async (ids) => { calls.deletedClients.push([...ids]); return { clientsDeleted: ids.length }; },
  _session: { id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1", status: "started", completionStatus: "not_started", sessionType: "pulse", conversationState: {} },
  _projectCycles: [{ id: "cyc_1", projectId: "prj_1", cycleType: "pulse", status: "closed" }],
  _projectSessions: [{ id: "sess_1", cycleId: "cyc_1", projectId: "prj_1" }],
  _projectIssues: [{ id: "iss_1", sessionId: "sess_1", projectId: "prj_1" }],
  _atomicDuplicateIds: new Set(),
  _cycleComplete: false,
  _cycleSummary: null,
  _inactiveFinalSweepCandidates: [],
  _expiredInactiveFinalSweeps: [],
  _expiredQuickCheckins: { expired: 0, sessions: [] },
  _messagingStatus: { enabled: true, updatedAt: null, updatedBy: null },
  _appUserRole: "super_admin",
  _internalPocs: [],
  _serviceChangeRequests: [],
  _appUserActive: true,
  _applicationUsers: [
    { id: "app_user_1", email: "employee@srvmedia.com", name: "SRV Employee", role: "super_admin", active: true, permissions: {} },
    { id: "app_user_clean", email: "clean@srvmedia.com", name: "Clean User", role: "project_user", active: true, permissions: {}, internalPocId: "ip_1" },
    { id: "app_user_history", email: "history@srvmedia.com", name: "History User", role: "project_user", active: true, permissions: {}, internalPocId: "ip_1", hasHistory: true },
    { id: "app_user_admin", email: "admin@srvmedia.com", name: "Admin User", role: "admin", active: true, permissions: {} }
  ],
  _injectRapidRatingMessages: false,
  _rapidRatingMessagesInjected: false
};

// Inject the stub in place of the real store factory.
const storePath = path.join(__dirname, "..", "src", "lib", "store.js");
require.cache[require.resolve(storePath)] = new Module(storePath, module);
require.cache[require.resolve(storePath)].exports = { createStore: () => store };
require.cache[require.resolve(storePath)].loaded = true;

const TEST_APP_PASSWORD = "test-login-password";
process.env.APP_LOGIN_PASSWORD = TEST_APP_PASSWORD;

const { handleApiRequest } = require("../src/server/api-handler");

function rawReq(method, pathname, body = {}, headers = {}) {
  return handleApiRequest({ method, path: pathname, body, headers, searchParams: new URLSearchParams(), baseUrl: "https://csat.srvmedia.com" });
}

let appCookie = "";
let googleAppCookie = "";
function req(method, pathname, body = {}, headers = {}) {
  const requestHeaders = { ...headers };
  if (appCookie && !Object.prototype.hasOwnProperty.call(requestHeaders, "cookie")) {
    requestHeaders.cookie = appCookie;
  }
  return rawReq(method, pathname, body, requestHeaders);
}

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, e.message]); }
}

(async () => {
  await scenario("GET /api/health reports v2", async () => {
    const res = await req("GET", "/api/health");
    assert.strictEqual(JSON.parse(res.body).version, "v2");
  });

  await scenario("browser APIs reject requests without a login session", async () => {
    const res = await rawReq("GET", "/api/projects");
    assert.strictEqual(res.statusCode, 401);
    assert.match(JSON.parse(res.body).error, /authentication required/i);
  });

  await scenario("auth status reports configured but signed out", async () => {
    const res = await rawReq("GET", "/api/auth/status");
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), {
      configured: true,
      passwordConfigured: true,
      googleConfigured: false,
      authenticated: false,
      accessAuthorized: false,
      user: null,
      sessionHours: 12
    });
  });

  await scenario("Google login fails closed until every production secret is configured", async () => {
    const res = await rawReq("GET", "/api/auth/google/start");
    assert.strictEqual(res.statusCode, 503);
    assert.match(JSON.parse(res.body).error, /google login is not configured/i);
  });

  await scenario("Google Workspace login verifies the hosted domain and creates the normal app session", async () => {
    const { OAuth2Client } = require("google-auth-library");
    const prior = {
      id: process.env.GOOGLE_CLIENT_ID,
      secret: process.env.GOOGLE_CLIENT_SECRET,
      domains: process.env.GOOGLE_ALLOWED_DOMAINS
    };
    const priorGetToken = OAuth2Client.prototype.getToken;
    const priorVerifyIdToken = OAuth2Client.prototype.verifyIdToken;
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_ALLOWED_DOMAINS = "srvmedia.com";
    OAuth2Client.prototype.getToken = async () => ({ tokens: { id_token: "verified-test-token" } });
    OAuth2Client.prototype.verifyIdToken = async () => ({
      getPayload: () => ({
        sub: "google-user-1",
        email: "employee@srvmedia.com",
        email_verified: true,
        hd: "srvmedia.com",
        name: "SRV Employee"
      })
    });
    try {
      const start = await rawReq("GET", "/api/auth/google/start");
      assert.strictEqual(start.statusCode, 302);
      assert.match(start.headers.location, /^https:\/\/accounts\.google\.com\//);
      const state = new URL(start.headers.location).searchParams.get("state");
      const stateCookie = String(start.headers["set-cookie"]).split(";")[0];
      assert.ok(state);

      const callback = await handleApiRequest({
        method: "GET",
        path: "/api/auth/google/callback",
        searchParams: new URLSearchParams({ code: "test-code", state }),
        headers: { cookie: stateCookie },
        body: {},
        baseUrl: "https://csat.srvmedia.com"
      });
      assert.strictEqual(callback.statusCode, 303);
      assert.strictEqual(callback.headers.location, "/dashboard");
      assert.ok(Array.isArray(callback.headers["set-cookie"]));
      const sessionCookieHeader = callback.headers["set-cookie"][0].split(";")[0];
      googleAppCookie = sessionCookieHeader;
      const status = await rawReq("GET", "/api/auth/status", {}, { cookie: sessionCookieHeader });
      const statusPayload = JSON.parse(status.body);
      assert.strictEqual(statusPayload.authenticated, true);
      assert.strictEqual(statusPayload.user.email, "employee@srvmedia.com");
      assert.strictEqual(statusPayload.user.hostedDomain, "srvmedia.com");
      const beforeSaves = calls.performanceSaves.length;
      const update = await rawReq("PUT", "/api/project-performance/prj_1", {
        updatedBy: "Spoofed Editor",
        expectedVersion: 0,
        clientProfile: {},
        profile: { financialYear: "2026-2027", currency: "INR", team: {}, links: {} },
        kpis: []
      }, { cookie: sessionCookieHeader });
      assert.strictEqual(update.statusCode, 200);
      assert.strictEqual(calls.performanceSaves.length, beforeSaves + 1);
      assert.strictEqual(calls.performanceSaves.at(-1).input.updatedBy, "employee@srvmedia.com");
    } finally {
      OAuth2Client.prototype.getToken = priorGetToken;
      OAuth2Client.prototype.verifyIdToken = priorVerifyIdToken;
      if (prior.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = prior.id;
      if (prior.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = prior.secret;
      if (prior.domains === undefined) delete process.env.GOOGLE_ALLOWED_DOMAINS; else process.env.GOOGLE_ALLOWED_DOMAINS = prior.domains;
    }
  });

  await scenario("Project User is restricted to Project Performance, creates paused projects, and requests service changes", async () => {
    store._appUserRole = "project_user";
    const portfolio = await rawReq("GET", "/api/project-performance", {}, { cookie: googleAppCookie });
    assert.strictEqual(portfolio.statusCode, 200);
    const dashboard = await rawReq("GET", "/api/dashboard", {}, { cookie: googleAppCookie });
    assert.strictEqual(dashboard.statusCode, 403);
    const created = await rawReq("POST", "/api/project-performance/projects", {
      clientId: "cl_1",
      key: "role-project",
      name: "Role Project",
      startDate: "2026-10-01",
      endDate: "2027-03-31",
      feedbackIntervalDays: 30
    }, { cookie: googleAppCookie });
    assert.strictEqual(created.statusCode, 201);
    assert.strictEqual(JSON.parse(created.body).project.activeStatus, "paused");
    const beforeDeletes = calls.deletedServices.length;
    const removed = await rawReq("DELETE", "/api/project-performance/projects/prj_1/services/svc_ppc", {}, { cookie: googleAppCookie });
    assert.strictEqual(removed.statusCode, 403);
    assert.strictEqual(calls.deletedServices.length, beforeDeletes);
    const requested = await rawReq("POST", "/api/project-performance/projects/prj_1/service-change-requests", {
      requestType: "remove_existing",
      projectServiceId: "svc_ppc",
      reason: "The service is no longer part of the signed project scope."
    }, { cookie: googleAppCookie });
    assert.strictEqual(requested.statusCode, 201);
    assert.strictEqual(JSON.parse(requested.body).request.status, "pending");
    assert.strictEqual(JSON.parse(requested.body).request.serviceName, "PPC / Media");
    assert.strictEqual(calls.deletedServices.length, beforeDeletes);
    const duplicate = await rawReq("POST", "/api/project-performance/projects/prj_1/service-change-requests", {
      requestType: "remove_existing",
      projectServiceId: "svc_ppc",
      reason: "Submitting the same request should be blocked."
    }, { cookie: googleAppCookie });
    assert.strictEqual(duplicate.statusCode, 409);
    const newServiceRequest = await rawReq("POST", "/api/project-performance/projects/prj_1/service-change-requests", {
      requestType: "add_new",
      requestedServiceName: "Influencer Strategy",
      reason: "The newly approved scope includes influencer strategy."
    }, { cookie: googleAppCookie });
    assert.strictEqual(newServiceRequest.statusCode, 201);
    assert.strictEqual(JSON.parse(newServiceRequest.body).request.serviceName, "Influencer Strategy");
    assert.strictEqual(JSON.parse(newServiceRequest.body).request.status, "pending");
    store._appUserRole = "super_admin";
  });

  await scenario("An inactive or unassigned Google user keeps authentication but receives no application access", async () => {
    store._appUserActive = false;
    const status = await rawReq("GET", "/api/auth/status", {}, { cookie: googleAppCookie });
    const payload = JSON.parse(status.body);
    assert.strictEqual(payload.authenticated, true);
    assert.strictEqual(payload.accessAuthorized, false);
    assert.strictEqual(payload.user.email, "employee@srvmedia.com");
    const portfolio = await rawReq("GET", "/api/project-performance", {}, { cookie: googleAppCookie });
    assert.strictEqual(portfolio.statusCode, 403);
    store._appUserActive = true;
  });

  await scenario("incorrect login password is rejected without a cookie", async () => {
    const res = await rawReq("POST", "/api/auth/login", { password: "wrong-password" });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.headers["set-cookie"], undefined);
  });

  await scenario("missing login configuration fails closed", async () => {
    delete process.env.APP_LOGIN_PASSWORD;
    try {
      const status = await rawReq("GET", "/api/auth/status");
      assert.strictEqual(JSON.parse(status.body).configured, false);
      const login = await rawReq("POST", "/api/auth/login", { password: TEST_APP_PASSWORD });
      assert.strictEqual(login.statusCode, 503);
      const projects = await rawReq("GET", "/api/projects");
      assert.strictEqual(projects.statusCode, 503);
    } finally {
      process.env.APP_LOGIN_PASSWORD = TEST_APP_PASSWORD;
    }
  });

  await scenario("valid login sets a signed secure HttpOnly cookie", async () => {
    const res = await rawReq("POST", "/api/auth/login", { password: TEST_APP_PASSWORD });
    assert.strictEqual(res.statusCode, 200);
    const setCookie = res.headers["set-cookie"];
    assert.match(setCookie, /^srv_csat_session=[^;]+;/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Max-Age=43200/);
    assert.strictEqual(res.headers["cache-control"], "no-store");
    appCookie = setCookie.split(";")[0];
  });

  await scenario("auth status accepts the valid session cookie", async () => {
    const res = await req("GET", "/api/auth/status");
    assert.strictEqual(JSON.parse(res.body).authenticated, true);
  });

  await scenario("tampering with the session cookie invalidates it", async () => {
    const res = await rawReq("GET", "/api/projects", {}, { cookie: `${appCookie}x` });
    assert.strictEqual(res.statusCode, 401);
  });

  await scenario("logout clears the browser cookie", async () => {
    const res = await req("POST", "/api/auth/logout");
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers["set-cookie"], /^srv_csat_session=;/);
    assert.match(res.headers["set-cookie"], /Max-Age=0/);
  });

  await scenario("WhatsApp machine routes do not require the browser cookie", async () => {
    const res = await rawReq("POST", "/api/whatsapp/inbound", {
      from: "+91 11111 11111",
      text: "hello"
    });
    assert.strictEqual(res.statusCode, 404);
    assert.doesNotMatch(JSON.parse(res.body).error, /authentication required/i);
  });

  await scenario("GET /api/projects returns projects", async () => {
    const res = await req("GET", "/api/projects");
    assert.strictEqual(JSON.parse(res.body).projects.length, 1);
  });

  await scenario("GET /api/project-performance returns the portfolio model", async () => {
    const res = await req("GET", "/api/project-performance");
    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.projects.length, 1);
    assert.deepStrictEqual(payload.financialYears, ["2026-2027"]);
  });

  await scenario("PUT /api/project-performance saves standardized current data", async () => {
    const before = calls.performanceSaves.length;
    const res = await req("PUT", "/api/project-performance/prj_1", {
      updatedBy: "Test Editor",
      expectedVersion: 0,
      clientProfile: { clientGroup: "", clientCriticality: "Critical" },
      profile: {
        financialYear: "2026-2027",
        projectType: "Performance Only",
        revenueCategory: "Below 25 L",
        portfolioType: "Portfolio",
        team: { amId: "ip_1" },
        currency: "INR",
        fxRateToInr: 1,
        poAmountLocal: 500000,
        performanceStatus: "On Track",
        currentPhase: "Execution",
        campaignStatus: "LIVE",
        clientSentiment: "Positive",
        relationshipStrength: "Good",
        meetingCadence: "Monthly",
        suggestionFrequency: "Monthly",
        links: {}
      },
      kpis: [{ kpiName: "Leads", unit: "number", direction: "higher_better", target: 100, actual: 90 }]
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls.performanceSaves.length, before + 1);
    assert.strictEqual(calls.performanceSaves.at(-1).projectId, "prj_1");
    assert.strictEqual(calls.performanceSaves.at(-1).input.profile.performanceStatus, "On Track");
  });

  await scenario("PUT /api/project-performance rejects non-standard dropdown values", async () => {
    const res = await req("PUT", "/api/project-performance/prj_1", {
      updatedBy: "Test Editor",
      expectedVersion: 0,
      clientProfile: {},
      profile: { financialYear: "2026-2027", currency: "Bitcoin", team: {}, links: {} },
      kpis: []
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /currency must be selected/i);
  });

  await scenario("Project Performance persistence keeps CSAT active status untouched and writes an audit", async () => {
    const provider = Object.create(SupabaseStore.prototype);
    const profiles = [];
    const clientProfiles = [];
    const kpiRows = [];
    const audits = [];
    provider.getProjectById = async () => ({ ...project, activeStatus: "active" });
    provider.request = async (table, options = {}) => {
      const method = options.method || "GET";
      if (method === "GET") {
        if (table === "project_performance_profiles") return [...profiles];
        if (table === "client_performance_profiles") return [...clientProfiles];
        if (table === "project_performance_kpis") return [...kpiRows];
      }
      if (method === "POST") {
        const rows = (Array.isArray(options.body) ? options.body : [options.body]).map((row, index) => ({
          id: `${table}_${index + 1}`,
          created_at: "2026-10-06T10:00:00.000Z",
          updated_at: "2026-10-06T10:00:00.000Z",
          ...row
        }));
        if (table === "project_performance_profiles") profiles.push(...rows);
        if (table === "client_performance_profiles") clientProfiles.push(...rows);
        if (table === "project_performance_kpis") kpiRows.push(...rows);
        if (table === "project_performance_audit") audits.push(...rows);
        return rows;
      }
      if (method === "PATCH" && table === "project_performance_profiles") {
        Object.assign(profiles[0], options.body);
        return [profiles[0]];
      }
      if (method === "PATCH" && table === "client_performance_profiles") {
        Object.assign(clientProfiles[0], options.body);
        return [clientProfiles[0]];
      }
      if (method === "DELETE" && table === "project_performance_kpis") {
        return kpiRows.splice(0, kpiRows.length);
      }
      throw new Error(`Unexpected persistence request ${method} ${table}`);
    };

    const saved = await provider.saveProjectPerformance(project.id, {
      updatedBy: "Ashish",
      expectedVersion: 0,
      clientProfile: { clientCriticality: "Critical" },
      profile: {
        financialYear: "2026-2027",
        performanceStatus: "On Track",
        currency: "INR",
        team: {},
        links: {}
      },
      kpis: [{ kpiName: "Leads", target: 100, actual: 90, isPrimary: true }]
    });
    assert.strictEqual(saved.version, 1);
    assert.strictEqual(profiles[0].performance_status, "On Track");
    assert.strictEqual(clientProfiles[0].client_criticality, "Critical");
    assert.strictEqual(Object.hasOwn(profiles[0], "active_status"), false);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].updated_by, "Ashish");
    assert.strictEqual(kpiRows.length, 1);
    const priorVaultKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const secret = "test-only-zoho-password";
      const repeated = [{ kpiName: "Leads", comment: "MBA IT", target: 100, actual: 200, isPrimary: true }, { kpiName: "Leads", comment: "Technology Management", target: 100, actual: 200, isPrimary: false }];
      await provider.saveProjectPerformance(project.id, { updatedBy: "Ashish", expectedVersion: 1, profile: { zohoDashboardLink: "https://example.com/dashboard", zohoPassword: secret }, kpis: repeated });
      assert.equal(kpiRows.length, 2, "identical KPI names and numbers are not deduplicated");
      assert.deepEqual(kpiRows.map((row) => row.comment), ["MBA IT", "Technology Management"]);
      assert.equal(profiles[0].zoho_dashboard_link, "https://example.com/dashboard");
      const ciphertext = profiles[0].zoho_password_encrypted;
      assert.ok(ciphertext && !ciphertext.includes(secret));
      assert.equal(await provider.getProjectZohoPassword(project.id), secret);
      assert.ok(!JSON.stringify(audits).includes(secret));
      assert.ok(!JSON.stringify(audits).includes(ciphertext));
      await provider.saveProjectPerformance(project.id, { updatedBy: "Ashish", expectedVersion: 2, profile: {}, kpis: repeated });
      assert.equal(profiles[0].zoho_password_encrypted, ciphertext, "unrelated updates and workbook imports preserve stored credentials");
      assert.equal(profiles[0].zoho_dashboard_link, "https://example.com/dashboard");
      await provider.saveProjectPerformance(project.id, { updatedBy: "Ashish", expectedVersion: 3, profile: { zohoPassword: "" }, kpis: repeated });
      assert.equal(profiles[0].zoho_password_encrypted, null);
      assert.equal(await provider.getProjectZohoPassword(project.id), "");
    } finally { if (priorVaultKey === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY; else process.env.CREDENTIALS_ENCRYPTION_KEY = priorVaultKey; }
  });

  await scenario("Zoho credential reveal requires sign-in and the assigned Project User scope", async () => {
    const previousRole = store._appUserRole;
    const previousGet = store.getProjectById;
    store._appUserRole = "project_user";
    store.getProjectById = async (id) => id === project.id ? project : null;
    store.getProjectZohoPassword = async () => "test-only-revealed-password";
    try {
      assert.equal((await rawReq("GET", "/api/project-performance/prj_1/zoho-password")).statusCode, 401);
      const allowed = await rawReq("GET", "/api/project-performance/prj_1/zoho-password", {}, { cookie: googleAppCookie });
      assert.equal(allowed.statusCode, 200);
      assert.equal(allowed.headers["cache-control"], "no-store");
      assert.equal(JSON.parse(allowed.body).password, "test-only-revealed-password");
      const denied = await rawReq("GET", "/api/project-performance/foreign-project/zoho-password", {}, { cookie: googleAppCookie });
      assert.equal(denied.statusCode, 403);
      assert.ok(!denied.body.includes("test-only-revealed-password"));
    } finally { store._appUserRole = previousRole; store.getProjectById = previousGet; delete store.getProjectZohoPassword; }
  });

  await scenario("Application User deletion is allowed only without Project Performance history", async () => {
    const provider = Object.create(SupabaseStore.prototype);
    let hasHistory = true;
    let deleted = false;
    provider.request = async (table, options = {}) => {
      const method = options.method || "GET";
      if (table === "app_users" && method === "GET") {
        return [{ id: "app_delete_test", email: "delete.test@srvmedia.com", name: "Delete Test", role: "project_user" }];
      }
      if (table === "project_performance_audit") return hasHistory ? [{ id: "audit_1" }] : [];
      if (table === "project_performance_profiles") return [];
      if (table === "app_users" && method === "DELETE") {
        deleted = true;
        return [{ id: "app_delete_test" }];
      }
      throw new Error(`Unexpected Application User deletion request ${method} ${table}`);
    };

    const blocked = await provider.deleteAppUserIfNoHistory("app_delete_test");
    assert.strictEqual(blocked.action, "blocked");
    assert.strictEqual(deleted, false);
    hasHistory = false;
    const removed = await provider.deleteAppUserIfNoHistory("app_delete_test");
    assert.strictEqual(removed.action, "deleted");
    assert.strictEqual(deleted, true);
  });

  await scenario("Project Performance Standards delete without changing saved project values", async () => {
    const provider = Object.create(SupabaseStore.prototype);
    const requests = [];
    provider.request = async (table, options = {}) => {
      requests.push({ table, options });
      const method = options.method || "GET";
      if (table === "performance_reference_values" && method === "GET") {
        return [{ id: "ref_1", category: "performance_status", value: "On Track", active: true }];
      }
      if (table === "performance_reference_values" && method === "DELETE") return [{ id: "ref_1" }];
      throw new Error(`Unexpected standard deletion request ${method} ${table}`);
    };
    const result = await provider.deletePerformanceReferenceValue("ref_1");
    assert.strictEqual(result.action, "deleted");
    assert.strictEqual(result.value, "On Track");
    assert.strictEqual(requests.some(({ table }) => table === "project_performance_profiles"), false);
  });

  await scenario("GET /api/projects/:key/workspace", async () => {
    const res = await req("GET", "/api/projects/acme-ug/workspace");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).project.key, "acme-ug");
  });

  await scenario("project automatic sending controls preserve manual sends, open data and POC influence", async () => {
    const previous = {
      feedback: project.automaticFeedbackEnabled,
      quick: project.automaticQuickCheckinEnabled,
      quickResumeAt: project.automaticQuickCheckinResumeAt,
      nextDue: project.nextCycleDueAt
    };
    const pocWeight = poc.weightPercentage;
    const sessionBefore = store._session;
    const automationClaimsBefore = new Map(calls.automationClaims);
    calls.createdCycleRequests.length = 0;
    calls.automation.length = 0;
    try {
      const turnedOff = await req("PUT", `/api/projects/${project.key}/automation-settings`, {
        automaticFeedbackEnabled: false,
        automaticQuickCheckinEnabled: false
      });
      assert.strictEqual(turnedOff.statusCode, 200, turnedOff.body);
      const offPayload = JSON.parse(turnedOff.body);
      assert.strictEqual(offPayload.project.automaticFeedbackEnabled, false);
      assert.strictEqual(offPayload.project.automaticQuickCheckinEnabled, false);
      assert.strictEqual(poc.weightPercentage, pocWeight, "POC influence must not be changed");
      assert.strictEqual(store._session, sessionBefore, "existing sessions must not be changed");
      assert.ok(calls.automation.some((event) => event.eventType === "project_automatic_sending_changed"));

      const scheduled = await req("POST", "/api/automation/create-due-sessions", {});
      assert.strictEqual(scheduled.statusCode, 201);
      const scheduledPayload = JSON.parse(scheduled.body);
      assert.strictEqual(scheduledPayload.cycles.length, 0);
      assert.strictEqual(scheduledPayload.skipped.length, 1);
      assert.match(scheduledPayload.skipped[0].reason, /automatic 30-day feedback is turned off/i);

      const manual = await req("POST", `/api/projects/${project.key}/request-feedback`, {
        cycleType: "pulse",
        clientPocIds: [poc.id]
      });
      assert.strictEqual(manual.statusCode, 201, manual.body);
      assert.strictEqual(calls.createdCycleRequests.at(-1).options.automatic, false);

      const turnedOn = await req("PUT", `/api/projects/${project.key}/automation-settings`, {
        automaticFeedbackEnabled: true,
        automaticQuickCheckinEnabled: true
      });
      assert.strictEqual(turnedOn.statusCode, 200, turnedOn.body);
      const onProject = JSON.parse(turnedOn.body).project;
      assert.strictEqual(onProject.automaticFeedbackEnabled, true);
      assert.strictEqual(onProject.automaticQuickCheckinEnabled, true);
      assert.ok(onProject.automaticQuickCheckinResumeAt, "quick check-in reactivation must wait for the next scheduled date");
      assert.notStrictEqual(onProject.nextCycleDueAt, previous.nextDue, "reactivation must start a fresh interval");
      assert.strictEqual(poc.weightPercentage, pocWeight);
    } finally {
      project.automaticFeedbackEnabled = previous.feedback;
      project.automaticQuickCheckinEnabled = previous.quick;
      project.automaticQuickCheckinResumeAt = previous.quickResumeAt;
      project.nextCycleDueAt = previous.nextDue;
      store._session = sessionBefore;
      calls.createdCycleRequests.length = 0;
      calls.automationClaims.clear();
      for (const [key, value] of automationClaimsBefore) calls.automationClaims.set(key, value);
    }
  });

  await scenario("manual rating questions advance the correct survey state", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const { processWhatsAppReply, STATES } = require("../src/lib/whatsapp-state-machine");
    const manualOverall = {
      body: "How would you like to rate SRV Media out of 10?",
      createdAt: new Date().toISOString(),
      metadata: { manualOutbound: true }
    };
    assert.strictEqual(conversationFlow.manualQuestionType(manualOverall, "pulse"), "overall_rating");
    assert.strictEqual(conversationFlow.manualQuestionType({
      ...manualOverall,
      body: "How would you like to rate SRV Media?"
    }, "pulse"), "overall_rating", "the dashboard user's natural wording should be recognised");
    assert.strictEqual(conversationFlow.manualQuestionType({
      ...manualOverall,
      body: "How likely are you to recommend SRV Media out of 10?"
    }, "pulse"), null, "monthly feedback must never activate NPS");
    assert.strictEqual(conversationFlow.manualQuestionType({
      ...manualOverall,
      body: "How likely are you to recommend SRV Media out of 10?"
    }, "project_end"), "nps");

    const projectEndSession = conversationFlow.applyManualQuestionContext({
      id: "sess_manual_rating",
      projectId: project.id,
      clientPocId: poc.id,
      sessionType: "project_end",
      conversationState: {
        sessionType: "project_end",
        state: "waiting_for_more_services",
        pendingQuestionType: "final_sweep",
        mentionedServices: {},
        projectEndReviewAsked: true,
        projectEndReviewCaptured: true,
        serviceScopeStatus: "overall_feedback",
        overallRating: null,
        npsScore: null,
        anythingElseAnswered: false
      }
    }, manualOverall);
    assert.strictEqual(projectEndSession.conversationState.state, STATES.WAITING_FOR_OVERALL_RATING);
    assert.strictEqual(projectEndSession.conversationState.overallRatingAsked, true);

    const ratingTurn = processWhatsAppReply({
      session: projectEndSession,
      project,
      poc,
      text: "8",
      manualContext: true,
      geminiUnavailable: true
    });
    assert.strictEqual(ratingTurn.conversationState.overallRating, 8);
    assert.strictEqual(ratingTurn.conversationState.state, STATES.WAITING_FOR_NPS);

    const npsTurn = processWhatsAppReply({
      session: { ...projectEndSession, conversationState: ratingTurn.conversationState },
      project,
      poc,
      text: "9",
      geminiUnavailable: true
    });
    assert.strictEqual(npsTurn.conversationState.npsScore, 9);
    assert.strictEqual(npsTurn.conversationState.pendingQuestionType, "final_sweep");
    assert.match(npsTurn.nextMessage.body, /anything else.*Directors/i);

    const closeTurn = processWhatsAppReply({
      session: { ...projectEndSession, conversationState: npsTurn.conversationState },
      project,
      poc,
      text: "No",
      geminiUnavailable: true
    });
    assert.strictEqual(closeTurn.conversationState.anythingElseAnswered, true);
    assert.strictEqual(closeTurn.conversationState.state, STATES.CLOSING_GRACE);

    const monthlySession = conversationFlow.applyManualQuestionContext({
      ...projectEndSession,
      sessionType: "pulse",
      conversationState: {
        ...projectEndSession.conversationState,
        sessionType: "pulse",
        serviceScopeStatus: "skip_remaining_services",
        readyForOverallRating: true,
        projectEndReviewCaptured: false,
        npsScore: null,
        askedForAnythingElse: false,
        anythingElseAnswered: false
      }
    }, manualOverall);
    const monthlyRating = processWhatsAppReply({
      session: monthlySession,
      project,
      poc,
      text: "7.5",
      manualContext: true,
      geminiUnavailable: true
    });
    assert.strictEqual(monthlyRating.conversationState.overallRating, 7.5);
    assert.strictEqual(monthlyRating.conversationState.pendingQuestionType, "final_sweep");
    assert.notStrictEqual(monthlyRating.conversationState.state, STATES.WAITING_FOR_NPS);
  });

  await scenario("dashboard manual WhatsApp sends through n8n and stores one contextual transcript message", async () => {
    const priorFetch = global.fetch;
    const priorWebhook = process.env.N8N_MANUAL_MESSAGE_WEBHOOK;
    const priorSession = store._session;
    const priorMessages = [...calls.messages];
    const requestId = "manual-send-test-1";
    let outbound = null;
    try {
      process.env.N8N_MANUAL_MESSAGE_WEBHOOK = "https://n8n.example/webhook/csat-manual-whatsapp-message";
      store._session = {
        ...priorSession,
        status: "partial",
        completionStatus: "partial",
        lastClientResponseAt: new Date().toISOString(),
        conversationState: {
          state: "waiting_for_service_feedback",
          pendingQuestionType: "service",
          pendingServiceKey: "website",
          mentionedServices: {}
        }
      };
      calls.messages.length = 0;
      calls.messages.push({
        id: "msg_client_manual_context",
        sessionId: store._session.id,
        side: "client",
        speaker: poc.name,
        body: "Can someone confirm this for me?",
        createdAt: new Date().toISOString(),
        metadata: { source: "whatsapp" }
      });
      calls.automationClaims.delete(`manual_whatsapp_message:session:${store._session.id}:request:${requestId}`);
      global.fetch = async (url, options) => {
        outbound = { url, options, body: JSON.parse(options.body) };
        return { ok: true, status: 200 };
      };

      const res = await req(
        "POST",
        `/api/sessions/${store._session.id}/manual-whatsapp-message`,
        { text: "Thank you. We are checking this for you.", requestId }
      );
      assert.strictEqual(res.statusCode, 201, res.body);
      assert.strictEqual(outbound.url, process.env.N8N_MANUAL_MESSAGE_WEBHOOK);
      assert.strictEqual(outbound.body.eventType, "manual_whatsapp_message");
      assert.strictEqual(outbound.body.to, poc.contactWhatsapp);
      assert.strictEqual(outbound.body.text, "Thank you. We are checking this for you.");
      const saved = calls.messages.at(-1);
      assert.strictEqual(saved.side, "srv");
      assert.strictEqual(saved.metadata.manualOutbound, true);
      assert.strictEqual(saved.metadata.manualQuestionType, null);
      assert.strictEqual(saved.metadata.manualRequestId, requestId);
      assert.strictEqual(store._session.conversationState.pendingServiceKey, "website");
    } finally {
      global.fetch = priorFetch;
      if (priorWebhook === undefined) delete process.env.N8N_MANUAL_MESSAGE_WEBHOOK;
      else process.env.N8N_MANUAL_MESSAGE_WEBHOOK = priorWebhook;
      store._session = priorSession;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      calls.automationClaims.delete(`manual_whatsapp_message:session:${priorSession.id}:request:${requestId}`);
    }
  });

  await scenario("dashboard manual WhatsApp blocks free text outside the 24-hour client window", async () => {
    const priorSession = store._session;
    const priorMessages = [...calls.messages];
    try {
      const oldReplyAt = new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString();
      store._session = { ...priorSession, lastClientResponseAt: oldReplyAt };
      calls.messages.length = 0;
      calls.messages.push({
        id: "msg_old_client_reply",
        sessionId: store._session.id,
        side: "client",
        body: "Old reply",
        createdAt: oldReplyAt,
        metadata: {}
      });
      const res = await req(
        "POST",
        `/api/sessions/${store._session.id}/manual-whatsapp-message`,
        { text: "This must not be sent as free text.", requestId: "manual-expired-test" }
      );
      assert.strictEqual(res.statusCode, 409);
      assert.match(JSON.parse(res.body).error, /24-hour WhatsApp reply window is closed/i);
      assert.ok(!calls.messages.some((message) => message.body === "This must not be sent as free text."));
    } finally {
      store._session = priorSession;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
    }
  });

  await scenario("retired /api/clients returns 410 with direction", async () => {
    const res = await req("GET", "/api/clients");
    assert.strictEqual(res.statusCode, 410);
    assert.ok(/\/api\/projects/.test(res.body));
  });

  await scenario("POST request-feedback starts a cycle and fires one event per POC", async () => {
    calls.automation.length = 0;
    const res = await req("POST", "/api/projects/acme-ug/request-feedback", { cycleType: "pulse" });
    assert.strictEqual(res.statusCode, 201);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.dispatched.length, 1);
    assert.ok(/\/project\?project=acme-ug&session=sess_1/.test(payload.dispatched[0].resumeUrl), payload.dispatched[0].resumeUrl);
    assert.strictEqual(calls.automation.filter((e) => e.eventType === "feedback_started").length, 1);
  });

  await scenario("manual feedback can target an explicit selection of project POCs", async () => {
    const res = await req("POST", "/api/projects/acme-ug/request-feedback", {
      cycleType: "project_end",
      clientPocIds: ["poc_1", "poc_1"]
    });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(calls.createdCycleRequests.at(-1).options.clientPocIds, ["poc_1"]);
  });

  await scenario("project-end feedback permanently blocks monthly and quick check-in sends", async () => {
    const previous = project.endFeedbackRequestedAt;
    project.endFeedbackRequestedAt = "2026-09-29T12:00:00.000Z";
    try {
      const monthly = await req("POST", "/api/projects/acme-ug/request-feedback", { cycleType: "pulse" });
      assert.strictEqual(monthly.statusCode, 409);
      assert.match(JSON.parse(monthly.body).error, /recurring feedback is closed/i);

      const quick = await req("POST", "/api/projects/acme-ug/request-feedback", { cycleType: "quick_checkin" });
      assert.strictEqual(quick.statusCode, 409);

      const resendProjectEnd = await req("POST", "/api/projects/acme-ug/request-feedback", {
        cycleType: "project_end",
        clientPocIds: ["poc_1"]
      });
      assert.strictEqual(resendProjectEnd.statusCode, 201);
    } finally {
      if (previous === undefined) delete project.endFeedbackRequestedAt;
      else project.endFeedbackRequestedAt = previous;
    }
  });

  await scenario("manual feedback rejects a selected POC from another project", async () => {
    const before = calls.createdCycleRequests.length;
    const res = await req("POST", "/api/projects/acme-ug/request-feedback", {
      cycleType: "pulse",
      clientPocIds: ["poc_foreign"]
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.createdCycleRequests.length, before);
  });

  await scenario("legacy scheduled feedback without a POC selection still targets all active POCs", async () => {
    const res = await req("POST", "/api/projects/acme-ug/request-feedback", { cycleType: "pulse" });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(Object.hasOwn(calls.createdCycleRequests.at(-1).options, "clientPocIds"), false);
  });

  await scenario("an active session blocks a quick check-in for the same WhatsApp number on another project", async () => {
    const guardStore = Object.create(SupabaseStore.prototype);
    guardStore.getProject = async () => ({
      id: "prj_second",
      key: "second-project",
      name: "Second Project",
      pocs: [{ ...poc, id: "poc_second", projectId: "prj_second" }]
    });
    guardStore.hasAnyCycle = async () => false;
    guardStore.getWhatsappRoutingContext = async () => ({
      status: "active",
      poc,
      session: { id: "session_first", projectId: "prj_first", sessionType: "quick_checkin" }
    });
    guardStore.getProjectById = async () => ({ id: "prj_first", name: "First Project" });
    await assert.rejects(
      () => guardStore.createCycle("second-project", { cycleType: "quick_checkin" }),
      /already has an active feedback request on First Project/i
    );
  });

  await scenario("WhatsApp inbound routes phone -> POC -> session and replies", async () => {
    const res = await req("POST", "/api/whatsapp/inbound", {
      from: "+91 99999 99999",
      text: "website changes are slow",
      providerMessageId: "wamid.aaa"
    });
    assert.strictEqual(res.statusCode, 201);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.sendToWhatsapp, true);
    assert.ok(payload.whatsappReplyText.length > 0);
    assert.strictEqual(payload.poc.id, "poc_1");
  });

  await scenario("Broad monthly feedback offers a rating transition while legacy scope choices still resume safely", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_feedback",
        pendingQuestionType: "service",
        pendingServiceKey: "ppc",
        mentionedServices: {},
        turnCount: 1
      }
    };
    const modelPayloads = [];
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ output_text: JSON.stringify(modelPayloads.shift()) })
    });
    try {
      modelPayloads.push(
        {
          intent: "feedback",
          deferRequested: false,
          serviceScope: "overall_feedback",
          sentiment: "positive",
          rating: null,
          serviceHint: null,
          serviceHints: [],
          explainsProblem: false,
          isObservation: false,
          serviceFeedback: [],
          observations: [],
          appreciations: []
        },
        {
          message: "How has PPC / Media been for you?",
          captured: [{
            serviceKey: "ppc", sentiment: "positive",
            summary: "The partnership improved", declined: false, needsFollowUp: false
          }],
          observations: [],
          appreciations: [],
          overallRating: null,
          corrects: false,
          readyToClose: false,
          deferRequested: false,
          serviceScope: "overall_feedback",
          askedForOverallRating: false,
          askedForAppreciation: false,
          askedForAnythingElse: false,
          askedForServiceScope: false,
          askedServiceKey: "ppc"
        }
      );
      const broad = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "We had a few hiccups initially, then things fell into place and I value the partnership.",
        providerMessageId: "wamid.overall-scope"
      });
      const broadPayload = JSON.parse(broad.body);
      assert.strictEqual(broad.statusCode, 201);
      assert.match(broadPayload.whatsappReplyText, /add anything else.*overall rating/i);
      assert.doesNotMatch(broadPayload.whatsappReplyText, /on a scale|out of 10/i);
      assert.strictEqual(store._session.conversationState.pendingQuestionType, "rating_feedback");
      assert.strictEqual(store._session.conversationState.serviceScopeStatus, "awaiting_choice");
      assert.deepStrictEqual(store._session.conversationState.mentionedServices, {});

      const scopeState = JSON.parse(JSON.stringify(store._session.conversationState));
      // Previously sent continue/skip questions must retain their meaning.
      store._session.conversationState = { ...scopeState, ratingFeedbackPause: null,
        state: "waiting_for_service_scope", pendingQuestionType: "service_scope" };
      modelPayloads.push({
        message: "How has PPC / Media been for you?",
        captured: [], observations: [], appreciations: [], overallRating: null,
        corrects: false, readyToClose: false, deferRequested: false,
        serviceScope: "continue_service_by_service",
        askedForOverallRating: false, askedForAppreciation: false,
        askedForAnythingElse: false, askedForServiceScope: false,
        askedServiceKey: "ppc"
      });
      const continued = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "yes",
        providerMessageId: "wamid.overall-continue"
      });
      assert.strictEqual(continued.statusCode, 201);
      assert.match(JSON.parse(continued.body).whatsappReplyText, /PPC/i);
      assert.strictEqual(store._session.conversationState.serviceScopeStatus, "service_by_service");
      assert.strictEqual(store._session.conversationState.pendingServiceKey, "ppc");

      store._session = {
        ...store._session,
        conversationState: scopeState
      };
      modelPayloads.push({
        message: "Before the overall rating, is there any team you would like to appreciate?",
        captured: [], observations: [], appreciations: [], overallRating: null,
        corrects: false, readyToClose: false, deferRequested: false,
        serviceScope: "skip_remaining_services",
        askedForOverallRating: false, askedForAppreciation: true,
        askedForAnythingElse: false, askedForServiceScope: false,
        askedServiceKey: null
      });
      const skipped = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "no",
        providerMessageId: "wamid.overall-skip"
      });
      assert.strictEqual(skipped.statusCode, 201);
      assert.match(JSON.parse(skipped.body).whatsappReplyText, /overall.*rate|rate.*overall/i);
      assert.strictEqual(store._session.conversationState.serviceScopeStatus, "skipped");
      assert.ok(Object.values(store._session.conversationState.mentionedServices)
        .every((service) => service.status === "declined" && service.sentiment === "neutral"),
      JSON.stringify(store._session.conversationState.mentionedServices));
      assert.strictEqual(store._session.conversationState.overallRating, null);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("Mixed onboarding feedback receives a nuanced Gemini acknowledgement before the rating choice", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    const priorServices = project.services;
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    project.services = [
      { id: "svc_account", projectId: "prj_1", serviceKey: "account", name: "Account Management" },
      { id: "svc_creatives", projectId: "prj_1", serviceKey: "creatives", name: "Creatives" },
      { id: "svc_campaign", projectId: "prj_1", serviceKey: "campaign", name: "Campaign Management" }
    ];
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_feedback",
        pendingQuestionType: "service",
        pendingServiceKey: "account",
        mentionedServices: {},
        turnCount: 1
      }
    };
    const clientText = "The client servicing is good and the team is proactive. We have had a good experience so far. Since ours was a last minute onboarding and there were teething issues at our end, we would like to see the full potential of the team in terms of creatives and videos. The learning phase is over and we are very satisfied.";
    const modelPayloads = [
      {
        intent: "feedback", deferRequested: false, serviceScope: "overall_feedback",
        sentiment: "positive", rating: null, serviceHint: "Account Management",
        serviceHints: ["Account Management", "Creatives"], explainsProblem: true,
        isObservation: false,
        serviceFeedback: [
          { serviceHint: "Account Management", sentiment: "positive", summary: "Client servicing is proactive and good", declined: false, needsFollowUp: false },
          { serviceHint: "Creatives", sentiment: "neutral", summary: "They now expect the team's full creative and video potential", declined: false, needsFollowUp: false }
        ],
        observations: [], appreciations: []
      },
      {
        message: "Thank you for appreciating the proactive team and sharing that you are very satisfied overall. We also recognise your expectation to now see the full creative and video potential. Would you like to add anything else, or shall we move to the overall rating?",
        acknowledgement: "It is encouraging to hear the team has been proactive and that you are very satisfied overall. We also recognise your expectation to now see the full creative and video potential.",
        captured: [
          { serviceKey: "account", sentiment: "positive", summary: "Client servicing is proactive and good", declined: false, needsFollowUp: false },
          { serviceKey: "creatives", sentiment: "neutral", summary: "They now expect the team's full creative and video potential", declined: false, needsFollowUp: false }
        ],
        observations: [], appreciations: [], overallRating: null,
        corrects: false, readyToClose: false, deferRequested: false,
        serviceScope: "overall_feedback", askedForOverallRating: false,
        askedForAppreciation: false, askedForAnythingElse: false,
        askedForServiceScope: false, askedForRatingTransition: true, askedServiceKey: null
      }
    ];
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ output_text: JSON.stringify(modelPayloads.shift()) })
    });
    try {
      const response = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: clientText,
        providerMessageId: "wamid.nuanced-onboarding"
      });
      const payload = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 201);
      assert.match(payload.whatsappReplyText, /proactive/i);
      assert.match(payload.whatsappReplyText, /full creative and video potential/i);
      assert.match(payload.whatsappReplyText, /add anything else.*overall rating/i);
      assert.strictEqual(payload.nextMessage.metadata.provider, "gemini_conducted");
      assert.strictEqual(payload.session.conversationState.serviceScopeStatus, "awaiting_choice");
      assert.strictEqual(
        payload.analysis.services.find((item) => item.serviceKey === "creatives").sentiment,
        "neutral"
      );
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
      project.services = priorServices;
    }
  });

  await scenario("a deferred client gets an acknowledgement without another service question", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    delete process.env.GEMINI_API_KEY;
    calls.messages.length = 0;
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_feedback",
        pendingQuestionType: "service",
        pendingServiceKey: "ppc",
        mentionedServices: {},
        turnCount: 2,
        repeatCount: 1
      }
    };
    try {
      const res = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "Will revert asap",
        providerMessageId: "wamid.defer-without-generation"
      });
      const payload = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 201);
      assert.match(payload.whatsappReplyText, /take your time/i);
      assert.match(payload.whatsappReplyText, /session is saved/i);
      assert.doesNotMatch(payload.whatsappReplyText, /how has|what is working/i);
      assert.strictEqual(payload.nextMessage.metadata.deferred, true);
      assert.strictEqual(payload.nextMessage.metadata.provider, "state_machine");
      assert.strictEqual(payload.nextMessage.metadata.fallbackReason, null);
      assert.strictEqual(store._session.conversationState.state, "waiting_for_service_feedback");
      assert.strictEqual(store._session.conversationState.pendingServiceKey, "ppc");
      assert.strictEqual(store._session.conversationState.repeatCount, 0);
      assert.ok(store._session.conversationState.deferredAt);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("Ready then Let's start resumes once without a duplicate or false service answer", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    delete process.env.GEMINI_API_KEY;
    calls.messages.length = 0;
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_feedback",
        sessionType: "pulse",
        pendingQuestionType: "service",
        pendingServiceKey: "ppc",
        mentionedServices: {
          ppc: {
            serviceKey: "ppc",
            serviceName: "PPC / Media",
            status: "needs_feedback",
            sentiment: "neutral",
            reasonText: null,
            reasonTags: [],
            rating: null
          }
        },
        turnCount: 2,
        repeatCount: 0,
        guardrailHits: [],
        deferredAt: new Date().toISOString()
      }
    };

    try {
      const ready = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "Ready",
        providerMessageId: "wamid.resume-ready"
      });
      const readyPayload = JSON.parse(ready.body);
      assert.strictEqual(ready.statusCode, 201);
      assert.strictEqual(readyPayload.sendToWhatsapp, true);
      assert.match(readyPayload.whatsappReplyText, /How has PPC \/ Media been for you/i);
      assert.strictEqual(store._session.conversationState.pendingQuestionType, "service");
      assert.strictEqual(store._session.conversationState.mentionedServices.ppc.status, "needs_feedback");

      const serviceRepliesBefore = calls.messages.filter((message) => message.side === "srv").length;
      const start = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "Let’s start",
        providerMessageId: "wamid.resume-start"
      });
      const startPayload = JSON.parse(start.body);
      assert.strictEqual(start.statusCode, 200);
      assert.strictEqual(startPayload.suppressed, true);
      assert.strictEqual(startPayload.suppressionReason, "consecutive_resumption");
      assert.strictEqual(startPayload.sendToWhatsapp, false);
      assert.strictEqual(
        calls.messages.filter((message) => message.side === "srv").length,
        serviceRepliesBefore,
        "the second conversational bubble must not create another bot reply"
      );
      assert.strictEqual(store._session.conversationState.pendingQuestionType, "service");
      assert.strictEqual(store._session.conversationState.mentionedServices.ppc.status, "needs_feedback");
      assert.strictEqual(store._session.conversationState.mentionedServices.ppc.reasonText, null);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("a Gemini-read pure defer uses one model call and no conductor call", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    let modelCalls = 0;
    global.fetch = async () => {
      modelCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({
            intent: "defer",
            deferRequested: true,
            sentiment: "neutral",
            rating: null,
            serviceHint: null,
            serviceHints: [],
            explainsProblem: false,
            isObservation: false,
            serviceFeedback: [],
            observations: [],
            appreciations: []
          })
        })
      };
    };
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_feedback",
        pendingQuestionType: "service",
        pendingServiceKey: "ppc",
        mentionedServices: {},
        turnCount: 2,
        repeatCount: 0
      }
    };
    try {
      const res = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "I need to review this properly before responding",
        providerMessageId: "wamid.model-pure-defer"
      });
      const payload = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(modelCalls, 1,
        "once Gemini identifies defer, response generation must not call it again");
      assert.match(payload.whatsappReplyText, /take your time/i);
      assert.strictEqual(payload.nextMessage.metadata.provider, "state_machine");
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("the response-writing call cannot invent a defer missed by the interpretation", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    let modelCalls = 0;
    global.fetch = async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            output_text: JSON.stringify({
              // Simulate the first read understanding the feedback but missing
              // the unfamiliar "circle back" postponement.
              intent: "feedback",
              deferRequested: false,
              sentiment: "positive",
              rating: null,
              serviceHint: "PPC / Media",
              serviceHints: ["PPC / Media"],
              explainsProblem: false,
              isObservation: false,
              serviceFeedback: [{
                serviceHint: "PPC / Media", sentiment: "positive",
                summary: "PPC is good", declined: false, needsFollowUp: false
              }],
              observations: [],
              appreciations: []
            })
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({
            // Deliberately unusable as outgoing text: the defer path must use
            // its deterministic acknowledgement without losing extraction.
            message: "Your issue has been logged.",
            deferRequested: true,
            captured: [{
              serviceKey: "ppc", sentiment: "positive",
              summary: "PPC is good", declined: false, needsFollowUp: false
            }],
            observations: [],
            appreciations: [],
            overallRating: null,
            corrects: false,
            readyToClose: false
          })
        })
      };
    };
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_feedback",
        pendingQuestionType: "service",
        pendingServiceKey: "ppc",
        mentionedServices: {},
        turnCount: 2,
        repeatCount: 0
      }
    };
    try {
      const res = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "PPC is good; I shall circle back once I have reviewed everything else.",
        providerMessageId: "wamid.conductor-mixed-defer"
      });
      const payload = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(modelCalls, 2,
        "this uses the normal interpretation plus conductor calls, not an added third call");
      assert.doesNotMatch(payload.whatsappReplyText, /take your time/i,
        "only the latest-reply interpretation may pause a session");
      assert.doesNotMatch(payload.whatsappReplyText, /logged/i);
      assert.strictEqual(store._session.conversationState.mentionedServices.ppc.sentiment, "positive");
      assert.strictEqual(store._session.conversationState.pendingQuestionType, "service_followup");
      assert.strictEqual(store._session.conversationState.pendingServiceKey, "ppc");
      assert.strictEqual(store._session.conversationState.deferredAt, undefined);
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("mixed feedback is preserved before a deferred client returns", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    delete process.env.GEMINI_API_KEY;
    calls.messages.length = 0;
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_feedback",
        pendingQuestionType: "service",
        pendingServiceKey: "ppc",
        mentionedServices: {},
        turnCount: 2,
        repeatCount: 0
      }
    };
    try {
      const res = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "PPC is good. Billing invoice is inaccurate. I appreciate the Website team. I will revert later.",
        providerMessageId: "wamid.mixed-defer"
      });
      const payload = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 201);
      assert.match(payload.whatsappReplyText, /take your time/i);
      assert.strictEqual(store._session.conversationState.pendingServiceKey, "ppc");
      assert.ok(store._session.conversationState.deferredAt);
      assert.strictEqual(store._session.conversationState.mentionedServices.ppc.sentiment, "positive");
      assert.doesNotMatch(
        store._session.conversationState.mentionedServices.ppc.reasonText || "",
        /billing|invoice|revert/i,
        "non-service and deferral clauses must not leak into PPC feedback"
      );
      assert.strictEqual(store._session.conversationState.mentionedServices.website.explicitAppreciation, true);
      assert.strictEqual(store._session.conversationState.appreciationAnswered, true);
      assert.ok(calls.analyses.at(-1).observations.some((item) => item.topic === "Billing"));
      assert.ok(calls.analyses.at(-1).observations.some((item) => item.kind === "appreciation"));
      assert.deepStrictEqual(
        payload.nextMessage.metadata.deferredCapture.services.sort(),
        ["ppc", "website"]
      );
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("structured deferred extraction keeps all fact types without advancing the pending question", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const stateBefore = {
      state: "waiting_for_service_feedback",
      pendingQuestionType: "service",
      pendingServiceKey: "ppc",
      mentionedServices: {},
      overallRatingAsked: false
    };
    const turn = {
      conversationState: {
        ...JSON.parse(JSON.stringify(stateBefore)),
        deferredAt: new Date().toISOString()
      },
      analysis: { observations: [] }
    };
    const captured = conversationFlow.applyDeferredInterpretation(
      turn,
      stateBefore,
      {
        intent: "feedback",
        deferRequested: true,
        sentiment: "positive",
        rating: 8,
        serviceKeys: ["ppc"],
        explainsProblem: false,
        captured: [{
          serviceKey: "ppc", sentiment: "positive",
          summary: "Budget management is good", needsFollowUp: false
        }],
        observations: [{
          topic: "Billing", detail: "The invoice amount is inaccurate",
          sentiment: "negative", severity: "watch", needsFollowUp: false
        }],
        appreciations: [{
          subject: "Website Team", detail: "The website team has been excellent",
          serviceKey: "website"
        }]
      },
      "PPC budget management is good. The invoice is inaccurate. The website team is excellent. I need time for the rest.",
      project
    );

    assert.deepStrictEqual(captured.captured.map((item) => item.serviceKey).sort(), ["ppc", "website"]);
    assert.strictEqual(turn.conversationState.pendingQuestionType, "service");
    assert.strictEqual(turn.conversationState.pendingServiceKey, "ppc");
    assert.strictEqual(turn.conversationState.overallRating, undefined,
      "a number must not be accepted before the overall-rating question was asked");
    assert.strictEqual(turn.conversationState.appreciationAnswered, true);
    assert.strictEqual(turn.conversationState.pendingObservation, null,
      "an actionable billing observation is saved without creating another interview");
    assert.ok(turn.analysis.observations.some((item) => item.topic === "Billing"));
  });

  await scenario("a rating given with a defer is saved only after the overall question", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const stateBefore = {
      state: "waiting_for_overall_rating",
      pendingQuestionType: "overall_rating",
      pendingServiceKey: null,
      mentionedServices: {},
      overallRatingAsked: true,
      overallRating: null
    };
    const turn = {
      conversationState: {
        ...JSON.parse(JSON.stringify(stateBefore)),
        deferredAt: new Date().toISOString()
      },
      analysis: { observations: [] }
    };
    conversationFlow.applyDeferredInterpretation(
      turn,
      stateBefore,
      {
        intent: "rating",
        deferRequested: true,
        rating: 6,
        serviceKeys: [],
        captured: [],
        observations: [],
        appreciations: []
      },
      "6 for now; I may add more after reviewing everything",
      project
    );
    assert.strictEqual(turn.conversationState.overallRating, 6);
    assert.strictEqual(turn.conversationState.pendingQuestionType, "overall_rating");
    assert.strictEqual(turn.conversationState.state, "waiting_for_overall_rating");
  });

  await scenario("An overall rating closes without a human-handoff event", async () => {
    const closingMessage = "That is everything — thank you for your time. Our team has your feedback and will take it forward with the right people.";
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_overall_rating",
        pendingQuestionType: "overall_rating",
        overallRating: null,
        overallRatingAsked: true,
        readyForOverallRating: true,
        askedForAppreciation: true,
        appreciationAnswered: true,
        askedForAnythingElse: true,
        anythingElseAnswered: true,
        repeatCount: 2,
        lastQuestionAsked: closingMessage,
        mentionedServices: {
          ppc: {
            serviceKey: "ppc", serviceName: "PPC / Media", status: "captured",
            sentiment: "neutral", detailAnswered: true, serviceFollowUpAnswered: true
          },
          website: {
            serviceKey: "website", serviceName: "Website / SEO", status: "captured",
            sentiment: "neutral", detailAnswered: true, serviceFollowUpAnswered: true
          }
        }
      }
    };
    calls.automation.length = 0;
    const res = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "7" });
    const payload = JSON.parse(res.body);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(payload.guardrail, null);
    assert.strictEqual(payload.analysis.csatScore, 7);
    assert.strictEqual(payload.analysis.isComplete, true);
    assert.strictEqual(payload.session.status, "completed");
    assert.ok(/thank you/i.test(payload.whatsappReplyText));
    assert.ok(!calls.automation.some((event) => ["handoff", "human_handoff"].includes(event.eventType)),
      JSON.stringify(calls.automation.map((event) => event.eventType)));
  });

  await scenario("Gemini fallback consumes a final-sweep no without repeating it", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    delete process.env.GEMINI_API_KEY;
    calls.messages.length = 0;
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_more_services",
        pendingQuestionType: "final_sweep",
        askedForAnythingElse: true,
        anythingElseAnswered: false,
        askedForAppreciation: true,
        appreciationAnswered: true,
        readyForOverallRating: true,
        generalSentiment: "positive",
        generalConcernText: "All services are fine. Do not ask about any more services.",
        overallRatingAsked: false,
        overallRating: null,
        lastQuestionAsked: "Overall, how would you rate the work SRV Media has done for you so far, out of 10?",
        repeatCount: 2,
        mentionedServices: {
          ppc: { serviceKey: "ppc", serviceName: "PPC / Media", status: "captured", sentiment: "neutral", serviceFollowUpAnswered: true },
          website: { serviceKey: "website", serviceName: "Website / SEO", status: "captured", sentiment: "neutral", serviceFollowUpAnswered: true }
        }
      }
    };
    try {
      const res = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "no",
        providerMessageId: "wamid.final-sweep-fallback"
      });
      const payload = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 201);
      assert.match(payload.whatsappReplyText, /overall.*rate|rate.*overall/i);
      assert.doesNotMatch(payload.whatsappReplyText, /department we missed/i);
      assert.strictEqual(store._session.conversationState.anythingElseAnswered, true);
      assert.strictEqual(store._session.conversationState.repeatCount, 0);
      assert.notStrictEqual(store._session.conversationState.state, "handed_off");
      assert.strictEqual(
        store._session.conversationState.lastQuestionAsked,
        payload.whatsappReplyText
      );
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("Closing-window fallback acknowledges Billing and praise, then closes briefly", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    delete process.env.GEMINI_API_KEY;
    calls.messages.length = 0;
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "completed", completionStatus: "completed", sessionType: "pulse",
      conversationState: {
        state: "closing_grace",
        pendingQuestionType: null,
        closingGraceExpiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
        askedForAnythingElse: true,
        anythingElseAnswered: true,
        askedForAppreciation: true,
        appreciationAnswered: true,
        overallRatingAsked: true,
        overallRating: 6,
        mentionedServices: {
          ppc: { serviceKey: "ppc", serviceName: "PPC / Media", status: "captured", sentiment: "neutral", serviceFollowUpAnswered: true },
          website: { serviceKey: "website", serviceName: "Website / SEO", status: "captured", sentiment: "neutral", serviceFollowUpAnswered: true }
        }
      }
    };
    try {
      const issue = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "Your billings are inaccurate; please ask the CFO to check the tax invoice. Additionally, I appreciate the creative team; the videos are fantastic.",
        providerMessageId: "wamid.billing-praise-fallback"
      });
      const issuePayload = JSON.parse(issue.body);
      assert.match(issuePayload.whatsappReplyText, /recorded your request/i);
      assert.match(issuePayload.whatsappReplyText, /appreciating (?:the )?Creative Team/i);
      assert.match(issuePayload.whatsappReplyText, /original 10-minute window/i);
      assert.strictEqual(store._session.conversationState.pendingObservation, null);
      assert.strictEqual(store._session.conversationState.appreciationAnswered, true);

      const close = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "no",
        providerMessageId: "wamid.billing-praise-close"
      });
      const closePayload = JSON.parse(close.body);
      assert.match(closePayload.whatsappReplyText, /feedback is recorded|recorded feedback/i);
      assert.doesNotMatch(closePayload.whatsappReplyText, /take care of your health/i,
        "the full original closing speech must not be repeated after every add-on");
      assert.strictEqual(store._session.conversationState.pendingObservation, null);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("Closing-window team appreciation is acknowledged without reopening a service interview", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    delete process.env.GEMINI_API_KEY;
    calls.messages.length = 0;
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "completed", completionStatus: "completed", sessionType: "pulse",
      conversationState: {
        state: "closing_grace",
        sessionType: "pulse",
        pendingQuestionType: null,
        closingGraceExpiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
        askedForAnythingElse: true,
        anythingElseAnswered: true,
        askedForAppreciation: true,
        appreciationAnswered: true,
        overallRatingAsked: true,
        overallRating: 7,
        mentionedServices: {
          ppc: { serviceKey: "ppc", serviceName: "PPC / Media", status: "captured", sentiment: "neutral", serviceFollowUpAnswered: true },
          website: { serviceKey: "website", serviceName: "Website / SEO", status: "captured", sentiment: "neutral", serviceFollowUpAnswered: true }
        }
      }
    };
    try {
      const response = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "I want to appreciate for website team",
        providerMessageId: "wamid.closing-appreciation"
      });
      const payload = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 201);
      assert.match(payload.whatsappReplyText, /thank you for appreciating the Website Team/i);
      assert.match(payload.whatsappReplyText, /share your kind words/i);
      assert.doesNotMatch(payload.whatsappReplyText, /anything else.*Website \/ SEO/i);
      assert.strictEqual(payload.state, "closing_grace");
      assert.match(payload.whatsappReplyText, /original 10-minute window is still open/i);

      const close = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "no",
        providerMessageId: "wamid.closing-appreciation-done"
      });
      const closePayload = JSON.parse(close.body);
      assert.strictEqual(closePayload.state, "closing_grace");
      assert.match(closePayload.whatsappReplyText, /window.*(?:open|close)/i);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("An unnamed appreciated person is acknowledged and requested by name once", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    delete process.env.GEMINI_API_KEY;
    calls.messages.length = 0;
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "completed", completionStatus: "completed", sessionType: "pulse",
      conversationState: {
        state: "closing_grace", sessionType: "pulse", pendingQuestionType: null,
        closingGraceExpiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
        askedForAnythingElse: true, anythingElseAnswered: true,
        askedForAppreciation: true, appreciationAnswered: true,
        overallRatingAsked: true, overallRating: 10,
        mentionedServices: {
          ppc: { serviceKey: "ppc", serviceName: "PPC / Media", status: "captured", sentiment: "neutral", serviceFollowUpAnswered: true },
          website: { serviceKey: "website", serviceName: "Website / SEO", status: "captured", sentiment: "neutral", serviceFollowUpAnswered: true }
        }
      }
    };
    try {
      const mention = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "A special mention for the website manager for being patient and understanding",
        providerMessageId: "wamid.unnamed-person-appreciation"
      });
      const mentionPayload = JSON.parse(mention.body);
      assert.match(mentionPayload.whatsappReplyText, /thank you.*special mention/i);
      assert.match(mentionPayload.whatsappReplyText, /share the .*manager'?s name/i);
      assert.strictEqual(mentionPayload.state, "waiting_for_service_followup");

      const named = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "Neha Sharma",
        providerMessageId: "wamid.appreciation-person-name"
      });
      const namedPayload = JSON.parse(named.body);
      assert.strictEqual(namedPayload.state, "closing_grace");
      assert.strictEqual(store._session.conversationState.mentionedServices.website.appreciationPersonName, "Neha Sharma");
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("Praise answering the appreciation question is acknowledged without a keyword", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const conducted = {
      captured: [{ serviceKey: "website", sentiment: "positive", summary: "The landing pages and video edits were very good", needsFollowUp: false }],
      observations: [],
      appreciations: []
    };
    conversationFlow.ensureClientAppreciations(
      conducted,
      { pendingQuestionType: "appreciation", askedForAppreciation: true, appreciationAnswered: false },
      "The landing page team designed good pages and the video edits were also very good",
      project
    );
    assert.ok(conducted.appreciations.length > 0);
    const reply = conversationFlow.fallbackForAction(
      { type: "overall_rating" },
      { overallRatingAsked: false },
      project,
      conducted
    );
    assert.match(reply, /thank you for appreciating/i);
    assert.match(reply, /share your kind words/i);
    assert.match(reply, /overall.*out of 10/i);
  });

  await scenario("0 then mistake then 8 updates the score without a handoff", async () => {
    const mentionedServices = Object.fromEntries(project.services.map((service) => [
      service.serviceKey,
      { serviceKey: service.serviceKey, serviceName: service.name, status: "captured", sentiment: "neutral" }
    ]));
    store._session = {
      ...store._session,
      status: "partial",
      conversationState: {
        state: "waiting_for_overall_rating",
        pendingQuestionType: "overall_rating",
        overallRatingAsked: true,
        askedForAppreciation: true,
        appreciationAnswered: true,
        askedForAnythingElse: true,
        anythingElseAnswered: true,
        mentionedServices
      }
    };
    store._cycleComplete = false;
    calls.automation.length = 0;

    const zero = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "0" });
    assert.strictEqual(JSON.parse(zero.body).state, "closing_grace");
    const mistake = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "Sorry, that was a mistake" });
    assert.match(JSON.parse(mistake.body).whatsappReplyText, /currently have.*0 out of 10/i);
    const eight = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "Take 8" });
    const payload = JSON.parse(eight.body);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(payload.analysis.csatScore, 8);
    assert.strictEqual(payload.session.csatScore, 8);
    assert.strictEqual(payload.state, "closing_grace");
    assert.ok(!calls.automation.some((event) => ["handoff", "human_handoff", "manager_alert"].includes(event.eventType)),
      JSON.stringify(calls.automation.map((event) => event.eventType)));
  });

  await scenario("G1 duplicate provider message id is ignored", async () => {
    const before = calls.messages.length;
    const res = await req("POST", "/api/whatsapp/inbound", {
      from: "919999999999", text: "website changes are slow", providerMessageId: "wamid.aaa"
    });
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.duplicate, true);
    assert.strictEqual(payload.sendToWhatsapp, false);
    assert.strictEqual(calls.messages.length, before, "no new messages stored");
  });

  await scenario("G1 concurrent duplicate loses the atomic insert claim", async () => {
    const providerMessageId = "wamid.atomic-race";
    store._atomicDuplicateIds.add(providerMessageId);
    const before = calls.messages.length;
    const res = await req("POST", "/api/whatsapp/inbound", {
      from: "919999999999", text: "PPC leads are poor", providerMessageId
    });
    store._atomicDuplicateIds.delete(providerMessageId);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.duplicate, true);
    assert.strictEqual(payload.sendToWhatsapp, false);
    assert.strictEqual(calls.messages.length, before);
  });

  await scenario("a stale slow turn cannot overwrite a newer rapid rating", async () => {
    const mentionedServices = Object.fromEntries(project.services.map((service) => [
      service.serviceKey,
      { serviceKey: service.serviceKey, serviceName: service.name, status: "captured", sentiment: "neutral" }
    ]));
    store._session = {
      ...store._session,
      id: "sess_1",
      status: "partial",
      conversationState: {
        state: "waiting_for_overall_rating",
        pendingQuestionType: "overall_rating",
        overallRatingAsked: true,
        askedForAppreciation: true,
        appreciationAnswered: true,
        askedForAnythingElse: true,
        anythingElseAnswered: true,
        mentionedServices
      }
    };
    calls.messages.length = 0;
    calls.messages.push({
      id: "msg_rating_question", sessionId: "sess_1", side: "srv",
      speaker: "SRV Media MD Office",
      body: "Overall, how would you rate the work SRV Media has done for you so far, out of 10?",
      metadata: { stateAfter: "waiting_for_overall_rating" }
    });
    store._injectRapidRatingMessages = true;
    store._rapidRatingMessagesInjected = false;
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "0" });
      const payload = JSON.parse(response.body);
      assert.strictEqual(payload.analysis.csatScore, 8,
        "the final write must re-read the later 'Take 8' message before persisting");
      assert.strictEqual(payload.session.csatScore, 8);
    } finally {
      store._injectRapidRatingMessages = false;
      store._rapidRatingMessagesInjected = false;
    }
  });

  await scenario("a stale middle correction cannot reopen a session after the newer rating", async () => {
    const mentionedServices = Object.fromEntries(project.services.map((service) => [
      service.serviceKey,
      { serviceKey: service.serviceKey, serviceName: service.name, status: "captured", sentiment: "neutral" }
    ]));
    store._session = {
      ...store._session,
      status: "partial",
      conversationState: {
        state: "waiting_for_overall_rating",
        pendingQuestionType: "overall_rating",
        overallRatingAsked: true,
        askedForAppreciation: true,
        appreciationAnswered: true,
        askedForAnythingElse: true,
        anythingElseAnswered: true,
        mentionedServices
      }
    };
    calls.messages.length = 0;
    calls.messages.push(
      { id: "q", sessionId: "sess_1", side: "srv", body: "Overall, how would you rate the work SRV Media has done for you so far, out of 10?" },
      { id: "r0", sessionId: "sess_1", side: "client", body: "0" },
      { id: "r8", sessionId: "sess_1", side: "client", body: "Take 8" }
    );
    const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "Sorry, that was a mistake" });
    const payload = JSON.parse(response.body);
    assert.strictEqual(payload.state, "closing_grace");
    assert.strictEqual(payload.analysis.csatScore, 8);
    assert.strictEqual(payload.session.status, "completed");
  });

  await scenario("unknown WhatsApp number is rejected, not silently dropped", async () => {
    const res = await req("POST", "/api/whatsapp/inbound", { from: "918888888888", text: "hi" });
    assert.strictEqual(res.statusCode, 404);
  });

  await scenario("WhatsApp Business greetings do not advance full-feedback sessions or promise a handoff", async () => {
    const priorSession = store._session;
    const priorMessages = [...calls.messages];
    const analysesBefore = calls.analyses.length;
    const automationsBefore = calls.automation.length;
    store._session = {
      ...priorSession,
      status: "pending",
      completionStatus: "not_started",
      sessionType: "project_end",
      reminderDueAt: "2099-01-02T00:00:00.000Z",
      conversationState: { state: "waiting_for_project_end_review", turnCount: 0 }
    };
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        providerMessageId: "wamid_business_greeting",
        fromName: "University Admissions",
        text: "Thank you for contacting Chanakya University Admissions Department! Please let us know how we can help you."
      });
      const payload = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(payload.automatedReply, true);
      assert.strictEqual(payload.automatedReplyReason, "business_greeting");
      assert.strictEqual(payload.sendToWhatsapp, false);
      assert.strictEqual(calls.analyses.length, analysesBefore);
      assert.strictEqual(calls.automation.length, automationsBefore);
      assert.strictEqual(store._session.conversationState.state, "waiting_for_project_end_review");
      assert.strictEqual(calls.messages.at(-1).metadata.ignoredForConversation, true);
      assert.strictEqual(calls.messages.at(-1).side, "client");
    } finally {
      store._session = priorSession;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
    }
  });

  await scenario("WhatsApp Business greetings do not advance 30-day feedback sessions", async () => {
    const priorSession = store._session;
    const priorMessages = [...calls.messages];
    const analysesBefore = calls.analyses.length;
    const automationsBefore = calls.automation.length;
    store._session = {
      ...priorSession,
      status: "pending",
      completionStatus: "not_started",
      sessionType: "pulse",
      reminderDueAt: "2099-01-02T00:00:00.000Z",
      conversationState: { state: "waiting_for_service_feedback", turnCount: 0 }
    };
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        providerMessageId: "wamid_monthly_business_greeting",
        fromName: "MIT Vishwaprayag University",
        text: "Thanks for Contacting MIT VISHWAPRAYAG UNIVERSITY SOLAPUR !!! Pls let us know how can we help you"
      });
      const payload = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(payload.automatedReply, true);
      assert.strictEqual(payload.automatedReplyReason, "business_greeting");
      assert.strictEqual(payload.sendToWhatsapp, false);
      assert.strictEqual(calls.analyses.length, analysesBefore);
      assert.strictEqual(calls.automation.length, automationsBefore);
      assert.strictEqual(store._session.status, "pending");
      assert.strictEqual(store._session.conversationState.state, "waiting_for_service_feedback");
      assert.strictEqual(store._session.reminderDueAt, "2099-01-02T00:00:00.000Z");
    } finally {
      store._session = priorSession;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
    }
  });

  await scenario("WhatsApp away replies do not complete quick check-ins or open the ten-minute window", async () => {
    const priorSession = store._session;
    const priorMessages = [...calls.messages];
    const responsesBefore = calls.quickCheckinResponses.length;
    const automationsBefore = calls.automation.length;
    store._session = {
      ...priorSession,
      status: "pending",
      completionStatus: "not_started",
      sessionType: "quick_checkin",
      reminderDueAt: "2099-01-02T00:00:00.000Z",
      conversationState: {
        state: "quick_checkin_choice",
        quickCheckinOutcome: "awaiting_response",
        quickCheckinWindowExpiresAt: null
      }
    };
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        providerMessageId: "wamid_away_reply",
        fromName: "Sri",
        text: "Hello Sriparna this side. Thank you for your message. I am unavailable right now, but will respond as soon as possible."
      });
      const payload = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(payload.automatedReply, true);
      assert.strictEqual(payload.automatedReplyReason, "away_reply");
      assert.strictEqual(payload.sendToWhatsapp, false);
      assert.strictEqual(calls.quickCheckinResponses.length, responsesBefore);
      assert.strictEqual(calls.automation.length, automationsBefore);
      assert.strictEqual(store._session.conversationState.state, "quick_checkin_choice");
      assert.strictEqual(store._session.conversationState.quickCheckinWindowExpiresAt, null);
      assert.strictEqual(calls.messages.at(-1).metadata.ignoredForConversation, true);
    } finally {
      store._session = priorSession;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
    }
  });

  await scenario("a genuine quick check-in postponement stays open and is not mistaken for an automated reply", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorSession = store._session;
    const priorMessages = [...calls.messages];
    const responsesBefore = calls.quickCheckinResponses.length;
    process.env.GEMINI_API_KEY = "test-key";
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        output_text: JSON.stringify({
          intent: "defer", deferRequested: true, serviceScope: "none", sentiment: "neutral", rating: null,
          serviceHint: null, serviceHints: [], explainsProblem: false, isObservation: false,
          serviceFeedback: [], observations: [], appreciations: []
        })
      })
    });
    store._session = {
      ...priorSession,
      status: "pending",
      completionStatus: "not_started",
      sessionType: "quick_checkin",
      reminderDueAt: "2099-01-02T00:00:00.000Z",
      conversationState: {
        state: "quick_checkin_choice",
        quickCheckinOutcome: "awaiting_response",
        quickCheckinWindowExpiresAt: null
      }
    };
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        providerMessageId: "wamid_real_postponement",
        fromName: "Client",
        text: "I am unavailable right now. I will reply later."
      });
      const payload = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 201);
      assert.notStrictEqual(payload.automatedReply, true);
      assert.strictEqual(payload.state, "quick_checkin_choice");
      assert.match(payload.whatsappReplyText, /whenever convenient/i);
      assert.doesNotMatch(payload.whatsappReplyText, /next 10 minutes/i);
      assert.strictEqual(calls.quickCheckinResponses.length, responsesBefore);
      assert.strictEqual(store._session.conversationState.quickCheckinWindowExpiresAt, null);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      store._session = priorSession;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
    }
  });

  await scenario("automated replies after completion do not create human-handoff emails", async () => {
    const priorSession = store._session;
    const priorMessages = [...calls.messages];
    const automationsBefore = calls.automation.length;
    store._session = {
      ...priorSession,
      status: "completed",
      completionStatus: "completed",
      sessionType: "project_end",
      reminderDueAt: null,
      conversationState: { state: "completed" }
    };
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        providerMessageId: "wamid_closed_auto_reply",
        fromName: "Admissions",
        text: "Thank you for contacting us. Please let us know how we can help you."
      });
      const payload = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(payload.automatedReply, true);
      assert.strictEqual(payload.sendToWhatsapp, false);
      assert.strictEqual(calls.automation.length, automationsBefore);
      assert.strictEqual(store._session.status, "completed");
    } finally {
      store._session = priorSession;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
    }
  });

  await scenario("G2 opt-out stops reminders and skips Gemini", async () => {
    calls.automation.length = 0;
    const res = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "STOP" });
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.guardrail, "G2_opt_out");
    assert.ok(calls.automation.some((e) => e.eventType === "opt_out"), JSON.stringify(calls.automation.map((e) => e.eventType)));
    const patch = calls.patches[calls.patches.length - 1];
    assert.strictEqual(patch.options.body.reminder_due_at, null);
    assert.strictEqual(patch.options.body.status, "opted_out");
  });

  await scenario("G3 message after completion does not rewrite the session", async () => {
    const priorWebhook = process.env.N8N_HUMAN_HANDOFF_WEBHOOK;
    const priorFetch = global.fetch;
    const outbound = [];
    process.env.N8N_HUMAN_HANDOFF_WEBHOOK = "https://n8n.example/webhook/csat-human-handoff";
    global.fetch = async (url, options) => {
      outbound.push({ url, options });
      return { ok: true, status: 200 };
    };
    try {
      store._session = { ...store._session, status: "completed", conversationState: { state: "completed", mentionedServices: {}, turnCount: 4 } };
      const analysesBefore = calls.analyses.length;
      calls.automation.length = 0;
      const res = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "Account management has issue" });
      const payload = JSON.parse(res.body);
      const handoff = calls.automation.find((event) => event.eventType === "post_completion_message");
      assert.strictEqual(payload.guardrail, "G3_post_completion");
      assert.strictEqual(calls.analyses.length, analysesBefore, "applyAnalysis must not run on a closed session");
      assert.strictEqual(handoff.status, "sent");
      assert.strictEqual(handoff.webhookUrlConfigured, true);
      assert.strictEqual(outbound[0].url, process.env.N8N_HUMAN_HANDOFF_WEBHOOK);
      assert.strictEqual(payload.postCompletionHandoffEvent.status, "sent");
      assert.ok(!calls.automation.some((event) => event.eventType === "manager_alert"));
      assert.ok(/already closed/i.test(payload.whatsappReplyText));
    } finally {
      if (priorWebhook === undefined) delete process.env.N8N_HUMAN_HANDOFF_WEBHOOK;
      else process.env.N8N_HUMAN_HANDOFF_WEBHOOK = priorWebhook;
      global.fetch = priorFetch;
    }
  });

  await scenario("quick check-in acknowledgements and meeting references keep waiting for feedback", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    const responsesBefore = calls.quickCheckinResponses.length;
    process.env.GEMINI_API_KEY = "test-key";
    global.fetch = async () => { throw new Error("Gemini must not run for deterministic pending-detail replies"); };
    store._session = {
      id: "sess_1", cycleId: "cyc_quick", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "quick_checkin",
      reminderDueAt: "2099-01-02T00:00:00.000Z",
      conversationState: {
        state: "quick_checkin_detail",
        quickCheckinOutcome: "needs_improvement",
        quickCheckinWindowExpiresAt: null
      }
    };
    try {
      const acknowledgement = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "Okay" });
      const acknowledgementPayload = JSON.parse(acknowledgement.body);
      assert.strictEqual(acknowledgementPayload.state, "quick_checkin_detail");
      assert.match(acknowledgementPayload.whatsappReplyText, /share the feedback whenever convenient/i);
      assert.doesNotMatch(acknowledgementPayload.whatsappReplyText, /next 10 minutes/i);
      assert.strictEqual(calls.quickCheckinResponses.length, responsesBefore);

      const meetingReference = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        text: "Discussed the same in the today’s meeting"
      });
      const meetingPayload = JSON.parse(meetingReference.body);
      assert.strictEqual(meetingPayload.state, "quick_checkin_detail");
      assert.match(meetingPayload.whatsappReplyText, /Directors to specifically note or follow up on/i);
      assert.match(meetingPayload.whatsappReplyText, /If everything is covered, just let us know/i);
      assert.doesNotMatch(meetingPayload.whatsappReplyText, /next 10 minutes/i);
      assert.strictEqual(calls.quickCheckinResponses.length, responsesBefore);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("quick check-in understands a natural covered response without exact wording", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    process.env.GEMINI_API_KEY = "test-key";
    global.fetch = async (_url, options) => ({
      ok: true,
      status: 200,
      json: async () => ({
        output_text: JSON.stringify(JSON.parse(options.body).input.includes("Task: verify ONLY")
          ? { decision: "feedback", evidence: "I think we have taken care of everything already" } : {
          intent: "negative", deferRequested: false, serviceScope: "none", sentiment: "neutral", rating: null,
          serviceHint: null, serviceHints: [], explainsProblem: false, isObservation: false,
          serviceFeedback: [], observations: [], appreciations: []
        })
      })
    });
    store._session = {
      id: "sess_1", cycleId: "cyc_quick", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "quick_checkin",
      reminderDueAt: "2099-01-02T00:00:00.000Z",
      conversationState: { state: "quick_checkin_detail", quickCheckinOutcome: "needs_improvement" }
    };
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        text: "I think we have taken care of everything already"
      });
      const payload = JSON.parse(response.body);
      assert.strictEqual(payload.state, "quick_checkin_window");
      assert.strictEqual(payload.session.conversationState.quickCheckinOutcome, "feedback_shared");
      assert.match(payload.whatsappReplyText, /nothing further/i);
      assert.match(payload.whatsappReplyText, /next 10 minutes/i);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("quick check-in starts its window only after substantive feedback", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    process.env.GEMINI_API_KEY = "test-key";
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        output_text: JSON.stringify({
          intent: "feedback", deferRequested: false, serviceScope: "none", sentiment: "positive", rating: null,
          serviceHint: "PPC / Media", serviceHints: ["PPC / Media"], explainsProblem: true, isObservation: false,
          serviceFeedback: [{ serviceHint: "PPC / Media", sentiment: "positive", summary: "PPC reports are clear and timely", declined: false, needsFollowUp: false }],
          observations: [], appreciations: []
        })
      })
    });
    store._session = {
      id: "sess_1", cycleId: "cyc_quick", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "quick_checkin",
      reminderDueAt: "2099-01-02T00:00:00.000Z",
      conversationState: { state: "quick_checkin_detail", quickCheckinOutcome: "needs_improvement" }
    };
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        text: "PPC reports are clear and timely"
      });
      const payload = JSON.parse(response.body);
      assert.strictEqual(payload.state, "quick_checkin_window");
      assert.strictEqual(payload.session.conversationState.quickCheckinOutcome, "feedback_shared");
      assert.match(payload.whatsappReplyText, /feedback has been recorded/i);
      assert.match(payload.whatsappReplyText, /next 10 minutes/i);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("quick check-in closing window preserves concerns and does not record a deferral as new feedback", async () => {
    const priorSession = store._session;
    const priorFetch = global.fetch;
    const priorKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "fixture";
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({
      intent: "defer", deferRequested: true, serviceScope: "none", sentiment: "neutral",
      completionScope: "none", explainsProblem: false, serviceFeedback: [], observations: [], concerns: [], appreciations: []
    }) }) });
    store._session = { id: "sess_1", cycleId: "cyc_quick", projectId: project.id, clientPocId: poc.id,
      sessionType: "quick_checkin", status: "partial", completionStatus: "partial",
      conversationState: { state: "quick_checkin_window", quickCheckinOutcome: "feedback_shared",
        quickCheckinDetail: "The reporting totals are inaccurate.", quickCheckinWindowExpiresAt: "2099-01-01T00:10:00.000Z" } };
    const before = calls.quickCheckinResponses.length;
    try {
      const positive = JSON.parse((await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "all good" })).body);
      assert.match(positive.whatsappReplyText, /earlier feedback remains recorded/i);
      assert.doesNotMatch(positive.whatsappReplyText, /All good response is already recorded/i);
      const later = JSON.parse((await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "I will send the rest tomorrow" })).body);
      assert.equal(later.session.conversationState.quickCheckinDetail, "The reporting totals are inaccurate.");
      assert.equal(later.session.conversationState.quickCheckinWindowExpiresAt, "2099-01-01T00:10:00.000Z");
      assert.equal(calls.quickCheckinResponses.length, before);
    } finally {
      store._session = priorSession; global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
    }
  });

  await scenario("quick check-in separates multiple concerns, acknowledges them, and sends one alert", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    const automationBefore = calls.automation.length;
    process.env.GEMINI_API_KEY = "test-key";
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        output_text: JSON.stringify({
          // Structured concerns must win even when the model's top-level
          // sentiment is inconsistent with its detailed extraction.
          intent: "negative", deferRequested: false, serviceScope: "overall_feedback", sentiment: "neutral", rating: null,
          serviceHint: null, serviceHints: [], explainsProblem: true, isObservation: false,
          serviceFeedback: [], observations: [], appreciations: [],
          concerns: [
            {
              title: "Campaign traction below expectations",
              summary: "The campaign has attracted little attention and applicant numbers do not justify the additional spend.",
              sentiment: "negative", severity: "high", serviceHint: null, needsFollowUp: false
            },
            {
              title: "Applicant-profile reporting is missing",
              summary: "The shared data does not explain the profile of applicants who are signing on.",
              sentiment: "negative", severity: "watch", serviceHint: null, needsFollowUp: false
            },
            {
              title: "More proactive ownership is needed",
              summary: "The client expects SRV to analyse performance and change course when required.",
              sentiment: "negative", severity: "watch", serviceHint: "PPC / Media", needsFollowUp: false
            }
          ]
        })
      })
    });
    store._session = {
      id: "sess_1", cycleId: "cyc_quick", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "quick_checkin",
      reminderDueAt: "2099-01-02T00:00:00.000Z",
      conversationState: { state: "quick_checkin_detail", quickCheckinOutcome: "needs_improvement" }
    };
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        text: "Thank you for this opportunity. Though I think all the processess are in place - however I am quite disappointed with the outcome so far. The campaign doesn’t seem to be attracting much attention and the applicants number we have got presently could be well achieved without spending additional resources . Also the data shared gives us no information on the profile of the individuals signing on. I need more ownership from your end - to review / analyse and change course if required- right now it seems to be lacking. You are the experts and I expect you to be taking more interest."
      });
      await new Promise((resolve) => setImmediate(resolve));
      const payload = JSON.parse(response.body);
      const recorded = calls.quickCheckinResponses.at(-1)?.input?.interpretation;
      const newAlerts = calls.automation.slice(automationBefore)
        .filter((item) => item.eventType === "manager_alert");

      assert.strictEqual(payload.state, "quick_checkin_window");
      assert.strictEqual(recorded.concerns.length, 3);
      assert.match(payload.whatsappReplyText, /campaign traction below expectations/i);
      assert.match(payload.whatsappReplyText, /applicant-profile reporting is missing/i);
      assert.match(payload.whatsappReplyText, /proactive ownership is needed/i);
      assert.match(payload.whatsappReplyText, /next 10 minutes/i);
      assert.strictEqual(newAlerts.length, 1, "one client message must create one consolidated management alert");
      assert.strictEqual(newAlerts[0].payload.analysis.issueCount, 3);
      assert.strictEqual(newAlerts[0].payload.analysis.concerns.length, 3);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("quick check-in preserves long mixed feedback when Gemini times out", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    const priorClaims = new Map(calls.automationClaims);
    const responsesBefore = calls.quickCheckinResponses.length;
    const automationBefore = calls.automation.length;
    calls.automationClaims.clear();
    process.env.GEMINI_API_KEY = "test-key";
    global.fetch = async () => { throw new Error("simulated Gemini timeout"); };
    store._session = {
      id: "sess_1", cycleId: "cyc_quick", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "quick_checkin",
      reminderDueAt: "2099-01-02T00:00:00.000Z",
      conversationState: { state: "quick_checkin_detail", quickCheckinOutcome: "needs_improvement" }
    };
    const text = "Across several design assets, agreed changes were applied inconsistently, so our team had to repeat the same feedback and go through avoidable rework. Better internal alignment would make delivery smoother. The POCs, Aisha and Dev, were always responsive and made coordination easy.";
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text });
      await new Promise((resolve) => setImmediate(resolve));
      const payload = JSON.parse(response.body);
      const recorded = calls.quickCheckinResponses[responsesBefore]?.input?.interpretation;
      const newAlerts = calls.automation.slice(automationBefore)
        .filter((item) => item.eventType === "manager_alert");

      assert.strictEqual(payload.state, "quick_checkin_window");
      assert.strictEqual(recorded.source, "deterministic_fallback");
      assert.strictEqual(recorded.concerns.length, 1, "the timeout fallback must preserve the process concern");
      assert.match(recorded.concerns[0].title, /inconsistent implementation.*creative feedback/i);
      assert.strictEqual(recorded.appreciations[0].subject, "Aisha and Dev");
      assert.match(payload.whatsappReplyText, /inconsistent implementation.*creative feedback/i);
      assert.match(payload.whatsappReplyText, /Aisha and Dev/i);
      assert.match(payload.whatsappReplyText, /next 10 minutes/i);
      assert.strictEqual(newAlerts.length, 1, "the timeout fallback must trigger one consolidated manager alert");
      assert.strictEqual(newAlerts[0].payload.analysis.issueCount, 1);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
      calls.automationClaims.clear();
      for (const [key, value] of priorClaims) calls.automationClaims.set(key, value);
    }
  });

  await scenario("quick check-in fails safe when feedback meaning cannot be confirmed", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    const responsesBefore = calls.quickCheckinResponses.length;
    process.env.GEMINI_API_KEY = "test-key";
    global.fetch = async () => { throw new Error("simulated Gemini timeout"); };
    store._session = {
      id: "sess_1", cycleId: "cyc_quick", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "quick_checkin",
      reminderDueAt: "2099-01-02T00:00:00.000Z",
      conversationState: { state: "quick_checkin_detail", quickCheckinOutcome: "needs_improvement" }
    };
    try {
      const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "Something different" });
      const payload = JSON.parse(response.body);
      assert.strictEqual(payload.state, "quick_checkin_detail");
      assert.match(payload.whatsappReplyText, /recorded accurately/i);
      assert.doesNotMatch(payload.whatsappReplyText, /next 10 minutes/i);
      assert.strictEqual(calls.quickCheckinResponses.length, responsesBefore);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("closed quick check-in routes substantive messages to human handoff", async () => {
    const priorWebhook = process.env.N8N_HUMAN_HANDOFF_WEBHOOK;
    const priorFetch = global.fetch;
    store._session = {
      ...store._session,
      status: "completed",
      completionStatus: "completed",
      sessionType: "quick_checkin",
      conversationState: {
        state: "completed",
        quickCheckinOutcome: "all_good",
        closureReason: "quick_checkin_window_elapsed"
      }
    };
    calls.automation.length = 0;
    process.env.N8N_HUMAN_HANDOFF_WEBHOOK = "https://n8n.example/webhook/csat-human-handoff";
    global.fetch = async () => ({ ok: true, status: 200 });
    try {
      const res = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        text: "Can someone call me about a new concern?"
      });
      const payload = JSON.parse(res.body);
      const event = calls.automation.find((item) => item.eventType === "post_completion_message");
      assert.strictEqual(payload.state, "completed");
      assert.strictEqual(payload.guardrail, "quick_checkin_post_completion");
      assert.strictEqual(payload.handoffStatus, "sent");
      assert.match(payload.whatsappReplyText, /passed your message to the SRV team/i);
      assert.ok(event, JSON.stringify(calls.automation.map((item) => item.eventType)));
      assert.strictEqual(event.status, "sent");
      assert.strictEqual(event.statusCode, 200);
      assert.strictEqual(event.payload.clientText, "Can someone call me about a new concern?");
      assert.strictEqual(store._session.status, "completed", "closed quick check-in must not reopen");
    } finally {
      global.fetch = priorFetch;
      if (priorWebhook === undefined) delete process.env.N8N_HUMAN_HANDOFF_WEBHOOK;
      else process.env.N8N_HUMAN_HANDOFF_WEBHOOK = priorWebhook;
    }
  });

  await scenario("closed quick check-in never claims an unconfigured handoff succeeded", async () => {
    const priorWebhook = process.env.N8N_HUMAN_HANDOFF_WEBHOOK;
    delete process.env.N8N_HUMAN_HANDOFF_WEBHOOK;
    store._session = {
      ...store._session,
      status: "completed",
      completionStatus: "completed",
      sessionType: "quick_checkin",
      conversationState: {
        state: "completed",
        quickCheckinOutcome: "all_good",
        closureReason: "quick_checkin_window_elapsed"
      }
    };
    calls.automation.length = 0;
    try {
      const res = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        text: "I have another concern to share"
      });
      const payload = JSON.parse(res.body);
      const event = calls.automation.find((item) => item.eventType === "post_completion_message");
      assert.strictEqual(payload.handoffStatus, "skipped");
      assert.match(payload.whatsappReplyText, /could not pass this new message/i);
      assert.ok(event, "a skipped handoff must still have an audit event");
      assert.strictEqual(event.status, "skipped");
      assert.strictEqual(event.webhookUrlConfigured, false);
    } finally {
      if (priorWebhook !== undefined) process.env.N8N_HUMAN_HANDOFF_WEBHOOK = priorWebhook;
    }
  });

  await scenario("closed quick check-in reports a failed human-handoff workflow honestly", async () => {
    const priorWebhook = process.env.N8N_HUMAN_HANDOFF_WEBHOOK;
    const priorFetch = global.fetch;
    process.env.N8N_HUMAN_HANDOFF_WEBHOOK = "https://n8n.example/webhook/csat-human-handoff";
    global.fetch = async () => ({ ok: false, status: 500 });
    store._session = {
      ...store._session,
      status: "completed",
      completionStatus: "completed",
      sessionType: "quick_checkin",
      conversationState: {
        state: "completed",
        quickCheckinOutcome: "all_good",
        closureReason: "quick_checkin_window_elapsed"
      }
    };
    calls.automation.length = 0;
    try {
      const res = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
        text: "Wrong creatives went live last time"
      });
      const payload = JSON.parse(res.body);
      const event = calls.automation.find((item) => item.eventType === "post_completion_message");
      assert.strictEqual(payload.handoffStatus, "failed");
      assert.match(payload.whatsappReplyText, /could not pass this new message/i);
      assert.ok(event, "a failed handoff must still have an audit event");
      assert.strictEqual(event.status, "failed");
      assert.strictEqual(event.statusCode, 500);
    } finally {
      global.fetch = priorFetch;
      if (priorWebhook === undefined) delete process.env.N8N_HUMAN_HANDOFF_WEBHOOK;
      else process.env.N8N_HUMAN_HANDOFF_WEBHOOK = priorWebhook;
    }
  });

  await scenario("closed quick check-in acknowledgement does not alert a human", async () => {
    store._session = {
      ...store._session,
      status: "completed",
      completionStatus: "completed",
      sessionType: "quick_checkin",
      conversationState: {
        state: "completed",
        quickCheckinOutcome: "all_good",
        closureReason: "quick_checkin_window_elapsed"
      }
    };
    calls.automation.length = 0;
    const res = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "Thanks" });
    const payload = JSON.parse(res.body);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(payload.state, "completed");
    assert.strictEqual(payload.guardrail, null);
    assert.match(payload.whatsappReplyText, /quick check-in has closed/i);
    assert.ok(!calls.automation.some((item) => item.eventType === "post_completion_message"));
    store._session = { ...store._session, sessionType: "pulse" };
  });

  await scenario("G7 escalation emits one manager alert and no handoff duplicate", async () => {
    store._session = {
      ...store._session,
      status: "partial",
      conversationState: { state: "waiting_for_open_feedback", mentionedServices: {}, turnCount: 2 }
    };
    calls.automation.length = 0;
    const res = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
      text: "This is unacceptable, our lawyer will contact you"
    });
    const payload = JSON.parse(res.body);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(payload.guardrail, "G7_escalation");
    const humanEvents = calls.automation.filter((event) => [
      "manager_alert", "escalation", "handoff", "post_completion_message", "cycle_completed"
    ].includes(event.eventType));
    assert.deepStrictEqual(humanEvents.map((event) => event.eventType), ["manager_alert"]);
  });

  await scenario("terminal acknowledgement sends no human or cycle notification", async () => {
    store._session = {
      ...store._session,
      status: "needs_attention",
      conversationState: {
        state: "handed_off", handoffReason: "not_understood", mentionedServices: {}, turnCount: 4
      }
    };
    calls.automation.length = 0;
    const res = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "ok" });
    const payload = JSON.parse(res.body);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(payload.state, "handed_off");
    const humanEvents = calls.automation.filter((event) => [
      "manager_alert", "escalation", "handoff", "post_completion_message",
      "cycle_completed", "client_question"
    ].includes(event.eventType));
    assert.deepStrictEqual(humanEvents, []);
  });

  await scenario("POC summary waits for the correction window and is not resent after completion", async () => {
    const mentionedServices = Object.fromEntries(project.services.map((service) => [
      service.serviceKey,
      { serviceKey: service.serviceKey, serviceName: service.name, status: "captured", sentiment: "neutral" }
    ]));
    store._session = {
      ...store._session,
      status: "partial",
      conversationState: {
        state: "waiting_for_overall_rating",
        pendingQuestionType: "overall_rating",
        overallRatingAsked: true,
        askedForAppreciation: true,
        appreciationAnswered: true,
        askedForAnythingElse: true,
        anythingElseAnswered: true,
        mentionedServices
      }
    };
    store._cycleComplete = true;
    store._cycleSummary = {
      project,
      cycle: { id: "cyc_1", csatScore: 8 },
      sessions: [store._session],
      issues: [],
      appreciations: [{ serviceKey: "website", text: "Good support" }],
      observations: [],
      recipients: ["owner@srvmedia.com"]
    };
    calls.automation.length = 0;
    calls.automationClaims.delete("cycle_completed:feedback:session:sess_1");

    await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "8" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(calls.automation.filter((e) => e.eventType === "cycle_completed").length, 0);
    assert.ok(store._session.conversationState.summaryPendingSince);

    await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "ok" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(calls.automation.filter((e) => e.eventType === "cycle_completed").length, 0);
    store._session.conversationState = { ...store._session.conversationState,
      state: "completed", closingGraceExpiresAt: "2020-01-01T00:00:00Z" };
    store.pendingFeedbackSummaries = async () => [store._session];
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await req("POST", "/api/automation/process-due-reminders", {});
        assert.equal(result.statusCode, 200);
        assert.strictEqual(calls.automation.filter((e) => e.eventType === "cycle_completed").length, 1);
      }
      assert.equal(calls.automation.find((e) => e.eventType === "cycle_completed").payload.summaryType, "feedback_poc");
    } finally { delete store.pendingFeedbackSummaries; }
    store._cycleComplete = false;
    store._cycleSummary = null;
  });

  await scenario("repeated STOP after opt-out does not resend opt-out notification", async () => {
    store._session = {
      ...store._session,
      status: "opted_out",
      conversationState: { state: "opted_out", optedOut: true, mentionedServices: {} }
    };
    calls.automation.length = 0;
    await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text: "STOP" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!calls.automation.some((event) => event.eventType === "opt_out"));
  });

  await scenario("reminder on a completed session is refused", async () => {
    const res = await req("POST", "/api/sessions/sess_1/reminder", {});
    assert.strictEqual(res.statusCode, 409);
  });

  await scenario("manual reminder counts toward the shared three-reminder limit", async () => {
    store._session = {
      id: "sess_1",
      cycleId: "cyc_1",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      completionStatus: "partial",
      reminderCount: 0,
      conversationState: { state: "waiting_for_service_feedback" }
    };
    const first = await req("POST", "/api/sessions/sess_1/reminder", {});
    const payload = JSON.parse(first.body);
    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(payload.session.reminderCount, 1);
    assert.deepStrictEqual(payload.reminderPolicy, {
      sent: 1,
      limit: 3,
      nextDueAt: "2026-08-02T00:00:00.000Z"
    });

    store._session = { ...store._session, reminderCount: 3 };
    const exhausted = await req("POST", "/api/sessions/sess_1/reminder", {});
    assert.strictEqual(exhausted.statusCode, 409);
    assert.match(JSON.parse(exhausted.body).error, /all 3 reminders/i);
  });

  await scenario("dashboard can stop one POC for only the selected cycle", async () => {
    store._session = {
      id: "sess_1",
      cycleId: "cyc_1",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      completionStatus: "partial",
      csatScore: 7,
      reminderCount: 1,
      reminderDueAt: "2026-08-02T00:00:00.000Z",
      conversationState: { state: "waiting_for_service_feedback", mentionedServices: { website: { reasonText: "Needs work" } } }
    };
    store._cycleComplete = false;
    const closingEventsBefore = calls.automation.filter(
      (event) => event.eventType === "feedback_session_closed"
    ).length;

    const stopped = await req("POST", "/api/sessions/sess_1/stop", {});
    const payload = JSON.parse(stopped.body);
    assert.strictEqual(stopped.statusCode, 200);
    assert.strictEqual(payload.stoppedForCycle, true);
    assert.strictEqual(payload.futureCyclesUnaffected, true);
    assert.strictEqual(payload.session.status, "opted_out");
    assert.strictEqual(payload.session.reminderDueAt, null);
    assert.strictEqual(payload.session.csatScore, 7, "partial feedback must be preserved");
    assert.strictEqual(payload.session.conversationState.stoppedByAdmin, true);
    assert.strictEqual(payload.session.conversationState.mentionedServices.website.reasonText, "Needs work");
    assert.strictEqual(
      calls.automation.filter((event) => event.eventType === "feedback_session_closed").length,
      closingEventsBefore,
      "Stop Feedback must not send the automatic-closing template"
    );

    const repeated = await req("POST", "/api/sessions/sess_1/stop", {});
    assert.strictEqual(JSON.parse(repeated.body).alreadyStopped, true);
  });

  await scenario("stopping a partial POC session runs a fresh terminal score", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    process.env.GEMINI_API_KEY = "test-key";
    store._cycleComplete = false;
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      csatScore: 7, predictedCsat: 7, csatSource: "predicted",
      conversationState: {
        state: "waiting_for_service_followup",
        mentionedServices: {
          ppc: {
            serviceKey: "ppc", serviceName: "PPC / Media", status: "needs_service_followup",
            sentiment: "negative", reasonText: "Lead quality is poor"
          }
        }
      }
    };
    calls.messages.length = 0;
    calls.messages.push({ id: "msg_stop_score", sessionId: "sess_1", side: "client", body: "PPC lead quality is poor" });
    global.fetch = async (_url, options) => {
      const input = JSON.parse(options.body).input;
      let output;
      if (/classify the CLIENT's tone/i.test(input)) {
        output = { tone: "disappointed", reason: "The client reported poor lead quality." };
      } else if (/decide which services have a real/i.test(input)) {
        output = { issues: [{ serviceKey: "ppc", title: "Poor PPC lead quality", rootCause: "Lead quality is poor.", severity: "watch" }] };
      } else if (/predict how satisfied/i.test(input)) {
        output = {
          overall: { score: 4.5, confidence: 90, reasoning: "Lead quality is poor.", signals: ["poor lead quality"] },
          services: [{ serviceKey: "ppc", score: 4, confidence: 90, reasoning: "Poor leads.", sentiment: "negative" }],
          observations: []
        };
      } else {
        throw new Error(`Unexpected Gemini task: ${input.slice(0, 80)}`);
      }
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(output) }) };
    };

    try {
      const res = await req("POST", "/api/sessions/sess_1/stop", {});
      const payload = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(payload.session.status, "opted_out");
      assert.strictEqual(payload.session.conversationState.closureReason, "stopped_by_admin");
      assert.strictEqual(payload.session.predictedCsat, 4.5, "the old interim reading must be replaced");
      assert.strictEqual(payload.stopScore.attempted, true);
      assert.strictEqual(payload.stopScore.scored, true);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
    }
  });

  await scenario("stopping with no client feedback clears every stale score without calling Gemini", async () => {
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    store._cycleComplete = false;
    store._session = {
      id: "sess_no_feedback", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "no_response", completionStatus: "no_response", sessionType: "pulse",
      csatScore: 7, predictedCsat: 7, predictedConfidence: 50, csatSource: "predicted",
      riskLevel: "Low", conversationState: { state: "waiting_for_open_feedback" }
    };
    calls.messages.length = 0;
    global.fetch = async () => { throw new Error("Gemini must not run without client feedback"); };

    try {
      const res = await req("POST", "/api/sessions/sess_no_feedback/stop", {});
      const payload = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(payload.session.status, "opted_out");
      assert.strictEqual(payload.session.csatScore, null);
      assert.strictEqual(payload.session.predictedCsat, null);
      assert.strictEqual(payload.session.predictedConfidence, null);
      assert.strictEqual(payload.session.riskLevel, null);
      assert.strictEqual(payload.stopScore.attempted, true);
      assert.strictEqual(payload.stopScore.scored, false);
      assert.match(payload.stopScore.reason, /no satisfaction evidence/i);
    } finally {
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
    }
  });

  await scenario("Supabase reminder persistence schedules exactly 24 hours and closes after three", async () => {
    const policyStore = Object.create(SupabaseStore.prototype);
    let current = {
      id: "sess_policy",
      cycleId: "cyc_policy",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      completionStatus: "partial",
      sessionType: "pulse",
      reminderCount: 2,
      conversationState: { state: "waiting_for_service_feedback" }
    };
    let lastPatch = null;
    let recomputed = 0;
    policyStore.getSession = async () => current;
    policyStore.recomputeCycle = async () => { recomputed += 1; };
    policyStore.request = async (table, options) => {
      assert.strictEqual(table, "feedback_sessions");
      lastPatch = options.body;
      return [{
        id: current.id,
        cycle_id: current.cycleId,
        project_id: current.projectId,
        client_poc_id: current.clientPocId,
        status: options.body.status,
        completion_status: current.completionStatus,
        conversation_state: options.body.conversation_state,
        reminder_count: options.body.reminder_count ?? current.reminderCount,
        reminder_due_at: options.body.reminder_due_at
      }];
    };

    current = await policyStore.markNoResponse(current.id);
    assert.strictEqual(current.reminderCount, 3);
    assert.strictEqual(
      new Date(current.reminderDueAt).getTime() - new Date(current.conversationState.lastReminderAt).getTime(),
      24 * 60 * 60 * 1000
    );

    current = await policyStore.finalizeReminderLoop(current.id);
    assert.strictEqual(lastPatch.reminder_due_at, null);
    assert.strictEqual(current.conversationState.reminderExhausted, true);
    assert.strictEqual(current.conversationState.closureReason, "partial_after_three_reminders");
    assert.strictEqual(sessionIsTerminal(current), true);
    assert.strictEqual(recomputed, 1);
  });

  await scenario("final partial analysis enriches scoring without changing the partial closure outcome", async () => {
    const analysisStore = Object.create(SupabaseStore.prototype);
    const current = {
      id: "sess_partial_final",
      cycleId: "cyc_partial_final",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      completionStatus: "partial",
      sessionType: "pulse",
      reminderCount: 3,
      reminderDueAt: null,
      csatScore: null,
      conversationState: {
        state: "completed",
        reminderExhausted: true,
        closureReason: "partial_after_three_reminders"
      }
    };
    let patchBody = null;
    let recomputed = 0;
    let enriched = 0;
    analysisStore.getSession = async () => current;
    analysisStore.recomputeCycle = async () => { recomputed += 1; };
    analysisStore.upsertServiceFeedback = async () => { enriched += 1; };
    analysisStore.updateProjectServices = async () => { enriched += 1; };
    analysisStore.maybeCreateIssue = async () => { enriched += 1; };
    analysisStore.request = async (table, options) => {
      assert.strictEqual(table, "feedback_sessions");
      patchBody = options.body;
      return [{
        id: current.id,
        cycle_id: current.cycleId,
        project_id: current.projectId,
        client_poc_id: current.clientPocId,
        status: current.status,
        completion_status: current.completionStatus,
        conversation_state: current.conversationState,
        reminder_count: current.reminderCount,
        reminder_due_at: current.reminderDueAt,
        csat_score: options.body.csat_score,
        predicted_csat: options.body.predicted_csat,
        predicted_confidence: options.body.predicted_confidence,
        csat_source: options.body.csat_source,
        risk_level: options.body.risk_level
      }];
    };

    const updated = await analysisStore.applyFinalPartialAnalysis(current.id, {
      csatScore: 4.5,
      predictedCsat: 4.5,
      predictedConfidence: 88,
      predictedReasoning: "The client reported a persistent concern.",
      predictedSignals: ["poor lead quality"],
      csatSource: "predicted",
      riskLevel: "High",
      focusSignal: "PPC / Media",
      rootCause: "PPC / Media: poor lead quality",
      services: []
    });

    assert.strictEqual(Object.hasOwn(patchBody, "status"), false);
    assert.strictEqual(Object.hasOwn(patchBody, "completion_status"), false);
    assert.strictEqual(Object.hasOwn(patchBody, "conversation_state"), false);
    assert.strictEqual(Object.hasOwn(patchBody, "reminder_due_at"), false);
    assert.strictEqual(updated.status, "partial");
    assert.strictEqual(updated.completionStatus, "partial");
    assert.strictEqual(updated.csatScore, 4.5);
    assert.strictEqual(updated.csatSource, "predicted");
    assert.strictEqual(recomputed, 1);
    assert.strictEqual(enriched, 3);
  });

  await scenario("Supabase interim scoring preserves the open workflow fields", async () => {
    const interimStore = Object.create(SupabaseStore.prototype);
    const current = {
      id: "sess_interim",
      cycleId: "cyc_interim",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      completionStatus: "partial",
      sessionType: "pulse",
      reminderDueAt: "2026-09-08T10:00:00.000Z",
      conversationState: { state: "waiting_for_service_followup", pendingServiceKey: "ppc" },
      csatScore: null,
      predictedCsat: null
    };
    let patchBody = null;
    let recomputed = 0;
    interimStore.getSession = async () => current;
    interimStore.recomputeCycle = async () => { recomputed += 1; };
    interimStore.request = async (table, options) => {
      assert.strictEqual(table, "feedback_sessions");
      patchBody = options.body;
      return [{
        id: current.id,
        cycle_id: current.cycleId,
        project_id: current.projectId,
        client_poc_id: current.clientPocId,
        status: current.status,
        completion_status: current.completionStatus,
        conversation_state: current.conversationState,
        reminder_due_at: current.reminderDueAt,
        csat_score: options.body.csat_score,
        predicted_csat: options.body.predicted_csat,
        predicted_confidence: options.body.predicted_confidence,
        predicted_reasoning: options.body.predicted_reasoning,
        predicted_signals: options.body.predicted_signals,
        csat_source: options.body.csat_source,
        risk_level: options.body.risk_level
      }];
    };

    const updated = await interimStore.applyInterimAnalysis(current.id, {
      csatScore: 4.5,
      predictedCsat: 4.5,
      predictedConfidence: 88,
      predictedReasoning: "Lead quality is poor.",
      predictedSignals: ["poor lead quality"],
      csatSource: "predicted",
      riskLevel: "High"
    });
    assert.strictEqual(Object.hasOwn(patchBody, "status"), false);
    assert.strictEqual(Object.hasOwn(patchBody, "completion_status"), false);
    assert.strictEqual(Object.hasOwn(patchBody, "conversation_state"), false);
    assert.strictEqual(Object.hasOwn(patchBody, "reminder_due_at"), false);
    assert.strictEqual(updated.status, "partial");
    assert.strictEqual(updated.completionStatus, "partial");
    assert.strictEqual(updated.conversationState.state, "waiting_for_service_followup");
    assert.strictEqual(updated.reminderDueAt, current.reminderDueAt);
    assert.strictEqual(updated.predictedCsat, 4.5);
    assert.strictEqual(recomputed, 1);
  });

  await scenario("Dashboard response tracker maps POC outcomes and latest replies", async () => {
    const dashboardStore = Object.create(SupabaseStore.prototype);
    dashboardStore.listProjects = async () => [project];
    const cycleRow = {
      id: "cyc_tracker", project_id: "prj_1", cycle_type: "pulse", status: "open",
      started_at: "2026-09-01T10:00:00.000Z", closed_at: null
    };
    const quickCycleRow = {
      id: "cyc_quick_tracker", project_id: "prj_1", cycle_type: "quick_checkin", status: "open",
      started_at: "2026-09-03T10:00:00.000Z", closed_at: null
    };
    const sessionRows = [
      {
        id: "sess_awaiting", cycle_id: "cyc_tracker", project_id: "prj_1", client_poc_id: "poc_a",
        status: "started", completion_status: "not_started", conversation_state: {},
        started_at: cycleRow.started_at, completed_at: null, last_client_response_at: null,
        reminder_due_at: "2026-09-02T10:00:00.000Z", reminder_count: 1,
        csat_score: null, predicted_csat: null, csat_source: null,
        client_pocs: { name: "Awaiting POC" }, projects: { project_key: project.key, name: project.name },
        feedback_cycles: cycleRow
      },
      {
        id: "sess_partial", cycle_id: "cyc_tracker", project_id: "prj_1", client_poc_id: "poc_b",
        status: "partial", completion_status: "partial", conversation_state: {},
        started_at: cycleRow.started_at, completed_at: null,
        last_client_response_at: "2026-09-02T11:00:00.000Z",
        reminder_due_at: "2026-09-03T11:00:00.000Z", reminder_count: 1,
        csat_score: 6, predicted_csat: 6, csat_source: "predicted",
        client_pocs: { name: "Partial POC" }, projects: { project_key: project.key, name: project.name },
        feedback_cycles: cycleRow
      },
      {
        id: "sess_completed", cycle_id: "cyc_tracker", project_id: "prj_1", client_poc_id: "poc_c",
        status: "completed", completion_status: "completed", conversation_state: { state: "closing_grace" },
        started_at: cycleRow.started_at, completed_at: "2026-09-02T12:00:00.000Z",
        last_client_response_at: "2026-09-02T12:00:00.000Z", reminder_due_at: null, reminder_count: 0,
        csat_score: 8, predicted_csat: 8, csat_source: "stated",
        client_pocs: { name: "Completed POC" }, projects: { project_key: project.key, name: project.name },
        feedback_cycles: cycleRow
      },
      {
        id: "sess_stopped", cycle_id: "cyc_tracker", project_id: "prj_1", client_poc_id: "poc_d",
        status: "opted_out", completion_status: "partial",
        conversation_state: { stoppedByAdmin: true, stoppedAt: "2026-09-02T13:00:00.000Z", closureReason: "stopped_by_admin" },
        started_at: cycleRow.started_at, completed_at: null,
        last_client_response_at: "2026-09-02T12:30:00.000Z", reminder_due_at: null, reminder_count: 1,
        csat_score: 5, predicted_csat: 5, csat_source: "predicted",
        client_pocs: { name: "Stopped POC" }, projects: { project_key: project.key, name: project.name },
        feedback_cycles: cycleRow
      },
      {
        id: "sess_quick", cycle_id: "cyc_quick_tracker", project_id: "prj_1", client_poc_id: "poc_e",
        status: "started", completion_status: "not_started",
        conversation_state: { state: "quick_checkin_choice" },
        started_at: quickCycleRow.started_at, completed_at: null, last_client_response_at: null,
        reminder_due_at: "2026-09-04T10:00:00.000Z", reminder_count: 0,
        csat_score: null, predicted_csat: null, csat_source: null,
        client_pocs: { name: "Quick Check-in POC" }, projects: { project_key: project.key, name: project.name },
        feedback_cycles: quickCycleRow
      }
    ];
    dashboardStore.request = async (table, options = {}) => {
      if (["clusters", "clients", "client_pocs", "automation_events"].includes(table)) return [];
      if (table === "project_services") {
        return [{ project_id: "prj_1", service_key: "creatives", name: "Creatives" }];
      }
      if (table === "issues") {
        return [{
          id: "issue_typo", project_id: "prj_1", session_id: "sess_partial", client_poc_id: "poc_b",
          service_key: "creatives", service_name: "Cretives", severity: "watch", status: "open",
          title: "Wrong creative went live", root_cause: "Wrong creative went live", created_at: cycleRow.started_at
        }];
      }
      if (table === "feedback_cycles") {
        return options.query.includes("cycle_type=neq.quick_checkin")
          ? [cycleRow]
          : [quickCycleRow, cycleRow];
      }
      if (table === "feedback_sessions") return sessionRows;
      if (table === "messages") {
        assert.match(options.query, /side=eq\.client/);
        return [
          {
            session_id: "sess_awaiting", body: "Thank you for contacting us. Please let us know how we can help you.",
            created_at: "2026-09-02T10:30:00.000Z", metadata: { automatedReply: true, ignoredForConversation: true }
          },
          { session_id: "sess_partial", body: "PPC lead quality is poor", created_at: "2026-09-02T11:00:00.000Z" },
          { session_id: "sess_completed", body: "8", created_at: "2026-09-02T12:00:00.000Z" },
          { session_id: "sess_stopped", body: "That is all", created_at: "2026-09-02T12:30:00.000Z" }
        ];
      }
      throw new Error(`Unexpected dashboard table ${table}`);
    };

    const dashboard = await dashboardStore.getDashboard();
    assert.deepStrictEqual(
      dashboard.responseTracker.map((session) => session.responseStatus),
      ["awaiting", "partial", "completed", "stopped", "awaiting"]
    );
    assert.strictEqual(dashboard.responseTracker[0].latestClientReply, null,
      "an ignored automated greeting must not turn an awaiting session into a response");
    assert.strictEqual(dashboard.responseTracker[1].latestClientReply, "PPC lead quality is poor");
    assert.strictEqual(dashboard.responseTracker[3].stoppedByAdmin, true);
    assert.strictEqual(dashboard.responseTracker[3].closureReason, "stopped_by_admin");
    assert.strictEqual(dashboard.responseTracker[4].cycleType, "quick_checkin");
    assert.strictEqual(dashboard.responseTracker[4].quickCheckinState, "quick_checkin_choice");
    assert.ok(dashboard.openCycles.some((cycle) => cycle.cycleType === "quick_checkin"));
    assert.ok(!dashboard.cycles.some((cycle) => cycle.cycleType === "quick_checkin"), "quick check-ins must not alter full-feedback KPI history");
    assert.strictEqual(dashboard.openIssues[0].service_name, "Creatives");
  });

  await scenario("Supabase cycle stop preserves feedback and clears only that session's reminder", async () => {
    const stopStore = Object.create(SupabaseStore.prototype);
    const current = {
      id: "sess_stop",
      cycleId: "cyc_stop",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      completionStatus: "partial",
      sessionType: "pulse",
      csatScore: 6,
      reminderCount: 2,
      reminderDueAt: "2026-08-03T00:00:00.000Z",
      conversationState: {
        state: "waiting_for_service_feedback",
        mentionedServices: { website: { reasonText: "Please modernise it" } }
      }
    };
    let recomputed = 0;
    let patchBody = null;
    stopStore.getSession = async () => current;
    stopStore.recomputeCycle = async (cycleId, projectId) => {
      assert.strictEqual(cycleId, "cyc_stop");
      assert.strictEqual(projectId, "prj_1");
      recomputed += 1;
    };
    stopStore.request = async (table, options) => {
      assert.strictEqual(table, "feedback_sessions");
      patchBody = options.body;
      return [{
        id: current.id,
        cycle_id: current.cycleId,
        project_id: current.projectId,
        client_poc_id: current.clientPocId,
        status: options.body.status,
        completion_status: current.completionStatus,
        csat_score: current.csatScore,
        reminder_count: current.reminderCount,
        reminder_due_at: options.body.reminder_due_at,
        conversation_state: options.body.conversation_state
      }];
    };

    const stopped = await stopStore.stopSessionForCycle(current.id, { actorName: "Test admin" });
    assert.strictEqual(patchBody.status, "opted_out");
    assert.strictEqual(patchBody.reminder_due_at, null);
    assert.strictEqual(stopped.csatScore, 6);
    assert.strictEqual(stopped.conversationState.mentionedServices.website.reasonText, "Please modernise it");
    assert.strictEqual(stopped.conversationState.stoppedByAdmin, true);
    assert.strictEqual(stopped.conversationState.stoppedBy, "Test admin");
    assert.strictEqual(recomputed, 1);
  });

  await scenario("cycle roll-up survives a later enrichment failure", async () => {
    const analysisStore = Object.create(SupabaseStore.prototype);
    const current = {
      id: "sess_rollup",
      cycleId: "cyc_rollup",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      sessionType: "pulse",
      conversationState: { state: "waiting_for_overall_rating" }
    };
    const order = [];
    analysisStore.getSession = async () => current;
    analysisStore.request = async (table, options) => {
      assert.strictEqual(table, "feedback_sessions");
      order.push("session_saved");
      return [{
        id: current.id,
        cycle_id: current.cycleId,
        project_id: current.projectId,
        client_poc_id: current.clientPocId,
        status: options.body.status,
        completion_status: options.body.completion_status,
        conversation_state: options.body.conversation_state,
        csat_score: options.body.csat_score
      }];
    };
    analysisStore.recomputeCycle = async () => { order.push("cycle_recomputed"); };
    analysisStore.upsertServiceFeedback = async () => {
      order.push("service_enrichment");
      throw new Error("optional service table unavailable");
    };
    analysisStore.updateProjectServices = async () => { order.push("project_enrichment"); };
    analysisStore.maybeCreateIssue = async () => { order.push("issue_enrichment"); };

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const saved = await analysisStore.applyAnalysis(current.id, {
        isComplete: true,
        requiresManagerAlert: false,
        dueInHours: null,
        csatScore: 7,
        riskLevel: "Watch",
        conversationState: { state: "closing_grace" },
        services: []
      });
      assert.strictEqual(saved.status, "completed");
      assert.strictEqual(saved.csatScore, 7);
      assert.deepStrictEqual(order.slice(0, 2), ["session_saved", "cycle_recomputed"]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  await scenario("workspace loads independent project data together and retains inactive POCs", async () => {
    const workspaceStore = Object.create(SupabaseStore.prototype);
    workspaceStore.expireDueQuickCheckins = async (_now, options) => {
      assert.deepStrictEqual(options, { windowsOnly: true, projectId: project.id });
      return { expired: 0, sessions: [] };
    };
    const started = new Set();
    const read = async (name, result) => {
      started.add(name);
      await Promise.resolve();
      assert.strictEqual(started.size, 5, "independent workspace reads should start together");
      return result;
    };
    workspaceStore.getProject = async () => ({ ...project, services: [] });
    workspaceStore.listProjectCycles = async () => [];
    workspaceStore.listProjectSessions = () => read("sessions", []);
    workspaceStore.listProjectIssues = () => read("issues", []);
    workspaceStore.serviceFeedbackByCycle = () => read("services", {});
    workspaceStore.listProjectObservations = () => read("observations", []);
    workspaceStore.pocsForProject = (projectId, options) => {
      assert.strictEqual(projectId, project.id);
      assert.strictEqual(options.activeOnly, false);
      return read("pocs", [{ ...poc, active: false }]);
    };

    const result = await workspaceStore.getProjectWorkspace(project.key);
    assert.strictEqual(result.project.id, project.id);
    assert.strictEqual(result.pocs[0].active, false);
    assert.deepStrictEqual(result.messages, []);
  });

  await scenario("workspace refresh repairs an open cycle whose sessions are complete", async () => {
    const repairStore = Object.create(SupabaseStore.prototype);
    repairStore.expireDueQuickCheckins = async () => ({ expired: 0, sessions: [] });
    const openCycle = { id: "cyc_stale", projectId: "prj_1", status: "open" };
    const closedCycle = { ...openCycle, status: "closed", csatScore: 7, pocResponded: 1, pocTotal: 1 };
    const completedSession = {
      id: "sess_stale",
      cycleId: openCycle.id,
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "completed",
      conversationState: { state: "closing_grace" },
      csatScore: 7
    };
    let cycleReads = 0;
    let repairs = 0;
    repairStore.getProject = async () => ({ ...project, services: [] });
    repairStore.listProjectCycles = async () => (++cycleReads === 1 ? [openCycle] : [closedCycle]);
    repairStore.listProjectSessions = async () => [completedSession];
    repairStore.listProjectIssues = async () => [];
    repairStore.serviceFeedbackByCycle = async () => ({});
    repairStore.listProjectObservations = async () => [];
    repairStore.pocsForProject = async () => [poc];
    repairStore.getMessagesForSession = async () => [];
    repairStore.recomputeCycle = async (cycleId, projectId) => {
      assert.strictEqual(cycleId, openCycle.id);
      assert.strictEqual(projectId, project.id);
      repairs += 1;
    };

    const workspace = await repairStore.getProjectWorkspace(project.key);
    assert.strictEqual(repairs, 1);
    assert.strictEqual(workspace.cycles[0].status, "closed");
    assert.strictEqual(workspace.cycles[0].csatScore, 7);
  });

  await scenario("workspace refresh repairs a legacy project-end lock after its cycle was already deleted", async () => {
    const repairStore = Object.create(SupabaseStore.prototype);
    repairStore.expireDueQuickCheckins = async () => ({ expired: 0, sessions: [] });
    const requests = [];
    const lockedAt = "2026-10-01T08:00:00.000Z";
    repairStore.getProject = async () => ({
      ...project,
      services: [],
      endFeedbackRequestedAt: lockedAt,
      automaticFeedbackEnabled: true,
      feedbackIntervalDays: 30
    });
    repairStore.listProjectCycles = async () => [];
    repairStore.listProjectSessions = async () => [];
    repairStore.listProjectIssues = async () => [];
    repairStore.serviceFeedbackByCycle = async () => ({});
    repairStore.listProjectObservations = async () => [];
    repairStore.pocsForProject = async () => [];
    repairStore.request = async (table, options = {}) => {
      requests.push({ table, options });
      if (table === "projects" && options.method === "PATCH") return [];
      throw new Error(`Unexpected ${options.method || "GET"} ${table}`);
    };

    const before = Date.now();
    const workspace = await repairStore.getProjectWorkspace(project.key);
    const after = Date.now();
    assert.strictEqual(workspace.project.endFeedbackRequestedAt, null);
    const projectPatch = requests.find((request) =>
      request.table === "projects" && request.options.method === "PATCH").options.body;
    assert.strictEqual(projectPatch.end_feedback_requested_at, null);
    const dueAt = Date.parse(projectPatch.next_cycle_due_at);
    assert.ok(dueAt >= before + (30 * 24 * 60 * 60 * 1000));
    assert.ok(dueAt <= after + (30 * 24 * 60 * 60 * 1000) + 1000);
  });

  await scenario("workspace refresh keeps the project-end lock while a project-end cycle remains", async () => {
    const repairStore = Object.create(SupabaseStore.prototype);
    repairStore.expireDueQuickCheckins = async () => ({ expired: 0, sessions: [] });
    const requests = [];
    const lockedAt = "2026-10-01T08:00:00.000Z";
    repairStore.getProject = async () => ({
      ...project,
      services: [],
      endFeedbackRequestedAt: lockedAt,
      automaticFeedbackEnabled: true,
      feedbackIntervalDays: 30
    });
    repairStore.listProjectCycles = async () => [{
      id: "cyc_project_end",
      projectId: project.id,
      cycleType: "project_end",
      status: "closed"
    }];
    repairStore.listProjectSessions = async () => [];
    repairStore.listProjectIssues = async () => [];
    repairStore.serviceFeedbackByCycle = async () => ({});
    repairStore.listProjectObservations = async () => [];
    repairStore.pocsForProject = async () => [];
    repairStore.request = async (table, options = {}) => {
      requests.push({ table, options });
      throw new Error(`Unexpected ${options.method || "GET"} ${table}`);
    };

    const workspace = await repairStore.getProjectWorkspace(project.key);
    assert.strictEqual(workspace.project.endFeedbackRequestedAt, lockedAt);
    assert.strictEqual(requests.length, 0);
  });

  await scenario("automation create-due-sessions starts a cycle per due project", async () => {
    const res = await req("POST", "/api/automation/create-due-sessions", {});
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(JSON.parse(res.body).cycles.length, 1);
  });

  await scenario("each completed quick-check-in POC sends one Directors summary", async () => {
    const previousSession = store._session;
    const previousExpired = store._expiredQuickCheckins;
    const quickSession = {
      id: "sess_quick_summary", cycleId: "cyc_quick_summary", projectId: project.id,
      clientPocId: poc.id, status: "completed", completionStatus: "completed",
      sessionType: "quick_checkin", lastClientResponseAt: "2026-10-15T06:00:00.000Z",
      conversationState: {
        state: "completed",
        closureReason: "quick_checkin_window_elapsed",
        quickCheckinOutcome: "feedback_shared",
        quickCheckinDetail: "Campaign ownership needs improvement."
      }
    };
    store._session = {
      ...quickSession,
      id: "sess_skip_reminder",
      conversationState: { state: "opted_out", optedOut: true }
    };
    store._expiredQuickCheckins = { expired: 1, sessions: [quickSession] };
    calls.automationClaims.delete("cycle_completed:quick_checkin:session:sess_quick_summary");
    const before = calls.automation.filter((event) =>
      event.eventType === "cycle_completed" && event.payload?.summaryType === "quick_checkin_poc"
    ).length;
    try {
      const first = await req("POST", "/api/automation/process-due-reminders", {});
      assert.strictEqual(first.statusCode, 200);
      const summaryEvents = calls.automation.filter((event) =>
        event.eventType === "cycle_completed" && event.payload?.summaryType === "quick_checkin_poc"
      );
      assert.strictEqual(summaryEvents.length, before + 1);
      assert.strictEqual(summaryEvents.at(-1).payload.poc.id, poc.id);
      assert.strictEqual(summaryEvents.at(-1).payload.quickCheckinDetail, "Campaign ownership needs improvement.");

      await req("POST", "/api/automation/process-due-reminders", {});
      assert.strictEqual(calls.automation.filter((event) =>
        event.eventType === "cycle_completed" && event.payload?.summaryType === "quick_checkin_poc"
      ).length, before + 1, "the same POC window must not email twice");
    } finally {
      store._session = previousSession;
      store._expiredQuickCheckins = previousExpired;
    }
  });

  await scenario("Dashboard keeps closed-project project-end delivery and stopped POC history visible", async () => {
    const previousDashboard = store.getDashboard;
    store.getDashboard = async () => ({
      projects: [{
        ...project,
        activeStatus: "closed",
        clientName: "Test Client",
        clusterName: "Orion",
        endDate: "2026-10-31",
        endFeedbackRequestedAt: "2026-10-14T10:00:00.000Z"
      }],
      clusters: [], clients: [], openIssues: [], openCycles: [], scheduleEvents: [],
      projectPocCounts: { [project.id]: 0 },
      cycles: [{
        id: "cyc_project_end_history", projectId: project.id, cycleType: "project_end",
        status: "closed", startedAt: "2026-10-14T10:00:00.000Z",
        closedAt: "2026-10-15T10:00:00.000Z", pocTotal: 1
      }],
      responseTracker: [{
        id: "sess_stopped_history", cycleId: "cyc_project_end_history", projectId: project.id,
        projectKey: project.key, projectName: project.name, pocName: poc.name,
        cycleType: "project_end", responseStatus: "stopped", stoppedByAdmin: true,
        cycleStartedAt: "2026-10-14T10:00:00.000Z"
      }]
    });
    try {
      const response = await req("GET", "/api/dashboard");
      const payload = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(payload.feedbackSchedule.length, 1);
      assert.strictEqual(payload.feedbackSchedule[0].cycleType, "project_end");
      assert.strictEqual(payload.feedbackSchedule[0].status, "completed");
      assert.strictEqual(payload.feedbackSchedule[0].cycleId, "cyc_project_end_history");
      assert.strictEqual(payload.responseTracker[0].responseStatus, "stopped");
    } finally {
      store.getDashboard = previousDashboard;
    }
  });

  await scenario("project-end feedback defaults to manual-only without blocking monthly or manual cycles", async () => {
    const priorSetting = process.env.AUTO_PROJECT_END_FEEDBACK;
    const originalTargets = store.getDueFeedbackTargets;
    delete process.env.AUTO_PROJECT_END_FEEDBACK;
    store.getDueFeedbackTargets = async () => [
      { projectKey: project.key, cycleType: "project_end" },
      { projectKey: project.key, cycleType: "pulse" }
    ];
    calls.createdCycleRequests.length = 0;

    try {
      const due = await req("GET", "/api/automation/due-feedback");
      assert.deepStrictEqual(
        JSON.parse(due.body).targets.map((target) => target.cycleType),
        ["pulse"]
      );

      process.env.AUTO_PROJECT_END_FEEDBACK = "true";
      const deliberatelyEnabled = await req("GET", "/api/automation/due-feedback");
      assert.deepStrictEqual(
        JSON.parse(deliberatelyEnabled.body).targets.map((target) => target.cycleType),
        ["project_end", "pulse"]
      );
      process.env.AUTO_PROJECT_END_FEEDBACK = "false";

      const scheduled = await req("POST", "/api/automation/create-due-sessions", {});
      assert.strictEqual(scheduled.statusCode, 201);
      assert.deepStrictEqual(
        calls.createdCycleRequests.map((item) => item.options.cycleType),
        ["pulse"]
      );

      const manual = await req("POST", `/api/projects/${project.key}/request-feedback`, {
        cycleType: "project_end"
      });
      assert.strictEqual(manual.statusCode, 201);
      assert.deepStrictEqual(
        calls.createdCycleRequests.map((item) => item.options.cycleType),
        ["pulse", "project_end"]
      );
    } finally {
      store.getDueFeedbackTargets = originalTargets;
      if (priorSetting === undefined) delete process.env.AUTO_PROJECT_END_FEEDBACK;
      else process.env.AUTO_PROJECT_END_FEEDBACK = priorSetting;
    }
  });

  await scenario("process-due-reminders skips opted-out sessions", async () => {
    store._session = { ...store._session, conversationState: { state: "opted_out", optedOut: true, mentionedServices: {} } };
    const res = await req("POST", "/api/automation/process-due-reminders", {});
    assert.strictEqual(JSON.parse(res.body).reminders.length, 0);
  });

  await scenario("third partial reminder requests the missing overall rating", async () => {
    store._session = {
      id: "sess_final_rating",
      cycleId: "cyc_final_rating",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      completionStatus: "partial",
      reminderCount: 2,
      sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_feedback",
        overallRating: null,
        mentionedServices: {}
      }
    };
    const res = await req("POST", "/api/automation/process-due-reminders", {});
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.reminders.length, 1);
    assert.strictEqual(payload.reminders[0].finalRatingReminder, true);
    assert.strictEqual(payload.reminders[0].session.conversationState.overallRatingAsked, true);
    assert.strictEqual(payload.reminders[0].session.conversationState.pendingQuestionType, "overall_rating");
    assert.strictEqual(payload.reminders[0].session.conversationState.state, "waiting_for_overall_rating");
    assert.strictEqual(calls.reminderOptions.at(-1).options.askForOverallRating, true);
    const event = calls.automation.find((item) =>
      item.eventType === "no_response" && item.payload?.session?.id === "sess_final_rating"
    );
    assert.strictEqual(event.payload.finalRatingReminder, true);
    assert.strictEqual(event.payload.reminderKind, "complete_partial_feedback");
  });

  await scenario("third partial reminder does not ask for a rating already supplied", async () => {
    store._session = {
      id: "sess_existing_rating",
      cycleId: "cyc_existing_rating",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      completionStatus: "partial",
      reminderCount: 2,
      sessionType: "pulse",
      csatScore: 7,
      csatSource: "stated",
      conversationState: {
        state: "waiting_for_service_feedback",
        overallRating: 7,
        overallRatingAsked: true,
        mentionedServices: {}
      }
    };
    const res = await req("POST", "/api/automation/process-due-reminders", {});
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.reminders.length, 1);
    assert.strictEqual(payload.reminders[0].finalRatingReminder, false);
    assert.strictEqual(calls.reminderOptions.at(-1).options.askForOverallRating, false);
    const event = calls.automation.find((item) =>
      item.eventType === "no_response" && item.payload?.session?.id === "sess_existing_rating"
    );
    assert.strictEqual(event.payload.finalRatingReminder, false);
  });

  await scenario("third reminder grace expiry closes partial feedback without a fourth message", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorClosingWebhook = process.env.N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    process.env.GEMINI_API_KEY = "test-key";
    process.env.N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK = "https://n8n.example/webhook/csat-feedback-session-closed";
    global.fetch = async (_url, options) => {
      const requestBody = JSON.parse(options.body);
      if (requestBody.eventType === "feedback_session_closed") {
        return { ok: true, status: 200, json: async () => ({ ok: true, sent: true }) };
      }
      const input = requestBody.input;
      let output;
      if (/classify the CLIENT's tone/i.test(input)) {
        output = { tone: "disappointed", reason: "Lead quality remained poor." };
      } else if (/decide which services have a real/i.test(input)) {
        output = { issues: [{ serviceKey: "ppc", title: "Poor PPC lead quality", rootCause: "The client said PPC leads were poor.", severity: "high" }] };
      } else if (/predict how satisfied/i.test(input)) {
        output = {
          overall: { score: 4.5, confidence: 88, reasoning: "The client reported poor PPC leads.", signals: ["poor lead quality"] },
          services: [{ serviceKey: "ppc", score: 4, confidence: 90, reasoning: "Leads were poor.", sentiment: "negative" }],
          observations: []
        };
      } else {
        throw new Error(`Unexpected Gemini task: ${input.slice(0, 80)}`);
      }
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(output) }) };
    };
    calls.messages.length = 0;
    calls.messages.push(
      { id: "msg_partial_1", sessionId: "sess_1", side: "srv", body: "How has PPC / Media been for you?" },
      { id: "msg_partial_2", sessionId: "sess_1", side: "client", body: "Campaign management is fine but lead quality is poor." }
    );
    const analysesBefore = calls.finalPartialAnalyses.length;
    store._session = {
      id: "sess_1",
      cycleId: "cyc_1",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      completionStatus: "partial",
      reminderCount: 3,
      sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_feedback",
        mentionedServices: {
          ppc: {
            serviceKey: "ppc",
            serviceName: "PPC / Media",
            projectId: "prj_1",
            sentiment: "negative",
            status: "captured",
            reasonText: "Lead quality is poor",
            reasonTags: ["lead quality"],
            detailAnswered: true,
            rating: null
          }
        }
      }
    };
    store._cycleComplete = true;
    store._cycleSummary = {
      project,
      cycle: { id: "cyc_1", csatScore: null },
      sessions: [store._session],
      issues: [], appreciations: [], observations: [], recipients: []
    };
    calls.automation.length = 0;
    calls.automationClaims.delete("cycle_completed:cycle:cyc_1");
    calls.automationClaims.delete("cycle_completed:feedback:session:sess_1");

    try {
      const res = await req("POST", "/api/automation/process-due-reminders", {});
      const payload = JSON.parse(res.body);
      assert.strictEqual(payload.reminders.length, 0);
      assert.strictEqual(payload.closed.length, 1);
      assert.strictEqual(payload.closed[0].outcome, "partial");
      assert.strictEqual(payload.closed[0].closingNotification.status, "sent");
      assert.strictEqual(payload.closed[0].finalAnalysisApplied, true);
      assert.strictEqual(payload.closed[0].session.conversationState.reminderExhausted, true);
      assert.ok(payload.closed[0].session.conversationState.closingTemplateSentAt);
      assert.strictEqual(payload.closed[0].session.csatScore, 4.5);
      assert.strictEqual(payload.closed[0].session.csatSource, "predicted");
      assert.strictEqual(calls.finalPartialAnalyses.length, analysesBefore + 1);
      const finalAnalysis = calls.finalPartialAnalyses.at(-1);
      assert.strictEqual(finalAnalysis.services[0].issueReady, true);
      assert.strictEqual(finalAnalysis.services[0].issueTitle, "Poor PPC lead quality");
      assert.strictEqual(finalAnalysis.predictedCsat, 4.5);
      assert.strictEqual(calls.automation.filter((event) => event.eventType === "cycle_completed").length, 1);
      assert.strictEqual(calls.automation.filter((event) => event.eventType === "feedback_session_closed").length, 1);
      assert.ok(!calls.automation.some((event) => event.eventType === "no_response"));
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      if (priorClosingWebhook === undefined) delete process.env.N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK;
      else process.env.N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK = priorClosingWebhook;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._cycleComplete = false;
      store._cycleSummary = null;
    }
  });

  await scenario("partial session remains open when the closing template cannot be delivered", async () => {
    const priorClosingWebhook = process.env.N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK;
    const priorFetch = global.fetch;
    process.env.N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK = "https://n8n.example/webhook/csat-feedback-session-closed";
    global.fetch = async () => ({ ok: false, status: 502, json: async () => ({ ok: false }) });
    store._session = {
      id: "sess_close_retry",
      cycleId: "cyc_close_retry",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "partial",
      completionStatus: "partial",
      reminderCount: 3,
      sessionType: "pulse",
      conversationState: {
        state: "waiting_for_overall_rating",
        overallRatingAsked: true,
        mentionedServices: {}
      }
    };
    try {
      const res = await req("POST", "/api/automation/process-due-reminders", {});
      const payload = JSON.parse(res.body);
      assert.strictEqual(payload.closed.length, 0);
      assert.strictEqual(payload.deferredClosures.length, 1);
      assert.strictEqual(payload.deferredClosures[0].reason, "closing_template_delivery_failed");
      assert.notStrictEqual(store._session.conversationState.reminderExhausted, true);
    } finally {
      if (priorClosingWebhook === undefined) delete process.env.N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK;
      else process.env.N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK = priorClosingWebhook;
      global.fetch = priorFetch;
    }
  });

  await scenario("third reminder grace expiry does not invent analysis for no response", async () => {
    const priorMessages = [...calls.messages];
    calls.messages.length = 0;
    const analysesBefore = calls.finalPartialAnalyses.length;
    store._session = {
      id: "sess_no_reply",
      cycleId: "cyc_no_reply",
      projectId: "prj_1",
      clientPocId: "poc_1",
      status: "no_response",
      completionStatus: "not_started",
      sessionType: "pulse",
      reminderCount: 3,
      csatScore: null,
      conversationState: { state: "waiting_for_service_feedback", mentionedServices: {} }
    };
    try {
      const res = await req("POST", "/api/automation/process-due-reminders", {});
      const payload = JSON.parse(res.body);
      assert.strictEqual(payload.closed.length, 1);
      assert.strictEqual(payload.closed[0].outcome, "no_response");
      assert.strictEqual(payload.closed[0].finalAnalysisApplied, false);
      assert.strictEqual(payload.closed[0].session.csatScore, null);
      assert.strictEqual(calls.finalPartialAnalyses.length, analysesBefore);
      assert.ok(!calls.automation.some((event) =>
        event.eventType === "feedback_session_closed"
        && event.payload?.session?.id === "sess_no_reply"
      ));
    } finally {
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
    }
  });

  await scenario("issue close route works", async () => {
    const res = await req("POST", "/api/issues/iss_1/close", { note: "spoke to client" });
    assert.strictEqual(JSON.parse(res.body).status, "closed");
  });

  // ---- Admin routes ----
  process.env.ADMIN_PIN = "1234";
  const PIN = { "x-admin-pin": "1234" };

  await scenario("bulk automatic feedback controls preview and update selected projects safely", async () => {
    const previous = {
      feedback: project.automaticFeedbackEnabled,
      quick: project.automaticQuickCheckinEnabled,
      quickResumeAt: project.automaticQuickCheckinResumeAt,
      nextDue: project.nextCycleDueAt
    };
    const pocWeight = poc.weightPercentage;
    const sessionBefore = store._session;
    try {
      const previewResponse = await req("POST", "/api/admin/project-automation/preview", {
        projectIds: [project.id],
        automaticFeedbackEnabled: false,
        automaticQuickCheckinEnabled: false
      }, PIN);
      assert.strictEqual(previewResponse.statusCode, 200, previewResponse.body);
      const preview = JSON.parse(previewResponse.body);
      assert.strictEqual(preview.eligibleProjects, 1);
      assert.strictEqual(preview.projects[0].current.automaticFeedbackEnabled, true);
      assert.strictEqual(preview.projects[0].next.automaticFeedbackEnabled, false);

      const updateResponse = await req("PUT", "/api/admin/project-automation/bulk", {
        projectIds: [project.id],
        automaticFeedbackEnabled: false,
        automaticQuickCheckinEnabled: false
      }, PIN);
      assert.strictEqual(updateResponse.statusCode, 200, updateResponse.body);
      const update = JSON.parse(updateResponse.body);
      assert.strictEqual(update.updatedProjects, 1);
      assert.strictEqual(project.automaticFeedbackEnabled, false);
      assert.strictEqual(project.automaticQuickCheckinEnabled, false);
      assert.strictEqual(poc.weightPercentage, pocWeight, "bulk controls must preserve POC influence");
      assert.strictEqual(store._session, sessionBefore, "bulk controls must preserve open sessions");
      assert.ok(calls.automation.some((event) => event.eventType === "project_automatic_sending_bulk_changed"));

      const duplicatePreviewResponse = await req("POST", "/api/admin/project-automation/preview", {
        projectIds: [project.id],
        automaticFeedbackEnabled: false,
        automaticQuickCheckinEnabled: false
      }, PIN);
      const duplicatePreview = JSON.parse(duplicatePreviewResponse.body);
      assert.strictEqual(duplicatePreview.eligibleProjects, 0);
      assert.match(duplicatePreview.projects[0].reasons[0], /already matches/i);
    } finally {
      project.automaticFeedbackEnabled = previous.feedback;
      project.automaticQuickCheckinEnabled = previous.quick;
      project.automaticQuickCheckinResumeAt = previous.quickResumeAt;
      project.nextCycleDueAt = previous.nextDue;
      store._session = sessionBefore;
    }
  });

  await scenario("admin write without the PIN is rejected", async () => {
    const res = await req("POST", "/api/admin/projects", { clientId: "cl_1", key: "new-one", name: "New" });
    assert.strictEqual(res.statusCode, 403);
  });

  await scenario("admin write with the wrong PIN is rejected", async () => {
    const res = await req("POST", "/api/admin/projects", { clientId: "cl_1", key: "new-one", name: "New" }, { "x-admin-pin": "9999" });
    assert.strictEqual(res.statusCode, 403);
  });

  await scenario("Project User and linked Internal POC can be created in one Application Users step", async () => {
    const beforeInternalPocs = calls.createdInternalPocs.length;
    const response = await rawReq("POST", "/api/admin/app-users", {
      email: "new.project.user@srvmedia.com",
      name: "New Project User",
      role: "project_user",
      createInternalPoc: true,
      active: true
    }, { cookie: googleAppCookie, ...PIN });
    const payload = JSON.parse(response.body);
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(calls.createdInternalPocs.length, beforeInternalPocs + 1);
    assert.strictEqual(payload.internalPoc.email, "new.project.user@srvmedia.com");
    assert.strictEqual(payload.user.internalPocId, payload.internalPoc.id);
    const refreshed = await rawReq("GET", "/api/admin/app-users", {}, { cookie: googleAppCookie, ...PIN });
    assert.strictEqual(refreshed.statusCode, 200);
    assert.ok(JSON.parse(refreshed.body).users.some((user) => user.email === "new.project.user@srvmedia.com"));
  });

  await scenario("one Internal POC cannot be linked to two Application Users", async () => {
    const createDuplicate = await rawReq("POST", "/api/admin/app-users", {
      email: "duplicate.owner@srvmedia.com",
      name: "Duplicate Owner",
      role: "project_user",
      internalPocId: "ip_1",
      active: true
    }, { cookie: googleAppCookie, ...PIN });
    assert.strictEqual(createDuplicate.statusCode, 409);
    assert.match(JSON.parse(createDuplicate.body).error, /already linked/i);

    const updateDuplicate = await rawReq("PATCH", "/api/admin/app-users/app_user_admin", {
      role: "project_user",
      internalPocId: "ip_1",
      active: true
    }, { cookie: googleAppCookie, ...PIN });
    assert.strictEqual(updateDuplicate.statusCode, 409);
    assert.match(JSON.parse(updateDuplicate.body).error, /already linked/i);
  });

  await scenario("Only Super Admin can approve a Project User service request", async () => {
    const request = store._serviceChangeRequests.find((item) => item.status === "pending");
    assert.ok(request, "Expected the Project User service request created earlier");
    store._appUserRole = "admin";
    const adminAttempt = await rawReq("PATCH", `/api/admin/service-change-requests/${request.id}`, {
      decision: "approved"
    }, { cookie: googleAppCookie, ...PIN });
    assert.strictEqual(adminAttempt.statusCode, 403);

    store._appUserRole = "super_admin";
    const queue = await rawReq("GET", "/api/admin/service-change-requests", {}, { cookie: googleAppCookie, ...PIN });
    assert.strictEqual(queue.statusCode, 200);
    assert.ok(JSON.parse(queue.body).requests.some((item) => item.id === request.id && item.status === "pending"));

    const beforeDeletes = calls.deletedServices.length;
    const approved = await rawReq("PATCH", `/api/admin/service-change-requests/${request.id}`, {
      decision: "approved",
      reviewNote: "Confirmed against the current scope."
    }, { cookie: googleAppCookie, ...PIN });
    assert.strictEqual(approved.statusCode, 200);
    assert.strictEqual(JSON.parse(approved.body).request.status, "approved");
    assert.strictEqual(calls.deletedServices.length, beforeDeletes + 1);

    const repeated = await rawReq("PATCH", `/api/admin/service-change-requests/${request.id}`, {
      decision: "approved"
    }, { cookie: googleAppCookie, ...PIN });
    assert.strictEqual(repeated.statusCode, 409);
  });

  await scenario("Application User without history can be permanently deleted", async () => {
    const res = await req("DELETE", "/api/admin/app-users/app_user_clean", {}, PIN);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).action, "deleted");
    assert.ok(!store._applicationUsers.some((user) => user.id === "app_user_clean"));
  });

  await scenario("Application User with history must be deactivated instead of deleted", async () => {
    const res = await req("DELETE", "/api/admin/app-users/app_user_history", {}, PIN);
    assert.strictEqual(res.statusCode, 409);
    assert.match(JSON.parse(res.body).error, /history/i);
    assert.ok(store._applicationUsers.some((user) => user.id === "app_user_history"));
  });

  await scenario("self-deletion and Super Admin deletion are protected", async () => {
    const own = await rawReq("DELETE", "/api/admin/app-users/app_user_1", {}, { cookie: googleAppCookie, ...PIN });
    assert.strictEqual(own.statusCode, 409);
    assert.match(JSON.parse(own.body).error, /own/i);
    const protectedAccount = await req("DELETE", "/api/admin/app-users/app_user_1", {}, PIN);
    assert.strictEqual(protectedAccount.statusCode, 409);
    assert.match(JSON.parse(protectedAccount.body).error, /Super Admin accounts cannot be deleted/i);
  });

  await scenario("WhatsApp master control needs the PIN and leaves email events available", async () => {
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    const priorMessagingStatus = store._messagingStatus;
    const wrong = await req("PATCH", "/api/admin/messaging", { enabled: false }, { "x-admin-pin": "9999" });
    assert.strictEqual(wrong.statusCode, 403);
    try {
      const paused = await req("PATCH", "/api/admin/messaging", { enabled: false }, PIN);
      assert.strictEqual(paused.statusCode, 200);
      assert.strictEqual(JSON.parse(paused.body).messaging.enabled, false);

      const cyclesBefore = calls.createdCycleRequests.length;
      const blocked = await req("POST", `/api/projects/${project.key}/request-feedback`, { cycleType: "pulse" });
      assert.strictEqual(blocked.statusCode, 423);
      assert.strictEqual(calls.createdCycleRequests.length, cyclesBefore);

      const scheduled = await rawReq("POST", "/api/automation/create-due-sessions", {}, {});
      assert.strictEqual(scheduled.statusCode, 200);
      assert.strictEqual(JSON.parse(scheduled.body).paused, true);

      const priorAutomationCount = calls.automation.length;
      store._session = {
        id: "sess_paused_inbound", cycleId: "cyc_paused_inbound", projectId: project.id,
        clientPocId: poc.id, status: "partial", completionStatus: "partial",
        sessionType: "pulse", conversationState: { state: "waiting_for_overall_rating" }
      };
      const inbound = await rawReq("POST", `/api/whatsapp/sessions/${store._session.id}/reply`, {
        from: poc.contactWhatsapp,
        fromName: poc.name,
        text: "Please ask the team to call me",
        providerMessageId: "wamid-paused-1"
      });
      const inboundPayload = JSON.parse(inbound.body);
      assert.strictEqual(inbound.statusCode, 200);
      assert.strictEqual(inboundPayload.sendToWhatsapp, false);
      assert.strictEqual(inboundPayload.messagingPaused, true);
      assert.strictEqual(calls.messages.at(-1).metadata.receivedWhileMessagingPaused, true);
      assert.ok(calls.automation.slice(priorAutomationCount).some((event) => event.eventType === "handoff"), "email handoff must remain available while WhatsApp is paused");

      const resumed = await req("PATCH", "/api/admin/messaging", { enabled: true }, PIN);
      assert.strictEqual(JSON.parse(resumed.body).messaging.enabled, true);
    } finally {
      store._messagingStatus = priorMessagingStatus;
      store._session = priorSession;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
    }
  });

  await scenario("bulk preview blocks every already-active WhatsApp conversation", async () => {
    const previousListProjects = store.listProjects;
    const previousRouting = store.getWhatsappRoutingContext;
    const previousSession = store._session;
    store.listProjects = async () => [{ ...project, activeStatus: "active", clientActiveStatus: "active", clientName: "Test Client" }];
    try {
      store.getWhatsappRoutingContext = async () => ({ status: "no_session", poc, session: null });
      const clear = await req("POST", "/api/admin/bulk-feedback/preview", { cycleType: "quick_checkin" }, PIN);
      assert.strictEqual(clear.statusCode, 200);
      assert.strictEqual(JSON.parse(clear.body).projects[0].eligible, true);

      const emptyScope = await req("POST", "/api/admin/bulk-feedback/preview", {
        cycleType: "quick_checkin",
        projectIds: []
      }, PIN);
      assert.strictEqual(emptyScope.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(emptyScope.body).projects, [], "an empty filtered scope must not fall back to all projects");

      store.getWhatsappRoutingContext = async () => ({
        status: "active",
        poc,
        session: { ...previousSession, sessionType: "quick_checkin", projectId: "another_project" }
      });
      const blocked = await req("POST", "/api/admin/bulk-feedback/preview", { cycleType: "quick_checkin" }, PIN);
      const projectPreview = JSON.parse(blocked.body).projects[0];
      assert.strictEqual(projectPreview.eligible, false);
      assert.match(projectPreview.conflicts[0].reason, /active session/i);
    } finally {
      store.listProjects = previousListProjects;
      if (previousRouting) store.getWhatsappRoutingContext = previousRouting;
      else delete store.getWhatsappRoutingContext;
      store._session = previousSession;
    }
  });

  await scenario("directory read needs no PIN", async () => {
    const res = await req("GET", "/api/admin/directory");
    assert.strictEqual(res.statusCode, 200);
  });

  await scenario("Admin can bulk update project teams from Internal POCs", async () => {
    const listing = await req("GET", "/api/admin/project-teams");
    assert.strictEqual(listing.statusCode, 200);
    assert.strictEqual(JSON.parse(listing.body).projects.length, 1);
    const before = calls.performanceSaves.length;
    const res = await req("PUT", "/api/admin/project-teams", {
      rows: [{
        projectId: "prj_1",
        team: { projectDirectorId: "ip_1", amId: "ip_1", tlId: "", adId: "", avpId: "" }
      }]
    }, PIN);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls.performanceSaves.length, before + 1);
    assert.strictEqual(calls.performanceSaves.at(-1).input.profile.team.projectDirectorId, "ip_1");
    assert.strictEqual(calls.performanceSaves.at(-1).input.profile.team.tlId, null);
  });

  await scenario("Admin can preview and apply a PIN-protected bulk project status change", async () => {
    const before = calls.updatedProjects.length;
    const res = await req("PUT", "/api/admin/projects/bulk-status", {
      projectIds: ["prj_1"],
      activeStatus: "paused"
    }, PIN);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).updated, 1);
    assert.strictEqual(calls.updatedProjects.length, before + 1);
    assert.deepStrictEqual(calls.updatedProjects.at(-1), { id: "prj_1", input: { activeStatus: "paused" } });

    const invalid = await req("PUT", "/api/admin/projects/bulk-status", {
      projectIds: ["prj_1"],
      activeStatus: "inactive"
    }, PIN);
    assert.strictEqual(invalid.statusCode, 400);
  });

  await scenario("client detail returns projects, pocs and services", async () => {
    const res = await req("GET", "/api/admin/clients/cl_1");
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.pocs.length, 1);
    assert.strictEqual(payload.projects.length, 1);
  });

  await scenario("admin can permanently delete selected client POCs", async () => {
    const res = await req("DELETE", "/api/admin/client-pocs", { clientId: "cl_1", pocIds: ["poc_1"] }, PIN);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).pocsDeleted, 1);
    assert.deepStrictEqual(calls.deletedClientPocs.at(-1), ["poc_1"]);
  });

  await scenario("POC deletion rejects a POC outside the selected client", async () => {
    const res = await req("DELETE", "/api/admin/client-pocs", { clientId: "cl_1", pocIds: ["poc_other"] }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("admin can permanently delete selected projects", async () => {
    const res = await req("DELETE", "/api/admin/projects", { clientId: "cl_1", projectIds: ["prj_1"] }, PIN);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).projectsDeleted, 1);
    assert.deepStrictEqual(calls.deletedProjects.at(-1), ["prj_1"]);
  });

  await scenario("admin can permanently delete a whole client", async () => {
    const res = await req("DELETE", "/api/admin/clients", { clientIds: ["cl_1"] }, PIN);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).clientsDeleted, 1);
    assert.deepStrictEqual(calls.deletedClients.at(-1), ["cl_1"]);
  });

  await scenario("all project POC tags and direct percentages save together", async () => {
    const res = await req("PUT", "/api/admin/projects/prj_1/pocs", {
      pocs: [{
        ...poc,
        levelId: "important",
        birthDate: "1988-04-18",
        weightPercentage: 100
      }],
      removedIds: []
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(payload.pocs[0].weightPercentage, 100);
    assert.strictEqual(payload.pocs[0].levelId, "important");
    assert.strictEqual(payload.pocs[0].birthDate, "1988-04-18");
  });

  await scenario("removing project POCs removes only the selected assignment, not its feedback history", async () => {
    const hardDeletes = calls.deletedClientPocs.length;
    const res = await req("PUT", "/api/admin/projects/prj_1/pocs", { pocs: [], removedIds: [poc.id] }, PIN);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).removed, 1);
    assert.deepStrictEqual(calls.removedProjectPocs.at(-1), { projectId: project.id, ids: [poc.id] });
    assert.strictEqual(calls.deletedClientPocs.length, hardDeletes);
  });

  await scenario("removing the same POC twice counts it only once", async () => {
    const res = await req("PUT", "/api/admin/projects/prj_1/pocs", { pocs: [], removedIds: [poc.id, poc.id] }, PIN);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).removed, 1);
  });

  await scenario("POC removal cannot affect an assignment on another project", async () => {
    const before = calls.savedPocBatches.length;
    const res = await req("PUT", "/api/admin/projects/prj_1/pocs", { pocs: [], removedIds: ["poc_other_project"] }, PIN);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.savedPocBatches.length, before);
  });

  await scenario("a POC cannot be both retained and removed in the same save", async () => {
    const before = calls.savedPocBatches.length;
    const res = await req("PUT", "/api/admin/projects/prj_1/pocs", { pocs: [poc], removedIds: [poc.id] }, PIN);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.savedPocBatches.length, before);
  });

  await scenario("removed project POCs cannot be reactivated from a stale Control Centre", async () => {
    const previousGet = store.getClientPocById;
    store.getClientPocById = async () => ({ ...poc, removedAt: "2026-10-20T00:00:00Z" });
    try {
      const res = await req("PUT", "/api/admin/pocs/bulk-control", { updates: [{ id: poc.id, active: true, weightPercentage: 100 }] }, PIN);
      assert.strictEqual(res.statusCode, 409);
      const patch = await req("PATCH", `/api/admin/pocs/${poc.id}`, { active: true }, PIN);
      assert.strictEqual(patch.statusCode, 409);
    } finally { store.getClientPocById = previousGet; }
  });

  await scenario("a removed assignment can be replaced by the same number in one project save", async () => {
    const res = await req("PUT", "/api/admin/projects/prj_1/pocs", {
      pocs: [{ ...poc, id: undefined, name: "Replacement" }], removedIds: [poc.id]
    }, PIN);
    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.removed, 1);
    assert.ok(payload.pocs[0].id && payload.pocs[0].id !== poc.id);
  });

  await scenario("editing a POC cannot move its historical assignment to another project", async () => {
    const res = await req("PATCH", `/api/admin/pocs/${poc.id}`, { projectId: "different-project" }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("an active client POC can be saved before their WhatsApp number is known", async () => {
    const res = await req("PUT", "/api/admin/projects/prj_1/pocs", {
      pocs: [{ ...poc, contactWhatsapp: "", levelId: "normal", weightPercentage: 100, active: true }],
      removedIds: []
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(payload.pocs[0].active, true);
    assert.strictEqual(payload.pocs[0].contactWhatsapp, "");
  });

  await scenario("active projects may keep only inactive historical POCs", async () => {
    const res = await req("PUT", "/api/admin/projects/prj_1/pocs", {
      pocs: [{ ...poc, levelId: "", active: false, weightPercentage: 0 }],
      removedIds: []
    }, PIN);
    assert.strictEqual(res.statusCode, 200);
  });

  await scenario("POC Control Centre saves salutation, status, tag and manual influence together", async () => {
    const res = await req("PUT", "/api/admin/pocs/bulk-control", {
      updates: [{ id: poc.id, salutation: "Haranath Sir", active: true, levelId: "important", weightPercentage: 100 }]
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(payload.updated, 1);
    assert.strictEqual(payload.pocs[0].active, true);
    assert.strictEqual(payload.pocs[0].salutation, "Haranath Sir");
    assert.strictEqual(payload.pocs[0].levelId, "important");
    assert.strictEqual(payload.pocs[0].weightPercentage, 100);
  });

  await scenario("POC Control Centre allows every POC on a project to be inactive", async () => {
    const previousGet = store.getClientPocById;
    const previousList = store.pocsForProject;
    const untagged = { ...poc, levelId: null, active: false, weightPercentage: 0 };
    store.getClientPocById = async () => untagged;
    store.pocsForProject = async () => [untagged];
    try {
      const res = await req("PUT", "/api/admin/pocs/bulk-control", {
        updates: [{ id: poc.id, active: false, levelId: "", weightPercentage: 0 }]
      }, PIN);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(JSON.parse(res.body).pocs[0].active, false);
    } finally {
      store.getClientPocById = previousGet;
      store.pocsForProject = previousList;
    }
  });

  await scenario("POC Control Centre can activate a POC whose WhatsApp number is still missing", async () => {
    const previousGet = store.getClientPocById;
    const previousList = store.pocsForProject;
    const numberPending = { ...poc, contactWhatsapp: "", levelId: "normal", active: false, weightPercentage: 0 };
    store.getClientPocById = async () => numberPending;
    store.pocsForProject = async () => [numberPending];
    try {
      const res = await req("PUT", "/api/admin/pocs/bulk-control", {
        updates: [{ id: poc.id, active: true, levelId: "normal", weightPercentage: 100 }]
      }, PIN);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(JSON.parse(res.body).pocs[0].active, true);
    } finally {
      store.getClientPocById = previousGet;
      store.pocsForProject = previousList;
    }
  });

  await scenario("project POC percentages must total exactly 100", async () => {
    const res = await req("PUT", "/api/admin/projects/prj_1/pocs", {
      pocs: [{ ...poc, weightPercentage: 40 }],
      removedIds: []
    }, PIN);
    assert.strictEqual(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /total exactly 100/i);
  });

  await scenario("admin can clear chats from selected project cycles without deleting derived records", async () => {
    const res = await req("DELETE", "/api/admin/projects/prj_1/chat-messages", { cycleIds: ["cyc_1"] }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(payload.messagesDeleted, 12);
    assert.strictEqual(payload.sessionsAffected, 3);
    assert.strictEqual(payload.cyclesAffected, 1);
    assert.ok(payload.preserved.includes("ratings"));
    assert.ok(payload.preserved.includes("issues"));
    assert.deepStrictEqual(calls.clearedProjectMessages.at(-1), { projectId: "prj_1", cycleIds: ["cyc_1"] });
  });

  await scenario("project chat cleanup requires at least one selected cycle", async () => {
    const before = calls.clearedProjectMessages.length;
    const res = await req("DELETE", "/api/admin/projects/prj_1/chat-messages", {}, PIN);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.clearedProjectMessages.length, before);
  });

  await scenario("project chat cleanup rejects cycles from another project", async () => {
    const before = calls.clearedProjectMessages.length;
    const res = await req("DELETE", "/api/admin/projects/prj_1/chat-messages", { cycleIds: ["cyc_foreign"] }, PIN);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.clearedProjectMessages.length, before);
  });

  await scenario("project chat cleanup requires the admin PIN", async () => {
    const before = calls.clearedProjectMessages.length;
    const res = await req("DELETE", "/api/admin/projects/prj_1/chat-messages");
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(calls.clearedProjectMessages.length, before);
  });

  await scenario("admin can permanently delete selected project cycles and all dependent feedback", async () => {
    const res = await req("DELETE", "/api/admin/projects/prj_1/feedback-cycles", {
      cycleIds: ["cyc_1"]
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(payload.cyclesDeleted, 1);
    assert.strictEqual(payload.sessionsDeleted, 2);
    assert.strictEqual(payload.messagesDeleted, 9);
    assert.strictEqual(payload.issuesDeleted, 3);
    assert.strictEqual(payload.serviceFeedbackDeleted, 4);
    assert.ok(payload.preserved.includes("feedback schedule"));
    assert.ok(payload.preserved.includes("other feedback cycles"));
    assert.deepStrictEqual(calls.deletedProjectCycles.at(-1), { projectId: "prj_1", cycleIds: ["cyc_1"] });
  });

  await scenario("project cycle deletion rejects cycles from another project", async () => {
    const before = calls.deletedProjectCycles.length;
    const res = await req("DELETE", "/api/admin/projects/prj_1/feedback-cycles", {
      cycleIds: ["cyc_foreign"]
    }, PIN);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.deletedProjectCycles.length, before);
  });

  await scenario("project cycle deletion requires the admin PIN", async () => {
    const before = calls.deletedProjectCycles.length;
    const res = await req("DELETE", "/api/admin/projects/prj_1/feedback-cycles", {
      cycleIds: ["cyc_1"]
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(calls.deletedProjectCycles.length, before);
  });

  await scenario("admin can delete selected issues from selected project cycles while preserving chats and ratings", async () => {
    const res = await req("DELETE", "/api/admin/projects/prj_1/issues", {
      cycleIds: ["cyc_1"],
      issueIds: ["iss_1"]
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(payload.issuesDeleted, 4);
    assert.strictEqual(payload.issueEventsDeleted, 7);
    assert.ok(payload.preserved.includes("chat messages"));
    assert.ok(payload.preserved.includes("ratings"));
    assert.deepStrictEqual(calls.clearedProjectIssues.at(-1), { projectId: "prj_1", issueIds: ["iss_1"] });
  });

  await scenario("project issue cleanup rejects issues outside the selected cycles", async () => {
    const before = calls.clearedProjectIssues.length;
    store._projectCycles.push({ id: "cyc_2", projectId: "prj_1", cycleType: "pulse", status: "closed" });
    store._projectSessions.push({ id: "sess_2", cycleId: "cyc_2", projectId: "prj_1" });
    store._projectIssues.push({ id: "iss_2", sessionId: "sess_2", projectId: "prj_1" });
    try {
      const res = await req("DELETE", "/api/admin/projects/prj_1/issues", {
        cycleIds: ["cyc_1"],
        issueIds: ["iss_2"]
      }, PIN);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(calls.clearedProjectIssues.length, before);
    } finally {
      store._projectCycles.pop();
      store._projectSessions.pop();
      store._projectIssues.pop();
    }
  });

  await scenario("project issue cleanup requires the admin PIN", async () => {
    const before = calls.clearedProjectIssues.length;
    const res = await req("DELETE", "/api/admin/projects/prj_1/issues");
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(calls.clearedProjectIssues.length, before);
  });

  await scenario("Supabase project chat cleanup deletes only messages belonging to that project's sessions", async () => {
    const cleanupStore = Object.create(SupabaseStore.prototype);
    const requests = [];
    cleanupStore.request = async (table, options = {}) => {
      requests.push({ table, options });
      if (table === "feedback_sessions" && !options.method) {
        return [{ id: "sess_a" }, { id: "sess_b" }];
      }
      if (table === "messages" && options.method === "DELETE") {
        return [{ id: "msg_1" }, { id: "msg_2" }, { id: "msg_3" }];
      }
      throw new Error(`Unexpected ${options.method || "GET"} ${table}`);
    };

    const result = await cleanupStore.clearProjectMessages("prj_cleanup", ["cyc_a", "cyc_b"]);
    assert.deepStrictEqual(result, { messagesDeleted: 3, sessionsAffected: 2, cyclesAffected: 2 });
    assert.match(requests[0].options.query, /^project_id=eq\.prj_cleanup&cycle_id=in\.\(cyc_a,cyc_b\)&select=id$/);
    assert.match(requests[1].options.query, /^session_id=in\.\(sess_a,sess_b\)&select=id$/);
    assert.strictEqual(requests[1].table, "messages");
    assert.ok(!requests.some((request) => request.table === "feedback_sessions" && request.options.method === "DELETE"));
  });

  await scenario("Supabase project issue cleanup removes issue events before only that project's issues", async () => {
    const cleanupStore = Object.create(SupabaseStore.prototype);
    const requests = [];
    cleanupStore.request = async (table, options = {}) => {
      requests.push({ table, options });
      if (table === "issues" && !options.method) return [{ id: "iss_a" }, { id: "iss_b" }];
      if (table === "issue_events" && options.method === "DELETE") return [{ id: "evt_1" }];
      if (table === "issues" && options.method === "DELETE") return [{ id: "iss_a" }, { id: "iss_b" }];
      throw new Error(`Unexpected ${options.method || "GET"} ${table}`);
    };

    const result = await cleanupStore.deleteProjectIssues("prj_cleanup", ["iss_a", "iss_b"]);
    assert.deepStrictEqual(result, { issuesDeleted: 2, issueEventsDeleted: 1 });
    assert.strictEqual(requests[0].options.query, "project_id=eq.prj_cleanup&id=in.(iss_a,iss_b)&select=id");
    assert.strictEqual(requests[1].table, "issue_events");
    assert.match(requests[1].options.query, /^issue_id=in\.\(iss_a,iss_b\)&select=id$/);
    assert.strictEqual(requests[2].table, "issues");
    assert.strictEqual(requests[2].options.query, "project_id=eq.prj_cleanup&id=in.(iss_a,iss_b)&select=id");
    assert.ok(!requests.some((request) => request.table === "messages"));
  });

  await scenario("Supabase project cycle deletion removes dependent feedback before sessions and cycles", async () => {
    const cleanupStore = Object.create(SupabaseStore.prototype);
    const requests = [];
    let rollupProjectId = null;
    cleanupStore.refreshProjectRollups = async (projectId) => { rollupProjectId = projectId; };
    cleanupStore.request = async (table, options = {}) => {
      requests.push({ table, options });
      if (table === "feedback_cycles" && !options.method) return [{ id: "cyc_a" }];
      if (table === "feedback_sessions" && !options.method) return [{ id: "sess_a" }, { id: "sess_b" }];
      if (table === "issues" && !options.method) return [{ id: "iss_a" }];
      if (table === "issue_events" && options.method === "DELETE") return [{ id: "evt_1" }, { id: "evt_2" }];
      if (table === "issues" && options.method === "DELETE") return [{ id: "iss_a" }];
      if (table === "observations" && options.method === "DELETE") return [{ id: "obs_1" }];
      if (table === "service_feedback" && options.method === "DELETE") return [{ id: "sf_1" }, { id: "sf_2" }];
      if (table === "messages" && options.method === "DELETE") return [{ id: "msg_1" }, { id: "msg_2" }, { id: "msg_3" }];
      if (table === "feedback_sessions" && options.method === "DELETE") return [{ id: "sess_a" }, { id: "sess_b" }];
      if (table === "feedback_cycles" && options.method === "DELETE") return [{ id: "cyc_a" }];
      throw new Error(`Unexpected ${options.method || "GET"} ${table}`);
    };

    const result = await cleanupStore.deleteProjectCycles("prj_cleanup", ["cyc_a"]);
    assert.deepStrictEqual(result, {
      cyclesDeleted: 1,
      sessionsDeleted: 2,
      messagesDeleted: 3,
      issuesDeleted: 1,
      issueEventsDeleted: 2,
      observationsDeleted: 1,
      serviceFeedbackDeleted: 2
    });
    assert.strictEqual(rollupProjectId, "prj_cleanup");
    const eventDelete = requests.findIndex((request) => request.table === "issue_events" && request.options.method === "DELETE");
    const issueDelete = requests.findIndex((request) => request.table === "issues" && request.options.method === "DELETE");
    const sessionDelete = requests.findIndex((request) => request.table === "feedback_sessions" && request.options.method === "DELETE");
    const cycleDelete = requests.findIndex((request) => request.table === "feedback_cycles" && request.options.method === "DELETE");
    assert.ok(eventDelete >= 0 && eventDelete < issueDelete);
    assert.ok(issueDelete < sessionDelete && sessionDelete < cycleDelete);
  });

  await scenario("deleting the final project-end cycle resets its recurring-feedback lock safely", async () => {
    const cleanupStore = Object.create(SupabaseStore.prototype);
    const requests = [];
    cleanupStore.refreshProjectRollups = async () => {};
    cleanupStore.request = async (table, options = {}) => {
      requests.push({ table, options });
      if (table === "feedback_cycles" && !options.method && options.query.includes("id=in.")) {
        return [{ id: "cyc_end", cycle_type: "project_end" }];
      }
      if (table === "feedback_sessions" && !options.method) return [];
      if (table === "feedback_cycles" && options.method === "DELETE") return [{ id: "cyc_end" }];
      if (table === "feedback_cycles" && !options.method && options.query.includes("cycle_type=eq.project_end")) {
        return [];
      }
      if (table === "projects" && !options.method) {
        return [{ id: "prj_cleanup", feedback_interval_days: 30, automatic_feedback_enabled: true }];
      }
      if (table === "projects" && options.method === "PATCH") return [];
      throw new Error(`Unexpected ${options.method || "GET"} ${table}: ${options.query || ""}`);
    };

    const before = Date.now();
    const result = await cleanupStore.deleteProjectCycles("prj_cleanup", ["cyc_end"]);
    const after = Date.now();
    assert.strictEqual(result.projectEndLockReset, true);
    const projectPatch = requests.find((request) =>
      request.table === "projects" && request.options.method === "PATCH").options.body;
    assert.strictEqual(projectPatch.end_feedback_requested_at, null);
    const dueAt = Date.parse(projectPatch.next_cycle_due_at);
    assert.ok(dueAt >= before + (30 * 24 * 60 * 60 * 1000));
    assert.ok(dueAt <= after + (30 * 24 * 60 * 60 * 1000) + 1000);
  });

  await scenario("deleting one project-end cycle keeps the lock when another remains", async () => {
    const cleanupStore = Object.create(SupabaseStore.prototype);
    const requests = [];
    cleanupStore.refreshProjectRollups = async () => {};
    cleanupStore.request = async (table, options = {}) => {
      requests.push({ table, options });
      if (table === "feedback_cycles" && !options.method && options.query.includes("id=in.")) {
        return [{ id: "cyc_end_old", cycle_type: "project_end" }];
      }
      if (table === "feedback_sessions" && !options.method) return [];
      if (table === "feedback_cycles" && options.method === "DELETE") return [{ id: "cyc_end_old" }];
      if (table === "feedback_cycles" && !options.method && options.query.includes("cycle_type=eq.project_end")) {
        return [{ id: "cyc_end_remaining" }];
      }
      throw new Error(`Unexpected ${options.method || "GET"} ${table}: ${options.query || ""}`);
    };

    const result = await cleanupStore.deleteProjectCycles("prj_cleanup", ["cyc_end_old"]);
    assert.strictEqual(result.projectEndLockReset, undefined);
    assert.ok(!requests.some((request) => request.table === "projects"));
  });

  await scenario("Supabase project deletion removes restricted children before the project", async () => {
    const cleanupStore = Object.create(SupabaseStore.prototype);
    const requests = [];
    cleanupStore.request = async (table, options = {}) => {
      requests.push({ table, options });
      if (table === "feedback_sessions" && !options.method) {
        return [{ id: "sess_a" }, { id: "sess_b" }];
      }
      if (options.method === "DELETE") {
        const counts = {
          issue_events: 2,
          issues: 1,
          observations: 3,
          service_feedback: 2,
          messages: 4,
          feedback_sessions: 2,
          feedback_cycles: 1,
          client_pocs: 1,
          project_services: 2,
          projects: 1
        };
        return Array.from({ length: counts[table] || 0 }, (_, index) => ({ id: `${table}_${index}` }));
      }
      throw new Error(`Unexpected ${options.method || "GET"} ${table}`);
    };

    const result = await cleanupStore.deleteProjects(["prj_cleanup"]);
    assert.deepStrictEqual(result, {
      projectsDeleted: 1,
      pocsDeleted: 1,
      servicesDeleted: 2,
      cyclesDeleted: 1,
      sessionsDeleted: 2,
      messagesDeleted: 4,
      serviceFeedbackDeleted: 2,
      observationsDeleted: 3,
      issuesDeleted: 1,
      issueEventsDeleted: 2
    });
    const observationDelete = requests.findIndex((request) => request.table === "observations");
    const sessionDelete = requests.findIndex((request) => request.table === "feedback_sessions" && request.options.method === "DELETE");
    const projectDelete = requests.findIndex((request) => request.table === "projects" && request.options.method === "DELETE");
    assert.ok(observationDelete >= 0 && observationDelete < sessionDelete);
    assert.ok(sessionDelete < projectDelete);
    assert.match(requests.find((request) => request.table === "messages").options.query, /^session_id=in\.\(sess_a,sess_b\)&select=id$/);
  });

  await scenario("Supabase whole-client deletion cleans its projects before the client", async () => {
    const cleanupStore = Object.create(SupabaseStore.prototype);
    const calls = [];
    cleanupStore.request = async (table, options = {}) => {
      calls.push({ table, options });
      if (table === "projects" && !options.method) return [{ id: "prj_a" }, { id: "prj_b" }];
      if (table === "clients" && options.method === "DELETE") return [{ id: "cl_a" }];
      throw new Error(`Unexpected ${options.method || "GET"} ${table}`);
    };
    cleanupStore.deleteProjects = async (ids) => {
      calls.push({ table: "deleteProjects", ids });
      return { projectsDeleted: ids.length, observationsDeleted: 3 };
    };

    const result = await cleanupStore.deleteClients(["cl_a"]);
    assert.deepStrictEqual(result, { clientsDeleted: 1, projectsDeleted: 2, observationsDeleted: 3 });
    assert.deepStrictEqual(calls.find((call) => call.table === "deleteProjects").ids, ["prj_a", "prj_b"]);
    assert.ok(calls.findIndex((call) => call.table === "deleteProjects")
      < calls.findIndex((call) => call.table === "clients" && call.options.method === "DELETE"));
  });

  await scenario("cycle deletion rollups use remaining history without changing feedback schedule fields", async () => {
    const rollupStore = Object.create(SupabaseStore.prototype);
    const patches = [];
    rollupStore.listProjectCycles = async () => [{ id: "cyc_remaining", csatScore: 8.2, riskLevel: "Low" }];
    rollupStore.listProjectSessions = async () => [
      { id: "sess_remaining", cycleId: "cyc_remaining", csatScore: 8.2, npsScore: 9, rootCause: "Older retained concern" }
    ];
    rollupStore.servicesForProject = async () => [
      { id: "svc_ads", serviceKey: "ads" },
      { id: "svc_seo", serviceKey: "seo" }
    ];
    rollupStore.request = async (table, options = {}) => {
      if (table === "service_feedback" && !options.method) {
        return [{ service_key: "ads", rating: null, predicted_rating: 7.5, reason_text: "Retained feedback" }];
      }
      if (options.method === "PATCH") {
        patches.push({ table, options });
        return [];
      }
      throw new Error(`Unexpected ${options.method || "GET"} ${table}`);
    };

    await rollupStore.refreshProjectRollups("prj_cleanup");
    const projectPatch = patches.find((patch) => patch.table === "projects").options.body;
    assert.strictEqual(projectPatch.csat_score, 8.2);
    assert.strictEqual(projectPatch.nps_score, 100);
    assert.strictEqual(projectPatch.root_cause, "Older retained concern");
    assert.ok(!Object.hasOwn(projectPatch, "next_cycle_due_at"));
    assert.ok(!Object.hasOwn(projectPatch, "last_cycle_started_at"));
    assert.ok(!Object.hasOwn(projectPatch, "end_feedback_requested_at"));
    const adsPatch = patches.find((patch) => patch.options.query === "id=eq.svc_ads").options.body;
    const seoPatch = patches.find((patch) => patch.options.query === "id=eq.svc_seo").options.body;
    assert.strictEqual(adsPatch.score, 7.5);
    assert.strictEqual(seoPatch.score, null);
    assert.strictEqual(seoPatch.pulse, null);
  });

  await scenario("POC group percentages can be updated with the PIN", async () => {
    const res = await req("PATCH", "/api/admin/poc-levels", {
      levels: [{ id: "normal", weight: 40 }, { id: "important", weight: 60 }]
    }, PIN);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).levels[1].weight, 60);
    assert.deepStrictEqual(calls.updatedPocLevels.at(-1), [
      { id: "normal", weight: 40 },
      { id: "important", weight: 60 }
    ]);
  });

  await scenario("POC level weight updates require the PIN", async () => {
    const res = await req("PATCH", "/api/admin/poc-levels", {
      levels: [{ id: "normal", weight: 40 }, { id: "important", weight: 60 }]
    });
    assert.strictEqual(res.statusCode, 403);
  });

  await scenario("invalid POC group percentages are refused", async () => {
    const before = calls.updatedPocLevels.length;
    const res = await req("PATCH", "/api/admin/poc-levels", {
      levels: [{ id: "normal", weight: 0 }, { id: "important", weight: 100 }]
    }, PIN);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.updatedPocLevels.length, before);
  });

  await scenario("Important POC allocation must remain greater than Normal", async () => {
    const res = await req("PATCH", "/api/admin/poc-levels", {
      levels: [{ id: "normal", weight: 50 }, { id: "important", weight: 50 }]
    }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("Normal and Important POC allocations must total 100 percent", async () => {
    const res = await req("PATCH", "/api/admin/poc-levels", {
      levels: [{ id: "normal", weight: 30 }, { id: "important", weight: 60 }]
    }, PIN);
    assert.strictEqual(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /total 100/i);
  });

  await scenario("unknown POC levels are refused before an update", async () => {
    const res = await req("PATCH", "/api/admin/poc-levels", {
      levels: [{ id: "unknown", weight: 3 }]
    }, PIN);
    assert.strictEqual(res.statusCode, 404);
  });

  await scenario("create project with the PIN works", async () => {
    const res = await req("POST", "/api/admin/projects", {
      clientId: "cl_1", key: "new-project", name: "New project",
      startDate: "2026-07-01", endDate: "2027-06-30"
    }, PIN);
    assert.strictEqual(res.statusCode, 201);
  });

  await scenario("project ID is independent of start and end dates", async () => {
    const res = await req("POST", "/api/admin/projects", {
      clientId: "cl_1", key: "website-revamp", name: "Website revamp",
      startDate: "2026-07-01", endDate: "2029-06-30"
    }, PIN);
    assert.strictEqual(res.statusCode, 201);
  });

  await scenario("editing a project ID preserves and resolves the former ID as an alias", async () => {
    const provider = Object.create(SupabaseStore.prototype);
    const requests = [];
    provider.request = async (table, options = {}) => {
      requests.push({ table, options });
      if (table === "projects" && !options.method && options.query.startsWith("id=eq.prj_alias")) {
        return [{ id: "prj_alias", project_key: "OLD-ID" }];
      }
      if (table === "project_key_aliases" && options.method === "POST") return options.body;
      if (table === "projects" && options.method === "PATCH") {
        return [{ id: "prj_alias", client_id: "cl_1", project_key: "NEW-ID", name: "Alias project", active_status: "active" }];
      }
      throw new Error(`Unexpected ${options.method || "GET"} ${table}: ${options.query || ""}`);
    };
    const updated = await provider.updateProject("prj_alias", { key: "NEW-ID" });
    assert.strictEqual(updated.key, "NEW-ID");
    const aliasWrite = requests.find((request) => request.table === "project_key_aliases");
    assert.deepStrictEqual(aliasWrite.options.body, [{ alias: "OLD-ID", project_id: "prj_alias" }]);

    const resolver = Object.create(SupabaseStore.prototype);
    const lookupRequests = [];
    resolver.request = async (table, options = {}) => {
      lookupRequests.push({ table, options });
      if (table === "projects" && options.query.startsWith("project_key=eq.OLD-ID")) return [];
      if (table === "project_key_aliases") return [{ project_id: "prj_alias" }];
      if (table === "projects" && options.query.startsWith("id=eq.prj_alias")) {
        return [{ id: "prj_alias", project_key: "NEW-ID", name: "Alias project" }];
      }
      throw new Error(`Unexpected lookup ${table}: ${options.query || ""}`);
    };
    const resolved = await resolver.getProjectRow("OLD-ID");
    assert.strictEqual(resolved.project_key, "NEW-ID");
    assert.strictEqual(lookupRequests[1].table, "project_key_aliases");
  });

  await scenario("complete project setup saves project POCs and services in one request", async () => {
    const res = await req("POST", "/api/admin/project-setups", {
      project: {
        clientId: "cl_1", key: "complete-setup", name: "Complete setup",
        activeStatus: "active", startDate: "2026-09-01", endDate: "2027-08-31",
        feedbackIntervalDays: 30
      },
      pocs: [{ name: "Aashish", contactWhatsapp: "919111111111", levelId: "important", weightPercentage: 100, active: true }],
      services: [
        { name: "PPC / Media", internalPocId: "ip_1", kpis: "Leads" },
        { name: "Website", internalPocId: "ip_1", kpis: "Speed" }
      ]
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(payload.pocs.length, 1);
    assert.deepStrictEqual(payload.services.map((service) => service.serviceKey), ["ppc", "website"]);
  });

  await scenario("complete project setup can be saved with no active POC", async () => {
    const res = await req("POST", "/api/admin/project-setups", {
      project: {
        clientId: "cl_1", key: "inactive-poc-setup", name: "Inactive POC setup",
        activeStatus: "active", startDate: "2026-09-01", endDate: "2027-08-31",
        feedbackIntervalDays: 30
      },
      pocs: [{ name: "Historical contact", contactWhatsapp: "", levelId: "", weightPercentage: 0, active: false }],
      services: [{ name: "SEO", internalPocId: "ip_1", kpis: "Rankings" }]
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(payload.pocs.length, 1);
    assert.strictEqual(payload.pocs[0].active, false);
    assert.strictEqual(payload.pocs[0].weightPercentage, 0);
  });

  await scenario("complete project setup accepts an active POC without a WhatsApp number", async () => {
    const res = await req("POST", "/api/admin/project-setups", {
      project: {
        clientId: "cl_1", key: "number-pending-setup", name: "Number pending setup",
        activeStatus: "active", startDate: "2026-09-01", endDate: "2027-08-31",
        feedbackIntervalDays: 30
      },
      pocs: [{ name: "Contact pending", contactWhatsapp: "", levelId: "normal", weightPercentage: 100, active: true }],
      services: [{ name: "SEO", internalPocId: "ip_1", kpis: "Rankings" }]
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(payload.pocs.length, 1);
    assert.strictEqual(payload.pocs[0].active, true);
    assert.strictEqual(payload.pocs[0].contactWhatsapp, "");
  });

  await scenario("multiple standard services are validated then added together", async () => {
    const before = calls.createdCatalogServices.length;
    const res = await req("POST", "/api/admin/service-catalog/bulk", {
      services: [{ name: "Influencer Marketing" }, { name: "Video Production" }]
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(payload.services.length, 2);
    assert.strictEqual(calls.createdCatalogServices.length, before + 2);
    assert.deepStrictEqual(payload.services.map((item) => item.serviceKey), ["influencer_marketing", "video_production"]);
  });

  await scenario("project ID and dates are required", async () => {
    const res = await req("POST", "/api/admin/projects", { clientId: "cl_1", name: "Future Ready Website" }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("bulk project import validates then creates every row", async () => {
    const before = calls.createdProjects.length;
    const res = await req("POST", "/api/admin/projects/bulk", {
      clientId: "cl_1",
      projects: [
        { name: "Organic Growth", goal: "Improve rankings", feedbackIntervalDays: 30 },
        { name: "Paid Growth", key: "paid-growth-import", activeStatus: "paused", feedbackIntervalDays: 14 }
      ]
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(payload.imported, 2);
    assert.strictEqual(calls.createdProjects.length, before + 2);
    assert.strictEqual(payload.projects[0].key, "organic-growth");
    assert.strictEqual(payload.projects[1].key, "paid-growth-import");
  });

  await scenario("invalid bulk project rows create nothing", async () => {
    const before = calls.createdProjects.length;
    const res = await req("POST", "/api/admin/projects/bulk", {
      clientId: "cl_1",
      projects: [
        { name: "Valid row" },
        { name: "Bad interval", feedbackIntervalDays: 0 }
      ]
    }, PIN);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.createdProjects.length, before);
  });

  await scenario("duplicate project key is refused", async () => {
    const res = await req("POST", "/api/admin/projects", {
      clientId: "cl_1", key: "TAKEN2627", name: "Dup",
      startDate: "2026-07-01", endDate: "2027-06-30"
    }, PIN);
    assert.strictEqual(res.statusCode, 409);
  });

  await scenario("bad project key format is refused", async () => {
    const res = await req("POST", "/api/admin/projects", {
      clientId: "cl_1", key: "Not Valid Key", name: "X",
      startDate: "2026-07-01", endDate: "2027-06-30"
    }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("end date before start date is refused", async () => {
    const res = await req("POST", "/api/admin/projects", { clientId: "cl_1", key: "X2626", name: "X", startDate: "2026-08-01", endDate: "2026-07-01" }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("short WhatsApp number is refused", async () => {
    const res = await req("POST", "/api/admin/pocs", { projectId: "prj_1", name: "Someone", contactWhatsapp: "12345" }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("WhatsApp number already used on the same project is refused", async () => {
    const res = await req("POST", "/api/admin/pocs", { projectId: "prj_1", name: "Someone", contactWhatsapp: "+91 99999 99999" }, PIN);
    assert.strictEqual(res.statusCode, 409);
  });

  await scenario("the same client POC number can be used on another project", async () => {
    const res = await req("POST", "/api/admin/pocs", { projectId: "prj_same_client", name: "Haranath", contactWhatsapp: "+91 99999 99999" }, PIN);
    assert.strictEqual(res.statusCode, 201);
  });

  await scenario("the same POC WhatsApp number can be used under another client", async () => {
    const res = await req("POST", "/api/admin/pocs", { projectId: "prj_other_client", name: "Someone", contactWhatsapp: "+91 99999 99999" }, PIN);
    assert.strictEqual(res.statusCode, 201);
  });

  await scenario("editing a POC may keep its own number", async () => {
    const res = await req("PATCH", "/api/admin/pocs/poc_1", { contactWhatsapp: "919999999999", designation: "Head" }, PIN);
    assert.strictEqual(res.statusCode, 200);
  });

  await scenario("editing an unknown POC returns 404", async () => {
    const res = await req("PATCH", "/api/admin/pocs/nope", { designation: "X" }, PIN);
    assert.strictEqual(res.statusCode, 404);
  });

  await scenario("create cluster works with the PIN", async () => {
    const res = await req("POST", "/api/admin/clusters", { name: "Education north" }, PIN);
    assert.strictEqual(res.statusCode, 201);
  });

  await scenario("duplicate cluster name is refused", async () => {
    const res = await req("POST", "/api/admin/clusters", { name: "Existing" }, PIN);
    assert.strictEqual(res.statusCode, 409);
  });

  await scenario("cluster rename keeps its own name", async () => {
    const res = await req("PATCH", "/api/admin/clusters/clu_1", { name: "Existing" }, PIN);
    assert.strictEqual(res.statusCode, 200);
  });

  await scenario("admin can delete a cluster while retaining assigned records", async () => {
    const res = await req("DELETE", "/api/admin/clusters/clu_1", {}, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(payload.clustersDeleted, 1);
    assert.strictEqual(payload.clientsUnassigned, 1);
    assert.strictEqual(payload.internalPocsUnassigned, 2);
    assert.strictEqual(calls.deletedClusters.at(-1), "clu_1");
  });

  await scenario("deleting an unknown cluster returns 404", async () => {
    const res = await req("DELETE", "/api/admin/clusters/nope", {}, PIN);
    assert.strictEqual(res.statusCode, 404);
  });

  await scenario("cluster deletion requires the admin PIN", async () => {
    const res = await req("DELETE", "/api/admin/clusters/clu_1", {});
    assert.strictEqual(res.statusCode, 403);
  });

  await scenario("create client works with the PIN", async () => {
    const res = await req("POST", "/api/admin/clients", { key: "new-client", name: "New Client" }, PIN);
    assert.strictEqual(res.statusCode, 201);
  });

  await scenario("client ID is generated from the client name", async () => {
    const res = await req("POST", "/api/admin/clients", { name: "North Star Education" }, PIN);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(JSON.parse(res.body).client.key, "north-star-education");
  });

  await scenario("duplicate client key is refused", async () => {
    const res = await req("POST", "/api/admin/clients", { key: "taken-client", name: "Dup" }, PIN);
    assert.strictEqual(res.statusCode, 409);
  });

  await scenario("bad client key format is refused", async () => {
    const res = await req("POST", "/api/admin/clients", { key: "Bad Key", name: "X" }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("client write without the PIN is rejected", async () => {
    const res = await req("POST", "/api/admin/clients", { key: "x-client", name: "X" });
    assert.strictEqual(res.statusCode, 403);
  });

  await scenario("editing an unknown client returns 404", async () => {
    const res = await req("PATCH", "/api/admin/clients/nope", { name: "X" }, PIN);
    assert.strictEqual(res.statusCode, 404);
  });

  await scenario("create internal POC works", async () => {
    const res = await req("POST", "/api/admin/internal-pocs", { name: "Riya Sharma", email: "riya@srvmedia.com" }, PIN);
    assert.strictEqual(res.statusCode, 201);
  });

  await scenario("invalid owner email is refused", async () => {
    const res = await req("POST", "/api/admin/internal-pocs", { name: "X", email: "not-an-email" }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("an internal POC may be their own reporting manager", async () => {
    const res = await req("PATCH", "/api/admin/internal-pocs/ip_1", { reportingManagerId: "ip_1" }, PIN);
    assert.strictEqual(res.statusCode, 200);
  });

  await scenario("a looping reporting line is refused", async () => {
    const res = await req("PATCH", "/api/admin/internal-pocs/ip_1", { reportingManagerId: "ip_loop" }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("sub-department from another department is refused", async () => {
    const res = await req("POST", "/api/admin/internal-pocs", { name: "X", departmentId: "dep_1", subDepartmentId: "sub_other" }, PIN);
    assert.strictEqual(res.statusCode, 400);
  });

  await scenario("organization standards can be added in one save", async () => {
    const res = await req("POST", "/api/admin/organization-standards/bulk", {
      clusters: ["West"], departments: ["Strategy"], subDepartments: []
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(payload.created.clusters.length, 1);
    assert.strictEqual(payload.created.departments.length, 1);
  });

  await scenario("admin can permanently delete an Internal POC and clear references", async () => {
    const res = await req("DELETE", "/api/admin/internal-pocs/ip_1", {}, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(payload.internalPocsDeleted, 1);
    assert.strictEqual(payload.servicesUnassigned, 2);
    assert.strictEqual(payload.appUsersUnlinked, 1);
  });

  await scenario("admin can delete Department and Sub-department standards", async () => {
    const department = await req("DELETE", "/api/admin/departments/dep_1", {}, PIN);
    const subDepartment = await req("DELETE", "/api/admin/sub-departments/sub_1", {}, PIN);
    assert.strictEqual(department.statusCode, 200);
    assert.strictEqual(JSON.parse(department.body).subDepartmentsDeleted, 2);
    assert.strictEqual(subDepartment.statusCode, 200);
    assert.strictEqual(JSON.parse(subDepartment.body).internalPocsUnassigned, 1);
  });

  await scenario("create service works", async () => {
    const res = await req("POST", "/api/admin/services", { projectId: "prj_1", name: "Design" }, PIN);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(JSON.parse(res.body).service.serviceKey, "design");
  });

  await scenario("duplicate generated service key on the same project is refused", async () => {
    const res = await req("POST", "/api/admin/services", { projectId: "prj_1", name: "PPC" }, PIN);
    assert.strictEqual(res.statusCode, 409);
  });

  await scenario("service key is generated and ignores user-supplied key text", async () => {
    const res = await req("POST", "/api/admin/services", { projectId: "prj_1", serviceKey: "Do Not Use", name: "Video Production" }, PIN);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(JSON.parse(res.body).service.serviceKey, "video_production");
  });

  await scenario("all project services can be added edited and removed in one save", async () => {
    const beforeDeleted = calls.deletedServices.length;
    const res = await req("PUT", "/api/admin/projects/prj_1/services", {
      services: [
        { id: "svc_ppc", name: "Paid Media", internalPocId: "ip_1", kpis: "Qualified leads" },
        { name: "Design", internalPocId: "ip_1", kpis: "Creative quality" }
      ]
    }, PIN);
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(payload.removed, ["svc_website"]);
    assert.strictEqual(calls.deletedServices.length, beforeDeleted + 1);
    assert.strictEqual(payload.services[1].serviceKey, "design");
  });

  await scenario("project service scope cannot change during an open feedback cycle", async () => {
    const beforeDeleted = calls.deletedServices.length;
    store._hasOpenFeedbackCycle = true;
    try {
      const res = await req("PUT", "/api/admin/projects/prj_1/services", {
        services: [
          { id: "svc_ppc", name: "PPC / Media", internalPocId: "ip_1", kpis: "Qualified leads" },
          { name: "Design", internalPocId: "ip_1", kpis: "Creative quality" }
        ]
      }, PIN);
      const payload = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 409);
      assert.match(payload.error, /cannot be added or removed while a feedback cycle is open/i);
      assert.strictEqual(calls.deletedServices.length, beforeDeleted);
    } finally {
      store._hasOpenFeedbackCycle = false;
    }
  });

  await scenario("service write without the PIN is rejected", async () => {
    const res = await req("POST", "/api/admin/services", { projectId: "prj_1", serviceKey: "seo", name: "SEO" });
    assert.strictEqual(res.statusCode, 403);
  });

  await scenario("editing is disabled when ADMIN_PIN is unset", async () => {
    delete process.env.ADMIN_PIN;
    const res = await req("POST", "/api/admin/projects", { clientId: "cl_1", key: "x", name: "X" }, PIN);
    assert.strictEqual(res.statusCode, 503);
    process.env.ADMIN_PIN = "1234";
  });

  await scenario("One message never advances the conversation twice", async () => {
    // The handler may run the state machine twice — once to decide whether
    // interpretation is needed, then again with it. The machine mutates
    // conversationState in place, so without a snapshot the second pass starts
    // from a state the first already moved: the client named a service and was
    // silently marked as having answered the reason question.
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "started", completionStatus: "not_started", sessionType: "pulse",
      conversationState: {}
    };
    calls.messages.length = 0;

    const res = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
      text: "PPC is not working well"
    });
    const payload = JSON.parse(res.body);
    const services = Object.keys(payload.session.conversationState.mentionedServices || {});
    assert.deepStrictEqual(services, ["ppc"], "the service should be captured once");

    const ppc = payload.session.conversationState.mentionedServices.ppc;
    assert.strictEqual(ppc.probeCount <= 1, true,
      `one message probed ${ppc.probeCount} times — the turn ran twice`);
  });

  await scenario("Scoring a session twice does not produce two numbers", async () => {
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "completed", completionStatus: "completed", sessionType: "pulse",
      conversationState: {
        state: "completed",
        mentionedServices: {
          ppc: { serviceKey: "ppc", status: "captured", sentiment: "positive", reasonText: "PPC has been good" }
        }
      },
      csatScore: null, predictedCsat: 7.5
    };
    calls.messages.length = 0;
    calls.messages.push({ id: "msg_scored", sessionId: "sess_1", side: "client", body: "PPC has been good" });
    const res = await req("POST", "/api/sessions/sess_1/score", {});
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.alreadyScored, true,
      "a scored conversation must be left alone, or the same chat yields two scores");
  });

  await scenario("Scoring refuses a session the client never replied to", async () => {
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "started", completionStatus: "not_started", sessionType: "pulse",
      conversationState: {}, csatScore: null, predictedCsat: null
    };
    calls.messages.length = 0;
    const res = await req("POST", "/api/sessions/sess_1/score", {});
    assert.strictEqual(res.statusCode, 409, "there is nothing to read");
  });

  await scenario("A greeting or postponement is never assigned a predicted midpoint", async () => {
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_feedback",
        deferredAt: new Date().toISOString(),
        mentionedServices: {}
      },
      csatScore: 5,
      predictedCsat: 5,
      predictedConfidence: 30,
      csatSource: "predicted",
      riskLevel: "Watch"
    };
    calls.messages.length = 0;
    calls.messages.push(
      { id: "msg_greeting", sessionId: "sess_1", side: "client", body: "Hi" },
      { id: "msg_defer", sessionId: "sess_1", side: "client", body: "Will send tomorrow morning" },
      { id: "msg_correction", sessionId: "sess_1", side: "client", body: "Send*" }
    );
    const res = await req("POST", "/api/sessions/sess_1/score", { force: true });
    const payload = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(payload.unscored, true);
    assert.strictEqual(payload.clearedUnsubstantiatedScore, true);
    assert.strictEqual(payload.session.predictedCsat, null);
    assert.strictEqual(payload.session.csatScore, null);
    assert.strictEqual(payload.session.status, "partial", "manual scoring must not close the session");
    assert.strictEqual(payload.session.conversationState.state, "waiting_for_service_feedback");
  });

  await scenario("Manual scoring enriches partial feedback without ending its session", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    process.env.GEMINI_API_KEY = "test-key";
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "pulse",
      conversationState: {
        state: "waiting_for_service_followup",
        pendingQuestionType: "service_followup",
        pendingServiceKey: "ppc",
        mentionedServices: {
          ppc: {
            serviceKey: "ppc", serviceName: "PPC / Media", status: "needs_service_followup",
            sentiment: "negative", reasonText: "Lead quality is poor"
          }
        }
      },
      csatScore: null,
      predictedCsat: null
    };
    calls.messages.length = 0;
    calls.messages.push({ id: "msg_partial_score", sessionId: "sess_1", side: "client", body: "PPC lead quality is poor" });
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        output_text: JSON.stringify({
          overall: { score: 4.5, confidence: 88, reasoning: "Lead quality is poor.", signals: ["poor lead quality"] },
          services: [{ serviceKey: "ppc", score: 4, confidence: 90, reasoning: "Poor leads.", sentiment: "negative" }],
          observations: []
        })
      })
    });

    try {
      const res = await req("POST", "/api/sessions/sess_1/score", {});
      const payload = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(payload.session.predictedCsat, 4.5);
      assert.strictEqual(payload.session.status, "partial");
      assert.strictEqual(payload.session.completionStatus, "partial");
      assert.strictEqual(payload.session.conversationState.state, "waiting_for_service_followup");
      assert.strictEqual(payload.sessionRemainsOpen, true);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
    }
  });

  await scenario("closed conversation scoring retries one Gemini timeout without reopening the cycle", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    let attempts = 0;
    process.env.GEMINI_API_KEY = "test-key";
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "completed", completionStatus: "completed", sessionType: "pulse",
      conversationState: {
        state: "completed",
        mentionedServices: {
          ppc: { serviceKey: "ppc", status: "captured", sentiment: "negative", reasonText: "Lead quality is poor" }
        }
      },
      csatScore: null, predictedCsat: null
    };
    calls.messages.length = 0;
    calls.messages.push({ id: "msg_closed_retry", sessionId: "sess_1", side: "client", body: "PPC lead quality is poor" });
    global.fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        const timeout = new Error("request timed out");
        timeout.name = "AbortError";
        throw timeout;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({
            overall: { score: 4.5, confidence: 88, reasoning: "Lead quality is poor.", signals: ["poor lead quality"] },
            services: [{ serviceKey: "ppc", score: 4, confidence: 90, reasoning: "Poor leads.", sentiment: "negative" }],
            observations: []
          })
        })
      };
    };

    try {
      const res = await req("POST", "/api/sessions/sess_1/score", {});
      const payload = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(attempts, 2);
      assert.strictEqual(payload.session.predictedCsat, 4.5);
      assert.strictEqual(payload.session.status, "completed");
      assert.strictEqual(payload.session.completionStatus, "completed");
      assert.strictEqual(payload.session.conversationState.state, "completed");
      assert.strictEqual(payload.sessionRemainsOpen, false);
      assert.strictEqual(payload.sessionStatusUnchanged, true);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
    }
  });

  await scenario("A conversation cannot close before everything is covered", async () => {
    const { isEverythingCovered, soundsLikeFarewell, buildChecklist } =
      require("../src/lib/whatsapp-state-machine");

    // Declining a service IS an answer — it must count as covered so we stop
    // asking, but the cycle still needs an overall rating before it can end.
    const state = {
      sessionType: "pulse",
      turnCount: 6,
      overallRating: null,
      npsScore: null,
      mentionedServices: {
        ppc: { serviceKey: "ppc", serviceName: "PPC / Media", status: "declined", sentiment: "neutral" },
        website: { serviceKey: "website", serviceName: "Website / SEO", status: "captured", sentiment: "positive" }
      }
    };
    const withAllServices = {
      ...project,
      services: [project.services[0], project.services[1]]
    };

    const checklist = buildChecklist(state, withAllServices);
    assert.deepStrictEqual(checklist.servicesNotYetDiscussed, [],
      "a declined service must not be asked about again");
    assert.strictEqual(checklist.overallRatingStillNeeded, true,
      "the overall rating follows service coverage without a separate department interview");
    assert.deepStrictEqual(checklist.stillToAsk, []);
    assert.strictEqual(isEverythingCovered(state, withAllServices), false,
      "no overall rating means the cycle is not finished");

    assert.ok(soundsLikeFarewell("Have a great day ahead!"),
      "a goodbye written mid-cycle must be recognised and replaced");
    assert.ok(!soundsLikeFarewell("How has PPC been for you?"));

    state.overallRating = 7;
    state.overallRatingAsked = true;
    state.askedForAppreciation = true;
    state.appreciationAnswered = true;
    state.askedForAnythingElse = true;
    state.anythingElseAnswered = true;
    assert.strictEqual(isEverythingCovered(state, withAllServices), true,
      "with every service covered and a rating given, the cycle may close");
  });

  await scenario("A correction replaces the earlier answer, not adds to it", async () => {
    const { applyCaptured } = require("../src/lib/whatsapp-state-machine");
    const state = {
      sessionType: "pulse",
      overallRating: 6,
      mentionedServices: {
        ppc: {
          serviceKey: "ppc", serviceName: "PPC / Media", sentiment: "negative",
          reasonText: "reports are late", reasonTags: ["speed"], status: "captured"
        }
      }
    };

    applyCaptured(
      state, project,
      [{ serviceKey: "ppc", sentiment: "positive", summary: "actually PPC has been fine", declined: false }],
      4, true
    );

    const ppc = state.mentionedServices.ppc;
    assert.ok(!/reports are late/i.test(ppc.reasonText || ""),
      "the withdrawn complaint must not survive the correction");
    assert.strictEqual(ppc.sentiment, "positive");
    assert.strictEqual(state.overallRating, 4, "the latest rating is the valid one");
    assert.ok(ppc.supersededAt, "the replacement should be recorded");
  });

  await scenario("Adding to an answer does NOT wipe what came before", async () => {
    const { applyCaptured } = require("../src/lib/whatsapp-state-machine");
    const state = {
      sessionType: "pulse",
      mentionedServices: {
        ppc: {
          serviceKey: "ppc", serviceName: "PPC / Media", sentiment: "negative",
          reasonText: "reports are late", reasonTags: [], status: "captured"
        }
      }
    };

    applyCaptured(
      state, project,
      [{ serviceKey: "ppc", sentiment: "negative", summary: "budget is also off", declined: false }],
      null, false
    );

    const ppc = state.mentionedServices.ppc;
    assert.ok(/reports are late/i.test(ppc.reasonText), "the earlier point must be kept");
    assert.ok(/budget is also off/i.test(ppc.reasonText), "the new point must be added");
  });

  await scenario("Near-identical service summaries are stored once", async () => {
    const { applyCaptured } = require("../src/lib/whatsapp-state-machine");
    const state = { sessionType: "pulse", mentionedServices: {} };
    applyCaptured(state, project, [{
      serviceKey: "ppc", sentiment: "negative",
      summary: "Campaign managemenet is good but leads are poor though", needsFollowUp: false
    }]);
    applyCaptured(state, project, [{
      serviceKey: "ppc", sentiment: "negative",
      summary: "Campaign management is good but leads are poor", needsFollowUp: false
    }]);
    assert.strictEqual(state.mentionedServices.ppc.points.length, 1);
    assert.strictEqual(
      (state.mentionedServices.ppc.reasonText.match(/leads are poor/gi) || []).length,
      1
    );
  });

  await scenario("Volunteered praise satisfies appreciation coverage without re-asking", async () => {
    const { applyTurnProgress, isEverythingCovered } = require("../src/lib/whatsapp-state-machine");
    const oneService = { ...project, services: [project.services[0]] };
    const state = {
      sessionType: "pulse", overallRating: 7, overallRatingAsked: true,
      askedForAppreciation: false, appreciationAnswered: false,
      askedForAnythingElse: true, anythingElseAnswered: true,
      mentionedServices: {
        ppc: { serviceKey: "ppc", serviceName: "PPC / Media", status: "captured" }
      }
    };
    applyTurnProgress(state, oneService, {
      answeredAppreciation: true,
      appreciationVolunteered: true
    }, { recordAsked: false });
    assert.strictEqual(state.appreciationVolunteered, true);
    assert.strictEqual(isEverythingCovered(state, oneService), true);
  });

  await scenario("A cycle cannot close on an inferred rating", async () => {
    const { isEverythingCovered } = require("../src/lib/whatsapp-state-machine");
    const oneService = { ...project, services: [project.services[0]] };
    const state = {
      sessionType: "pulse",
      overallRating: 7,
      mentionedServices: { ppc: { serviceKey: "ppc", serviceName: "PPC / Media", status: "captured" } }
    };
    assert.strictEqual(isEverythingCovered(state, oneService), false,
      "the rating must have been asked for, not assumed from a passing mention");
    state.overallRatingAsked = true;
    state.askedForAppreciation = true;
    state.appreciationAnswered = true;
    state.askedForAnythingElse = true;
    state.anythingElseAnswered = true;
    assert.strictEqual(isEverythingCovered(state, oneService), true);
  });

  await scenario("Zero is a real rating, not a missing one", async () => {
    const { isEverythingCovered } = require("../src/lib/whatsapp-state-machine");
    const oneService = { ...project, services: [project.services[0]] };
    const state = {
      sessionType: "pulse",
      overallRating: 0,
      overallRatingAsked: true,
      askedForAppreciation: true,
      appreciationAnswered: true,
      askedForAnythingElse: true,
      anythingElseAnswered: true,
      mentionedServices: { ppc: { serviceKey: "ppc", serviceName: "PPC / Media", status: "captured" } }
    };
    assert.strictEqual(isEverythingCovered(state, oneService), true,
      "a client who rates us 0 has answered — treating it as missing loses their worst score");
  });

  await scenario("A number is accepted overall only after the overall question", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    assert.strictEqual(
      conversationFlow.acceptedOverallRating({ overallRatingAsked: false }, { overallRating: 5 }, "5"),
      null,
      "a bare number during service follow-up must not become the overall score"
    );
    assert.strictEqual(
      conversationFlow.acceptedOverallRating(
        { overallRatingAsked: true, state: "waiting_for_overall_rating" },
        { overallRating: 0 },
        "0"
      ),
      0,
      "a real zero must still be preserved after the question"
    );
    assert.strictEqual(
      conversationFlow.acceptedOverallRating(
        { overallRatingAsked: true, state: "waiting_for_nps", pendingQuestionType: "nps" },
        { overallRating: 5 },
        "5"
      ),
      null,
      "a number answering NPS must never overwrite the earlier overall score"
    );
  });

  await scenario("historical Arun feedback progresses through the API even when response wording tries to reopen a service", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorSession = store._session;
    const priorMessages = [...calls.messages];
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    const opening = "The campaign was never optimized and acquisition cost reached 1.9 lacs for only 32 admissions. The account managers did not understand our requirements.";
    const busy = "Some account managers were busy with their work. They were never available for the review.";
    const done = "Hope this feedback is sufficient";
    const extract = (text) => ({
      intent: "feedback", deferRequested: false, sentiment: "negative", rating: null,
      serviceScope: "overall_feedback", explainsProblem: true,
      serviceFeedback: [{ serviceHint: "PPC / Media", sentiment: "negative", summary: text, needsFollowUp: false }],
      observations: [], concerns: [], appreciations: []
    });
    const answer = { message: "Thank you. Is there anything else about PPC / Media?", captured: [], observations: [], appreciations: [], askedServiceFollowUpKey: "ppc" };
    const replies = [extract(opening), answer, extract(busy), answer, {
      intent: "negative", deferRequested: false, completionScope: "feedback", completionEvidence: done,
      sentiment: "neutral", serviceFeedback: [], observations: [], concerns: [], appreciations: []
    }, answer];
    let modelCalls = 0;
    global.fetch = async (_url, options) => {
      const input = JSON.parse(options?.body || "{}").input || "";
      const result = input.includes("Task: verify ONLY the client's survey-control instruction")
        ? { decision: "feedback", evidence: done }
        : replies[modelCalls++] || answer;
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(result) }) };
    };
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
      status: "started", completionStatus: "no_response", sessionType: "project_end",
      conversationState: { state: "waiting_for_open_feedback", sessionType: "project_end", pendingQuestionType: "project_end_review", projectEndReviewAsked: true }
    };
    try {
      for (const [index, text] of [opening, busy, done].entries()) {
        const response = await rawReq("POST", "/api/whatsapp/inbound", {
          from: "919999999999", text, providerMessageId: `wamid.history-arun-${index}`
        });
        const result = JSON.parse(response.body);
        assert.strictEqual(response.statusCode, 201);
        assert.strictEqual(result.state, "waiting_for_overall_rating", text);
        if (index === 0) {
          assert.match(result.whatsappReplyText, /Would you like to add anything else, or shall we move to the overall rating\?$/);
          assert.doesNotMatch(result.whatsappReplyText, /out of 10|on a scale/i);
        } else if (index === 1) {
          assert.doesNotMatch(result.whatsappReplyText, /anything else.*overall rating\?$/i);
          assert.doesNotMatch(result.whatsappReplyText, /out of 10|on a scale/i);
          assert.doesNotMatch(result.whatsappReplyText, /appreciat|kind words/i, "never available is a complaint, not praise");
        } else assert.match(result.whatsappReplyText, /overall.*out of 10/i);
        assert.doesNotMatch(result.whatsappReplyText, /the client|I have recorded:/i);
        assert.doesNotMatch(result.whatsappReplyText, /take your time|anything else about PPC|Senior Involvement/i);
        assert.strictEqual(result.session.conversationState.overallRating, null);
      }
      assert.match(store._session.conversationState.mentionedServices.ppc.reasonText, /32 admissions/);
      assert.match(store._session.conversationState.mentionedServices.ppc.reasonText, /never available for the review/);
      assert.strictEqual(store._session.conversationState.feedbackQuestionsComplete, true);
      for (const [index, [text, csat, nps]] of [["5", 5, null], ["0", 5, 0], ["change rating to 3", 3, 0], ["and nps rating to 4", 3, 4]].entries()) {
        const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text, providerMessageId: `wamid.history-arun-score-${index}` });
        const result = JSON.parse(response.body);
        assert.equal(response.statusCode, 201);
        assert.equal(result.session.conversationState.overallRating, csat, text);
        assert.equal(result.session.conversationState.npsScore, nps, text);
        assert.doesNotMatch(result.whatsappReplyText, /anything else about PPC|Senior Involvement|the client|I have recorded:/i);
      }
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  for (const sessionType of ["pulse", "project_end"]) for (const variant of ["incorrect skip", "courtesy completion", "incorrect service consent", "no scope", "incorrect completion intent", "verification timeout"]) {
    await scenario(`${sessionType} first broad review cannot bypass the invitation with ${variant}`, async () => {
      const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
      const priorSession = store._session, priorMessages = [...calls.messages];
      process.env.GEMINI_API_KEY = "test-key";
      calls.messages.length = 0;
      const text = "Hi thanks a lot for your message. I believe we were all working in the direction to make things better for all so we could achieve what we had envisaged for this year likewise as done in the past. I appreciate your taking the feedback in a positive manner as I stepped in for the first time though I have been in the system for more than 8 years. I hope we keep up the good work giving our best and carry on with a mutually beneficial relationship in the times to come as well. Once again thanks for all the support you and your team has extended and for taking things in a positive stride I guess that is how we all learn and improvise, applies to us also and would like to learn and benefit from your expertise in the field.";
      const acknowledgement = "Thank you for your kind words and trust. We value the partnership and the support you have recognised.";
      let controlCalls = 0;
      global.fetch = async (_url, options) => {
        const input = JSON.parse(options?.body || "{}").input || "";
        if (input.includes("Task: verify ONLY the client's survey-control instruction")) {
          controlCalls += 1;
          if (variant === "verification timeout") throw new Error("simulated survey-control verification timeout");
          return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ decision: "none", evidence: null }) }) };
        }
        const result = input.includes("Task: interpret ONE client reply") ? {
          intent: variant === "incorrect completion intent" ? "negative" : "feedback", sentiment: "positive", acknowledgement,
          serviceScope: variant === "incorrect skip" ? "skip_remaining_services" : variant === "incorrect service consent" ? "continue_service_by_service" : variant === "no scope" ? "none" : "overall_feedback",
          completionScope: ["courtesy completion", "verification timeout"].includes(variant) ? "feedback" : "none",
          completionEvidence: "Once again thanks for all the support you and your team has extended",
          appreciations: [{ subject: "SRV Team", detail: "I appreciate your taking the feedback in a positive manner" }]
        } : { message: `${acknowledgement} On a scale of 0 to 10, how would you rate your overall experience?`,
          acknowledgement, askedForOverallRating: true, readyToClose: false };
        return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(result) }) };
      };
      store._session = { id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
        status: "partial", completionStatus: "partial", sessionType, conversationState: {
          state: sessionType === "project_end" ? "waiting_for_open_feedback" : "waiting_for_service_feedback", sessionType,
          pendingQuestionType: sessionType === "project_end" ? "project_end_review" : "service",
          pendingServiceKey: sessionType === "project_end" ? null : "ppc",
          projectEndReviewAsked: sessionType === "project_end", overallRatingAsked: false, mentionedServices: {}
        } };
      try {
        const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text,
          providerMessageId: `wamid.first-review-${sessionType}-${variant}` });
        const result = JSON.parse(response.body);
        assert.equal(response.statusCode, 201);
        assert.equal(result.session.conversationState.pendingQuestionType, "rating_feedback", result.whatsappReplyText);
        assert.match(result.whatsappReplyText, /add anything else.*overall rating/i);
        assert.doesNotMatch(result.whatsappReplyText, /on a scale|out of 10|missed.*department|one by one/i);
        assert.equal(result.session.conversationState.overallRating, null);
        assert.equal(result.session.conversationState.npsScore, null);
        assert.notEqual(result.session.conversationState.overallRatingAsked, true, "an internal draft must not count as an asked rating");
        assert.notEqual(result.session.conversationState.serviceScopeStatus, "skipped");
        if (variant !== "no scope") assert.equal(controlCalls, 1);
        assert.equal(result.nextMessage.metadata.pendingQuestionType, "rating_feedback");
        if (variant !== "no scope") assert.equal(result.nextMessage.metadata.interpretation.controlVerification, "unverified");
      } finally {
        global.fetch = priorFetch;
        if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
        calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
      }
    });
  }

  for (const [text, decision, evidence] of [
    ["The reports arrived late. That covers everything I wanted to share", "feedback", "That covers everything I wanted to share"],
    ["The reports arrived late. Hope this feedback is sufficient", "feedback", "Hope this feedback is sufficient"],
    ["The reports arrived late. Ab rating poochiye", "proceed_to_rating", "Ab rating poochiye"],
    ["The reports arrived late. Please leave the rest of the service questions", "skip_remaining_services", "Please leave the rest of the service questions"],
    ["The reports arrived late. I prefer not to answer any further questions", "conversation", "I prefer not to answer any further questions"]
  ]) await scenario(`A verified '${decision}' instruction in a first review is honoured without losing its concern`, async () => {
    const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
    const priorSession = store._session, priorMessages = [...calls.messages];
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    global.fetch = async (_url, options) => {
      const input = JSON.parse(options?.body || "{}").input || "";
      const result = input.includes("Task: verify ONLY the client's survey-control instruction") ? { decision, evidence }
        : input.includes("Task: interpret ONE client reply") ? {
          intent: "feedback", sentiment: "negative", serviceScope: "overall_feedback", completionScope: "feedback", completionEvidence: evidence,
          acknowledgement: "I am sorry the reports arrived late.",
          serviceFeedback: [{ serviceHint: "PPC / Media", summary: "The reports arrived late", sentiment: "negative", needsFollowUp: false }]
        } : { message: "Thank you. Anything else about PPC / Media?", askedServiceFollowUpKey: "ppc" };
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(result) }) };
    };
    store._session = { id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
      status: "partial", completionStatus: "partial", sessionType: "pulse", conversationState: {
        state: "waiting_for_service_feedback", sessionType: "pulse", pendingQuestionType: "service", pendingServiceKey: "ppc",
        overallRatingAsked: false, mentionedServices: {}
      } };
    try {
      const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text,
        providerMessageId: `wamid.first-review-explicit-${evidence}` });
      const result = JSON.parse(response.body);
      assert.equal(response.statusCode, 201);
      assert.match(result.session.conversationState.mentionedServices.ppc.reasonText, /reports arrived late/i);
      assert.equal(result.session.conversationState.overallRating, null);
      if (decision === "conversation") {
        assert.equal(result.state, "closing_grace");
        assert.doesNotMatch(result.whatsappReplyText, /\?/);
      } else {
        assert.equal(result.session.conversationState.pendingQuestionType, "overall_rating", result.whatsappReplyText);
        assert.match(result.whatsappReplyText, /overall.*out of 10/i);
        assert.doesNotMatch(result.whatsappReplyText, /Would you like to add anything else/);
      }
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
    }
  });

  await scenario("An uncertain rating-choice verification reoffers the choice instead of an acknowledgement-only dead end", async () => {
    const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
    const priorSession = store._session, priorMessages = [...calls.messages];
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    let text = "We can proceed to the score now";
    global.fetch = async (_url, options) => {
      const input = JSON.parse(options?.body || "{}").input || "";
      if (input.includes("Task: verify ONLY the client's survey-control instruction")) throw new Error("simulated control timeout");
      const result = input.includes("Task: interpret ONE client reply")
        ? { intent: "feedback", sentiment: "neutral", ratingChoice: "proceed", ratingChoiceEvidence: text }
        : { message: "Thank you for confirming.", acknowledgement: "Thank you for confirming." };
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(result) }) };
    };
    store._session = { id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
      status: "partial", completionStatus: "partial", sessionType: "pulse", conversationState: {
        state: "waiting_for_overall_rating", sessionType: "pulse", pendingQuestionType: "rating_feedback",
        ratingFeedbackPause: { ratingType: "overall_rating", choiceAsked: true, overallReview: true },
        generalFeedbackText: "The partnership has been good", serviceScopeStatus: "awaiting_choice", mentionedServices: {},
        overallRatingAsked: false, overallRating: null, lastQuestionAsked: "Thank you for confirming."
      } };
    try {
      const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text, providerMessageId: "wamid.uncertain-control-choice" });
      const result = JSON.parse(response.body);
      assert.equal(response.statusCode, 201);
      assert.match(result.whatsappReplyText, /add anything else.*overall rating/i);
      assert.equal(result.session.conversationState.pendingQuestionType, "rating_feedback");
      assert.equal(result.session.conversationState.overallRating, null);
      assert.equal(result.nextMessage.metadata.interpretation.controlVerification, "unverified");
      assert.ok(result.nextMessage.metadata.interpretation.controlVerificationError);
      text = "rating";
      const retry = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text, providerMessageId: "wamid.uncertain-control-resolved" });
      const retried = JSON.parse(retry.body);
      assert.equal(retry.statusCode, 201);
      assert.match(retried.whatsappReplyText, /overall.*out of 10/i);
      assert.equal(retried.session.conversationState.pendingQuestionType, "overall_rating");
      assert.equal(retried.session.conversationState.overallRating, null);
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
    }
  });

  for (const [sessionType, ratingType] of [["pulse", "overall_rating"], ["project_end", "overall_rating"], ["project_end", "nps"]]) {
    for (const [text, semanticChoice, evidence, timeout] of [
      ["rating", "none", null, false],
      [ratingType === "nps" ? "recommendation rating" : "overall rating", "none", null, true],
      ["The second option please", "proceed", "The second option please", false],
      ["Let us get to the number now", "proceed", "Let us get to the number now", true]
    ]) await scenario(`${sessionType} ${ratingType} choice '${text}' escapes an acknowledgement-only stall`, async () => {
      const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
      const priorSession = store._session, priorMessages = [...calls.messages];
      process.env.GEMINI_API_KEY = "test-key";
      calls.messages.length = 0;
      let extractionPrompt = "";
      global.fetch = async (_url, options) => {
        const input = JSON.parse(options?.body || "{}").input || "";
        if (input.includes("Task: verify ONLY the client's survey-control instruction")) return {
          ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ decision: "proceed_to_rating", evidence }) })
        };
        if (input.includes("Task: interpret ONE client reply")) {
          extractionPrompt = input;
          return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({
            intent: "feedback", sentiment: "neutral", rating: null,
            ratingChoice: semanticChoice, ratingChoiceEvidence: evidence,
            acknowledgement: "Thank you for confirming.", serviceFeedback: [], observations: [], appreciations: []
          }) }) };
        }
        if (timeout) throw new Error("simulated rating-choice response-writer timeout");
        return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({
          message: "Thank you for confirming.", acknowledgement: "Thank you for confirming.",
          // Markers must never substitute for the actual numeric question.
          askedForOverallRating: ratingType === "overall_rating", overallRating: 10,
          ratingChoice: "continue_feedback", captured: [{ serviceKey: "ppc", summary: "Invented campaign concern", sentiment: "negative" }]
        }) }) };
      };
      store._session = { id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
        status: "partial", completionStatus: "partial", sessionType,
        conversationState: { state: ratingType === "nps" ? "waiting_for_nps" : "waiting_for_overall_rating",
          sessionType, pendingQuestionType: "rating_feedback",
          ratingFeedbackPause: { ratingType, choiceAsked: true, overallReview: true },
          lastQuestionAsked: "Thank you for letting us know.",
          generalFeedbackText: "The partnership and support have been helpful", serviceScopeStatus: "skipped",
          projectEndReviewCaptured: sessionType === "project_end", overallRatingAsked: ratingType === "nps",
          overallRating: ratingType === "nps" ? 6 : null, npsScore: null,
          mentionedServices: Object.fromEntries(project.services.map((service) => [service.serviceKey, { ...service,
            status: "captured", sentiment: "neutral", serviceFollowUpAnswered: true }]))
        } };
      try {
        const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text,
          providerMessageId: `wamid.rating-choice-${sessionType}-${ratingType}-${text}` });
        const result = JSON.parse(response.body);
        assert.equal(response.statusCode, 201);
        assert.equal(result.session.conversationState.pendingQuestionType, ratingType, result.whatsappReplyText);
        assert.match(result.whatsappReplyText, ratingType === "nps" ? /recommend.*out of 10/i : /overall.*out of 10/i);
        assert.equal(result.session.conversationState.overallRating, ratingType === "nps" ? 6 : null);
        assert.equal(result.session.conversationState.npsScore, null);
        assert.equal(result.session.conversationState.ratingFeedbackPause, null);
        assert.ok(extractionPrompt.includes(`<pending_rating_choice>\n${ratingType}\n</pending_rating_choice>`));
        assert.doesNotMatch(JSON.stringify(result.session.conversationState), /Invented campaign concern/);
      } finally {
        global.fetch = priorFetch;
        if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
        calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
      }
    });
  }

  await scenario("Rating option labels work with Gemini unavailable only while the choice is pending", async () => {
    const priorKey = process.env.GEMINI_API_KEY, priorSession = store._session, priorMessages = [...calls.messages];
    delete process.env.GEMINI_API_KEY;
    calls.messages.length = 0;
    try {
      for (const text of ["rating", "overall rating", "score"]) {
        store._session = { id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
          status: "partial", completionStatus: "partial", sessionType: "pulse", conversationState: {
            state: "waiting_for_overall_rating", sessionType: "pulse", pendingQuestionType: "rating_feedback",
            ratingFeedbackPause: { ratingType: "overall_rating", choiceAsked: true, overallReview: true },
            generalFeedbackText: "The partnership is good", serviceScopeStatus: "awaiting_choice", mentionedServices: {},
            lastQuestionAsked: "Thank you for confirming."
          } };
        const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text,
          providerMessageId: `wamid.choice-outage-${text}` });
        const result = JSON.parse(response.body);
        assert.equal(response.statusCode, 201);
        assert.equal(result.session.conversationState.pendingQuestionType, "overall_rating", result.whatsappReplyText);
        assert.match(result.whatsappReplyText, /overall.*out of 10/i);
        assert.equal(result.session.conversationState.overallRating, null);
      }
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
    }
  });

  for (const sessionType of ["pulse", "project_end"]) await scenario(`${sessionType} closing acknowledgements distinguish scores and completion from new facts`, async () => {
    const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
    const priorSession = store._session, priorMessages = [...calls.messages];
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    let read = {};
    global.fetch = async (_url, options) => {
      const input = JSON.parse(options?.body || "{}").input || "";
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(
        input.includes("Task: interpret ONE client reply") ? read : {
          message: "Thank you for providing your overall rating. Thank you for confirming.",
          acknowledgement: "Thank you for providing your overall rating.", readyToClose: true
        }
      ) }) };
    };
    store._session = { id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
      status: "partial", completionStatus: "partial", sessionType, conversationState: {
        state: sessionType === "project_end" ? "waiting_for_nps" : "waiting_for_overall_rating", sessionType,
        pendingQuestionType: sessionType === "project_end" ? "nps" : "overall_rating", overallRatingAsked: true,
        overallRating: sessionType === "project_end" ? 6 : null, npsScore: null,
        projectEndReviewCaptured: sessionType === "project_end", serviceScopeStatus: "skipped",
        askedForAnythingElse: true, anythingElseAnswered: true,
        mentionedServices: Object.fromEntries(project.services.map((service) => [service.serviceKey, { ...service,
          status: "captured", sentiment: "neutral", serviceFollowUpAnswered: true }]))
      } };
    try {
      const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp,
        text: sessionType === "project_end" ? "9" : "6", providerMessageId: `wamid.closing-no-duplicate-${sessionType}` });
      const closed = JSON.parse(response.body);
      assert.equal(response.statusCode, 201);
      assert.equal(closed.state, "closing_grace");
      assert.doesNotMatch(closed.whatsappReplyText, /Thank you for providing/);
      const deadline = closed.session.conversationState.closingGraceExpiresAt;
      const before = JSON.stringify(closed.session.conversationState.mentionedServices);
      for (const [index, text] of ["thats it", "Nothing further from my side", "Everything I wanted to share is covered"].entries()) {
        read = { intent: "negative", sentiment: "neutral", completionScope: "feedback", completionEvidence: text,
          acknowledgement: "Thank you for confirming that you have shared all your feedback." };
        const reply = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text,
          providerMessageId: `wamid.window-finish-${sessionType}-${index}` });
        const result = JSON.parse(reply.body);
        assert.equal(reply.statusCode, 201);
        assert.equal(result.state, "closing_grace");
        assert.doesNotMatch(result.whatsappReplyText, /added|additional|out of 10|next 10 minutes/i);
        assert.match(result.whatsappReplyText, /original 10-minute window|close automatically/i);
        assert.equal(result.session.conversationState.closingGraceExpiresAt, deadline);
        assert.equal(result.session.conversationState.overallRating, 6);
        assert.equal(result.session.conversationState.npsScore, sessionType === "project_end" ? 9 : null);
        assert.equal(JSON.stringify(result.session.conversationState.mentionedServices), before);
      }
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
    }
  });

  await scenario("A monthly client can volunteer the invited rating without losing the management invitation", async () => {
    const priorKey = process.env.GEMINI_API_KEY, priorSession = store._session, priorMessages = [...calls.messages];
    delete process.env.GEMINI_API_KEY;
    calls.messages.length = 0;
    store._session = { id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
      status: "partial", completionStatus: "partial", sessionType: "pulse", conversationState: {
        state: "waiting_for_overall_rating", sessionType: "pulse", pendingQuestionType: "rating_feedback",
        ratingFeedbackPause: { ratingType: "overall_rating", choiceAsked: true, overallReview: true },
        generalFeedbackText: "The partnership and team support have been helpful", serviceScopeStatus: "awaiting_choice",
        mentionedServices: {}, overallRatingAsked: false,
        lastQuestionAsked: "Would you like to add anything else, or shall we move to the overall rating?"
      } };
    try {
      const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text: "8", providerMessageId: "wamid.monthly-volunteered-score" });
      const result = JSON.parse(response.body);
      assert.equal(response.statusCode, 201);
      assert.equal(result.session.conversationState.overallRating, 8);
      assert.equal(result.session.conversationState.npsScore, null);
      assert.equal(result.session.conversationState.pendingQuestionType, "final_sweep");
      assert.match(result.whatsappReplyText, /Directors/i);
      assert.doesNotMatch(result.whatsappReplyText, /recommend|out of 10/i);
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
    }
  });

  await scenario("Pooja project-end review progresses without manual intervention and keeps a visit request neutral", async () => {
    const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
    const priorSession = store._session, priorMessages = [...calls.messages];
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    let read = {}, writer = {};
    global.fetch = async (_url, options) => {
      const input = JSON.parse(options?.body || "{}").input || "";
      const payload = input.includes("Task: interpret ONE client reply") ? read
        : input.includes("Task: verify ONLY the client's survey-control instruction") ? { decision: read.completionScope || "none", evidence: read.completionEvidence || null }
        : /predict how satisfied/i.test(input) ? { overall: { score: 8, confidence: 0.9, reasoning: "Fixture", signals: [] }, services: [], observations: [] }
        : writer;
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(payload) }) };
    };
    store._session = { id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
      status: "started", completionStatus: "no_response", sessionType: "project_end", conversationState: {
        state: "waiting_for_open_feedback", sessionType: "project_end", pendingQuestionType: "project_end_review", projectEndReviewAsked: true
      } };
    let index = 0;
    const send = async (text, extraction, responseWriter = { message: "Thank you for sharing that." }) => {
      read = { intent: "feedback", sentiment: "neutral", rating: null, observations: [], appreciations: [], serviceFeedback: [], concerns: [], ...extraction };
      writer = responseWriter;
      const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text, providerMessageId: `wamid.pooja-replay-${index++}` });
      assert.equal(response.statusCode, 201, response.body);
      return JSON.parse(response.body);
    };
    try {
      const praise = "Overall engagement was good…we could meet our registration nos….";
      const acknowledgement = "Thank you for sharing your experience. We are glad to hear that the overall engagement went well and that the registration numbers were met.";
      let result = await send(praise, { sentiment: "positive", serviceScope: "overall_feedback", acknowledgement,
        appreciations: [{ subject: "Overall Engagement", detail: praise }] });
      assert.ok(result.whatsappReplyText.startsWith(acknowledgement), result.whatsappReplyText);
      assert.doesNotMatch(result.whatsappReplyText, /appreciating Overall Engagement|kind words with them/i);
      assert.match(result.whatsappReplyText, /anything else.*overall rating\?/i);

      const repeatedPraiseAck = "Thank you for confirming that the overall engagement went well and that your registration targets were successfully met.";
      result = await send(praise, { sentiment: "positive", serviceScope: "overall_feedback", acknowledgement: repeatedPraiseAck,
        appreciations: [{ subject: "Overall Engagement", detail: praise }] });
      assert.equal(result.whatsappReplyText, repeatedPraiseAck, "already acknowledged positive outcomes must not receive a second abstract-topic thank-you");
      assert.equal(result.session.conversationState.overallRating, null);

      const concern = "Yes would request the deliverables to be provided in shorter time. Currently it seems the SRV Spoc assigned handles other campaigns and this slows down overall response time or leads to minor mistakes";
      const specificConcernAck = "We hear your feedback regarding the turnaround times and the response delays from your assigned point of contact. We also understand your concern that handling multiple campaigns may be affecting response speed and attention to detail, including minor mistakes.";
      result = await send(concern, { sentiment: "negative", isObservation: true, explainsProblem: true,
        acknowledgement: "I have noted your concern about delivery turnaround, slow responses and minor mistakes, and your impression that the SPOC may be handling other campaigns.",
        observations: [{ topic: "Delivery Turnaround", detail: concern, sentiment: "negative", needsFollowUp: false }] }, { message: specificConcernAck });
      assert.equal(result.whatsappReplyText, specificConcernAck, "a specific natural acknowledgement must not be rejected for lacking a canned Thank you/recorded prefix");
      assert.doesNotMatch(result.whatsappReplyText, /anything else.*overall rating\?/i);
      assert.equal(result.session.conversationState.idleRatingPromptEligible, true);
      assert.doesNotMatch(result.whatsappReplyText, /what specifically happened|Senior Involvement/i);
      result = await send("rating", { intent: "affirmative" });
      assert.match(result.whatsappReplyText, /overall.*out of 10/i);
      result = await send("8", { intent: "rating", rating: 8 });
      assert.equal(result.session.conversationState.overallRating, 8);
      assert.match(result.whatsappReplyText, /recommend/i);
      result = await send("9", { intent: "rating", rating: 9 });
      assert.equal(result.session.conversationState.overallRating, 8);
      assert.equal(result.session.conversationState.npsScore, 9);
      assert.match(result.whatsappReplyText, /Directors/i);
      result = await send("No nothing thank u", { intent: "negative", completionScope: "feedback", completionEvidence: "No nothing" });
      assert.equal(result.state, "closing_grace", result.whatsappReplyText);
      const deadline = result.session.conversationState.closingGraceExpiresAt;

      const visit = "I wish to conduct a small visit with my students to your office and if ull can guide them on AI for branding";
      const beforeRecords = calls.observations.length;
      result = await send(visit, { isObservation: true, explainsProblem: false,
        acknowledgement: "I have noted your request for a student office visit and guidance on AI for branding for review by the relevant team.",
        observations: [{ topic: "Office Visit & AI Guidance Request", detail: visit, sentiment: "neutral", kind: "request", needsFollowUp: false }] },
      { message: "I am sorry to hear that. What specifically happened with Management Feedback?", askedObservationReasonTopic: "Management Feedback" });
      assert.equal(result.state, "closing_grace", result.whatsappReplyText);
      assert.equal(result.session.conversationState.pendingObservation, null);
      assert.doesNotMatch(result.whatsappReplyText, /sorry|what specifically|Management Feedback|anything else about|confirmed|notified/i);
      assert.match(result.whatsappReplyText, /student office visit.*AI for branding/i);
      const entries = calls.observations.slice(beforeRecords).flatMap((record) => record.observations || []);
      assert.equal(entries.filter((item) => item.kind !== "appreciation").length, 1, JSON.stringify(entries));
      assert.equal(entries[0].sentiment, "neutral");
      assert.equal(entries[0].kind, "request");

      const clarification = "No just a field visit like an industry visit early next year";
      result = await send(clarification, { isObservation: true, explainsProblem: false,
        acknowledgement: "Thank you for clarifying that you are looking for an industry visit early next year. I have noted this with your request.",
        observations: [{ topic: "Industry Visit Timing", detail: clarification, sentiment: "neutral", kind: "request", needsFollowUp: false }] });
      assert.equal(result.state, "closing_grace", result.whatsappReplyText);
      assert.equal(result.session.conversationState.closingGraceExpiresAt, deadline);
      assert.equal(result.session.conversationState.overallRating, 8);
      assert.equal(result.session.conversationState.npsScore, 9);
      assert.doesNotMatch(result.whatsappReplyText, /sorry|what specifically|Management Feedback|anything else about/i);
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
    }
  });

  for (const sessionType of ["project_end", "pulse", "quick_checkin"]) {
    await scenario(`${sessionType}: detailed campaign feedback survives wrong questions and service-specific scope without losing its meaning`, async () => {
      const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
      const priorSession = store._session, priorMessages = [...calls.messages];
      process.env.GEMINI_API_KEY = "test-key";
      calls.messages.length = 0;
      let read = {}, writer = {}, writerTimeout = false;
      const prompts = [];
      global.fetch = async (_url, options) => {
        const input = JSON.parse(options?.body || "{}").input || "";
        prompts.push(input);
        const payload = input.includes("Task: interpret ONE client reply") ? read
          : input.includes("Task: verify ONLY the client's survey-control instruction") ? { decision: read.completionScope || "none", evidence: read.completionEvidence || null }
          : /predict how satisfied/i.test(input) ? { overall: { score: 5, confidence: 0.9, reasoning: "Fixture", signals: [] }, services: [], observations: [] }
          : writerTimeout ? null : writer;
        if (payload === null) throw new Error("simulated writer timeout");
        return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(payload) }) };
      };
      store._session = { id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
        status: "started", completionStatus: "no_response", sessionType, conversationState: {
          state: sessionType === "quick_checkin" ? "quick_checkin_detail" : "waiting_for_open_feedback", sessionType,
          pendingQuestionType: sessionType === "project_end" ? "project_end_review" : "service",
          projectEndReviewAsked: sessionType === "project_end", quickCheckinOutcome: "needs_improvement"
        } };
      const samples = [
        ["There is very less reach for the campaigns for admission process", "Admission Campaign Reach",
          "We hear your concern regarding the low reach on campaigns for the admission process.",
          "Your concern about low campaign reach for admissions is noted."],
        ["I was reviewing the posts on Instagram since July even before we engaged with SRV and many posts have same reach as was in the month of July", "Instagram Reach",
          "We hear your concern regarding Instagram post reach remaining at July levels.",
          "The comparison with July helps explain your concern that Instagram post reach has not improved."],
        ["SRV’s digital marketing performance for admissions has been below expectations. - The current strategy has not delivered the desired results in terms of enquiries and conversions. - We need complete transparency and detailed reporting of all campaigns, including amount spent, reach, impressions, clicks, and conversions. - Screenshots and supporting data for every campaign and activity must be shared to verify the work being executed. - We also require detailed reports of all SMS and WhatsApp campaigns, including the number of messages sent and delivered. - Overall, we are dissatisfied with SRV’s performance this year and expect greater accountability, transparency, and a clear action plan to improve admission results.", "Admissions Performance and Reporting",
          "We hear your concern about admissions results, enquiries and conversions, and your request for campaign metrics, spend, screenshots and SMS/WhatsApp delivery reports.",
          "Your dissatisfaction with admissions results and enquiries is noted, along with the request for transparent campaign metrics, spend, screenshots, and SMS and WhatsApp delivery reports."],
        ["1. SRVs strategy is clearly not working. 2. ⁠The narrative that MBA education is down is wrong. 3. ⁠AICTE’s CMAT itself got over 50,000 forms..so why is SNAP going down. 4. ⁠NCR has several MBA programs where there is hardly any decline. 5. ⁠Clearly, the SRV team assigned to SIBM, Noida is not able to deliver. 6. ⁠We were told that a significant number of SMS and WhatsApp messages will be sent..it appears that the same has not been done.. 7. ⁠I am not happy with SRVs performance this year.", "Strategy and Messaging Delivery",
          "We hear your concern about the admissions strategy and whether the promised SMS and WhatsApp messages were sent.",
          "You also question the explanation about MBA demand, citing CMAT and NCR programs, and raise concerns about SIBM Noida delivery and whether the expected SMS and WhatsApp messages were sent."]
      ];
      let index = 0, deadline;
      const send = async (text, extraction, responseWriter, timeout = false) => {
        read = { intent: "feedback", sentiment: "negative", rating: null, observations: [], appreciations: [], serviceFeedback: [], concerns: [], ...extraction };
        writer = responseWriter || { message: "Thank you for sharing that." };
        writerTimeout = timeout;
        const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text, providerMessageId: `wamid.continuity-${sessionType}-${index++}` });
        assert.equal(response.statusCode, 201, response.body);
        return JSON.parse(response.body);
      };
      try {
        for (const [sampleIndex, [text, topic, acknowledgement, alternativeAcknowledgement]] of samples.entries()) {
          const expectedAck = sampleIndex ? alternativeAcknowledgement : acknowledgement;
          const result = await send(text, {
            isObservation: true, explainsProblem: true, serviceScope: sampleIndex < 2 ? "none" : "overall_feedback",
            acknowledgement: sessionType === "quick_checkin" || sampleIndex === 2 ? expectedAck : "Thank you for providing this context.",
            alternativeAcknowledgement: "Thank you for the context.",
            observations: [{ topic, detail: text, sentiment: "negative", needsFollowUp: false }]
          }, { message: `${expectedAck} How has Account Management been for you?`, acknowledgement: expectedAck }, sampleIndex === 2);
          assert.ok(result.whatsappReplyText.startsWith(expectedAck), result.whatsappReplyText);
          assert.doesNotMatch(result.whatsappReplyText, /How has Account Management/);
          assert.doesNotMatch(result.whatsappReplyText, /Senior Involvement|anything else about Account Management|have notified|has been verified/i);
          if (sessionType === "quick_checkin") {
            assert.equal(result.state, "quick_checkin_window");
            assert.doesNotMatch(result.whatsappReplyText, /out of 10|recommend|overall rating/i);
            deadline ||= result.session.conversationState.quickCheckinWindowExpiresAt;
            assert.equal(result.session.conversationState.quickCheckinWindowExpiresAt, deadline);
          } else {
            assert.equal(result.session.conversationState.overallRating, null);
            assert.equal(Boolean(result.session.conversationState.idleRatingPromptEligible), sessionType === "project_end" || sampleIndex >= 2);
            assert.equal((result.whatsappReplyText.match(/\?/g) || []).length, sampleIndex === (sessionType === "pulse" ? 2 : 0) ? 1 : 0);
          }
        }
        assert.ok(prompts.some((prompt) => /<recent_assistant_openings>\n\["we hear your concern"/.test(prompt)));
        if (sessionType !== "quick_checkin") {
          let result = await send("thats it", { intent: "negative", completionScope: "feedback", completionEvidence: "thats it" });
          assert.match(result.whatsappReplyText, /overall.*out of 10/i);
          result = await send("5", { intent: "rating", rating: 5 });
          assert.equal(result.session.conversationState.overallRating, 5);
          if (sessionType === "project_end") {
            assert.match(result.whatsappReplyText, /recommend/i);
            result = await send("9", { intent: "rating", rating: 9 });
            assert.equal(result.session.conversationState.overallRating, 5);
            assert.equal(result.session.conversationState.npsScore, 9);
          }
          if (result.state !== "closing_grace") result = await send("Nothing more", { intent: "negative", completionScope: "feedback", completionEvidence: "Nothing more" });
          assert.equal(result.state, "closing_grace");
        }
      } finally {
        global.fetch = priorFetch;
        if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
        calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
      }
    });
  }

  await scenario("Structured requests and mixed concerns retain their own meaning without generic fallback duplicates", async () => {
    const { conversationFlow: flow } = require("../src/server/api-handler");
    const requests = [
      "Our students would love to see how your agency operates.",
      "An introduction to AI-assisted branding for our faculty would be welcome.",
      "May we have access to the source artwork?",
      "I wish to explore an internship collaboration next summer.",
      "No, just an industry visit early next year."
    ];
    for (const text of requests) {
      const read = { intent: "feedback", sentiment: "neutral", isObservation: true, explainsProblem: false,
        observations: [{ topic: "Client Request", detail: text, sentiment: "neutral", kind: "request", needsFollowUp: false }] };
      const facts = flow.enrichConductedWithDeterministicFacts({}, text, project, read, { protectSubstantiveConcern: true });
      assert.equal(facts.observations.length, 1, JSON.stringify(facts));
      assert.equal(facts.observations[0].kind, "request");
      assert.equal(facts.observations[0].sentiment, "neutral", JSON.stringify(facts));
      assert.equal(flow.observationFromInterpretation(read, text), null);
    }
    const text = "I wish to arrange a student visit. The invoice is incorrect.";
    const read = { intent: "feedback", sentiment: "negative", isObservation: true, explainsProblem: false,
      observations: [
        { topic: "Student Visit", detail: "I wish to arrange a student visit", sentiment: "neutral", kind: "request", needsFollowUp: true },
        { topic: "Billing", detail: "The invoice is incorrect", sentiment: "negative", kind: "feedback", needsFollowUp: true }
      ] };
    const facts = flow.enrichConductedWithDeterministicFacts({}, text, project, read, { protectSubstantiveConcern: true });
    assert.equal(facts.observations.length, 2, JSON.stringify(facts));
    assert.equal(facts.observations[0].sentiment, "neutral");
    const before = { closingGraceExpiresAt: new Date(Date.now() + 600000).toISOString(), overallRating: 8, npsScore: 9 };
    const state = { ...before, mentionedServices: {} };
    flow.settleActionableFinalSweepFacts(state, before, facts, text, read, project);
    assert.equal(state.pendingObservation.topic, "Billing");
    assert.equal(state.closingGraceExpiresAt, before.closingGraceExpiresAt);
  });

  for (const type of ["pulse", "project_end"]) for (const timeout of [false, true]) {
    await scenario(`${type} closing additions use current semantic points with ${timeout ? "a writer timeout" : "conflicting writer facts"}`, async () => {
      const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
      const priorSession = store._session, priorMessages = [...calls.messages];
      process.env.GEMINI_API_KEY = "test-key";
      calls.messages.length = 0;
      const deadline = new Date(Date.now() + 8 * 60 * 1000).toISOString();
      store._session = {
        id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
        status: "completed", completionStatus: "completed", sessionType: type,
        conversationState: { state: "closing_grace", sessionType: type,
          closingGraceExpiresAt: deadline, overallRatingAsked: true, overallRating: 7,
          npsScore: type === "project_end" ? 9 : null,
          askedForAnythingElse: true, anythingElseAnswered: true, mentionedServices: {
            website: { serviceKey: "website", serviceName: "Website / SEO", status: "needs_service_followup", sentiment: "negative", serviceFollowUpAnswered: false, reasonText: "Earlier unrelated concern" }
          } }
      };
      const variants = [
        ["there should be weekly meeting with team", "Weekly Team Meetings", "I have noted your request for weekly meetings with the team.", "request"],
        ["Could you enable access to our shared dashboard?", "Dashboard Access", "I have noted your request for access to the shared dashboard.", "request"],
        ["Our students would love to see how your agency operates", "Student Agency Visit", "I have noted your interest in a student visit to our agency.", "request"],
        ["An introduction to AI-assisted branding for our faculty would be welcome", "Faculty AI Introduction", "I have noted your request for an introduction to AI-assisted branding for your faculty.", "request"],
        ["The form freezes when we submit it", "Form Submission Freezes", "I am sorry the form freezes when you submit it. I have noted this concern for review.", "feedback"],
        ["The team explains the reports very clearly", "Reporting Team", "Thank you for appreciating how clearly the team explains your reports.", "appreciation"]
      ];
      let extraction;
      global.fetch = async (_url, options) => {
        const input = JSON.parse(options?.body || "{}").input || "";
        if (input.includes("Task: interpret ONE client reply")) return {
          ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(extraction) })
        };
        if (/predict how satisfied/i.test(input)) return {
          ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({
            overall: { score: 7, confidence: 0.9, reasoning: "Fixture", signals: [] }, services: [],
            observations: [{ topic: "Reporting Frequency", detail: "Old report request paraphrased by scoring", sentiment: "neutral" }]
          }) })
        };
        if (timeout) throw new Error("simulated response-writer timeout");
        return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({
          message: "I am sorry your whole experience has been disappointing. Anything else about Website / SEO?",
          acknowledgement: "I am sorry your whole experience has been disappointing.",
          askedServiceFollowUpKey: "website", overallRating: 1,
          captured: [{ serviceKey: "ppc", sentiment: "negative", summary: "Invented PPC failure" }],
          observations: [{ topic: "Senior Involvement", detail: "Invented leadership absence", sentiment: "negative" }]
        }) }) };
      };
      try {
        for (const [index, [text, topic, acknowledgement, kind]] of variants.entries()) {
          extraction = { intent: "feedback", sentiment: kind === "feedback" ? "negative" : kind === "appreciation" ? "positive" : "neutral",
            acknowledgement, isObservation: kind === "request", explainsProblem: kind !== "request", serviceFeedback: [],
            observations: kind === "appreciation" ? [] : [{ topic, detail: text, kind, sentiment: kind === "feedback" ? "negative" : "neutral", needsFollowUp: false }],
            appreciations: kind === "appreciation" ? [{ subject: topic, detail: text }] : [] };
          const beforeRecords = calls.observations.length;
          const response = await rawReq("POST", "/api/whatsapp/inbound", {
            from: poc.contactWhatsapp, text, providerMessageId: `wamid.closing-semantic-${type}-${timeout}-${index}`
          });
          const result = JSON.parse(response.body);
          assert.equal(response.statusCode, 201);
          assert.equal(result.state, "closing_grace", result.whatsappReplyText);
          assert.ok(result.whatsappReplyText.includes(acknowledgement), result.whatsappReplyText);
          assert.doesNotMatch(result.whatsappReplyText, /anything else about|whole experience|Senior Involvement|meeting request|correct number|Directors have been notified/i);
          assert.equal(result.session.conversationState.closingGraceExpiresAt, deadline);
          assert.equal(result.session.conversationState.overallRating, 7);
          assert.equal(result.session.conversationState.npsScore, type === "project_end" ? 9 : null);
          assert.doesNotMatch(JSON.stringify(result.session.conversationState), /Invented PPC|Invented leadership/);
          const records = calls.observations.slice(beforeRecords);
          assert.doesNotMatch(JSON.stringify(records), /Old report request paraphrased by scoring/);
          for (const record of records) {
            assert.equal(record.options.sourceMessage.body, text);
            assert.ok(record.options.sourceMessage.id);
          }
        }
      } finally {
        global.fetch = priorFetch;
        if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
        calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
      }
    });
  }

  await scenario("Quick-check-in visit and collaboration requests stay neutral before and during the window", async () => {
    const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
    const priorSession = store._session, priorMessages = [...calls.messages];
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    let extraction;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(extraction) }) });
    const variants = [
      ["I wish to conduct a visit with my students to your office for AI branding guidance", "Student Office Visit", "I have noted your request for a student office visit and AI branding guidance."],
      ["An introduction to your production process for our faculty would be welcome", "Faculty Production Introduction", "I have noted your interest in a faculty introduction to our production process."],
      ["No just an industry visit early next year", "Industry Visit Timing", "Thank you for clarifying that you would like an industry visit early next year."]
    ];
    try {
      for (const state of ["quick_checkin_detail", "quick_checkin_window"]) {
        for (const [index, [text, topic, acknowledgement]] of variants.entries()) {
          store._session = { id: "sess_1", cycleId: "cyc_quick", projectId: project.id, clientPocId: poc.id,
            status: "partial", completionStatus: "partial", sessionType: "quick_checkin", conversationState: {
              state, quickCheckinOutcome: state === "quick_checkin_window" ? "feedback_shared" : "needs_improvement",
              quickCheckinWindowExpiresAt: state === "quick_checkin_window" ? "2099-01-01T00:10:00.000Z" : null
            } };
          extraction = { intent: "feedback", sentiment: "neutral", isObservation: true, explainsProblem: false, acknowledgement,
            observations: [{ topic, detail: text, sentiment: "neutral", kind: "request", needsFollowUp: false }] };
          const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
            text, providerMessageId: "wamid.quick-visit-" + state + "-" + index
          });
          const result = JSON.parse(response.body);
          assert.equal(response.statusCode, 201);
          assert.equal(result.state, "quick_checkin_window", result.whatsappReplyText);
          assert.ok(result.whatsappReplyText.startsWith(acknowledgement), result.whatsappReplyText);
          assert.doesNotMatch(result.whatsappReplyText, /sorry|what specifically|Management Feedback|anything else about|out of 10|rate|recommend/i);
          const stored = calls.quickCheckinResponses.at(-1).input.interpretation;
          assert.equal(stored.observations.length, 1);
          assert.equal(stored.observations[0].kind, "request");
          assert.equal(stored.observations[0].sentiment, "neutral");
          assert.equal((stored.concerns || []).length, 0);
        }
      }
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
    }
  });

  await scenario("Quick check-in recognises positive outcomes once without changing its response window", async () => {
    const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
    const priorSession = store._session, priorMessages = [...calls.messages];
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    const text = "Overall engagement was good; we met our registration numbers.";
    const acknowledgement = "Thank you for confirming that the overall engagement went well and that your registration targets were successfully met.";
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({
      intent: "feedback", sentiment: "positive", acknowledgement, serviceScope: "overall_feedback",
      appreciations: [{ subject: "Overall Engagement", detail: text }], observations: [], concerns: []
    }) }) });
    try {
      for (const state of ["quick_checkin_detail", "quick_checkin_window"]) {
        const deadline = "2099-01-01T00:10:00.000Z";
        store._session = { id: "sess_1", cycleId: "cyc_quick", projectId: project.id, clientPocId: poc.id,
          status: "partial", completionStatus: "partial", sessionType: "quick_checkin", conversationState: {
            state, quickCheckinOutcome: state === "quick_checkin_window" ? "feedback_shared" : "needs_improvement",
            quickCheckinWindowExpiresAt: state === "quick_checkin_window" ? deadline : null
          } };
        const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", {
          text, providerMessageId: "wamid.quick-outcome-" + state
        });
        const result = JSON.parse(response.body);
        assert.equal(response.statusCode, 201);
        assert.equal(result.state, "quick_checkin_window");
        assert.ok(result.whatsappReplyText.startsWith(acknowledgement), result.whatsappReplyText);
        assert.equal((result.whatsappReplyText.match(/Thank you/gi) || []).length, 1, result.whatsappReplyText);
        assert.doesNotMatch(result.whatsappReplyText, /kind words|appreciating Overall Engagement|out of 10|recommend|anything else about/i);
        if (state === "quick_checkin_window") assert.equal(result.session.conversationState.quickCheckinWindowExpiresAt, deadline);
      }
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
      calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
    }
  });

  await scenario("Request and complaint details sharing words are not collapsed into one negative request", async () => {
    const { conversationFlow: flow } = require("../src/server/api-handler");
    const text = "The weekly report about spend arrived late. Please send the weekly report about spend by Monday.";
    const facts = flow.enrichConductedWithDeterministicFacts({}, text, project, {
      intent: "feedback", sentiment: "negative", isObservation: true, observations: [
        { topic: "Spend Reporting", detail: "The weekly report about spend arrived late", sentiment: "negative", kind: "feedback", needsFollowUp: false },
        { topic: "Spend Reporting", detail: "Please send the weekly report about spend by Monday", sentiment: "neutral", kind: "request", needsFollowUp: false }
      ]
    });
    assert.equal(facts.observations.length, 2);
    assert.equal(facts.observations[0].sentiment, "negative");
    assert.equal(facts.observations[1].sentiment, "neutral");
    assert.equal(facts.observations[1].kind, "request");
    const reply = flow.fallbackForAction({ type: "observation_reason", topic: "Management Feedback" }, {
      pendingObservation: { topic: "Management Feedback", responseKind: "request" }
    }, project);
    assert.match(reply, /request/i);
    assert.doesNotMatch(reply, /sorry|happened|Management Feedback/i);
  });

  for (const kind of ["request", "mixed"]) {
    await scenario(`quick check-in keeps ${kind} acknowledgements specific without unwarranted apology`, async () => {
      const priorKey = process.env.GEMINI_API_KEY, priorFetch = global.fetch;
      const priorSession = store._session, priorMessages = [...calls.messages];
      process.env.GEMINI_API_KEY = "test-key";
      calls.messages.length = 0;
      const text = kind === "request" ? "Could we receive a monthly ledger please?"
        : "The form freezes after submission, but our reporting team explains the numbers clearly.";
      const acknowledgement = kind === "request" ? "I have noted your request for a monthly ledger."
        : "I am sorry the form freezes after submission. Thank you for appreciating how clearly the team explains your reports.";
      global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({
        intent: "feedback", sentiment: kind === "request" ? "neutral" : "negative", acknowledgement,
        explainsProblem: true, isObservation: true, observations: [{ topic: kind === "request" ? "Billing" : "Form Submission Freezes",
          detail: text, kind: kind === "request" ? "request" : "feedback", sentiment: kind === "request" ? "neutral" : "negative", needsFollowUp: false }],
        appreciations: kind === "mixed" ? [{ subject: "Reporting Team", detail: "Our reporting team explains the numbers clearly" }] : []
      }) }) });
      store._session = { id: "sess_1", cycleId: "cyc_quick", projectId: project.id, clientPocId: poc.id,
        status: "partial", completionStatus: "partial", sessionType: "quick_checkin",
        conversationState: { state: "quick_checkin_detail", quickCheckinOutcome: "needs_improvement" } };
      try {
        const response = await req("POST", "/api/whatsapp/sessions/sess_1/reply", { text });
        const result = JSON.parse(response.body);
        assert.equal(response.statusCode, 201);
        assert.ok(result.whatsappReplyText.startsWith(acknowledgement), result.whatsappReplyText);
        assert.doesNotMatch(result.whatsappReplyText, /experience has been disappointing|anything else about|rate|recommend/i);
        assert.equal(result.state, "quick_checkin_window");
        if (kind === "request") assert.doesNotMatch(result.whatsappReplyText, /sorry|apolog|concerns|disappoint/i);
      } finally {
        global.fetch = priorFetch;
        if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
        calls.messages.length = 0; calls.messages.push(...priorMessages); store._session = priorSession;
      }
    });
  }

  for (const variant of ["natural choice", "premature numeric question", "internal summary"]) {
    await scenario(`overall review preserves a client-facing acknowledgement with ${variant}`, async () => {
      const priorKey = process.env.GEMINI_API_KEY;
      const priorFetch = global.fetch;
      const priorSession = store._session;
      const priorMessages = [...calls.messages];
      process.env.GEMINI_API_KEY = "test-key";
      calls.messages.length = 0;
      const text = "The PPC campaign was never optimized and acquisition costs were too high. We got only 32 admissions.";
      const acknowledgement = "I am sorry the campaign results fell short, particularly the high acquisition costs and lack of optimisation.";
      const naturalMessage = `${acknowledgement} Is there anything else you would like to share before we move to an overall rating?`;
      const writer = {
        acknowledgement,
        message: variant === "natural choice" ? naturalMessage
          : variant === "internal summary" ? "The client emphasizes poor campaign results. How would you rate us out of 10?"
          : `${acknowledgement} How would you rate us out of 10?`,
        askedForRatingTransition: variant === "natural choice",
        askedForOverallRating: variant !== "natural choice",
        captured: [{ serviceKey: "website", summary: "Invented website failure", sentiment: "negative" }]
      };
      global.fetch = async (_url, options) => {
        const input = JSON.parse(options?.body || "{}").input || "";
        const result = input.includes("Task: interpret ONE client reply") ? {
          intent: "feedback", sentiment: "negative", serviceScope: "overall_feedback", explainsProblem: true,
          serviceFeedback: [{ serviceHint: "PPC / Media", summary: text, sentiment: "negative", needsFollowUp: false }]
        } : writer;
        return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(result) }) };
      };
      store._session = {
        id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
        status: "started", completionStatus: "no_response", sessionType: "project_end",
        conversationState: { state: "waiting_for_open_feedback", sessionType: "project_end", pendingQuestionType: "project_end_review", projectEndReviewAsked: true }
      };
      try {
        const response = await rawReq("POST", "/api/whatsapp/inbound", { from: poc.contactWhatsapp, text, providerMessageId: `wamid.opening-quality-${variant}` });
        const result = JSON.parse(response.body);
        assert.equal(response.statusCode, 201);
        assert.ok(result.whatsappReplyText.startsWith(acknowledgement), result.whatsappReplyText);
        assert.doesNotMatch(result.whatsappReplyText, /the client|I have recorded:|out of 10|on a scale|website/i);
        if (variant === "natural choice") assert.equal(result.whatsappReplyText, naturalMessage);
        assert.equal(result.session.conversationState.pendingQuestionType, "rating_feedback");
        assert.equal(result.session.conversationState.overallRating, null);
        assert.equal(result.session.conversationState.npsScore, null);
        assert.doesNotMatch(JSON.stringify(result.session.conversationState), /Invented website failure/);
      } finally {
        global.fetch = priorFetch;
        if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = priorKey;
        calls.messages.length = 0;
        calls.messages.push(...priorMessages);
        store._session = priorSession;
      }
    });
  }

  for (const responseTimeout of [false, true]) {
    await scenario(`feedback-to-rating choice works through the API with ${responseTimeout ? "a response-writer timeout" : "a conflicting response-writer question"}`, async () => {
      const priorKey = process.env.GEMINI_API_KEY;
      const priorFetch = global.fetch;
      const priorSession = store._session;
      const priorMessages = [...calls.messages];
      process.env.GEMINI_API_KEY = "test-key";
      calls.messages.length = 0;
      let currentRead = {};
      global.fetch = async (_url, options) => {
        const input = JSON.parse(options?.body || "{}").input || "";
        if (input.includes("Task: interpret ONE client reply")) {
          return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(currentRead) }) };
        }
        if (responseTimeout) throw new Error("simulated response-writer timeout");
        return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({
          message: "Is there anything else about Senior Involvement?", askedObservationFollowUpTopic: "Senior Involvement",
          captured: [{ serviceKey: "ppc", sentiment: "negative", summary: "Invented leadership failure" }],
          observations: [{ topic: "Senior Involvement", detail: "Invented leadership failure", sentiment: "negative" }]
        }) }) };
      };
      store._session = {
        id: "sess_1", cycleId: "cyc_1", projectId: project.id, clientPocId: poc.id,
        status: "started", completionStatus: "partial", sessionType: "project_end",
        conversationState: {
          state: "waiting_for_overall_rating", pendingQuestionType: "overall_rating", sessionType: "project_end",
          projectEndReviewCaptured: true, serviceScopeStatus: "project_end_overall", overallRatingAsked: true,
          overallRating: null, npsScore: null, mentionedServices: {}
        }
      };
      const steps = [
        ["Please send weekly spend reports", { intent: "feedback", observations: [{ topic: "Spend Reporting", detail: "Please send weekly spend reports", sentiment: "neutral", kind: "request", needsFollowUp: false }] }, "choice"],
        ["Please include the campaign allocation breakdown too", { intent: "feedback", observations: [{ topic: "Spend Reporting", detail: "Please include the campaign allocation breakdown too", sentiment: "neutral", kind: "request", needsFollowUp: false }] }, "acknowledgement"],
        ["The PPC reports are clear now", { intent: "feedback", serviceFeedback: [{ serviceHint: "PPC / Media", sentiment: "positive", summary: "The PPC reports are clear now", needsFollowUp: false }] }, "acknowledgement"],
        ["That's it", { intent: "negative", completionScope: "feedback", completionEvidence: "That's it" }, "rating"],
        ["The invoice has the wrong tax number", { intent: "feedback", observations: [{ topic: "Billing", detail: "The invoice has the wrong tax number", sentiment: "negative", needsFollowUp: false }] }, "choice"],
        ["no", { intent: "negative" }, "rating"]
      ];
      try {
        for (const [index, [text, extraction, expected]] of steps.entries()) {
          currentRead = { sentiment: "neutral", deferRequested: false, rating: null, serviceFeedback: [], observations: [], appreciations: [], concerns: [], ...extraction };
          const response = await rawReq("POST", "/api/whatsapp/inbound", {
            from: "919999999999", text, providerMessageId: `wamid.choice-${responseTimeout}-${index}`
          });
          const result = JSON.parse(response.body);
          assert.equal(response.statusCode, 201);
          assert.equal(result.state, "waiting_for_overall_rating");
          assert.equal(result.session.conversationState.overallRating, null);
          assert.notEqual(result.session.conversationState.overallRatingDeclined, true);
          assert.doesNotMatch(result.whatsappReplyText, /Senior Involvement|Invented leadership/i);
          if (expected === "choice") assert.match(result.whatsappReplyText, /Would you like to add anything else, or shall we move to the overall rating\?$/);
          if (expected === "acknowledgement") assert.doesNotMatch(result.whatsappReplyText, /\?|out of 10|anything else about/i);
          if (text === "The PPC reports are clear now") assert.match(result.session.conversationState.mentionedServices.ppc.reasonText, /reports are clear/i);
          if (expected === "rating") assert.match(result.whatsappReplyText, /overall.*out of 10/i);
        }
        assert.equal(store._session.conversationState.ratingFeedbackPause, null);
        assert.doesNotMatch(JSON.stringify(store._session.conversationState), /Invented leadership failure|Senior Involvement/i,
          "response-writing facts must not enter the state; an unmentioned service placeholder is allowed");
      } finally {
        global.fetch = priorFetch;
        if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = priorKey;
        store._session = priorSession;
        calls.messages.length = 0;
        calls.messages.push(...priorMessages);
      }
    });
  }

  await scenario("an explicit rating survives a management-feedback interruption", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const rating = conversationFlow.acceptedOverallRating({
      overallRatingAsked: true,
      pendingQuestionType: "observation_followup",
      pendingObservation: { topic: "Senior Involvement", stage: "followup" }
    }, { overallRating: 7 }, "7");
    assert.strictEqual(rating, 7,
      "the already-requested rating must not be discarded just because an observation is still being closed");
  });

  await scenario("the latest explicit rating wins across rapid concurrent messages", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const rating = conversationFlow.latestExplicitOverallRating([
      { side: "srv", body: "Overall, how would you rate the work SRV Media has done for you so far, out of 10?" },
      { side: "client", body: "0" },
      { side: "client", body: "Sorry, that was a mistake" },
      { side: "client", body: "Take 8" },
      // A stale overlapping request may repeat the question after the newer
      // client message. It must not reset the rating window.
      { side: "srv", body: "Overall, how would you rate the work SRV Media has done for you so far, out of 10?" }
    ], true);
    assert.strictEqual(rating, 8);
  });

  await scenario("rating reconciliation understands corrections rather than restoring an older score", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const rating = conversationFlow.latestExplicitOverallRating([
      { side: "srv", body: "Overall, how would you rate the work SRV Media has done for you so far, out of 10?" },
      { side: "client", body: "8" },
      { side: "client", body: "Revise the raiting to 10" },
      { side: "client", body: "I said 10" }
    ], true);
    assert.strictEqual(rating, 10);

    const twoValues = conversationFlow.latestExplicitOverallRating([
      { side: "srv", body: "Overall, how would you rate SRV Media, out of 10?" },
      { side: "client", body: "8" },
      { side: "client", body: "Please change it from 8 to 9.5" }
    ], true);
    assert.strictEqual(twoValues, 9.5,
      "the intended replacement value must win when old and new scores share a message");
  });

  await scenario("recommendation answers are excluded from overall-rating reconciliation", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const rating = conversationFlow.latestExplicitOverallRating([
      { side: "srv", body: "Overall, how would you rate the work SRV Media delivered on this project, out of 10?" },
      { side: "client", body: "4" },
      { side: "srv", body: "Lastly, how likely are you to recommend SRV Media to someone in your network, out of 10?" },
      { side: "client", body: "no take three point five" },
      { side: "client", body: "take 5 for recommending SRV" }
    ], true);
    assert.strictEqual(rating, 4,
      "the recommendation answer and its correction must not replace overall CSAT");
  });

  await scenario("Partial transcript reconciliation does not guess that an unlabelled score is CSAT", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    assert.equal(conversationFlow.latestExplicitOverallRating([
      { side: "client", body: "9" },
      { side: "srv", body: "Thank you. Your feedback and rating of 6 out of 10 are recorded." },
      { side: "client", body: "That is all" }
    ], true), null, "missing question history must not pull an NPS answer into CSAT");
    assert.equal(conversationFlow.latestExplicitOverallRating([
      { side: "client", body: "9" }, { side: "client", body: "Change my overall rating to 6" }
    ], true), 6, "an explicitly identified CSAT correction remains usable");
  });

  await scenario("closing-window CSAT and recommendation corrections remain separate during transcript reconciliation", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const transcript = [
      { side: "srv", body: "Overall, how would you rate the work SRV Media delivered on this project, out of 10?" },
      { side: "client", body: "7" },
      { side: "srv", body: "On a scale of 0 to 10, how likely are you to recommend SRV Media to a friend or colleague?" },
      { side: "client", body: "9" },
      { side: "srv", body: "Thank you. Your overall rating of 7 out of 10 has been recorded. The 10-minute correction window remains open." },
      { side: "client", body: "There should be a weekly report sent to us about spend" },
      { side: "srv", body: "Thank you for that suggestion. We have recorded the weekly spend-report request." },
      { side: "client", body: "no" },
      { side: "srv", body: "Rating of 7 out of 10 remains recorded, and the original 10-minute window is still open." },
      { side: "client", body: "change rating to 10" },
      { side: "srv", body: "No problem — I have updated your overall rating to 10 out of 10." }
    ];

    assert.strictEqual(
      conversationFlow.latestExplicitOverallRating(transcript, true),
      10,
      "an explicit CSAT correction must work even though the most recent score question was NPS"
    );

    for (const recommendationCorrection of [
      "change recommend rating to 9",
      "change recommendation rating to 9",
      "take 5 for recommending SRV",
      "set NPS to 8",
      "my likelihood rating should be 6"
    ]) {
      assert.strictEqual(
        conversationFlow.latestExplicitOverallRating([
          ...transcript,
          { side: "client", body: recommendationCorrection }
        ], true),
        10,
        `recommendation wording must not rewrite CSAT: ${recommendationCorrection}`
      );
    }
  });

  await scenario("scale-first recommendation wording cannot replace project-end CSAT", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const rating = conversationFlow.latestExplicitOverallRating([
      { side: "srv", body: "Overall, how would you rate the work SRV Media delivered on this project, out of 10?" },
      { side: "client", body: "9" },
      { side: "srv", body: "Thank you for the 9 out of 10 rating! On a scale of 0 to 10, how likely are you to recommend SRV Media to a colleague or peer?" },
      { side: "client", body: "10" },
      { side: "srv", body: "Is there anything else you would like our Directors to know?" },
      { side: "client", body: "The delivery process needs better internal alignment." },
      { side: "srv", body: "Is there anything else you would like to add?" },
      { side: "client", body: "No, that is all." }
    ], true);
    assert.strictEqual(rating, 9,
      "recommendation questions that state the scale before 'recommend' must still switch to NPS context");
    assert.strictEqual(
      conversationFlow.acceptedOverallRating({
        overallRatingAsked: true,
        pendingQuestionType: "final_sweep",
        overallRating: 9
      }, { overallRating: 10 }, "No, that is all."),
      null,
      "a stale transcript number returned by Gemini must not become the latest CSAT"
    );
  });

  await scenario("a spoken rating followed by no take 5 is corrected to 5", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const rating = conversationFlow.latestExplicitOverallRating([
      { side: "srv", body: "On a scale of 0 to 10, how would you rate your overall experience with SRV Media?" },
      { side: "client", body: "six" },
      { side: "client", body: "no take 5" }
    ], true);
    assert.strictEqual(rating, 5,
      "the client's latest explicit correction must override the first spoken score");
  });

  await scenario("meeting frequency is not mistaken for an overall score", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const rating = conversationFlow.latestExplicitOverallRating([
      { side: "srv", body: "Overall, how would you rate the work SRV Media has done for you so far, out of 10?" },
      { side: "client", body: "I need at least one meeting a month with seniors" },
      { side: "client", body: "so far I will give a seven out of 10" }
    ], true);
    assert.strictEqual(rating, 7);
  });

  await scenario("a spoken seven out of ten is deterministically a rating", async () => {
    const { detectors, processWhatsAppReply } = require("../src/lib/whatsapp-state-machine");
    const text = "so far I will give a seven out of 10";
    assert.deepStrictEqual(detectors.detectNumber(text), { value: 7, scale: 10 });
    assert.strictEqual(detectors.looksLikeRatingAnswer(text), true);
    assert.strictEqual(
      detectors.looksLikeRatingAnswer("I need at least one meeting every month with seniors"),
      false,
      "meeting frequency must not be captured as a rating"
    );

    const allCovered = Object.fromEntries(project.services.map((service) => [
      service.serviceKey,
      {
        serviceKey: service.serviceKey,
        serviceName: service.name,
        status: "captured",
        sentiment: "neutral",
        serviceFollowUpAnswered: true
      }
    ]));
    const turn = processWhatsAppReply({
      session: {
        sessionType: "pulse",
        conversationState: {
          state: "waiting_for_overall_rating",
          pendingQuestionType: "overall_rating",
          overallRatingAsked: true,
          askedForAppreciation: true,
          appreciationAnswered: true,
          askedForAnythingElse: true,
          anythingElseAnswered: true,
          mentionedServices: allCovered
        }
      },
      project,
      poc,
      text
    });
    assert.strictEqual(turn.conversationState.overallRating, 7);
    assert.strictEqual(turn.conversationState.state, "closing_grace");
    assert.match(turn.nextMessage.body, /rating of 7 out of 10/i);
    assert.match(turn.nextMessage.body, /next 10 minutes/i);
    assert.match(turn.nextMessage.body, /confidential review by the Directors/i);
    assert.match(turn.nextMessage.body, /recorded for constructive and discreet review/i);
    assert.doesNotMatch(turn.nextMessage.body, /notified the Directors/i);
    assert.match(turn.nextMessage.body, /request a callback/i);
    assert.match(turn.nextMessage.body, /honesty, time and trust/i);
    assert.match(turn.nextMessage.body, /please take care/i);
    assert.match(turn.nextMessage.body, /connecting with you again next month/i);
  });

  await scenario("Changing services naturally finishes the previous anything-else prompt", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const before = {
      state: "waiting_for_service_followup",
      pendingQuestionType: "service_followup",
      pendingServiceKey: "design"
    };
    const markers = conversationFlow.validatedAnswerMarkers(before, {
      completedServiceFollowUpKeys: ["design"],
      answeredAppreciation: true,
      captured: [{ serviceKey: "ppc", sentiment: "negative" }]
    }, "PPC leads are down");
    assert.deepStrictEqual(markers.completedServiceFollowUpKeys, ["design"],
      "moving to a different service should not force the client back to say no");
    assert.strictEqual(markers.answeredAppreciation, false,
      "a bare model marker cannot invent appreciation when none was extracted");
  });

  await scenario("Volunteered appreciation is covered and is not asked for again", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const conducted = {
      captured: [{
        serviceKey: "design", sentiment: "negative",
        summary: "Ad creatives use too many stock images"
      }],
      observations: [],
      appreciations: [{ subject: "Creative Team", detail: "The videos are fantastic", serviceKey: "design" }]
    };
    conversationFlow.separateAppreciations(conducted);
    assert.deepStrictEqual(conducted.captured.map((item) => item.serviceKey), ["design"],
      "mapped praise should also cover that service without making the client repeat it");
    assert.strictEqual(conducted.captured[0].fromAppreciation, true,
      "mixed praise and criticism must retain an explicit appreciation marker");
    const before = {
      pendingQuestionType: "service_followup",
      pendingServiceKey: "website"
    };
    const markers = conversationFlow.validatedAnswerMarkers(before, conducted,
      "I appreciate the creative team; the videos are fantastic");
    assert.strictEqual(markers.answeredAppreciation, true);
    assert.strictEqual(markers.appreciationVolunteered, true);

    const praiseOnly = {
      captured: [{
        serviceKey: "account", sentiment: "positive",
        summary: "I want to appreciate the Account Management team",
        needsFollowUp: true
      }],
      observations: [],
      appreciations: [{
        subject: "Account Management Team",
        detail: "I want to appreciate the Account Management team",
        serviceKey: "account"
      }]
    };
    conversationFlow.separateAppreciations(praiseOnly);
    assert.strictEqual(praiseOnly.captured[0].needsFollowUp, false,
      "explicit praise must not reopen a completed service for another question");
  });

  await scenario("Overall feedback asks for scope before selecting another service", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const state = {
      sessionType: "pulse",
      mentionedServices: {},
      serviceScopeStatus: "awaiting_choice"
    };
    const checklist = {
      serviceScopeChoiceStillNeeded: true,
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [],
      servicesWaitingForAnythingElseAnswer: [],
      servicesNotYetDiscussedWithKeys: [{ serviceKey: "ppc", name: "PPC / Media" }],
      overallRatingStillNeeded: false,
      npsStillNeeded: false
    };
    const action = conversationFlow.requiredConversationAction(checklist, state);
    assert.deepStrictEqual(action, { type: "service_scope" });
    const reply = conversationFlow.fallbackForAction(action, state, project);
    assert.match(reply, /services one by one/i);
    assert.match(reply, /skip/i);
    const markers = conversationFlow.recordRequiredQuestion(state, project, action);
    conversationFlow.setStateForRequiredAction(state, action, markers);
    assert.strictEqual(state.state, "waiting_for_service_scope");
    assert.strictEqual(state.pendingQuestionType, "service_scope");
  });

  await scenario("Fresh project-end feedback asks for one whole-project review", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const { buildChecklist } = require("../src/lib/whatsapp-state-machine");
    const state = {
      sessionType: "project_end",
      mentionedServices: {},
      projectEndReviewCaptured: false,
      serviceScopeStatus: null
    };
    const checklist = buildChecklist(state, project);
    const action = conversationFlow.requiredConversationAction(checklist, state);
    assert.deepStrictEqual(action, { type: "project_end_review" });
    const reply = conversationFlow.fallbackForAction(action, state, project);
    assert.match(reply, /entire duration/i);
    assert.match(reply, /issues, concerns, areas for improvement, or positive experiences/i);
    assert.match(reply, /Directors/i);
    assert.doesNotMatch(reply, /services one by one|How has .* been for you/i);

    const markers = conversationFlow.recordRequiredQuestion(state, project, action);
    conversationFlow.setStateForRequiredAction(state, action, markers);
    assert.strictEqual(state.pendingQuestionType, "project_end_review");
    assert.strictEqual(state.projectEndReviewAsked, true);
    assert.strictEqual(state.state, "waiting_for_open_feedback");
  });

  await scenario("Project-end broad response moves past unmentioned services", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const { buildChecklist } = require("../src/lib/whatsapp-state-machine");
    const stateBefore = {
      sessionType: "project_end",
      state: "waiting_for_open_feedback",
      pendingQuestionType: "project_end_review",
      projectEndReviewAsked: true,
      projectEndReviewCaptured: false,
      mentionedServices: {},
      overallRating: null,
      npsScore: null,
      appreciationAnswered: false,
      anythingElseAnswered: false
    };
    const state = JSON.parse(JSON.stringify(stateBefore));
    conversationFlow.applyTurnServiceScope(
      state,
      project,
      "Overall the project went well and the team was supportive.",
      { intent: "feedback", sentiment: "positive", serviceScope: "overall_feedback" },
      { captured: [], observations: [], appreciations: [], serviceScope: "overall_feedback" },
      stateBefore
    );
    const checklist = buildChecklist(state, project);
    const action = conversationFlow.requiredConversationAction(checklist, state);
    assert.strictEqual(state.projectEndReviewCaptured, true);
    assert.deepStrictEqual(state.mentionedServices, {});
    assert.deepStrictEqual(checklist.servicesNotYetDiscussedWithKeys, []);
    assert.deepStrictEqual(action, { type: "overall_rating" });
    const praiseReply = conversationFlow.fallbackForAction(action, state, project, {
      appreciations: [{
        subject: "Client appreciation",
        detail: "India's best agency. Keep it up.",
        serviceKey: null
      }]
    });
    assert.match(praiseReply, /kind words about SRV Media/i);
    assert.match(praiseReply, /overall.*rate|rate.*overall/i);
    assert.doesNotMatch(praiseReply, /missed.*department|department.*missed/i);
  });

  await scenario("Project-end accepts natural refusal without requiring the word skip", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const { buildChecklist } = require("../src/lib/whatsapp-state-machine");
    const stateBefore = {
      sessionType: "project_end",
      state: "waiting_for_open_feedback",
      pendingQuestionType: "project_end_review",
      projectEndReviewAsked: true,
      projectEndReviewCaptured: false,
      mentionedServices: {}
    };
    const state = JSON.parse(JSON.stringify(stateBefore));
    conversationFlow.applyTurnServiceScope(
      state,
      project,
      "No, I do not want to give separate service replies. That is all from my side.",
      { intent: "negative", sentiment: "neutral", serviceScope: "skip_remaining_services" },
      { captured: [], observations: [], appreciations: [], serviceScope: "skip_remaining_services" },
      stateBefore
    );
    assert.strictEqual(state.projectEndReviewCaptured, true);
    assert.strictEqual(state.serviceScopeStatus, "project_end_overall");
    assert.deepStrictEqual(state.mentionedServices, {},
      "a project-end refusal must not create fake declined service records");
    assert.deepStrictEqual(buildChecklist(state, project).servicesNotYetDiscussedWithKeys, []);
  });

  await scenario("Project-end API captures the broad review without asking configured services", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    const priorFetch = global.fetch;
    const priorMessages = [...calls.messages];
    const priorSession = store._session;
    process.env.GEMINI_API_KEY = "test-key";
    calls.messages.length = 0;
    store._session = {
      id: "sess_1", cycleId: "cyc_1", projectId: "prj_1", clientPocId: "poc_1",
      status: "partial", completionStatus: "partial", sessionType: "project_end",
      conversationState: {
        state: "waiting_for_open_feedback",
        pendingQuestionType: "project_end_review",
        projectEndReviewAsked: true,
        projectEndReviewCaptured: false,
        mentionedServices: {},
        turnCount: 1
      }
    };
    const modelPayloads = [
      {
        intent: "feedback", deferRequested: false, serviceScope: "overall_feedback",
        sentiment: "positive", rating: null, serviceHint: null, serviceHints: [],
        explainsProblem: false, isObservation: false, serviceFeedback: [],
        observations: [], appreciations: []
      },
      {
        message: "Thank you for that positive overall project feedback. Is there any team or department you would especially like to appreciate?",
        captured: [], observations: [], appreciations: [], overallRating: null,
        corrects: false, readyToClose: false, deferRequested: false,
        serviceScope: "overall_feedback", askedForProjectEndReview: false,
        askedForOverallRating: false, askedForAppreciation: true,
        askedForAnythingElse: false, askedForServiceScope: false,
        askedServiceKey: null
      }
    ];
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ output_text: JSON.stringify(modelPayloads.shift()) })
    });
    try {
      const response = await rawReq("POST", "/api/whatsapp/inbound", {
        from: "+91 99999 99999",
        text: "Overall project delivery has been good and the team was supportive.",
        providerMessageId: "wamid.project-end-overall"
      });
      const payload = JSON.parse(response.body);
      assert.strictEqual(response.statusCode, 201);
      assert.match(payload.whatsappReplyText, /anything else.*overall rating/i);
      assert.doesNotMatch(payload.whatsappReplyText, /missed.*department|department.*missed/i);
      assert.doesNotMatch(payload.whatsappReplyText, /services one by one|How has .* been for you/i);
      assert.strictEqual(payload.session.conversationState.projectEndReviewCaptured, true);
      assert.strictEqual(payload.session.conversationState.serviceScopeStatus, "project_end_overall");
      assert.deepStrictEqual(payload.session.conversationState.mentionedServices, {});
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
      global.fetch = priorFetch;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      store._session = priorSession;
    }
  });

  await scenario("Correct Gemini wording is accepted even if a JSON action marker is missing", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    assert.strictEqual(
      conversationFlow.messageMatchesRequiredAction(
        { type: "service_scope" },
        "Would you like to continue through the services one by one, or skip the remaining service questions?"
      ),
      true
    );
    assert.strictEqual(
      conversationFlow.messageMatchesRequiredAction(
        { type: "service_scope" },
        "How has PPC / Media been for you?"
      ),
      false
    );
  });

  await scenario("Broad relationship feedback is not guessed as the service in the question", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const conducted = {
      serviceScope: "overall_feedback",
      captured: [{
        serviceKey: "ppc",
        sentiment: "positive",
        summary: "The relationship is improving"
      }]
    };
    conversationFlow.suppressBroadOverallServiceGuess(conducted, {
      serviceScope: "overall_feedback",
      serviceKeys: []
    }, "We had a few hiccups initially, then things fell into place.", project);
    assert.deepStrictEqual(conducted.captured, []);
  });

  await scenario("A pending real issue remains ahead of the service-scope choice", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const state = {
      pendingServiceKey: "ppc",
      serviceScopeStatus: "awaiting_choice"
    };
    const action = conversationFlow.requiredConversationAction({
      serviceScopeChoiceStillNeeded: true,
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [
        { serviceKey: "ppc", name: "PPC / Media" }
      ],
      servicesWaitingForAnythingElseAnswer: [],
      servicesNotYetDiscussedWithKeys: [{ serviceKey: "website", name: "Website / SEO" }],
      overallRatingStillNeeded: false,
      npsStillNeeded: false
    }, state);
    assert.deepStrictEqual(action, {
      type: "issue_reason", serviceKey: "ppc", name: "PPC / Media"
    });
  });

  await scenario("Broad feedback scope comes before a routine positive or neutral service follow-up", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const state = {
      pendingServiceKey: "ppc",
      serviceScopeStatus: "awaiting_choice",
      mentionedServices: {
        ppc: { serviceKey: "ppc", sentiment: "neutral", status: "needs_service_followup" }
      }
    };
    const action = conversationFlow.requiredConversationAction({
      serviceScopeChoiceStillNeeded: true,
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [],
      servicesWaitingForAnythingElseAnswer: [
        { serviceKey: "ppc", name: "PPC / Media", askCount: 0 }
      ],
      servicesNotYetDiscussedWithKeys: [{ serviceKey: "website", name: "Website / SEO" }],
      overallRatingStillNeeded: false,
      npsStillNeeded: false
    }, state);
    assert.deepStrictEqual(action, { type: "service_scope" });
  });

  await scenario("Nuanced multi-service feedback is not flattened into false praise", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const nuancedProject = {
      services: [
        { serviceKey: "account", name: "Account Management" },
        { serviceKey: "creatives", name: "Creatives" }
      ]
    };
    const text = "The client servicing is good and the team is proactive. Since ours was a last minute onboarding and there were teething issues at our end, we would like to see the full potential of the team in terms of creatives and videos. The learning phase is over and we are very satisfied.";
    const grounded = conversationFlow.groundMultiServiceCaptures([
      {
        serviceKey: "account", sentiment: "positive",
        summary: "Client servicing is good and proactive", needsFollowUp: false
      },
      {
        serviceKey: "creatives", sentiment: "neutral",
        summary: "They now expect the team's full creative and video potential", needsFollowUp: false
      }
    ], text, nuancedProject, {});
    const creative = grounded.find((item) => item.serviceKey === "creatives");
    assert.strictEqual(creative.sentiment, "neutral");
    assert.match(creative.summary, /expect.*creative.*video/i);
    const outageFallback = conversationFlow.groundMultiServiceCaptures([], text, nuancedProject, {});
    assert.strictEqual(
      outageFallback.find((item) => item.serviceKey === "creatives").sentiment,
      "neutral",
      "the deterministic outage path must not turn a future expectation into praise"
    );
    assert.deepStrictEqual(
      outageFallback.map((item) => item.serviceKey).sort(),
      ["account", "creatives"],
      "an exact custom Creatives service must not also be duplicated under legacy Design"
    );
  });

  await scenario("Exact custom service names win over overlapping legacy aliases", async () => {
    const { detectors } = require("../src/lib/whatsapp-state-machine");
    const customProject = {
      services: [
        { serviceKey: "landing_page", name: "Landing Page" },
        { serviceKey: "website", name: "Website" }
      ]
    };
    assert.deepStrictEqual(
      detectors.detectServices("The Landing Page is slow but SEO is good", customProject).sort(),
      ["landing_page", "website"]
    );
    assert.deepStrictEqual(
      detectors.detectServices("The Landing Page is slow", customProject),
      ["landing_page"]
    );
  });

  await scenario("Broad feedback plus skip bypasses the repetitive final sweep", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const { applyServiceScopeDecision, buildChecklist, SERVICE_SCOPE_DECISIONS } =
      require("../src/lib/whatsapp-state-machine");
    const state = {
      sessionType: "pulse",
      mentionedServices: {},
      serviceScopeStatus: "awaiting_choice",
      generalFeedbackText: "The relationship is positive overall.",
      appreciationAnswered: true,
      appreciationVolunteered: true,
      overallRating: null
    };
    applyServiceScopeDecision(state, project, SERVICE_SCOPE_DECISIONS.SKIP_REMAINING_SERVICES);
    assert.strictEqual(state.askedForAnythingElse, true);
    assert.strictEqual(state.anythingElseAnswered, true);
    assert.deepStrictEqual(
      conversationFlow.requiredConversationAction(buildChecklist(state, project), state),
      { type: "overall_rating" }
    );
  });

  await scenario("Consecutive client bubbles are combined and only the newest invocation replies", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const messages = [
      { id: "q1", side: "srv", body: "How has the work been?" },
      { id: "c1", side: "client", body: "The team has been proactive." },
      { id: "c2", side: "client", body: "Thank you" }
    ];
    assert.strictEqual(
      conversationFlow.clientBurstContext(messages, messages[1]).superseded,
      true
    );
    const latest = conversationFlow.clientBurstContext(messages, messages[2]);
    assert.strictEqual(latest.superseded, false);
    assert.strictEqual(latest.text, "The team has been proactive.\nThank you");
  });

  await scenario("Skipping service questions proceeds directly to the overall rating", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const { applyServiceScopeDecision, buildChecklist, SERVICE_SCOPE_DECISIONS } =
      require("../src/lib/whatsapp-state-machine");
    const state = {
      sessionType: "pulse",
      mentionedServices: {},
      serviceScopeStatus: "awaiting_choice",
      appreciationAnswered: false,
      anythingElseAnswered: false,
      overallRating: null
    };
    applyServiceScopeDecision(
      state,
      project,
      SERVICE_SCOPE_DECISIONS.SKIP_REMAINING_SERVICES
    );
    const action = conversationFlow.requiredConversationAction(buildChecklist(state, project), state);
    assert.deepStrictEqual(action, { type: "overall_rating" });
    assert.strictEqual(state.overallRating, null);
  });

  await scenario("Creative praise does not reopen a completed Design service or pollute its issue", async () => {
    const { applyCaptured, buildChecklist } = require("../src/lib/whatsapp-state-machine");
    const designService = { serviceKey: "design", name: "Design" };
    const oneService = {
      ...project,
      services: [designService]
    };
    const originalIssue = "Website designs look dated and should be more futuristic";
    const state = {
      sessionType: "pulse",
      mentionedServices: {
        design: {
          serviceKey: "design",
          serviceName: "Design",
          status: "captured",
          sentiment: "negative",
          sentiments: ["negative"],
          reasonText: originalIssue,
          points: [originalIssue],
          serviceFollowUpAnswered: true,
          serviceFollowUpAskCount: 1
        }
      }
    };
    applyCaptured(state, oneService, [{
      serviceKey: "design",
      sentiment: "positive",
      summary: "The creative team is doing a fantastic job with the videos",
      needsFollowUp: false,
      fromAppreciation: true
    }]);
    assert.strictEqual(state.mentionedServices.design.status, "captured");
    assert.strictEqual(state.mentionedServices.design.serviceFollowUpAnswered, true);
    assert.strictEqual(state.mentionedServices.design.reasonText, originalIssue,
      "praise must not be appended to a negative issue root cause");
    assert.deepStrictEqual(state.mentionedServices.design.appreciationPoints,
      ["The creative team is doing a fantastic job with the videos"]);
    assert.deepStrictEqual(buildChecklist(state, oneService).servicesWaitingForAnythingElseAnswer, []);
  });

  await scenario("A pure appreciation can cover a new service without starting an interview", async () => {
    const { applyCaptured, buildChecklist } = require("../src/lib/whatsapp-state-machine");
    const designService = { serviceKey: "design", name: "Design" };
    const oneService = {
      ...project,
      services: [designService]
    };
    const state = { sessionType: "pulse", mentionedServices: {} };
    applyCaptured(state, oneService, [{
      serviceKey: "design",
      sentiment: "positive",
      summary: "The creative team's videos are excellent",
      needsFollowUp: false,
      fromAppreciation: true
    }]);
    assert.strictEqual(state.mentionedServices.design.status, "captured");
    assert.strictEqual(state.mentionedServices.design.serviceFollowUpAnswered, true);
    assert.deepStrictEqual(buildChecklist(state, oneService).servicesWaitingForAnythingElseAnswer, []);
  });

  await scenario("Website design detail is not duplicated under Design", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const scoped = conversationFlow.scopeCapturedToPendingQuestion({
      pendingQuestionType: "issue_reason",
      pendingServiceKey: "website",
      mentionedServices: {
        website: { serviceKey: "website", serviceName: "Website" }
      }
    }, [
      { serviceKey: "website", sentiment: "negative", summary: "Website looks like the 1990s and needs a futuristic design" },
      { serviceKey: "design", sentiment: "negative", summary: "Design looks like the 1990s and should be futuristic" }
    ], { explainsProblem: true, serviceKeys: ["website", "design"] },
    "The website looks like it was made in the 1990s and should be futuristic");
    assert.deepStrictEqual(scoped.map((item) => item.serviceKey), ["website"]);

    const stateAfterRules = {
      mentionedServices: {
        website: { serviceKey: "website", serviceName: "Website", status: "needs_reason" },
        design: { serviceKey: "design", serviceName: "Design", sentiment: "negative", reasonText: "Design looks like the 1990s" }
      }
    };
    conversationFlow.reconcilePendingServiceArtifacts(stateAfterRules, {
      pendingQuestionType: "issue_reason",
      pendingServiceKey: "website",
      mentionedServices: {
        website: { serviceKey: "website", serviceName: "Website", status: "needs_reason" }
      }
    }, scoped);
    assert.deepStrictEqual(Object.keys(stateAfterRules.mentionedServices), ["website"],
      "a keyword-created Design artifact must not survive the scoped model capture");
  });

  await scenario("Mixed service feedback keeps each clause's own sentiment and summary", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const { applyCaptured } = require("../src/lib/whatsapp-state-machine");
    const multiProject = {
      ...project,
      services: [
        { serviceKey: "website", name: "Website" },
        { serviceKey: "seo", name: "SEO" },
        { serviceKey: "account", name: "Account Management" }
      ]
    };
    const text = "Website needs to improve. SEO performance is satisfactory. Client servicing is okayish.";
    const wronglyGlobal = ["website", "seo", "account"].map((serviceKey) => ({
      serviceKey,
      sentiment: "negative",
      summary: text,
      needsFollowUp: true
    }));
    const grounded = conversationFlow.groundMultiServiceCaptures(
      wronglyGlobal,
      text,
      multiProject
    );
    assert.deepStrictEqual(grounded.map((item) => ({
      serviceKey: item.serviceKey,
      sentiment: item.sentiment,
      summary: item.summary,
      needsFollowUp: item.needsFollowUp
    })), [
      { serviceKey: "website", sentiment: "negative", summary: "Website needs to improve", needsFollowUp: true },
      { serviceKey: "seo", sentiment: "neutral", summary: "SEO performance is satisfactory", needsFollowUp: false },
      { serviceKey: "account", sentiment: "neutral", summary: "Client servicing is okayish", needsFollowUp: false }
    ]);

    const state = {
      mentionedServices: Object.fromEntries(["website", "seo", "account"].map((serviceKey) => [
        serviceKey,
        {
          serviceKey,
          serviceName: serviceKey,
          sentiment: "negative",
          sentiments: ["negative"],
          status: "needs_reason",
          reasonText: text
        }
      ]))
    };
    conversationFlow.resetFreshCapturedServices(state, { mentionedServices: {} }, grounded);
    applyCaptured(state, multiProject, grounded);
    assert.strictEqual(state.mentionedServices.website.sentiment, "negative");
    assert.strictEqual(state.mentionedServices.website.status, "needs_reason");
    assert.strictEqual(state.mentionedServices.seo.sentiment, "neutral");
    assert.strictEqual(state.mentionedServices.seo.status, "needs_service_followup");
    assert.strictEqual(state.mentionedServices.account.sentiment, "neutral");
    assert.strictEqual(state.mentionedServices.account.status, "needs_service_followup");
    assert.strictEqual(state.mentionedServices.seo.reasonText, "SEO performance is satisfactory");
    assert.strictEqual(state.mentionedServices.account.reasonText, "Client servicing is okayish");
  });

  await scenario("Required issue and final-sweep wording is contextual", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const issueReply = conversationFlow.fallbackForAction(
      { type: "issue_reason", serviceKey: "website", name: "Website" },
      { mentionedServices: {} },
      project
    );
    assert.match(issueReply, /sorry to hear/i);
    assert.match(issueReply, /what specifically should improve/i);

    const finalReply = conversationFlow.fallbackForAction(
      { type: "final_sweep" },
      {
        mentionedServices: {
          ppc: { serviceKey: "ppc", status: "captured" },
          website: { serviceKey: "website", status: "captured" }
        }
      },
      project
    );
    assert.match(finalReply, /anything else.*Directors/i);
    assert.match(finalReply, /issue/i);
    assert.match(finalReply, /area for improvement/i);
    assert.match(finalReply, /appreciation/i);
    assert.doesNotMatch(finalReply, /department.*missed|missed.*department/i);

    const skippedReply = conversationFlow.fallbackForAction(
      { type: "final_sweep" },
      {
        mentionedServices: {
          ppc: { serviceKey: "ppc", status: "captured" },
          website: { serviceKey: "website", status: "declined" }
        }
      },
      project
    );
    assert.strictEqual(skippedReply, finalReply,
      "the final management question should not recite departments or services");
  });

  await scenario("Fallback acknowledgements are empathetic without repeating Understood", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const reply = conversationFlow.fallbackForAction({
      type: "service_followup", serviceKey: "website", name: "Website", askCount: 0
    }, {
      mentionedServices: { website: { sentiment: "negative" } }
    }, project);
    assert.ok(/sorry to hear/i.test(reply));
    assert.ok(/team will look into it/i.test(reply));
    assert.ok(!/understood/i.test(reply));
  });

  await scenario("The same underlying issue is filed under only its best owner", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const services = [
      {
        serviceKey: "design", serviceName: "Design", sentiment: "negative", issueReady: true,
        issueTitle: "Outdated website design quality",
        issueRootCause: "Designs look like the 1990s and need to be more futuristic"
      },
      {
        serviceKey: "website", serviceName: "Website", sentiment: "negative", issueReady: true,
        issueTitle: "Website needs a futuristic visual design",
        issueRootCause: "Website designs look like the 1990s and need to be more futuristic"
      }
    ];
    conversationFlow.suppressDuplicateIssues(services);
    assert.strictEqual(services.filter((item) => item.issueReady).length, 1);
    assert.strictEqual(services.find((item) => item.issueReady).serviceKey, "website");
  });

  await scenario("Terminal prediction cannot erase an appreciation observation", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const merged = conversationFlow.mergeObservations(
      [{ topic: "Creative Team", detail: "The videos are fantastic", sentiment: "positive" }],
      [{ topic: "Billing", detail: "The tax invoice is inaccurate", sentiment: "negative" }]
    );
    assert.strictEqual(merged.length, 2);
    assert.ok(merged.some((item) => item.sentiment === "positive"));
  });

  await scenario("An actionable reason returns to anything else on the same service", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const state = {
      mentionedServices: {
        website: { serviceKey: "website", sentiment: "negative", status: "needs_reason" }
      }
    };
    const changed = conversationFlow.applyPendingIssueInterpretation(
      state,
      { pendingQuestionType: "issue_reason", pendingServiceKey: "website" },
      { explainsProblem: true, serviceKeys: ["website", "design"] }
    );
    assert.strictEqual(changed, true);
    assert.strictEqual(state.mentionedServices.website.status, "needs_service_followup");
    assert.strictEqual(state.mentionedServices.website.detailAnswered, true);
  });

  await scenario("A vague new issue pauses appreciation and asks for details", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const state = {
      pendingQuestionType: "appreciation",
      askedForAppreciation: true,
      appreciationAnswered: false,
      mentionedServices: {}
    };
    conversationFlow.applyConversationInterruption(
      state, state,
      { intent: "more_detail", serviceKeys: [], explainsProblem: false },
      { captured: [], observations: [] },
      "There is one more issue"
    );
    const action = conversationFlow.requiredConversationAction({
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [],
      servicesWaitingForAnythingElseAnswer: [],
      servicesNotYetDiscussedWithKeys: [],
      overallRatingStillNeeded: false,
      npsStillNeeded: false
    }, state);
    assert.strictEqual(action.type, "general_issue_detail");
    assert.strictEqual(state.resumeQuestionType, "appreciation");
    assert.ok(/tell me what happened/i.test(
      conversationFlow.fallbackForAction(action, state, project)
    ));
  });

  await scenario("An actionable billing observation is acknowledged without another topic interview", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const state = { mentionedServices: {}, pendingQuestionType: "final_sweep" };
    conversationFlow.applyConversationInterruption(
      state, state,
      { intent: "feedback", serviceKeys: [], explainsProblem: true },
      {
        captured: [],
        observations: [{
          topic: "Billing", detail: "Tax invoice is inaccurate",
          sentiment: "negative", severity: "high", needsFollowUp: false
        }]
      },
      "Your billings are inaccurate"
    );
    const action = conversationFlow.requiredConversationAction({
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [],
      servicesWaitingForAnythingElseAnswer: [],
      servicesNotYetDiscussedWithKeys: [],
      overallRatingStillNeeded: false,
      npsStillNeeded: false
    }, state);
    assert.deepStrictEqual(action, { type: "final_sweep" });
    const context = { latestClientText: "Your billings are inaccurate", acknowledgement: "I am sorry about the inaccuracies in the tax invoice.", observations: [{ topic: "Billing", detail: "Tax invoice is inaccurate", sentiment: "negative" }] };
    const reply = conversationFlow.fallbackForAction(action, state, project, context);
    assert.ok(/sorry/i.test(reply));
    assert.match(reply, /inaccuracies in the tax invoice/i);
    assert.ok(/anything else you would like the Directors to know/i.test(reply));
    assert.ok(!/rate .*support/i.test(reply), "per-service ratings must never leak into this turn");
    const recorded = conversationFlow.recordRequiredQuestion(state, project, action);
    conversationFlow.setStateForRequiredAction(state, action, recorded);
    const retry = conversationFlow.fallbackForAction(action, state, project);
    assert.ok(/before we finish/i.test(retry));
    assert.ok(!/sorry/i.test(retry), "do not apologise for the same issue again on a retry");
  });

  await scenario("an actionable senior meeting request is saved before returning to the pending rating", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const state = {
      mentionedServices: {},
      pendingQuestionType: "overall_rating",
      overallRatingAsked: true
    };
    conversationFlow.applyConversationInterruption(
      state,
      { ...state },
      { intent: "feedback", serviceKeys: [], explainsProblem: true, isObservation: true },
      {
        captured: [],
        observations: [{
          topic: "Senior Involvement",
          detail: "Client wants one senior meeting each month",
          sentiment: "neutral",
          severity: "watch",
          needsFollowUp: false
        }]
      },
      "I need one meeting a month with seniors involved"
    );
    const action = conversationFlow.requiredConversationAction({
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [],
      servicesWaitingForAnythingElseAnswer: [],
      servicesNotYetDiscussedWithKeys: [],
      overallRatingStillNeeded: true,
      npsStillNeeded: false
    }, state);
    assert.deepStrictEqual(action, { type: "overall_rating" });
    const reply = conversationFlow.fallbackForAction(action, state, project, { observations: [{
      topic: "Senior Involvement", detail: "Client wants one senior meeting each month", kind: "request", sentiment: "neutral"
    }] });
    assert.match(reply, /recorded your request.*relevant team/i);
    assert.doesNotMatch(reply, /Client wants|I have recorded:/i);
    assert.match(reply, /overall.*out of 10/i);
  });

  await scenario("AVP absence is always classified as Senior Involvement", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const message = "Your AVPs are absent from meetings; Sarang has not attended or picked up my calls for three months.";
    const observation = {
      topic: "Review Meeting",
      detail: message,
      sentiment: "negative",
      needsFollowUp: false
    };
    assert.strictEqual(
      conversationFlow.canonicalObservationTopic(observation, message),
      "Senior Involvement",
      "the concrete senior/AVP signal must override Gemini's broader meeting label"
    );
    const state = {
      pendingObservation: {
        topic: "Senior Involvement", stage: "followup", acknowledged: false,
        responseKind: "feedback"
      }
    };
    const reply = conversationFlow.fallbackForAction(
      { type: "observation_followup", topic: "Senior Involvement" },
      state,
      project
    );
    assert.doesNotMatch(reply, /lack of senior involvement and communication/i,
      "fallback must not manufacture an explanation from the topic label alone");
    assert.match(reply, /recorded for review/i);
  });

  await scenario("that's it from my side answers a final sweep", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const markers = conversationFlow.validatedAnswerMarkers({
      state: "waiting_for_more_services",
      pendingQuestionType: "final_sweep",
      askedForAnythingElse: true,
      anythingElseAnswered: false
    }, { captured: [], observations: [], appreciations: [] }, "thats it from my side. Thanks!");
    assert.strictEqual(markers.answeredAnythingElse, true);
  });

  await scenario("no that's it plus a meeting request is actioned before the next service", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const text = "no that's it, but I would like to have a meeting on this in the coming week with detailed reports";
    const interpretation = {
      intent: "feedback",
      isObservation: false,
      serviceKeys: ["ppc"],
      sentiment: "neutral",
      explainsProblem: false
    };
    const observation = conversationFlow.observationFromInterpretation(interpretation, text);
    assert.ok(observation, "an explicit action request must not depend on Gemini setting isObservation");
    assert.strictEqual(observation.topic, "Review Meeting");
    assert.strictEqual(observation.kind, "request");
    assert.strictEqual(observation.needsFollowUp, false);

    const state = {
      mentionedServices: {},
      pendingQuestionType: "service_followup",
      pendingServiceKey: "ppc"
    };
    conversationFlow.applyConversationInterruption(
      state,
      { ...state },
      interpretation,
      { captured: [], observations: [observation] },
      text
    );
    const action = conversationFlow.requiredConversationAction({
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [],
      servicesWaitingForAnythingElseAnswer: [],
      servicesNotYetDiscussedWithKeys: [{ serviceKey: "seo", name: "SEO" }],
      overallRatingStillNeeded: true,
      npsStillNeeded: false
    }, state);
    assert.deepStrictEqual(action, { type: "service", serviceKey: "seo", name: "SEO" });
    const reply = conversationFlow.fallbackForAction(action, state, project, { observations: [observation] });
    assert.match(reply, /recorded your request/i);
    assert.match(reply, /relevant team/i);
    assert.match(reply, /how has SEO/i, "an actionable request must not force a second interview");
  });

  await scenario("a closing-window social-media update and senior meeting survive Gemini timeout", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const text = "Social media is working well. And we would appreciate a meeting with your senior management if possible.";
    const observation = conversationFlow.observationFromInterpretation(null, text);
    assert.ok(observation, "the meeting request must have a deterministic fallback");
    assert.strictEqual(observation.topic, "Review Meeting");
    assert.strictEqual(observation.kind, "request");
    assert.strictEqual(observation.positiveContext, "Social Media");

    const state = {
      mentionedServices: {},
      pendingQuestionType: null,
      askedForAppreciation: true,
      appreciationAnswered: true,
      askedForAnythingElse: true,
      anythingElseAnswered: true,
      overallRatingAsked: true,
      overallRating: 8
    };
    conversationFlow.applyConversationInterruption(
      state,
      { ...state },
      null,
      { captured: [], observations: [observation] },
      text
    );
    const action = conversationFlow.requiredConversationAction({
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [],
      servicesWaitingForAnythingElseAnswer: [],
      servicesNotYetDiscussedWithKeys: [],
      overallRatingStillNeeded: false,
      npsStillNeeded: false
    }, state);
    assert.deepStrictEqual(action, { type: "close" });
    const reply = conversationFlow.fallbackForAction(action, state, project, { observations: [observation] });
    assert.match(reply, /social media is working well/i);
    assert.match(reply, /recorded your request.*relevant team/i);
    assert.ok(!/PPC/i.test(reply));
  });

  await scenario("long mixed process feedback receives a specific safe reply during Gemini timeout", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const mixedText = "Across several design assets, agreed changes were applied inconsistently, so our team had to repeat the same feedback and go through avoidable rework. Better internal alignment would make delivery smoother. The POCs, Aisha and Dev, were always responsive and made coordination easy.";
    const scopedProject = {
      ...project,
      services: [
        { serviceKey: "account", name: "Account Management" },
        { serviceKey: "campaign", name: "Campaign Management" }
      ]
    };
    const observation = conversationFlow.fallbackDeliveryObservation(mixedText);
    const appreciations = conversationFlow.fallbackRoleAppreciations(mixedText, scopedProject);
    assert.ok(observation, "repeated and inconsistently applied changes must survive a model timeout");
    assert.strictEqual(observation.topic, "Creative Process");
    assert.strictEqual(observation.needsFollowUp, false);
    assert.strictEqual(appreciations[0].subject, "Aisha and Dev");
    assert.strictEqual(appreciations[0].serviceKey, "account");

    const state = {
      pendingObservation: {
        topic: "Creative Process", stage: "followup", acknowledged: false,
        responseKind: "feedback"
      }
    };
    const reply = conversationFlow.fallbackForAction(
      { type: "observation_followup", topic: "Creative Process" },
      state,
      scopedProject,
      { observations: [observation], appreciations }
    );
    assert.match(reply, /sorry.*creative process.*back-and-forth/i);
    assert.match(reply, /agreed feedback was not implemented consistently/i);
    assert.match(reply, /internal alignment and communication/i);
    assert.match(reply, /Aisha and Dev/i);
    assert.match(reply, /anything else.*Directors/i);
    assert.ok(!/Glad to hear that about Account Management/i.test(reply));
  });

  await scenario("successful Gemini output cannot omit a detailed process concern or named POC praise", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const mixedText = "We agreed one set of amendments across several visual assets, but some changes were implemented inconsistently and had to be reiterated. Better internal alignment would make the process smoother. Our POCs, Aisha initially and now Dev, were approachable and responsive throughout.";
    const scopedProject = {
      ...project,
      services: [
        { serviceKey: "account", name: "Account Management" },
        { serviceKey: "campaign", name: "Campaign Management" }
      ]
    };
    // Reproduce a successful conductor response whose prose is usable but
    // whose structured arrays accidentally omit everything the client raised.
    const conducted = {
      text: "Thank you for sharing your feedback.",
      acknowledgement: "I am sorry the agreed amendments were not applied consistently, leading to avoidable rework.",
      captured: [],
      observations: [],
      appreciations: [],
      answeredAnythingElse: true,
      readyToClose: true
    };
    conversationFlow.enrichConductedWithDeterministicFacts(conducted, mixedText, scopedProject);
    assert.strictEqual(conducted.observations.length, 1);
    assert.strictEqual(conducted.observations[0].topic, "Creative Process");
    assert.strictEqual(conducted.observations[0].fallbackKind, "delivery_process");
    assert.strictEqual(conducted.appreciations[0].subject, "Aisha and Dev");

    const state = {
      pendingQuestionType: "final_sweep",
      pendingObservation: null,
      overallRatingAsked: true,
      overallRating: 9,
      npsAsked: true,
      npsScore: 10
    };
    conversationFlow.applyConversationInterruption(
      state,
      { ...state },
      { intent: "feedback" },
      conducted,
      mixedText
    );
    const action = conversationFlow.requiredConversationAction({
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [],
      servicesWaitingForAnythingElseAnswer: [],
      servicesNotYetDiscussedWithKeys: [],
      overallRatingStillNeeded: false,
      npsStillNeeded: false
    }, state);
    assert.deepStrictEqual(action, { type: "final_sweep" });
    const reply = conversationFlow.fallbackForAction(action, state, scopedProject, conducted);
    assert.match(reply, /inconsisten\w*|amendments|feedback/i);
    assert.match(reply, /Aisha and Dev/i);
    assert.match(reply, /anything else.*Directors/i);
    assert.ok(!/remain active for the next 10 minutes/i.test(reply));
  });

  await scenario("successful Gemini output cannot omit other substantial concerns", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const text = "The campaign results are below expectations, the reporting does not provide the profiles we need, and we need much stronger ownership from the team.";
    const interpretation = {
      source: "gemini",
      intent: "feedback",
      sentiment: "negative",
      explainsProblem: true,
      concerns: [{
        title: "Campaign performance and reporting",
        summary: text,
        sentiment: "negative",
        severity: "high"
      }]
    };
    const conducted = {
      text: "Thank you for sharing your feedback.",
      captured: [],
      observations: [],
      appreciations: [],
      readyToClose: true
    };
    conversationFlow.enrichConductedWithDeterministicFacts(
      conducted,
      text,
      project,
      interpretation,
      { protectSubstantiveConcern: true }
    );
    assert.strictEqual(conducted.observations.length, 1);
    assert.strictEqual(conducted.observations[0].sentiment, "negative");
    assert.strictEqual(conducted.observations[0].detail, text, "keep all the grounded concern detail without a second fallback interpretation");
    assert.strictEqual(conducted.observations[0].needsFollowUp, false);
  });

  await scenario("facts from the authoritative latest-reply read survive across unrelated topics", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const cases = [
      {
        name: "commercial scope",
        text: "The delivered scope does not match the signed commercial proposal.",
        interpretation: {
          intent: "feedback", sentiment: "negative", explainsProblem: true,
          concerns: [{
            title: "Commercial scope mismatch", summary: "Delivered scope differs from the signed proposal.",
            sentiment: "negative", severity: "high", serviceKey: null, needsFollowUp: false
          }]
        },
        expectedTopic: "Commercial scope mismatch"
      },
      {
        name: "data quality",
        text: "The attribution model assigns webinar conversions to the preceding source.",
        interpretation: {
          intent: "feedback", sentiment: "negative", explainsProblem: true,
          observations: [{
            topic: "Attribution Data", detail: "Webinar conversions are assigned to the preceding source.",
            sentiment: "negative", severity: "watch", needsFollowUp: false, kind: "feedback"
          }]
        },
        expectedTopic: "Attribution Data"
      },
      {
        name: "service delivery",
        text: "Organic search recommendations arrive after our publishing decisions.",
        interpretation: {
          intent: "feedback", sentiment: "negative", explainsProblem: true,
          captured: [{
            serviceKey: "seo", sentiment: "negative",
            summary: "Recommendations arrive after publishing decisions.", declined: false, needsFollowUp: false
          }]
        },
        expectedService: "seo"
      },
      {
        name: "action request",
        text: "Please arrange a review with the project director before the next launch.",
        interpretation: {
          intent: "feedback", sentiment: "neutral", explainsProblem: true,
          observations: [{
            topic: "Leadership Review", detail: "Arrange a project-director review before launch.",
            sentiment: "neutral", severity: "info", needsFollowUp: false, kind: "request"
          }]
        },
        expectedTopic: "Leadership Review"
      },
      {
        name: "person appreciation",
        text: "Riya kept every stakeholder aligned and made coordination effortless.",
        interpretation: {
          intent: "feedback", sentiment: "positive", explainsProblem: true,
          appreciations: [{ subject: "Riya", detail: "Kept stakeholders aligned.", serviceKey: null }]
        },
        expectedAppreciation: "Riya"
      }
    ];

    for (const item of cases) {
      const conducted = {
        text: "Thank you for sharing this. Is there anything else you would like the Directors to know?",
        captured: [], observations: [], appreciations: [], readyToClose: true
      };
      conversationFlow.enrichConductedWithDeterministicFacts(
        conducted, item.text, project, item.interpretation,
        { protectSubstantiveConcern: true }
      );
      if (item.expectedService) {
        assert.ok(conducted.captured.some((fact) => (
          fact.serviceKey === item.expectedService && fact.sentiment === "negative"
        )), `${item.name}: service concern disappeared`);
      }
      if (item.expectedTopic) {
        assert.ok(conducted.observations.some((fact) => fact.topic === item.expectedTopic),
          `${item.name}: observation disappeared`);
      }
      if (item.expectedAppreciation) {
        assert.ok(conducted.appreciations.some((fact) => fact.subject === item.expectedAppreciation),
          `${item.name}: appreciation disappeared`);
      }
    }
  });

  await scenario("response wording cannot manufacture a client concern", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const text = "The cohort model assigns converted leads to the preceding source, so the report leads us toward the opposite channel decision.";
    const conducted = {
      text: "I’m sorry this affected your decisions. We will review it carefully. Is there anything else you would like the Directors to know?",
      captured: [], observations: [], appreciations: [], answeredAnythingElse: true, readyToClose: true
    };
    const interpretation = {
      source: "gemini", intent: "feedback", sentiment: "neutral", explainsProblem: false,
      captured: [], observations: [], concerns: [], appreciations: []
    };
    conversationFlow.enrichConductedWithDeterministicFacts(
      conducted, text, project, interpretation,
      { protectSubstantiveConcern: true }
    );
    assert.strictEqual(conducted.observations.length, 0,
      "an apology written by the response model must not become evidence that the client raised a concern");

    const state = {
      pendingQuestionType: "final_sweep",
      pendingObservation: null,
      askedForAnythingElse: true,
      anythingElseAnswered: false
    };
    conversationFlow.applyConversationInterruption(
      state, { ...state }, interpretation, conducted, text
    );
    const action = conversationFlow.requiredConversationAction({
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [],
      servicesWaitingForAnythingElseAnswer: [],
      servicesNotYetDiscussedWithKeys: [],
      projectEndReviewStillNeeded: false,
      serviceScopeChoiceStillNeeded: false,
      overallRatingStillNeeded: false,
      npsStillNeeded: false
    }, state);
    assert.strictEqual(action.type, "final_sweep",
      "an ungrounded response must leave the inclusive Directors question open, not close or invent a topic");

    const positive = {
      text: "Thank you for the kind words. We will share them with the team.",
      captured: [], observations: [], appreciations: [], readyToClose: true
    };
    conversationFlow.enrichConductedWithDeterministicFacts(
      positive,
      "Everything has progressed smoothly and the team has been excellent.",
      project,
      { intent: "feedback", sentiment: "positive", explainsProblem: true },
      { protectSubstantiveConcern: true, allowLanguageOnly: true }
    );
    assert.strictEqual(positive.observations.length, 0,
      "positive feedback must not be converted into a concern by the fail-safe");
  });

  await scenario("latest-message grounding rejects fabricated labels and preserves real design feedback", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const text = "I want to talk about one more issue regarding design.";
    const interpreted = conversationFlow.groundLatestReplyInterpretation({
      source: "gemini",
      intent: "feedback",
      sentiment: "neutral",
      observations: [{
        topic: "Senior Involvement",
        detail: text,
        sentiment: "neutral",
        severity: "info",
        needsFollowUp: true,
        kind: "feedback"
      }],
      concerns: [],
      captured: [],
      appreciations: []
    }, text, project);
    assert.strictEqual(interpreted.observations.length, 1);
    assert.strictEqual(interpreted.observations[0].topic, "Creative Process",
      "a fabricated label must be replaced by a topic grounded in the latest reply");

    const conducted = {
      text: "I am sorry to hear about Senior Involvement. What happened with Senior Involvement?",
      captured: [], observations: [], appreciations: []
    };
    conversationFlow.enrichConductedWithDeterministicFacts(
      conducted, text, project, interpreted,
      { protectSubstantiveConcern: true, allowLanguageOnly: true }
    );
    assert.ok(conversationFlow.responseIntroducesUnsupportedTopic(
      conducted.text, text, project, conducted, { type: "observation_reason", topic: "Creative Process" }
    ), "an outgoing reply must not introduce an unsupported senior-involvement topic");
  });

  await scenario("requests stay grounded in the latest words and never inherit a service or meeting topic", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const cases = [
      ["There should be a weekly report sent to us about spend.", "Spend Reporting"],
      ["Could the team share regular budget updates with us?", "Spend Reporting"],
      ["Please provide a campaign dashboard every fortnight.", "Reporting"],
      ["We would like a review call next week.", "Review Meeting"]
    ];

    for (const [text, expectedTopic] of cases) {
      const interpreted = conversationFlow.groundLatestReplyInterpretation({
        source: "gemini",
        intent: "feedback",
        sentiment: "neutral",
        explainsProblem: true,
        isObservation: true,
        captured: [{
          serviceKey: "account", sentiment: "negative", summary: text,
          declined: false, needsFollowUp: false
        }],
        concerns: [{
          title: "Account Management", summary: text, sentiment: "negative",
          severity: "watch", serviceKey: "account", needsFollowUp: false
        }],
        observations: [{
          topic: "Senior Involvement", detail: text, sentiment: "neutral",
          severity: "info", needsFollowUp: false, kind: "request"
        }],
        appreciations: []
      }, text, project);

      assert.deepStrictEqual(interpreted.captured, [], `${text}: inferred service survived`);
      assert.deepStrictEqual(interpreted.concerns, [], `${text}: inferred service concern survived`);
      assert.strictEqual(interpreted.observations.length, 1, text);
      assert.strictEqual(interpreted.observations[0].topic, expectedTopic, text);
      assert.strictEqual(
        conversationFlow.canonicalObservationTopic(interpreted.observations[0], text),
        expectedTopic,
        text
      );

      assert.equal(conversationFlow.observationFromInterpretation(interpreted, text), null,
        "do not add a second observation when a grounded structured request already exists");
      const observed = interpreted.observations[0];
      assert.strictEqual(observed.topic, expectedTopic, text);
      assert.strictEqual(observed.kind, "request", text);

      const reply = conversationFlow.fallbackForAction(
        { type: "observation_followup", topic: expectedTopic },
        {
          pendingObservation: {
            topic: expectedTopic, stage: "followup", acknowledged: false,
            responseKind: "request"
          }
        },
        project,
        { observations: [observed], appreciations: [] }
      );
      assert.match(reply, /recorded your request/i, text);
      assert.doesNotMatch(reply, /meeting request|Senior Involvement|Account Management/i, text);
    }

    const mixedText = "Creative changes were not applied consistently. Please send us a weekly spend report.";
    assert.strictEqual(
      conversationFlow.canonicalObservationTopic({
        topic: "Creative Process",
        detail: "Creative changes were not applied consistently.",
        sentiment: "negative",
        kind: "feedback"
      }, mixedText),
      "Creative Process",
      "a separate reporting request must not relabel the creative concern"
    );
    assert.strictEqual(
      conversationFlow.canonicalObservationTopic({
        topic: "Spend Reporting",
        detail: "Please send us a weekly spend report.",
        sentiment: "neutral",
        kind: "request"
      }, mixedText),
      "Spend Reporting",
      "the request must retain the topic grounded in its own clause"
    );
  });

  await scenario("rating routing requires score context rather than generic correction words", async () => {
    const { detectors } = require("../src/lib/whatsapp-state-machine");
    const realCorrections = [
      "Revise the rating to 10",
      "I meant nine point five",
      "change it from 9.5 to 7",
      "10 instead of 7",
      "my score should be 8"
    ];
    const unrelated = [
      "There should be a weekly report",
      "Please update the report every 7 days",
      "Set the meeting for 10 days from now",
      "Actually, deliver the creatives in 2 days",
      "The rating process needs 2 weeks to be redesigned"
    ];
    for (const text of realCorrections) {
      assert.strictEqual(detectors.isRatingCorrectionReply(text), true, text);
    }
    for (const text of unrelated) {
      assert.strictEqual(detectors.isRatingCorrectionReply(text), false, text);
    }
    for (const text of ["Sorry, that was a mistake", "I need to correct my rating", "My score was wrong"]) {
      assert.strictEqual(detectors.isRatingCorrectionClarification(text), true, text);
    }
  });

  await scenario("rating and move-on replies cannot inherit fabricated observations", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const fabricated = () => ({
      text: "I am sorry to hear about the lack of senior involvement. What happened?",
      captured: [{
        serviceKey: "account", sentiment: "negative", summary: "Senior leader did not attend.",
        declined: false, needsFollowUp: true
      }],
      observations: [{
        topic: "Senior Involvement", detail: "A senior leader was absent from meetings.",
        sentiment: "negative", severity: "watch", needsFollowUp: true, kind: "feedback"
      }],
      appreciations: [{ subject: "Senior Leader", detail: "Helpful leadership.", serviceKey: null }],
      readyToClose: false
    });
    const hallucinatedInterpretation = {
      source: "gemini", intent: "rating", sentiment: "negative", rating: 10,
      captured: [{
        serviceKey: "account", sentiment: "negative", summary: "Leader was absent.",
        declined: false, needsFollowUp: true
      }],
      observations: [{
        topic: "Senior Involvement", detail: "Leader was absent.", sentiment: "negative",
        severity: "watch", needsFollowUp: true, kind: "feedback"
      }],
      concerns: [{
        title: "Senior Involvement", summary: "Leader was absent.", sentiment: "negative",
        severity: "watch", serviceKey: null, needsFollowUp: true
      }],
      appreciations: [{ subject: "Senior Leader", detail: "Helpful leadership.", serviceKey: null }]
    };

    for (const text of ["10", "10/10", "I would give 10 out of 10", "nothing", "nothing happened. Move on"]) {
      const conducted = fabricated();
      conversationFlow.enrichConductedWithDeterministicFacts(
        conducted, text, project, hallucinatedInterpretation,
        { protectSubstantiveConcern: true, allowLanguageOnly: true }
      );
      assert.deepStrictEqual(conducted.captured, [], `${text}: fabricated service fact survived`);
      assert.deepStrictEqual(conducted.observations, [], `${text}: fabricated observation survived`);
      assert.deepStrictEqual(conducted.appreciations, [], `${text}: fabricated appreciation survived`);
    }

    const semanticMoveOn = fabricated();
    conversationFlow.enrichConductedWithDeterministicFacts(
      semanticMoveOn, "Let's leave that subject and carry on with the survey", project,
      { ...hallucinatedInterpretation, intent: "negative", rating: null },
      { protectSubstantiveConcern: true, allowLanguageOnly: true }
    );
    assert.deepStrictEqual(semanticMoveOn.observations, [],
      "a semantically declined follow-up must not depend on an exact phrase list");

    const misreadComplaint = fabricated();
    conversationFlow.enrichConductedWithDeterministicFacts(
      misreadComplaint,
      "There is no weekly spend report and this needs to be fixed",
      project,
      {
        source: "gemini", intent: "negative", sentiment: "negative", rating: null,
        captured: [], appreciations: [], concerns: [],
        observations: [{
          topic: "Spend Reporting",
          detail: "There is no weekly spend report and this needs to be fixed",
          sentiment: "negative", severity: "watch", needsFollowUp: false,
          kind: "feedback"
        }]
      },
      { protectSubstantiveConcern: true, allowLanguageOnly: true }
    );
    assert.strictEqual(misreadComplaint.observations.length, 1,
      "a model intent label must not erase grounded substantive feedback");
    assert.strictEqual(misreadComplaint.observations[0].topic, "Spend Reporting");

    const positiveNarrative = fabricated();
    conversationFlow.enrichConductedWithDeterministicFacts(
      positiveNarrative,
      "The engagement has gone smoothly and the team has been consistently responsive.",
      project,
      { ...hallucinatedInterpretation, intent: "feedback", rating: null },
      { protectSubstantiveConcern: true, allowLanguageOnly: true }
    );
    assert.deepStrictEqual(positiveNarrative.captured, [],
      "an ungrounded service fact from model JSON must not survive a narrative reply");
    assert.deepStrictEqual(positiveNarrative.observations, [],
      "an ungrounded observation from model JSON must not survive a narrative reply");
    assert.deepStrictEqual(positiveNarrative.appreciations, [],
      "an ungrounded appreciation from model JSON must not survive a narrative reply");

    const afterNps = fabricated();
    conversationFlow.enrichConductedWithDeterministicFacts(
      afterNps, "10", project, hallucinatedInterpretation,
      { protectSubstantiveConcern: true, allowLanguageOnly: true }
    );
    const nextAfterNps = conversationFlow.requiredConversationAction({
      servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: [],
      servicesWaitingForAnythingElseAnswer: [],
      servicesNotYetDiscussedWithKeys: [],
      projectEndReviewStillNeeded: false,
      serviceScopeChoiceStillNeeded: false,
      overallRatingStillNeeded: false,
      npsStillNeeded: false
    }, { pendingObservation: null, anythingElseAnswered: false });
    assert.strictEqual(nextAfterNps.type, "final_sweep",
      "after project-end NPS, the bot must ask the inclusive Directors question—not invent an issue");

    for (const text of ["nothing", "nothing happened. Move on", "no concerns for now"]) {
      const stateBefore = {
        pendingQuestionType: "observation_reason",
        pendingObservation: {
          topic: "Senior Involvement", stage: "reason", acknowledged: false,
          responseKind: "feedback"
        }
      };
      const state = JSON.parse(JSON.stringify(stateBefore));
      conversationFlow.applyConversationInterruption(
        state, stateBefore, { intent: "negative" },
        { captured: [], observations: [], appreciations: [] }, text
      );
      assert.strictEqual(state.pendingObservation, null,
        `${text}: explicit refusal must dismiss the detail question`);
    }

    const semanticStateBefore = {
      pendingQuestionType: "observation_reason",
      pendingObservation: {
        topic: "Senior Involvement", stage: "reason", acknowledged: false,
        responseKind: "feedback"
      }
    };
    const semanticState = JSON.parse(JSON.stringify(semanticStateBefore));
    conversationFlow.applyConversationInterruption(
      semanticState, semanticStateBefore, { intent: "negative" },
      { captured: [], observations: [], appreciations: [] },
      "Let's leave that subject and carry on with the survey"
    );
    assert.strictEqual(semanticState.pendingObservation, null,
      "Gemini's semantic decline must dismiss a follow-up without exact phrase matching");
  });

  await scenario("quick check-in supplements successful Gemini output with omitted concerns", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const text = "The campaign outcomes are below expectations, the report lacks useful profile information, and we need more proactive ownership.";
    const enriched = conversationFlow.enrichQuickCheckinInterpretation(text, project, {
      source: "gemini",
      intent: "feedback",
      sentiment: "negative",
      explainsProblem: true,
      concerns: [],
      observations: [],
      appreciations: []
    });
    assert.ok(enriched.concerns.length >= 3, "all independently detectable concern categories should be preserved");
    assert.ok(enriched.concerns.some((item) => /outcomes/i.test(item.title)));
    assert.ok(enriched.concerns.some((item) => /reporting/i.test(item.title)));
    assert.ok(enriched.concerns.some((item) => /ownership/i.test(item.title)));

    const unfamiliar = conversationFlow.enrichQuickCheckinInterpretation(
      "The cohort logic attributes converted enquiries to the preceding touchpoint and sends our planning in the wrong direction.",
      project,
      {
        source: "gemini", intent: "feedback", sentiment: "negative", explainsProblem: true,
        concerns: [], captured: [], observations: [], appreciations: []
      }
    );
    assert.strictEqual(unfamiliar.concerns.length, 1,
      "an unfamiliar explained concern must not produce an empty quick-check-in record");
    assert.strictEqual(unfamiliar.concerns[0].title, "Concern requiring management review");
  });

  await scenario("polite meeting requests are not recorded as appreciations", async () => {
    const { extractExplicitAppreciations, isAppreciationActionRequest } = require("../src/lib/gemini");
    const services = [
      { serviceKey: "design", name: "Design" },
      { serviceKey: "ppc", name: "PPC / Media" }
    ];
    const request = "Social media is working well. We would appreciate a meeting with your senior management if possible.";
    assert.strictEqual(isAppreciationActionRequest(request), true);
    assert.deepStrictEqual(extractExplicitAppreciations(request, services), []);
    assert.strictEqual(
      extractExplicitAppreciations("I appreciate the creative team; the videos are fantastic.", services)[0].subject,
      "Creative Team"
    );
  });

  await scenario("a negative emoji requires a specific service explanation", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const grounded = conversationFlow.groundMultiServiceCaptures(
      [{ serviceKey: "ppc", sentiment: "negative", summary: "Thumbs down", needsFollowUp: false }],
      "👎",
      project,
      { pendingServiceKey: "ppc" }
    );
    assert.strictEqual(grounded.length, 1);
    assert.strictEqual(grounded[0].serviceKey, "ppc");
    assert.strictEqual(grounded[0].needsFollowUp, true);
  });

  await scenario("final-sweep concerns get one inclusive follow-up, not one interview per service", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const { applyCaptured, applyTurnProgress, buildChecklist } =
      require("../src/lib/whatsapp-state-machine");
    const before = {
      sessionType: "project_end",
      mentionedServices: {},
      pendingQuestionType: "final_sweep",
      askedForAnythingElse: true,
      anythingElseAnswered: false,
      overallRatingAsked: true,
      overallRating: 9,
      npsScore: 10,
      projectEndReviewCaptured: true,
      serviceScopeStatus: "overall_feedback"
    };
    const conducted = {
      captured: [
        {
          serviceKey: "ppc", sentiment: "negative",
          summary: "Creative changes required repeated follow-up", needsFollowUp: false
        },
        {
          serviceKey: "website", sentiment: "negative",
          summary: "The same changes were repeated while working on landing pages", needsFollowUp: false
        }
      ],
      observations: [],
      appreciations: [],
      answeredAnythingElse: true
    };

    const state = JSON.parse(JSON.stringify(before));
    applyCaptured(state, project, conducted.captured);
    assert.ok(Object.values(state.mentionedServices).every((service) =>
      service.status === "captured"));
    conversationFlow.settleActionableFinalSweepFacts(state, before, conducted);
    assert.ok(Object.values(state.mentionedServices).every((service) =>
      service.status === "captured" && service.serviceFollowUpAnswered === true));

    const markers = conversationFlow.validatedAnswerMarkers(
      before, conducted,
      "The agreed changes had to be repeated across creatives and landing pages.",
      { intent: "feedback" }
    );
    assert.strictEqual(markers.answeredAnythingElse, false,
      "substantive feedback should be acknowledged before the inclusive question closes");
    applyTurnProgress(state, project, markers);
    assert.strictEqual(
      conversationFlow.requiredConversationAction(buildChecklist(state, project), state).type,
      "final_sweep",
      "actionable feedback must not queue one anything-else question per service"
    );

    const afterQuestion = { ...state, pendingQuestionType: "final_sweep" };
    const noMarkers = conversationFlow.validatedAnswerMarkers(
      afterQuestion,
      { captured: [], observations: [], appreciations: [] },
      "no",
      { intent: "negative" }
    );
    applyTurnProgress(afterQuestion, project, noMarkers);
    assert.strictEqual(
      conversationFlow.requiredConversationAction(buildChecklist(afterQuestion, project), afterQuestion).type,
      "close",
      "the client's no must close instead of reopening captured services"
    );
  });

  await scenario("invoice and ledger feedback overrides an incorrect senior-involvement label", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const text = "Invoices are inaccurate; please send the ledger";
    assert.strictEqual(
      conversationFlow.canonicalObservationTopic({
        topic: "Senior Involvement",
        detail: "Please send the ledger",
        sentiment: "negative"
      }, text),
      "Billing"
    );
  });

  await scenario("stretched no replies are accepted by the machine and Gemini intent", async () => {
    const { isMoveOnReply } = require("../src/lib/whatsapp-state-machine");
    const { conversationFlow } = require("../src/server/api-handler");
    for (const answer of ["noooooo", "nopeeee", "nothinggggg"]) {
      assert.strictEqual(isMoveOnReply(answer), true, `${answer} should be accepted without Gemini`);
    }
    const markers = conversationFlow.validatedAnswerMarkers({
      pendingQuestionType: "final_sweep"
    }, { captured: [], observations: [], appreciations: [] }, "not anymor", {
      intent: "negative"
    });
    assert.strictEqual(markers.answeredAnythingElse, true,
      "Gemini's interpreted negative intent should handle wording outside deterministic rules");
  });

  await scenario("an emphatic make-it-work reply is acknowledged before moving services", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const state = {
      mentionedServices: {
        ppc: {
          serviceKey: "ppc",
          serviceName: "PPC / Media",
          sentiment: "negative",
          reasonText: "Performance is not working",
          status: "needs_service_followup",
          noteNeedsAck: true,
          issueReasonAskCount: 1
        }
      }
    };
    const reply = conversationFlow.fallbackForAction(
      { type: "service_followup", serviceKey: "ppc", name: "PPC / Media", askCount: 0 },
      state,
      project
    );
    assert.match(reply, /I hear you/i);
    assert.match(reply, /Our team will look into it/i);
    assert.match(reply, /anything else about PPC \/ Media/i);
    assert.doesNotMatch(reply, /relevant team/i);
  });

  await scenario("even neutral service feedback gets one anything-else turn", async () => {
    const { applyCaptured, applyTurnProgress, buildChecklist } =
      require("../src/lib/whatsapp-state-machine");
    const oneService = { ...project, services: [project.services[0]] };
    const state = { sessionType: "pulse", mentionedServices: {} };
    applyCaptured(state, oneService, [{
      serviceKey: "ppc", sentiment: "neutral", summary: "It is fine", needsFollowUp: false
    }]);
    assert.strictEqual(state.mentionedServices.ppc.status, "needs_service_followup");
    assert.deepStrictEqual(
      buildChecklist(state, oneService).servicesWaitingForAnythingElseAnswer,
      [{ serviceKey: "ppc", name: "PPC / Media", askCount: 0 }]
    );
    applyTurnProgress(state, oneService, { completedServiceFollowUpKeys: ["ppc"] });
    assert.strictEqual(state.mentionedServices.ppc.status, "captured");
  });

  await scenario("API flow converts legacy per-service rating state into a follow-up", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const state = {
      missingFields: ["service_rating", "overall_rating"],
      mentionedServices: {
        ppc: {
          serviceKey: "ppc",
          serviceName: "PPC / Media",
          sentiment: "positive",
          status: "needs_rating"
        }
      }
    };
    conversationFlow.normalizeLegacyServiceFollowups(state);
    assert.strictEqual(state.mentionedServices.ppc.status, "needs_service_followup");
    assert.strictEqual(state.mentionedServices.ppc.serviceFollowUpAnswered, false);
    assert.deepStrictEqual(state.missingFields, ["overall_rating", "service_followup"]);
  });

  await scenario("A named problem with no reason keeps its service open", async () => {
    const { applyCaptured, applyTurnProgress, isEverythingCovered, buildChecklist } =
      require("../src/lib/whatsapp-state-machine");

    const state = {
      sessionType: "pulse", overallRating: 7, overallRatingAsked: true,
      askedForAppreciation: true, appreciationAnswered: true,
      askedForAnythingElse: true, anythingElseAnswered: true, mentionedServices: {}
    };
    const oneService = { ...project, services: [project.services[0]] };

    // "The website needs to improve" tells a developer nothing. Acknowledging
    // it and moving on is how a whole conversation produced no actionable
    // feedback at all.
    applyCaptured(state, oneService, [{
      serviceKey: "ppc", sentiment: "negative",
      summary: "needs to improve", declined: false, needsFollowUp: true
    }]);

    assert.deepStrictEqual(
      buildChecklist(state, oneService).servicesWhereWeStillDoNotKnowWhatIsWrong,
      ["PPC / Media"]
    );
    assert.strictEqual(isEverythingCovered(state, oneService), false,
      "a complaint with no reason must not count as a finished answer");

    applyCaptured(state, oneService, [{
      serviceKey: "ppc", sentiment: "negative",
      summary: "reports arrive three days late", declined: false, needsFollowUp: false
    }]);
    assert.deepStrictEqual(
      buildChecklist(state, oneService).servicesWaitingForAnythingElseAnswer,
      [{ serviceKey: "ppc", name: "PPC / Media", askCount: 0 }]
    );
    assert.strictEqual(isEverythingCovered(state, oneService), false,
      "an actionable issue still needs the service-level anything-else answer");

    applyTurnProgress(state, oneService, { completedServiceFollowUpKeys: ["ppc"] });
    assert.strictEqual(isEverythingCovered(state, oneService), true,
      "the service is finished after the client says there is nothing else");
  });

  await scenario("cycle CSAT uses each POC's direct percentage and treats importance as a tag", async () => {
    const { aggregateCycle } = require("../src/lib/supabase-store");
    const aggregate = aggregateCycle([
      { clientPocId: "normal_1", csatScore: 0, riskLevel: "High" },
      { clientPocId: "important_1", csatScore: 10, riskLevel: "Low" },
      { clientPocId: "important_2", csatScore: 10, riskLevel: "Low" },
      { clientPocId: "important_3", csatScore: 10, riskLevel: "Low" },
      { clientPocId: "important_4", csatScore: 10, riskLevel: "Low" }
    ], [
      { id: "normal_1", levelId: "normal", levelName: "Normal", weightPercentage: 40 },
      { id: "important_1", levelId: "important", levelName: "Important", weightPercentage: 15 },
      { id: "important_2", levelId: "important", levelName: "Important", weightPercentage: 15 },
      { id: "important_3", levelId: "important", levelName: "Important", weightPercentage: 15 },
      { id: "important_4", levelId: "important", levelName: "Important", weightPercentage: 15 }
    ]);
    assert.strictEqual(aggregate.csatScore, 6);
    assert.strictEqual(aggregate.weightResponded, 1);
    assert.strictEqual(aggregate.pocResponded, 5);
  });

  await scenario("legacy POCs without individual percentages fall back to equal influence", async () => {
    const { aggregateCycle } = require("../src/lib/supabase-store");
    const aggregate = aggregateCycle([
      { clientPocId: "normal_1", csatScore: 8, riskLevel: "Low" },
      { clientPocId: "normal_2", csatScore: 6, riskLevel: "Watch" }
    ], [
      { id: "normal_1", levelId: "normal", levelName: "Normal", weight: 40 },
      { id: "normal_2", levelId: "normal", levelName: "Normal", weight: 40 }
    ]);
    assert.strictEqual(aggregate.csatScore, 7);
    assert.strictEqual(aggregate.weightResponded, 1);
  });

  await scenario("partial response coverage uses the responder's direct percentage", async () => {
    const { aggregateCycle } = require("../src/lib/supabase-store");
    const aggregate = aggregateCycle([
      { clientPocId: "normal_1", csatScore: null, riskLevel: null },
      { clientPocId: "normal_2", csatScore: null, riskLevel: null },
      { clientPocId: "important_1", csatScore: 8, riskLevel: "Watch" }
    ], [
      { id: "normal_1", levelId: "normal", levelName: "Normal", weightPercentage: 20 },
      { id: "normal_2", levelId: "normal", levelName: "Normal", weightPercentage: 20 },
      { id: "important_1", levelId: "important", levelName: "Important", weightPercentage: 60 }
    ]);
    assert.strictEqual(aggregate.csatScore, 8);
    assert.strictEqual(aggregate.weightResponded, 0.6);
    assert.strictEqual(aggregate.pocResponded, 1);
  });

  await scenario("saving POC group percentages updates the lookup and clears its cache", async () => {
    const { SupabaseStore } = require("../src/lib/supabase-store");
    const levelStore = Object.create(SupabaseStore.prototype);
    const rows = [
      { id: "normal", name: "Normal", weight: 40 },
      { id: "important", name: "Important", weight: 60 }
    ];
    const patches = [];
    levelStore._levels = new Map(rows.map((row) => [row.id, row]));
    levelStore.request = async (table, options) => {
      assert.strictEqual(table, "poc_levels");
      if (!options.method) return rows;
      const id = decodeURIComponent(options.query.replace("id=eq.", ""));
      patches.push({ id, weight: options.body.weight });
      return [{ ...rows.find((row) => row.id === id), weight: options.body.weight }];
    };

    const result = await levelStore.updatePocLevelWeights([
      { id: "normal", weight: 35 },
      { id: "important", weight: 65 }
    ]);
    assert.strictEqual(result.status, "updated");
    assert.deepStrictEqual(patches, [
      { id: "normal", weight: 35 },
      { id: "important", weight: 65 }
    ]);
    assert.strictEqual(levelStore._levels, null);
  });

  await scenario("six-hour completion accepts an existing monthly final-sweep session", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const question = "Before we finish, is there anything else you would like the Directors to know—such as an issue, an area for improvement, or any appreciation you would like us to record? If not, just reply no.";
    const session = {
      id: "sess_existing_final",
      sessionType: "pulse",
      status: "partial",
      completionStatus: "partial",
      csatScore: 8,
      csatSource: "stated",
      lastClientResponseAt: "2026-10-01T00:00:00.000Z",
      conversationState: {
        sessionType: "pulse",
        state: "waiting_for_more_services",
        pendingQuestionType: "final_sweep",
        askedForAnythingElse: true,
        anythingElseAnswered: false,
        overallRating: 8,
        lastQuestionAsked: question
      }
    };
    const messages = [
      { side: "client", body: "8", createdAt: "2026-10-01T00:00:00.000Z" },
      { side: "srv", body: question, createdAt: "2026-10-01T00:00:05.000Z" }
    ];
    const eligible = conversationFlow.inactiveFinalSweepEligibility(
      session,
      messages,
      "2026-10-01T06:01:00.000Z"
    );
    assert.strictEqual(eligible.eligible, true);
    assert.strictEqual(eligible.reason, "due");
    assert.strictEqual(eligible.dueAt, "2026-10-01T06:00:05.000Z");

    const ignoredAutoReply = conversationFlow.inactiveFinalSweepEligibility(
      session,
      [
        ...messages,
        {
          side: "client",
          body: "Thank you for contacting us. Please let us know how we can help you.",
          createdAt: "2026-10-01T01:00:00.000Z",
          metadata: { automatedReply: true, ignoredForConversation: true }
        }
      ],
      "2026-10-01T06:01:00.000Z"
    );
    assert.strictEqual(ignoredAutoReply.eligible, true,
      "an ignored automated greeting must not block the normal six-hour completion rule");

    const legacyQuestion = "Is there any specific team or department you would like to appreciate for their work?";
    const legacyAppreciation = conversationFlow.inactiveFinalSweepEligibility({
      ...session,
      conversationState: {
        ...session.conversationState,
        pendingQuestionType: "appreciation",
        askedForAnythingElse: false,
        askedForAppreciation: true,
        appreciationAnswered: false,
        lastQuestionAsked: legacyQuestion
      }
    }, [
      messages[0],
      { side: "srv", body: legacyQuestion, createdAt: "2026-10-01T00:00:05.000Z" }
    ], "2026-10-01T06:01:00.000Z");
    assert.strictEqual(legacyAppreciation.eligible, true,
      "an already-open legacy optional appreciation prompt must also time out safely");

    const closing = conversationFlow.inactiveFinalSweepEligibility({
      ...session,
      conversationState: {
        ...session.conversationState,
        state: "closing_grace",
        closingGraceExpiresAt: "2026-10-01T06:11:00.000Z"
      }
    }, messages, "2026-10-01T06:01:00.000Z");
    assert.strictEqual(closing.eligible, false);
    assert.strictEqual(closing.reason, "already_completed_or_claimed",
      "the normal thank-you path must block the fallback send");
  });

  await scenario("six-hour completion requires project-end NPS and respects client replies", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const question = "Before we finish, is there anything else you would like the Directors to know? If not, just reply no.";
    const base = {
      id: "sess_project_end_final",
      sessionType: "project_end",
      csatScore: 8,
      csatSource: "stated",
      lastClientResponseAt: "2026-10-01T00:00:00.000Z",
      conversationState: {
        state: "waiting_for_more_services",
        pendingQuestionType: "final_sweep",
        askedForAnythingElse: true,
        anythingElseAnswered: false,
        overallRating: 8,
        lastQuestionAsked: question
      }
    };
    const messages = [
      { side: "client", body: "8", createdAt: "2026-10-01T00:00:00.000Z" },
      { side: "srv", body: question, createdAt: "2026-10-01T00:00:05.000Z" }
    ];
    const missingNps = conversationFlow.inactiveFinalSweepEligibility(
      base,
      messages,
      "2026-10-01T07:00:00.000Z"
    );
    assert.strictEqual(missingNps.eligible, false);
    assert.strictEqual(missingNps.reason, "mandatory_score_missing");

    const withNps = {
      ...base,
      npsScore: 9,
      npsSource: "stated",
      conversationState: { ...base.conversationState, npsScore: 9 }
    };
    assert.strictEqual(conversationFlow.inactiveFinalSweepEligibility(
      withNps,
      messages,
      "2026-10-01T07:00:00.000Z"
    ).eligible, true);
    const replied = conversationFlow.inactiveFinalSweepEligibility(
      withNps,
      [...messages, { side: "client", body: "One more point", createdAt: "2026-10-01T01:00:00.000Z" }],
      "2026-10-01T07:00:00.000Z"
    );
    assert.strictEqual(replied.eligible, false);
    assert.strictEqual(replied.reason, "client_replied_after_final_sweep");
  });

  await scenario("six-hour completion never sends free text outside WhatsApp's service window", async () => {
    const { conversationFlow } = require("../src/server/api-handler");
    const question = "Before we finish, is there anything else you would like the Directors to know? If not, just reply no.";
    const assessment = conversationFlow.inactiveFinalSweepEligibility({
      id: "sess_old_final",
      sessionType: "pulse",
      csatScore: 7,
      csatSource: "stated",
      lastClientResponseAt: "2026-09-29T00:00:00.000Z",
      conversationState: {
        state: "waiting_for_more_services",
        pendingQuestionType: "final_sweep",
        askedForAnythingElse: true,
        anythingElseAnswered: false,
        overallRating: 7,
        lastQuestionAsked: question
      }
    }, [
      { side: "client", body: "7", createdAt: "2026-09-29T00:00:00.000Z" },
      { side: "srv", body: question, createdAt: "2026-09-29T00:00:05.000Z" }
    ], "2026-10-01T00:00:06.000Z");
    assert.strictEqual(assessment.eligible, false);
    assert.strictEqual(assessment.closeWithoutMessage, true);
    assert.strictEqual(assessment.reason, "outside_whatsapp_service_window");
  });

  await scenario("six-hour scheduler sends once and repeated scans cannot duplicate it", async () => {
    const priorWebhook = process.env.N8N_MANUAL_MESSAGE_WEBHOOK;
    const priorSecret = process.env.N8N_WEBHOOK_SECRET;
    const priorFetch = global.fetch;
    const priorSession = store._session;
    const priorCandidates = store._inactiveFinalSweepCandidates;
    const priorMessages = [...calls.messages];
    const priorClaims = new Map(calls.automationClaims);
    const sends = [];
    const question = "Before we finish, is there anything else you would like the Directors to know—such as an issue, an area for improvement, or any appreciation you would like us to record? If not, just reply no.";
    process.env.N8N_MANUAL_MESSAGE_WEBHOOK = "https://n8n.example.test/webhook/csat-manual-whatsapp-message";
    process.env.N8N_WEBHOOK_SECRET = "six-hour-secret";
    calls.messages.length = 0;
    calls.messages.push(
      { id: "msg_rating", sessionId: "sess_six_hour", side: "client", body: "8", createdAt: "2026-10-01T00:00:00.000Z" },
      { id: "msg_final", sessionId: "sess_six_hour", side: "srv", body: question, createdAt: "2026-10-01T00:00:05.000Z" }
    );
    store._session = {
      id: "sess_six_hour", cycleId: "cyc_six_hour", projectId: project.id,
      clientPocId: poc.id, status: "partial", completionStatus: "partial",
      sessionType: "pulse", csatScore: 8, csatSource: "stated",
      lastClientResponseAt: "2026-10-01T00:00:00.000Z",
      reminderDueAt: "2026-10-02T00:00:00.000Z",
      conversationState: {
        sessionType: "pulse",
        state: "waiting_for_more_services",
        pendingQuestionType: "final_sweep",
        askedForAnythingElse: true,
        anythingElseAnswered: false,
        overallRating: 8,
        lastQuestionAsked: question
      }
    };
    store._inactiveFinalSweepCandidates = [store._session];
    calls.automationClaims.delete("six_hour_completion:sess_six_hour");
    global.fetch = async (url, options) => {
      sends.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    };
    try {
      const first = await rawReq("POST", "/api/automation/complete-inactive-final-responses", {
        now: "2026-10-01T06:01:00.000Z"
      }, { "x-csat-webhook-secret": "six-hour-secret" });
      const firstPayload = JSON.parse(first.body);
      assert.strictEqual(first.statusCode, 200);
      assert.strictEqual(firstPayload.sent.length, 1);
      assert.strictEqual(sends.length, 1);
      assert.strictEqual(sends[0].body.eventType, "manual_whatsapp_message");
      assert.match(sends[0].body.text, /remain active for the next 10 minutes/i);
      assert.strictEqual(store._session.conversationState.state, "closing_grace");
      assert.ok(store._session.conversationState.sixHourAutoCompletionSentAt);
      assert.strictEqual(
        calls.messages.filter((message) => message.metadata?.source === "six_hour_final_response_completion").length,
        1
      );

      store._inactiveFinalSweepCandidates = [store._session];
      const second = await rawReq("POST", "/api/automation/complete-inactive-final-responses", {
        now: "2026-10-01T06:02:00.000Z"
      }, { "x-csat-webhook-secret": "six-hour-secret" });
      const secondPayload = JSON.parse(second.body);
      assert.strictEqual(second.statusCode, 200);
      assert.strictEqual(secondPayload.sent.length, 0);
      assert.strictEqual(sends.length, 1, "the thank-you message must never be sent twice");
    } finally {
      if (priorWebhook === undefined) delete process.env.N8N_MANUAL_MESSAGE_WEBHOOK;
      else process.env.N8N_MANUAL_MESSAGE_WEBHOOK = priorWebhook;
      if (priorSecret === undefined) delete process.env.N8N_WEBHOOK_SECRET;
      else process.env.N8N_WEBHOOK_SECRET = priorSecret;
      global.fetch = priorFetch;
      store._session = priorSession;
      store._inactiveFinalSweepCandidates = priorCandidates;
      calls.messages.length = 0;
      calls.messages.push(...priorMessages);
      calls.automationClaims.clear();
      for (const [key, value] of priorClaims) calls.automationClaims.set(key, value);
    }
  });

  await scenario("expired automatic correction windows are finalized without another message", async () => {
    const provider = Object.create(SupabaseStore.prototype);
    const row = {
      id: "sess_expired_auto", cycle_id: "cyc_1", project_id: project.id,
      client_poc_id: poc.id, status: "completed", completion_status: "completed",
      conversation_state: {
        state: "closing_grace",
        sixHourAutoCompletionSentAt: "2026-10-01T06:00:00.000Z",
        closingGraceExpiresAt: "2026-10-01T06:10:00.000Z"
      },
      completed_at: "2026-10-01T06:00:00.000Z",
      feedback_cycles: { cycle_type: "pulse" }
    };
    let savedState = null;
    let recomputed = false;
    provider.recomputeCycle = async () => { recomputed = true; };
    provider.request = async (table, options) => {
      assert.strictEqual(table, "feedback_sessions");
      if (!options.method) return [row];
      savedState = options.body.conversation_state;
      return [{ ...row, conversation_state: savedState }];
    };
    const closed = await provider.finalizeExpiredInactiveFinalSweeps("2026-10-01T06:11:00.000Z");
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(savedState.state, "completed");
    assert.strictEqual(savedState.closureReason, "final_sweep_inactive_six_hours");
    assert.equal(recomputed, true);
  });

  let failed = 0;
  for (const [status, name, message] of results) {
    if (status === "FAIL") failed += 1;
    console.log(`${status}  ${name}${message ? `\n      ${message}` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} API scenarios passed`);
  process.exit(failed ? 1 : 0);
})();
