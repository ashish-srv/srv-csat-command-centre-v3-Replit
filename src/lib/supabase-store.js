const { statusFromScore } = require("./analysis");

const MAX_REMINDERS = 3;
const REMINDER_INTERVAL_HOURS = 24;

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required when DATA_PROVIDER=supabase`);
  }
  return process.env[name];
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function quickCheckinScheduleKey(nowIso = new Date().toISOString()) {
  const date = new Date(nowIso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  if (!["11", "21"].includes(parts.day)) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function firstPulseDueAt(startDate, intervalDays = 30) {
  const start = startDate
    ? new Date(`${String(startDate).slice(0, 10)}T00:00:00.000Z`)
    : new Date();
  const safeStart = Number.isNaN(start.getTime()) ? new Date() : start;
  return addDays(safeStart, Number(intervalDays) || 30);
}

function digits(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function num(value) {
  return value === null || value === undefined ? null : Number(value);
}

function readsAsExplicitAppreciation(value) {
  return /\b(?:appreciat\w*|kudos|praise|commend\w*|well done|(?:great|good) job|fantastic|excellent|amazing|outstanding|exceptional|impressed|love(?:d)?|very happy|delighted)\b/i
    .test(String(value || ""));
}

function reminderLoopExhausted(session) {
  return Boolean(session && session.conversationState && session.conversationState.reminderExhausted);
}

function sessionIsTerminal(session) {
  if (!session) return false;
  const state = (session.conversationState && session.conversationState.state) || "";
  return ["completed", "opted_out"].includes(session.status)
    || ["completed", "opted_out", "handed_off"].includes(state)
    || reminderLoopExhausted(session);
}

// ---------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------

function toInternalPoc(row, manager = null) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    clusterId: row.cluster_id,
    departmentId: row.department_id,
    subDepartmentId: row.sub_department_id,
    reportingManagerId: row.reporting_manager_id,
    manager: manager
      ? { id: manager.id, name: manager.name, email: manager.email, phone: manager.phone }
      : null
  };
}

function toInternalPocRow(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    clusterId: row.cluster_id,
    departmentId: row.department_id,
    subDepartmentId: row.sub_department_id,
    reportingManagerId: row.reporting_manager_id,
    active: row.active
  };
}

function toClientPoc(row, level = null) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    designation: row.designation,
    contactWhatsapp: row.contact_whatsapp,
    contactEmail: row.contact_email,
    birthDate: row.birth_date,
    salutation: row.salutation || row.name,
    honorific: row.honorific,
    active: row.active,
    levelId: row.poc_level_id,
    levelName: level ? level.name : null,
    weight: level ? Number(level.weight) : 1,
    weightPercentage: num(row.weight_percentage)
  };
}

function toService(row, owner = null) {
  return {
    id: row.id,
    projectId: row.project_id,
    serviceKey: row.service_key,
    name: row.name,
    kpis: row.kpis || null,
    score: num(row.score),
    status: row.status,
    pulse: row.pulse,
    ownerAction: row.owner_action,
    internalPocId: row.internal_poc_id,
    serviceCatalogId: row.service_catalog_id || null,
    ownerName: owner ? owner.name : null,
    ownerEmail: owner ? owner.email : null,
    managerEmail: owner && owner.manager ? owner.manager.email : null,
    managerName: owner && owner.manager ? owner.manager.name : null
  };
}

function toProject(row, extra = {}) {
  return {
    id: row.id,
    clientId: row.client_id,
    key: row.project_key,
    name: row.name,
    goal: row.goal,
    activeStatus: row.active_status,
    startDate: row.start_date,
    endDate: row.end_date,
    feedbackIntervalDays: row.feedback_interval_days,
    lastCycleStartedAt: row.last_cycle_started_at,
    nextCycleDueAt: row.next_cycle_due_at,
    endFeedbackRequestedAt: row.end_feedback_requested_at,
    csatScore: num(row.csat_score),
    clientActiveStatus: extra.clientActiveStatus || null,
    healthScore: num(row.health_score),
    npsScore: num(row.nps_score),
    riskLevel: row.risk_level,
    rootCause: row.root_cause,
    clientName: extra.clientName || null,
    clientKey: extra.clientKey || null,
    clusterId: extra.clusterId || null,
    clusterName: extra.clusterName || null,
    services: extra.services || [],
    pocs: extra.pocs || []
  };
}

function toCycle(row) {
  return {
    scheduleKey: row.schedule_key || null,
    id: row.id,
    projectId: row.project_id,
    cycleType: row.cycle_type,
    status: row.status,
    startedAt: row.started_at,
    closedAt: row.closed_at,
    csatScore: num(row.csat_score),
    npsScore: num(row.nps_score),
    riskLevel: row.risk_level,
    weightResponded: num(row.weight_responded),
    pocTotal: row.poc_total,
    pocResponded: row.poc_responded
  };
}

function toSession(row, extra = {}) {
  const conversationState = row.conversation_state || null;
  const snapshottedWeight = num(conversationState?.pocWeightPercentage);
  return {
    id: row.id,
    npsSource: row.nps_source || null,
    predictedCsat: num(row.predicted_csat),
    predictedConfidence: row.predicted_confidence === null || row.predicted_confidence === undefined
      ? null
      : Number(row.predicted_confidence),
    predictedReasoning: row.predicted_reasoning || null,
    predictedSignals: row.predicted_signals || [],
    csatSource: row.csat_source || null,
    tone: row.tone || null,
    toneReason: row.tone_reason || null,
    toneSource: row.tone_source || null,
    cycleId: row.cycle_id,
    clientPocId: row.client_poc_id,
    projectId: row.project_id,
    status: row.status,
    completionStatus: row.completion_status,
    conversationState,
    channel: row.channel,
    startedAt: row.started_at,
    lastClientResponseAt: row.last_client_response_at,
    reminderDueAt: row.reminder_due_at,
    reminderCount: row.reminder_count,
    csatScore: num(row.csat_score),
    npsScore: num(row.nps_score),
    riskLevel: row.risk_level,
    focusService: row.focus_service,
    rootCause: row.root_cause,
    completedAt: row.completed_at,
    sessionType: extra.cycleType || null,
    pocName: extra.pocName || null,
    pocWeight: snapshottedWeight ?? (extra.pocWeight === undefined ? null : extra.pocWeight)
  };
}

function toMessage(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    speaker: row.speaker,
    side: row.side,
    body: row.body,
    providerMessageId: row.provider_message_id,
    metadata: row.metadata,
    createdAt: row.created_at
  };
}

function toIssue(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    clientPocId: row.client_poc_id,
    serviceKey: row.service_key,
    serviceName: row.service_name,
    severity: row.severity,
    status: row.status,
    title: row.title,
    rootCause: row.root_cause,
    internalPocId: row.internal_poc_id,
    sla: row.sla,
    dueAt: row.due_at,
    resolutionNote: row.resolution_note,
    reopenReason: row.reopen_reason,
    closedAt: row.closed_at,
    reopenedAt: row.reopened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toIssueEvent(row) {
  return {
    id: row.id,
    issueId: row.issue_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    action: row.action,
    previousStatus: row.previous_status,
    nextStatus: row.next_status,
    note: row.note,
    actorName: row.actor_name,
    createdAt: row.created_at
  };
}

// ---------------------------------------------------------------------
// Weighted aggregation (Option B)
//  - score is the weighted average across POCs who actually responded
//  - weightResponded reports how much of the project's total weight
//    that represents, so the UI can show "2 of 3 POCs - 67% weight"
// ---------------------------------------------------------------------

/**
 * Net Promoter Score, calculated properly.
 *
 * NPS is NOT an average of the 0-10 answers — it is the percentage of
 * promoters minus the percentage of detractors, on a -100..+100 scale.
 * Averaging the raw answers produces a number that looks like NPS, sits in
 * the wrong range, and cannot be compared with anyone else's NPS.
 *
 * Deliberately unweighted: NPS counts people, not influence. Applying POC
 * weights here would depart from the standard definition and make the figure
 * incomparable — the weighting belongs on CSAT, where it already is.
 */
function netPromoterScore(scores) {
  const answers = scores.filter((value) => value !== null && value !== undefined);
  if (!answers.length) {
    return { score: null, promoters: 0, passives: 0, detractors: 0, responses: 0 };
  }

  const promoters = answers.filter((value) => value >= 9).length;
  const detractors = answers.filter((value) => value <= 6).length;
  const passives = answers.length - promoters - detractors;

  return {
    score: Math.round(((promoters - detractors) / answers.length) * 100),
    promoters,
    passives,
    detractors,
    responses: answers.length
  };
}

// Retain the export name for compatibility with existing tests and callers.
// The values are now direct per-POC percentages; Normal/Important no longer
// changes the calculation. Missing legacy values fall back to equal influence.
function groupAllocationWeights(allPocs) {
  const totalAllocation = allPocs.reduce(
    (sum, poc) => sum + Math.max(0, Number(poc.weightPercentage) || 0),
    0
  );
  const weights = new Map();
  if (!allPocs.length) return weights;
  if (!totalAllocation) {
    const equalWeight = 1 / allPocs.length;
    for (const poc of allPocs) weights.set(poc.id, equalWeight);
    return weights;
  }
  for (const poc of allPocs) {
    weights.set(poc.id, Math.max(0, Number(poc.weightPercentage) || 0) / totalAllocation);
  }
  return weights;
}

/**
 * Apply each POC's explicit percentage. Percentages are normalized defensively
 * for historical data, while Manage and Excel require active POCs to total 100%.
 */
function aggregateCycle(sessions, allPocs) {
  const responded = sessions.filter((s) => s.csatScore !== null && s.csatScore !== undefined);
  const effectiveWeights = groupAllocationWeights(allPocs);
  const fallbackWeight = allPocs.length ? 1 / allPocs.length : 1;
  const sessionWeight = (session) => effectiveWeights.get(session.clientPocId) ?? fallbackWeight;
  const totalWeight = [...effectiveWeights.values()].reduce((sum, weight) => sum + weight, 0) || 1;
  const respondedWeight = responded.reduce((sum, session) => sum + sessionWeight(session), 0);

  if (!responded.length) {
    return {
      csatScore: null,
      npsScore: null,
      riskLevel: null,
      weightResponded: 0,
      pocResponded: 0,
      pocTotal: allPocs.length
    };
  }

  const csat =
    responded.reduce((sum, session) => sum + session.csatScore * sessionWeight(session), 0) / (respondedWeight || 1);

  // Every session that answered the NPS question, whether or not it produced
  // a CSAT — someone can decline to rate and still say they would recommend us.
  const nps = netPromoterScore(sessions.map((s) => s.npsScore));

  const rank = { High: 3, Watch: 2, Low: 1 };
  const worst = responded
    .map((s) => s.riskLevel)
    .reduce((acc, level) => ((rank[level] || 0) > (rank[acc] || 0) ? level : acc), "Low");

  return {
    csatScore: Math.round(csat * 10) / 10,
    npsScore: nps.score,
    npsResponses: nps.responses,
    npsPromoters: nps.promoters,
    npsPassives: nps.passives,
    npsDetractors: nps.detractors,
    riskLevel: worst,
    weightResponded: Math.round((respondedWeight / totalWeight) * 100) / 100,
    pocResponded: responded.length,
    pocTotal: allPocs.length
  };
}

class SupabaseStore {
  constructor(options = {}) {
    if (options.skipEnv) return;
    this.url = requireEnv("SUPABASE_URL").replace(/\/$/, "");
    this.key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  }

  async request(table, options = {}) {
    const query = options.query ? `?${options.query}` : "";
    const response = await fetch(`${this.url}/rest/v1/${table}${query}`, {
      method: options.method || "GET",
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
        prefer: options.prefer || "return=representation"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase ${table} request failed: ${response.status} ${text}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  // -------------------------------------------------------------------
  // Reference lookups
  // -------------------------------------------------------------------

  async pocLevels() {
    if (!this._levels) {
      const rows = await this.request("poc_levels", { query: "select=*" });
      this._levels = new Map(rows.map((row) => [row.id, row]));
    }
    return this._levels;
  }

  async internalPocById(internalPocId) {
    if (!internalPocId) return null;
    const rows = await this.request("internal_pocs", {
      query: `id=eq.${encodeURIComponent(internalPocId)}&select=*&limit=1`
    });
    if (!rows.length) return null;
    let manager = null;
    if (rows[0].reporting_manager_id) {
      const managerRows = await this.request("internal_pocs", {
        query: `id=eq.${encodeURIComponent(rows[0].reporting_manager_id)}&select=*&limit=1`
      });
      manager = managerRows[0] || null;
    }
    return toInternalPoc(rows[0], manager);
  }

  async servicesForProject(projectId) {
    const rows = await this.request("project_services", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&order=name.asc`
    });
    const owners = new Map();
    for (const row of rows) {
      if (row.internal_poc_id && !owners.has(row.internal_poc_id)) {
        owners.set(row.internal_poc_id, await this.internalPocById(row.internal_poc_id));
      }
    }
    return rows.map((row) => toService(row, owners.get(row.internal_poc_id) || null));
  }

  async pocsForProject(projectId, { activeOnly = true } = {}) {
    const levels = await this.pocLevels();
    const activeFilter = activeOnly ? "&active=is.true" : "";
    const rows = await this.request("client_pocs", {
      query: `project_id=eq.${encodeURIComponent(projectId)}${activeFilter}&order=name.asc`
    });
    return rows.map((row) => toClientPoc(row, levels.get(row.poc_level_id) || null));
  }

  // -------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------

  projectExtras(row) {
    return {
      clientName: row.clients ? row.clients.name : null,
      clientKey: row.clients ? row.clients.client_key : null,
      clusterId: row.clients && row.clients.clusters ? row.clients.clusters.id : null,
      clientActiveStatus: row.clients ? row.clients.active_status : null,
      clusterName: row.clients && row.clients.clusters ? row.clients.clusters.name : null
    };
  }

  async listProjects() {
    const rows = await this.request("projects", {
      query: "select=*,clients(id,client_key,name,cluster_id,active_status,clusters(id,name))&order=name.asc"
    });
    return rows.map((row) => toProject(row, this.projectExtras(row)));
  }

  async getProjectRow(value, byId = false) {
    const field = byId ? "id" : "project_key";
    const rows = await this.request("projects", {
      query: `${field}=eq.${encodeURIComponent(value)}&select=*,clients(id,client_key,name,cluster_id,active_status,clusters(id,name))&limit=1`
    });
    return rows[0] || null;
  }

  async hydrateProject(row) {
    if (!row) return null;
    return toProject(row, {
      ...this.projectExtras(row),
      services: await this.servicesForProject(row.id),
      pocs: await this.pocsForProject(row.id)
    });
  }

  async getProject(projectKey) {
    return this.hydrateProject(await this.getProjectRow(projectKey));
  }

  async getProjectById(projectId) {
    return this.hydrateProject(await this.getProjectRow(projectId, true));
  }

  // -------------------------------------------------------------------
  // POC / session lookup (inbound WhatsApp)
  // -------------------------------------------------------------------

  async getPocByWhatsapp(phone) {
    const pocs = await this.getPocsByWhatsapp(phone);
    return pocs[0] || null;
  }

  async getPocsByWhatsapp(phone) {
    const normalized = digits(phone);
    if (!normalized) return [];
    const levels = await this.pocLevels();
    const rows = await this.request("client_pocs", {
      query: `contact_whatsapp=eq.${encodeURIComponent(normalized)}&active=is.true&select=*&order=updated_at.desc&limit=20`
    });
    return rows.map((row) => toClientPoc(row, levels.get(row.poc_level_id) || null));
  }

  async getActiveSessionForPoc(clientPocId) {
    const rows = await this.request("feedback_sessions", {
      query: `client_poc_id=eq.${encodeURIComponent(clientPocId)}&status=in.(started,partial,no_response)&select=*,feedback_cycles(cycle_type)&order=started_at.desc&limit=1`
    });
    if (!rows.length) return null;
    const session = toSession(rows[0], {
      cycleType: rows[0].feedback_cycles ? rows[0].feedback_cycles.cycle_type : null
    });
    return sessionIsTerminal(session) ? null : session;
  }

  async getLatestSessionForPoc(clientPocId) {
    const rows = await this.request("feedback_sessions", {
      query: `client_poc_id=eq.${encodeURIComponent(clientPocId)}&select=*,feedback_cycles(cycle_type)&order=started_at.desc&limit=1`
    });
    if (!rows.length) return null;
    return toSession(rows[0], {
      cycleType: rows[0].feedback_cycles ? rows[0].feedback_cycles.cycle_type : null
    });
  }

  /**
   * One client contact may represent several projects. Route their WhatsApp
   * reply to the only open session across those project-specific POC rows.
   */
  async getWhatsappRoutingContext(phone) {
    const pocs = await this.getPocsByWhatsapp(phone);
    if (!pocs.length) return { status: "not_found", poc: null, session: null };

    const activePairs = [];
    for (const poc of pocs) {
      const session = await this.getActiveSessionForPoc(poc.id);
      if (session) activePairs.push({ poc, session });
    }
    if (activePairs.length > 1) {
      return { status: "ambiguous", candidates: activePairs, poc: null, session: null };
    }
    if (activePairs.length === 1) return { status: "active", ...activePairs[0] };

    const latestPairs = [];
    for (const poc of pocs) {
      const session = await this.getLatestSessionForPoc(poc.id);
      if (session) latestPairs.push({ poc, session });
    }
    latestPairs.sort((left, right) =>
      new Date(right.session.startedAt || 0).getTime() - new Date(left.session.startedAt || 0).getTime()
    );
    return latestPairs.length
      ? { status: "latest", ...latestPairs[0] }
      : { status: "no_session", poc: pocs[0], session: null };
  }

  async getSession(sessionId) {
    const rows = await this.request("feedback_sessions", {
      query: `id=eq.${encodeURIComponent(sessionId)}&select=*,feedback_cycles(cycle_type),client_pocs(name,salutation,honorific,poc_level_id,weight_percentage)&limit=1`
    });
    if (!rows.length) return null;
    const poc = rows[0].client_pocs;
    return toSession(rows[0], {
      cycleType: rows[0].feedback_cycles ? rows[0].feedback_cycles.cycle_type : null,
      pocName: poc ? poc.name : null,
      pocWeight: poc ? num(poc.weight_percentage) : null
    });
  }

  async getClientPocById(clientPocId) {
    const levels = await this.pocLevels();
    const rows = await this.request("client_pocs", {
      query: `id=eq.${encodeURIComponent(clientPocId)}&select=*&limit=1`
    });
    if (!rows.length) return null;
    return toClientPoc(rows[0], levels.get(rows[0].poc_level_id) || null);
  }

  async getMessagesForSession(sessionId) {
    const rows = await this.request("messages", {
      query: `session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc`
    });
    return rows.map(toMessage);
  }

  /**
   * Permanently remove only the visible transcript for a project.
   *
   * Sessions are deliberately retained: their client rating, predicted score,
   * conversation state, cycle membership and every derived record live outside
   * `messages`. This is a transcript cleanup operation, not a history reset.
   */
  async clearProjectMessages(projectId, cycleIds = []) {
    const selectedCycleIds = [...new Set(cycleIds.filter(Boolean))];
    if (!selectedCycleIds.length) {
      return { messagesDeleted: 0, sessionsAffected: 0, cyclesAffected: 0 };
    }
    const encodedCycleIds = selectedCycleIds.map((id) => encodeURIComponent(id));
    const sessions = await this.request("feedback_sessions", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&cycle_id=in.(${encodedCycleIds.join(",")})&select=id`
    });
    const sessionIds = sessions.map((row) => row.id).filter(Boolean);
    let messagesDeleted = 0;

    // Keep PostgREST URLs bounded for projects with a long feedback history.
    for (let index = 0; index < sessionIds.length; index += 100) {
      const ids = sessionIds.slice(index, index + 100).map((id) => encodeURIComponent(id));
      const deleted = await this.request("messages", {
        method: "DELETE",
        query: `session_id=in.(${ids.join(",")})&select=id`,
        prefer: "return=representation"
      });
      messagesDeleted += Array.isArray(deleted) ? deleted.length : 0;
    }

    return {
      messagesDeleted,
      sessionsAffected: sessionIds.length,
      cyclesAffected: selectedCycleIds.length
    };
  }

  /** Delete selected project issues and their status-change audit rows. */
  async deleteProjectIssues(projectId, issueIds = []) {
    const selectedIssueIds = [...new Set(issueIds.filter(Boolean))];
    if (!selectedIssueIds.length) return { issuesDeleted: 0, issueEventsDeleted: 0 };
    const encodedSelectedIds = selectedIssueIds.map((id) => encodeURIComponent(id));
    const issues = await this.request("issues", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&id=in.(${encodedSelectedIds.join(",")})&select=id`
    });
    const matchedIssueIds = issues.map((row) => row.id).filter(Boolean);
    let issueEventsDeleted = 0;

    // Delete child rows explicitly instead of depending on an installation's
    // foreign-key cascade configuration.
    for (let index = 0; index < matchedIssueIds.length; index += 100) {
      const ids = matchedIssueIds.slice(index, index + 100).map((id) => encodeURIComponent(id));
      const deletedEvents = await this.request("issue_events", {
        method: "DELETE",
        query: `issue_id=in.(${ids.join(",")})&select=id`,
        prefer: "return=representation"
      });
      issueEventsDeleted += Array.isArray(deletedEvents) ? deletedEvents.length : 0;
    }

    if (matchedIssueIds.length) {
      await this.request("issues", {
        method: "DELETE",
        query: `project_id=eq.${encodeURIComponent(projectId)}&id=in.(${matchedIssueIds.map((id) => encodeURIComponent(id)).join(",")})&select=id`,
        prefer: "return=representation"
      });
    }

    return { issuesDeleted: matchedIssueIds.length, issueEventsDeleted };
  }

  /**
   * Rebuild the denormalized project/service figures from the history that is
   * still present after an administrator removes one or more cycles.
   * Scheduling fields are intentionally untouched: deleting test/history data
   * must not unexpectedly create a new due cycle or change the live cadence.
   */
  async refreshProjectRollups(projectId) {
    const [cycles, sessions, services, serviceFeedbackRows] = await Promise.all([
      this.listProjectCycles(projectId),
      this.listProjectSessions(projectId),
      this.servicesForProject(projectId),
      this.request("service_feedback", {
        query: `project_id=eq.${encodeURIComponent(projectId)}&select=*&order=updated_at.desc`
      })
    ]);
    const latestCycle = cycles[0] || null;
    const latestCycleSessions = latestCycle
      ? sessions.filter((session) => session.cycleId === latestCycle.id)
      : [];
    const projectNps = netPromoterScore(sessions.map((session) => session.npsScore));
    const worst = latestCycleSessions
      .filter((session) => session.rootCause)
      .sort((left, right) =>
        (left.csatScore === null ? 10 : left.csatScore) - (right.csatScore === null ? 10 : right.csatScore)
      )[0];

    await this.request("projects", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(projectId)}`,
      body: {
        csat_score: latestCycle ? latestCycle.csatScore : null,
        health_score: latestCycle && latestCycle.csatScore !== null
          ? Math.round(latestCycle.csatScore * 10)
          : null,
        nps_score: projectNps.score,
        risk_level: latestCycle ? latestCycle.riskLevel : null,
        root_cause: worst ? worst.rootCause : null,
        updated_at: new Date().toISOString()
      }
    });

    // updateProjectServices keeps the last feedback row that supplied a usable
    // score. Recreate that same meaning after rows belonging to a deleted cycle
    // disappear, and clear services for which no rating evidence remains.
    const latestScoredFeedback = new Map();
    for (const row of serviceFeedbackRows) {
      if (latestScoredFeedback.has(row.service_key)) continue;
      const stated = num(row.rating);
      const predicted = num(row.predicted_rating);
      const effective = stated === null ? predicted : stated;
      if (effective === null) continue;
      latestScoredFeedback.set(row.service_key, {
        score: Math.round(effective * 10) / 10,
        pulse: row.reason_text || null
      });
    }
    for (const service of services) {
      const latest = latestScoredFeedback.get(service.serviceKey);
      await this.request("project_services", {
        method: "PATCH",
        query: `id=eq.${encodeURIComponent(service.id)}`,
        body: latest
          ? { score: latest.score, status: statusFromScore(latest.score), pulse: latest.pulse, updated_at: new Date().toISOString() }
          : { score: null, status: "watch", pulse: null, updated_at: new Date().toISOString() }
      });
    }
  }

  /**
   * Permanently delete selected cycles and every feedback record owned by their
   * sessions. Issues must be removed explicitly because their session foreign
   * key is intentionally ON DELETE SET NULL in older installations.
   */
  async deleteProjectCycles(projectId, cycleIds = []) {
    const selectedCycleIds = [...new Set(cycleIds.filter(Boolean))];
    if (!selectedCycleIds.length) {
      return {
        cyclesDeleted: 0, sessionsDeleted: 0, messagesDeleted: 0,
        issuesDeleted: 0, issueEventsDeleted: 0, observationsDeleted: 0,
        serviceFeedbackDeleted: 0
      };
    }
    const selectedIds = selectedCycleIds.map((id) => encodeURIComponent(id));
    const cycles = await this.request("feedback_cycles", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&id=in.(${selectedIds.join(",")})&select=id`
    });
    const matchedCycleIds = cycles.map((row) => row.id).filter(Boolean);
    if (!matchedCycleIds.length) {
      return {
        cyclesDeleted: 0, sessionsDeleted: 0, messagesDeleted: 0,
        issuesDeleted: 0, issueEventsDeleted: 0, observationsDeleted: 0,
        serviceFeedbackDeleted: 0
      };
    }

    const encodedMatchedCycles = matchedCycleIds.map((id) => encodeURIComponent(id));
    const sessions = await this.request("feedback_sessions", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&cycle_id=in.(${encodedMatchedCycles.join(",")})&select=id`
    });
    const sessionIds = sessions.map((row) => row.id).filter(Boolean);
    const counts = {
      cyclesDeleted: 0,
      sessionsDeleted: 0,
      messagesDeleted: 0,
      issuesDeleted: 0,
      issueEventsDeleted: 0,
      observationsDeleted: 0,
      serviceFeedbackDeleted: 0
    };

    const issueIds = [];
    for (let index = 0; index < sessionIds.length; index += 100) {
      const ids = sessionIds.slice(index, index + 100).map((id) => encodeURIComponent(id));
      const rows = await this.request("issues", {
        query: `project_id=eq.${encodeURIComponent(projectId)}&session_id=in.(${ids.join(",")})&select=id`
      });
      issueIds.push(...rows.map((row) => row.id).filter(Boolean));
    }

    for (let index = 0; index < issueIds.length; index += 100) {
      const ids = issueIds.slice(index, index + 100).map((id) => encodeURIComponent(id));
      const events = await this.request("issue_events", {
        method: "DELETE",
        query: `issue_id=in.(${ids.join(",")})&select=id`,
        prefer: "return=representation"
      });
      counts.issueEventsDeleted += Array.isArray(events) ? events.length : 0;
      const deletedIssues = await this.request("issues", {
        method: "DELETE",
        query: `project_id=eq.${encodeURIComponent(projectId)}&id=in.(${ids.join(",")})&select=id`,
        prefer: "return=representation"
      });
      counts.issuesDeleted += Array.isArray(deletedIssues) ? deletedIssues.length : 0;
    }

    const sessionTables = [
      ["observations", "observationsDeleted"],
      ["service_feedback", "serviceFeedbackDeleted"],
      ["messages", "messagesDeleted"]
    ];
    for (let index = 0; index < sessionIds.length; index += 100) {
      const ids = sessionIds.slice(index, index + 100).map((id) => encodeURIComponent(id));
      for (const [table, countKey] of sessionTables) {
        const deleted = await this.request(table, {
          method: "DELETE",
          query: `session_id=in.(${ids.join(",")})&select=id`,
          prefer: "return=representation"
        });
        counts[countKey] += Array.isArray(deleted) ? deleted.length : 0;
      }
      const deletedSessions = await this.request("feedback_sessions", {
        method: "DELETE",
        query: `project_id=eq.${encodeURIComponent(projectId)}&id=in.(${ids.join(",")})&select=id`,
        prefer: "return=representation"
      });
      counts.sessionsDeleted += Array.isArray(deletedSessions) ? deletedSessions.length : 0;
    }

    const deletedCycles = await this.request("feedback_cycles", {
      method: "DELETE",
      query: `project_id=eq.${encodeURIComponent(projectId)}&id=in.(${encodedMatchedCycles.join(",")})&select=id`,
      prefer: "return=representation"
    });
    counts.cyclesDeleted = Array.isArray(deletedCycles) ? deletedCycles.length : 0;
    await this.refreshProjectRollups(projectId);
    return counts;
  }

  async hasProviderMessage(providerMessageId) {
    if (!providerMessageId) return false;
    const rows = await this.request("messages", {
      query: `provider_message_id=eq.${encodeURIComponent(providerMessageId)}&select=id&limit=1`
    });
    return rows.length > 0;
  }

  // -------------------------------------------------------------------
  // Cycles and sessions
  // -------------------------------------------------------------------

  sessionExtras(row) {
    return {
      cycleType: row.feedback_cycles ? row.feedback_cycles.cycle_type : null,
      pocName: row.client_pocs ? row.client_pocs.name : null,
      pocWeight: row.client_pocs ? num(row.client_pocs.weight_percentage) : null
    };
  }

  async listProjectCycles(projectId) {
    const rows = await this.request("feedback_cycles", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&order=started_at.desc`
    });
    return rows.map(toCycle);
  }

  async listCycleSessions(cycleId) {
    const rows = await this.request("feedback_sessions", {
      query: `cycle_id=eq.${encodeURIComponent(cycleId)}&select=*,client_pocs(name,salutation,poc_level_id,weight_percentage),feedback_cycles(cycle_type)&order=started_at.asc`
    });
    return rows.map((row) => toSession(row, this.sessionExtras(row)));
  }

  async listProjectSessions(projectId) {
    const rows = await this.request("feedback_sessions", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&select=*,client_pocs(name,salutation,poc_level_id,weight_percentage),feedback_cycles(cycle_type)&order=started_at.desc`
    });
    return rows.map((row) => toSession(row, this.sessionExtras(row)));
  }

  async hasOpenCycle(projectId, cycleType) {
    const rows = await this.request("feedback_cycles", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&cycle_type=eq.${encodeURIComponent(cycleType)}&status=eq.open&select=id&limit=1`
    });
    return rows.length > 0;
  }

  /**
   * Create a cycle for a project plus one session per ACTIVE client POC.
   */
  async createCycle(projectKey, options = {}) {
    const project = await this.getProject(projectKey);
    if (!project) throw new Error(`Project ${projectKey} not found`);

    const allowedCycleTypes = new Set(["pulse", "project_end", "quick_checkin"]);
    const cycleType = allowedCycleTypes.has(options.cycleType) ? options.cycleType : "pulse";
    const isQuickCheckin = cycleType === "quick_checkin";
    const selectionProvided = Array.isArray(options.clientPocIds);
    const requestedPocIds = selectionProvided
      ? [...new Set(options.clientPocIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : [];
    if (selectionProvided && !requestedPocIds.length) {
      throw new Error("Select at least one client POC for this feedback cycle");
    }
    const projectPocsById = new Map(project.pocs.map((poc) => [poc.id, poc]));
    const unknownPocId = requestedPocIds.find((id) => !projectPocsById.has(id));
    if (unknownPocId) throw new Error("A selected client POC does not belong to this project");

    const requestedPocIdSet = new Set(requestedPocIds);
    const selectedPocs = selectionProvided
      ? project.pocs.filter((poc) => requestedPocIdSet.has(poc.id))
      : project.pocs;
    const unavailablePocs = selectedPocs.filter((poc) => !poc.active || !digits(poc.contactWhatsapp));
    if (unavailablePocs.length) {
      throw new Error(`Selected POC${unavailablePocs.length === 1 ? "" : "s"} cannot receive WhatsApp feedback: ${unavailablePocs.map((poc) => poc.name).join(", ")}`);
    }
    const pocs = selectedPocs.filter((poc) => poc.active && digits(poc.contactWhatsapp));
    if (!pocs.length) {
      throw new Error(`Project ${projectKey} has no active POC with a WhatsApp number`);
    }

    // Full feedback must remain the only open conversation for a phone number.
    // Quick check-ins can coexist because template buttons identify a session;
    // subsequent free text is routed to the one awaiting details.
    for (const poc of pocs) {
      const routing = await this.getWhatsappRoutingContext(poc.contactWhatsapp);
      const activeSessions = routing.status === "ambiguous"
        ? routing.candidates.map((candidate) => candidate.session)
        : routing.status === "active" ? [routing.session] : [];
      const conflicts = isQuickCheckin
        ? activeSessions.some((activeSession) => activeSession.sessionType !== "quick_checkin")
        : activeSessions.length > 0;
      if (conflicts) {
        const blockingSession = activeSessions.find((activeSession) => (
          isQuickCheckin ? activeSession.sessionType !== "quick_checkin" : true
        ));
        const blockingProject = blockingSession?.projectId
          ? await this.getProjectById(blockingSession.projectId)
          : null;
        throw new Error(`${poc.name} already has an active feedback request${blockingProject ? ` on ${blockingProject.name}` : " on another project"}. Finish or stop it before starting this cycle.`);
      }
    }

    const now = new Date();
    const cycleRows = await this.request("feedback_cycles", {
      method: "POST",
      body: [{
        project_id: project.id,
        cycle_type: cycleType,
        schedule_key: options.scheduleKey || null,
        status: "open",
        started_at: now.toISOString(),
        poc_total: pocs.length,
        poc_responded: 0,
        weight_responded: 0
      }]
    });
    const cycle = toCycle(cycleRows[0]);

    const sessionRows = await this.request("feedback_sessions", {
      method: "POST",
      body: pocs.map((poc) => ({
        cycle_id: cycle.id,
        client_poc_id: poc.id,
        project_id: project.id,
        status: "started",
        completion_status: "not_started",
        conversation_state: isQuickCheckin
          ? {
              pocWeightPercentage: num(poc.weightPercentage),
              state: "quick_checkin_choice",
              quickCheckinOutcome: "awaiting_response",
              scheduleKey: options.scheduleKey || null
            }
          : { pocWeightPercentage: num(poc.weightPercentage) },
        channel: options.channel || "whatsapp",
        started_at: now.toISOString(),
        reminder_due_at: addHours(now, isQuickCheckin ? 48 : (options.reminderHours || 24))
      }))
    });

    if (!isQuickCheckin) {
    const projectPatch = { last_cycle_started_at: now.toISOString() };
    if (cycleType === "project_end") {
      projectPatch.end_feedback_requested_at = now.toISOString();
    } else {
      projectPatch.next_cycle_due_at = addDays(now, project.feedbackIntervalDays || 30);
    }
    await this.request("projects", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(project.id)}`,
      body: projectPatch
    });
    }

    const sessions = sessionRows.map((row) => {
      const poc = pocs.find((item) => item.id === row.client_poc_id);
      return toSession(row, {
        cycleType,
        pocName: poc ? poc.name : null,
        pocWeight: poc ? poc.weightPercentage : null
      });
    });

    for (const session of sessions) {
      const poc = pocs.find((item) => item.id === session.clientPocId);
      const label = isQuickCheckin ? "Quick check-in" : cycleType === "project_end" ? "Project-end" : "Monthly";
      await this.addMessage(session.id, {
        speaker: "SRV Media Directors' Office",
        side: "system",
        body: `${label} started for ${poc ? poc.name : "client POC"}.`,
        metadata: { source: "cycle_created" }
      });
    }

    return { cycle, sessions, project, pocs };
  }

  async addMessage(sessionId, message) {
    const rows = await this.request("messages", {
      method: "POST",
      body: [{
        session_id: sessionId,
        speaker: message.speaker,
        side: message.side,
        body: message.body,
        provider_message_id: message.providerMessageId || null,
        metadata: message.metadata || {}
      }]
    });
    return toMessage(rows[0]);
  }

  /**
   * Atomically claim a provider message id while inserting the inbound row.
   * The earlier SELECT-then-INSERT sequence allowed two concurrent Meta retries
   * to process the same complaint. The unique index in guardrail-hardening.sql
   * makes the losing insert return no row instead.
   */
  async addInboundMessage(sessionId, message) {
    if (!message.providerMessageId) return this.addMessage(sessionId, message);
    const rows = await this.request("messages", {
      method: "POST",
      query: "on_conflict=provider_message_id",
      prefer: "resolution=ignore-duplicates,return=representation",
      body: [{
        session_id: sessionId,
        speaker: message.speaker,
        side: message.side,
        body: message.body,
        provider_message_id: message.providerMessageId,
        metadata: message.metadata || {}
      }]
    });
    return rows && rows[0] ? toMessage(rows[0]) : null;
  }

  // -------------------------------------------------------------------
  // Applying analysis
  // -------------------------------------------------------------------

  async applyAnalysis(sessionId, analysis) {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const now = new Date();
    const sessionPatch = {
      status: analysis.requiresManagerAlert
        ? "needs_attention"
        : analysis.isComplete
          ? "completed"
          : "partial",
      completion_status: analysis.isComplete ? "completed" : "partial",
      conversation_state: analysis.conversationState || {},
      completed_at: analysis.isComplete ? now.toISOString() : null,
      last_client_response_at: now.toISOString(),
      // A finished conversation must never queue a reminder. dueInHours is
      // deliberately null once a session is terminal — "|| 24" overrode that
      // null and booked a reminder 24h out on every completed session.
      reminder_due_at: analysis.dueInHours ? addHours(now, analysis.dueInHours) : null,
      csat_score: analysis.csatScore,
      risk_level: analysis.riskLevel,
      predicted_csat: analysis.predictedCsat === undefined ? null : analysis.predictedCsat,
      predicted_confidence: analysis.predictedConfidence === undefined ? null : analysis.predictedConfidence,
      predicted_reasoning: analysis.predictedReasoning || null,
      predicted_signals: analysis.predictedSignals || [],
      csat_source: analysis.csatSource || null,
      nps_score: analysis.npsScore === undefined ? null : analysis.npsScore,
      nps_source: analysis.npsSource || null,
      tone: analysis.tone || null,
      tone_reason: analysis.toneReason || null,
      tone_source: analysis.toneSource || null,
      focus_service: analysis.focusSignal,
      root_cause: analysis.rootCause
    };
    if (analysis.npsScore !== null && analysis.npsScore !== undefined) {
      sessionPatch.nps_score = analysis.npsScore;
    }

    const updatedRows = await this.request("feedback_sessions", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(sessionId)}`,
      body: sessionPatch
    });
    const updatedSession = toSession(updatedRows[0], {
      cycleType: session.sessionType,
      pocName: session.pocName,
      pocWeight: session.pocWeight
    });

    // Close/recalculate the parent cycle immediately after the authoritative
    // session row is saved. Previously this ran after service/issue enrichment;
    // if one optional table write failed, the POC showed Completed with 7/10
    // while the parent cycle remained Open with 0 responses.
    await this.recomputeCycle(session.cycleId, session.projectId);

    const enrichments = await Promise.allSettled([
      this.upsertServiceFeedback(session, analysis),
      this.updateProjectServices(session.projectId, analysis),
      this.maybeCreateIssue(session, analysis)
    ]);
    for (const [index, result] of enrichments.entries()) {
      if (result.status !== "rejected") continue;
      const labels = ["service feedback", "project service score", "issue"];
      console.error(`[analysis] ${labels[index]} enrichment failed after session save:`, result.reason);
    }

    return updatedSession;
  }

  /**
   * Save a manual "Score it now" reading without changing conversation
   * progress. In particular, do not set completion_status, completed_at,
   * reminder_due_at or conversation_state: scoring is not a close action.
   */
  async applyInterimAnalysis(sessionId, analysis) {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const body = {
      csat_score: analysis.csatScore === undefined ? session.csatScore : analysis.csatScore,
      risk_level: analysis.riskLevel === undefined ? session.riskLevel : analysis.riskLevel,
      predicted_csat: analysis.predictedCsat === undefined ? session.predictedCsat : analysis.predictedCsat,
      predicted_confidence: analysis.predictedConfidence === undefined
        ? session.predictedConfidence
        : analysis.predictedConfidence,
      predicted_reasoning: analysis.predictedReasoning === undefined
        ? session.predictedReasoning
        : analysis.predictedReasoning || null,
      predicted_signals: analysis.predictedSignals === undefined
        ? session.predictedSignals || []
        : analysis.predictedSignals || [],
      csat_source: analysis.csatSource === undefined ? session.csatSource : analysis.csatSource || null
    };

    const rows = await this.request("feedback_sessions", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(sessionId)}`,
      body
    });
    const updatedSession = toSession(rows[0], {
      cycleType: session.sessionType,
      pocName: session.pocName,
      pocWeight: session.pocWeight
    });
    await this.recomputeCycle(session.cycleId, session.projectId);
    return updatedSession;
  }

  /**
   * Save the final transcript review for a session closed by the reminder
   * policy. Unlike applyAnalysis(), this deliberately preserves the partial
   * terminal outcome, reminder count, closure reason and last client response.
   * A predicted score enriches the record; it never rewrites history as though
   * the client completed the questionnaire.
   */
  async applyFinalPartialAnalysis(sessionId, analysis, expectedClosureReason = "partial_after_three_reminders") {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.conversationState?.closureReason !== expectedClosureReason) {
      throw new Error(`Terminal analysis is only allowed after ${expectedClosureReason}`);
    }

    const body = {
      csat_score: analysis.csatScore === undefined ? session.csatScore : analysis.csatScore,
      risk_level: analysis.riskLevel === undefined ? session.riskLevel : analysis.riskLevel,
      focus_service: analysis.focusSignal === undefined ? session.focusService : analysis.focusSignal,
      root_cause: analysis.rootCause === undefined ? session.rootCause : analysis.rootCause
    };
    if (analysis.predictedCsat !== undefined) body.predicted_csat = analysis.predictedCsat;
    if (analysis.predictedConfidence !== undefined) body.predicted_confidence = analysis.predictedConfidence;
    if (analysis.predictedReasoning !== undefined) body.predicted_reasoning = analysis.predictedReasoning || null;
    if (analysis.predictedSignals !== undefined) body.predicted_signals = analysis.predictedSignals || [];
    if (analysis.csatSource !== undefined) body.csat_source = analysis.csatSource || null;
    if (analysis.npsScore !== undefined) body.nps_score = analysis.npsScore;
    if (analysis.npsSource !== undefined) body.nps_source = analysis.npsSource || null;
    if (analysis.tone !== undefined) body.tone = analysis.tone;
    if (analysis.toneReason !== undefined) body.tone_reason = analysis.toneReason || null;
    if (analysis.toneSource !== undefined) body.tone_source = analysis.toneSource || null;

    const rows = await this.request("feedback_sessions", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(sessionId)}`,
      body
    });
    const updatedSession = toSession(rows[0], {
      cycleType: session.sessionType,
      pocName: session.pocName,
      pocWeight: session.pocWeight
    });

    await this.recomputeCycle(session.cycleId, session.projectId);
    const enrichments = await Promise.allSettled([
      this.upsertServiceFeedback(session, analysis),
      this.updateProjectServices(session.projectId, analysis),
      this.maybeCreateIssue(session, analysis)
    ]);
    for (const [index, result] of enrichments.entries()) {
      if (result.status !== "rejected") continue;
      const labels = ["service feedback", "project service score", "issue"];
      console.error(`[analysis] final partial ${labels[index]} enrichment failed:`, result.reason);
    }

    return updatedSession;
  }

  async applyStoppedSessionAnalysis(sessionId, analysis) {
    return this.applyFinalPartialAnalysis(sessionId, analysis, "stopped_by_admin");
  }

  async upsertServiceFeedback(session, analysis) {
    const services = (analysis.services || []).filter((service) => service.serviceKey);
    if (!services.length) return;

    const projectServices = await this.servicesForProject(session.projectId);
    for (const service of services) {
      const projectService = projectServices.find((item) => item.serviceKey === service.serviceKey);
      const existing = await this.request("service_feedback", {
        query: `session_id=eq.${encodeURIComponent(session.id)}&service_key=eq.${encodeURIComponent(service.serviceKey)}&select=id&limit=1`
      });
      const body = {
        session_id: session.id,
        project_id: session.projectId,
        client_poc_id: session.clientPocId,
        service_key: service.serviceKey,
        service_name: service.serviceName || (projectService ? projectService.name : service.serviceKey),
        sentiment: service.sentiment || "neutral",
        // `|| null` turned a stated 0 into "no rating". Only null and undefined
        // mean absent.
        rating: service.rating === null || service.rating === undefined ? null : service.rating,
        // The client is asked for one OVERALL rating now, so per-service
        // numbers are read from the conversation. Without persisting them the
        // services table showed "--" for everything after a finished cycle.
        predicted_rating: service.predictedRating === null || service.predictedRating === undefined
          ? null
          : service.predictedRating,
        predicted_confidence: service.predictedConfidence === undefined ? null : service.predictedConfidence,
        predicted_reasoning: service.predictedReasoning || null,
        rating_source: service.rating === null || service.rating === undefined
          ? (service.predictedRating === null || service.predictedRating === undefined ? null : "predicted")
          : "stated",
        reason_text: service.reasonText || null,
        reason_tags: service.reasonTags || [],
        internal_poc_id: projectService ? projectService.internalPocId : null,
        status: service.rating === null || service.rating === undefined ? "captured" : "rated"
      };
      if (existing.length) {
        await this.request("service_feedback", {
          method: "PATCH",
          query: `id=eq.${encodeURIComponent(existing[0].id)}`,
          body
        });
      } else {
        await this.request("service_feedback", { method: "POST", body: [body] });
      }
    }
  }

  async updateProjectServices(projectId, analysis) {
    for (const service of analysis.services || []) {
      if (!service.serviceKey) continue;
      // Ratings are already 0-10. The old *2 was left over from the 1-5 scale
      // and turned a stated 4 into a displayed 8.
      // A client is asked for ONE overall rating now, so most services have no
      // stated score. The predicted one is what the dashboard shows — without
      // persisting it, every service read "--" after a completed cycle.
      const stated = service.rating === null || service.rating === undefined ? null : Number(service.rating);
      const predicted = service.predictedRating === null || service.predictedRating === undefined
        ? null
        : Number(service.predictedRating);
      const effective = stated === null ? predicted : stated;
      if (effective === null) continue;
      const score = Math.round(effective * 10) / 10;
      await this.request("project_services", {
        method: "PATCH",
        query: `project_id=eq.${encodeURIComponent(projectId)}&service_key=eq.${encodeURIComponent(service.serviceKey)}`,
        body: {
          score,
          status: statusFromScore(score),
          pulse: service.reasonText || null
        }
      });
    }
  }

  /**
   * An issue is only created when the client actually reported a problem:
   * negative sentiment AND a concrete reason. Greetings and praise never
   * create issues.
   */
  async maybeCreateIssue(session, analysis) {
    // The state machine decides when a complaint is settled and detailed enough
    // to page an owner (issueReady). Sentiment alone never opens an issue.
    const problems = (analysis.services || []).filter(
      (service) =>
        service.issueReady === true &&
        service.sentiment === "negative" &&
        service.reasonText &&
        String(service.reasonText).trim().length > 0
    );
    if (!problems.length) return;

    const projectServices = await this.servicesForProject(session.projectId);

    for (const problem of problems) {
      const existing = await this.request("issues", {
        query: `session_id=eq.${encodeURIComponent(session.id)}&service_key=eq.${encodeURIComponent(problem.serviceKey)}&select=id&limit=1`
      });
      if (existing.length) continue;

      const projectService = projectServices.find((item) => item.serviceKey === problem.serviceKey);
      const severity = problem.issueSeverity
        || (problem.rating !== null && problem.rating !== undefined && problem.rating <= 4 ? "high" : "watch");
      const issueRows = await this.request("issues", {
        method: "POST",
        query: "on_conflict=session_id,service_key",
        prefer: "resolution=ignore-duplicates,return=representation",
        body: [{
          project_id: session.projectId,
          session_id: session.id,
          client_poc_id: session.clientPocId,
          service_key: problem.serviceKey,
          service_name: problem.serviceName || (projectService ? projectService.name : problem.serviceKey),
          severity,
          status: "open",
          // The API layer may attach Gemini-written text. The RULES still decide
          // that this issue exists; Gemini only supplies the wording.
          title: problem.issueTitle || String(problem.reasonText || "Needs attention").slice(0, 160),
          root_cause: problem.issueRootCause || problem.reasonText,
          internal_poc_id: projectService ? projectService.internalPocId : null,
          sla: severity === "high" ? "24h" : "48h",
          due_at: addHours(new Date(), severity === "high" ? 24 : 48)
        }]
      });
      if (!issueRows.length) continue;

      await this.request("issue_events", {
        method: "POST",
        body: [{
          issue_id: issueRows[0].id,
          project_id: session.projectId,
          session_id: session.id,
          action: "created",
          next_status: "open",
          note: "Created from client feedback"
        }]
      });
    }
  }

  /**
   * Recompute weighted cycle and project roll-ups (Option B).
   */
  async recomputeCycle(cycleId, projectId) {
    if (!cycleId) return null;
    const sessions = await this.listCycleSessions(cycleId);
    if (sessions[0]?.sessionType === "quick_checkin") {
      const responded = sessions.filter((session) => Boolean(session.lastClientResponseAt));
      const complete = sessions.length > 0 && sessions.every(sessionIsTerminal);
      const configuredWeight = sessions.reduce((sum, session) => sum + Math.max(0, Number(session.pocWeight) || 0), 0);
      const respondedWeight = responded.reduce((sum, session) => sum + Math.max(0, Number(session.pocWeight) || 0), 0);
      const result = {
        csatScore: null,
        npsScore: null,
        riskLevel: null,
        weightResponded: configuredWeight ? respondedWeight / configuredWeight : 0,
        pocResponded: responded.length,
        pocTotal: sessions.length
      };
      await this.request("feedback_cycles", {
        method: "PATCH",
        query: `id=eq.${encodeURIComponent(cycleId)}`,
        body: {
          status: complete ? "closed" : "open",
          closed_at: complete ? new Date().toISOString() : null,
          weight_responded: result.weightResponded,
          poc_responded: result.pocResponded,
          poc_total: result.pocTotal
        }
      });
      return result;
    }

    // The POC population is the one that actually received this cycle. A POC
    // deactivated afterward must not disappear from the historical weighting.
    const sessionPocIds = new Set(sessions.map((session) => session.clientPocId));
    const pocs = (await this.pocsForProject(projectId, { activeOnly: false }))
      .filter((poc) => sessionPocIds.has(poc.id));
    const sessionWeights = new Map(sessions.map((session) => [session.clientPocId, session.pocWeight]));
    const weightedPocs = pocs.map((poc) => ({
      ...poc,
      weightPercentage: sessionWeights.get(poc.id) ?? poc.weightPercentage
    }));
    const agg = aggregateCycle(sessions, weightedPocs);
    // A cycle ends when every POC session has reached a real terminal outcome,
    // not merely when every POC happens to have a score. A client can give a
    // rating early and still have unanswered services; conversely, a genuine
    // no-response outcome has no score but must not block the next monthly cycle.
    const complete = sessions.length > 0 && sessions.every(sessionIsTerminal);

    await this.request("feedback_cycles", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(cycleId)}`,
      body: {
        csat_score: agg.csatScore,
        nps_score: agg.npsScore,
        risk_level: agg.riskLevel,
        weight_responded: agg.weightResponded,
        poc_responded: agg.pocResponded,
        poc_total: agg.pocTotal,
        status: complete ? "closed" : "open",
        closed_at: complete ? new Date().toISOString() : null
      }
    });

    const projectPatch = {
      csat_score: agg.csatScore,
      health_score: agg.csatScore === null ? null : Math.round(agg.csatScore * 10),
      risk_level: agg.riskLevel
    };
    // Project NPS is calculated across EVERY respondent on the project, not
    // copied from the latest cycle. NPS is a proportion, so one cycle's figure
    // says nothing about the project as a whole.
    const projectSessions = await this.listProjectSessions(projectId);
    const projectNps = netPromoterScore(projectSessions.map((item) => item.npsScore));
    projectPatch.nps_score = projectNps.score;
    const worst = sessions
      .filter((s) => s.rootCause)
      .sort((a, b) => (a.csatScore === null ? 10 : a.csatScore) - (b.csatScore === null ? 10 : b.csatScore))[0];
    if (worst) projectPatch.root_cause = worst.rootCause;

    await this.request("projects", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(projectId)}`,
      body: projectPatch
    });

    return agg;
  }

  async markNoResponse(sessionId, options = {}) {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (sessionIsTerminal(session)) throw new Error("Session is closed and will not be reminded");
    const currentCount = Number(session.reminderCount) || 0;
    if (currentCount >= MAX_REMINDERS) throw new Error("Reminder limit reached");
    const now = new Date();
    const nextCount = currentCount + 1;
    const conversationState = {
      ...(session.conversationState || {}),
      reminderCount: nextCount,
      lastReminderAt: now.toISOString(),
      reminderExhausted: false
    };
    if (options.askForOverallRating) {
      conversationState.overallRatingAsked = true;
      conversationState.finalRatingReminderPending = true;
      conversationState.finalRatingReminderSentAt = now.toISOString();
      conversationState.pendingQuestionType = "overall_rating";
      conversationState.pendingServiceKey = null;
      conversationState.state = "waiting_for_overall_rating";
    }
    const rows = await this.request("feedback_sessions", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(sessionId)}`,
      body: {
        status: session.completionStatus === "partial" ? "partial" : "no_response",
        reminder_count: nextCount,
        // Even after reminder three, retain one final 24-hour grace period.
        // The scheduler closes the loop when this timestamp becomes due; it
        // does not send a fourth reminder.
        reminder_due_at: addHours(now, REMINDER_INTERVAL_HOURS),
        conversation_state: conversationState
      }
    });
    return toSession(rows[0], {
      cycleType: session.sessionType,
      pocName: session.pocName,
      pocWeight: session.pocWeight
    });
  }

  async markClosingTemplateSent(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const sentAt = new Date().toISOString();
    const rows = await this.request("feedback_sessions", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(sessionId)}`,
      body: {
        conversation_state: {
          ...(session.conversationState || {}),
          closingTemplateSentAt: sentAt
        }
      }
    });
    return toSession(rows[0], {
      cycleType: session.sessionType,
      pocName: session.pocName,
      pocWeight: session.pocWeight
    });
  }

  async stopSessionForCycle(sessionId, options = {}) {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const existingState = session.conversationState || {};
    if (existingState.stoppedByAdmin) return session;
    if (sessionIsTerminal(session)) throw new Error("Session is already closed");

    const now = new Date().toISOString();
    const conversationState = {
      ...existingState,
      state: "completed",
      stoppedByAdmin: true,
      stoppedAt: now,
      stoppedBy: String(options.actorName || "Dashboard user").trim(),
      stopReason: String(options.reason || "").trim() || null,
      closureReason: "stopped_by_admin"
    };
    const rows = await this.request("feedback_sessions", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(sessionId)}`,
      body: {
        // Keep the established terminal database value for compatibility, but
        // distinguish an administrator stop from a client's opt-out in JSON.
        status: "opted_out",
        reminder_due_at: null,
        conversation_state: conversationState
      }
    });
    const updated = toSession(rows[0], {
      cycleType: session.sessionType,
      pocName: session.pocName,
      pocWeight: session.pocWeight
    });
    await this.recomputeCycle(session.cycleId, session.projectId);
    return updated;
  }

  async finalizeReminderLoop(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (sessionIsTerminal(session)) return session;
    if ((Number(session.reminderCount) || 0) < MAX_REMINDERS) {
      throw new Error("Reminder loop cannot close before the third reminder");
    }

    const now = new Date();
    const partial = session.completionStatus === "partial";
    const conversationState = {
      ...(session.conversationState || {}),
      state: "completed",
      reminderExhausted: true,
      reminderClosedAt: now.toISOString(),
      closureReason: partial ? "partial_after_three_reminders" : "no_response_after_three_reminders"
    };
    const rows = await this.request("feedback_sessions", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(sessionId)}`,
      body: {
        status: partial ? "partial" : "no_response",
        reminder_due_at: null,
        conversation_state: conversationState
      }
    });
    const updated = toSession(rows[0], {
      cycleType: session.sessionType,
      pocName: session.pocName,
      pocWeight: session.pocWeight
    });
    await this.recomputeCycle(session.cycleId, session.projectId);
    return updated;
  }

  // -------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------

  async hasIssueForAnalysis(sessionId, analysis) {
    const keys = (analysis.services || [])
      .filter((service) => service.sentiment === "negative")
      .map((service) => service.serviceKey);
    if (!keys.length) return false;
    const rows = await this.request("issues", {
      query: `session_id=eq.${encodeURIComponent(sessionId)}&select=id&limit=1`
    });
    return rows.length > 0;
  }

  async getIssue(issueId) {
    const rows = await this.request("issues", {
      query: `id=eq.${encodeURIComponent(issueId)}&select=*&limit=1`
    });
    if (!rows.length) return null;
    const events = await this.request("issue_events", {
      query: `issue_id=eq.${encodeURIComponent(issueId)}&order=created_at.asc`
    });
    return { ...toIssue(rows[0]), events: events.map(toIssueEvent) };
  }

  async updateIssueStatus(issueId, action, options = {}) {
    const issue = await this.getIssue(issueId);
    if (!issue) throw new Error("Issue not found");

    const now = new Date();
    const nextStatus =
      action === "close"
        ? "closed"
        : action === "reopen"
          ? "open"
          : action === "progress"
            ? "in_progress"
            : issue.status;

    const body = { status: nextStatus };
    if (action === "close") {
      body.closed_at = now.toISOString();
      body.resolution_note = options.note || issue.resolutionNote;
    }
    if (action === "reopen") {
      body.reopened_at = now.toISOString();
      body.reopen_reason = options.note || null;
      body.closed_at = null;
    }

    const rows = await this.request("issues", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(issueId)}`,
      body
    });

    await this.request("issue_events", {
      method: "POST",
      body: [{
        issue_id: issueId,
        project_id: issue.projectId,
        session_id: issue.sessionId,
        action,
        previous_status: issue.status,
        next_status: nextStatus,
        note: options.note || null,
        actor_name: options.actorName || "SRV Team"
      }]
    });

    return toIssue(rows[0]);
  }

  async listProjectIssues(projectId) {
    const rows = await this.request("issues", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&order=created_at.desc`
    });
    const issues = rows.map(toIssue);
    for (const issue of issues) {
      const events = await this.request("issue_events", {
        query: `issue_id=eq.${encodeURIComponent(issue.id)}&order=created_at.asc`
      });
      issue.events = events.map(toIssueEvent);
    }
    return issues;
  }

  // -------------------------------------------------------------------
  // Automation
  // -------------------------------------------------------------------

  async recordAutomationEvent(event) {
    const rows = await this.request("automation_events", {
      method: "POST",
      body: [{
        event_type: event.eventType,
        dedupe_key: event.dedupeKey || null,
        payload: event.payload || {},
        status: event.status || "pending",
        webhook_url_configured: Boolean(event.webhookUrlConfigured),
        status_code: event.statusCode || null,
        sent_at: event.sentAt || null,
        error: event.error || null
      }]
    });
    return rows[0];
  }

  /** Reserve an automation side effect before calling n8n. */
  async claimAutomationEvent(eventType, payload, dedupeKey) {
    if (!dedupeKey) return null;
    const rows = await this.request("automation_events", {
      method: "POST",
      query: "on_conflict=dedupe_key",
      prefer: "resolution=ignore-duplicates,return=representation",
      body: [{
        event_type: eventType,
        dedupe_key: dedupeKey,
        payload: payload || {},
        status: "pending",
        webhook_url_configured: false
      }]
    });
    return rows && rows[0] ? rows[0] : null;
  }

  async completeAutomationEvent(eventId, event) {
    const rows = await this.request("automation_events", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(eventId)}`,
      body: {
        payload: event.payload || {},
        status: event.status || "pending",
        webhook_url_configured: Boolean(event.webhookUrlConfigured),
        status_code: event.statusCode || null,
        sent_at: event.sentAt || null,
        error: event.error || null
      }
    });
    return rows && rows[0] ? rows[0] : null;
  }

  // -------------------------------------------------------------------
  // Scheduler targets
  // -------------------------------------------------------------------

  async getDueFeedbackTargets(nowIso = new Date().toISOString()) {
    const projects = await this.listProjects();
    const targets = [];
    const nowMs = new Date(nowIso).getTime();

    for (const project of projects) {
      if (project.activeStatus !== "active") continue;

      const endDue =
        project.endDate && new Date(project.endDate).getTime() <= nowMs && !project.endFeedbackRequestedAt;
      if (endDue && !(await this.hasOpenCycle(project.id, "project_end"))) {
        targets.push({ projectKey: project.key, cycleType: "project_end" });
        continue;
      }

      const pulseDue = project.nextCycleDueAt && new Date(project.nextCycleDueAt).getTime() <= nowMs;
      const projectEnded = project.endDate && new Date(project.endDate).getTime() <= nowMs;
      if (pulseDue && !projectEnded && !(await this.hasOpenCycle(project.id, "pulse"))) {
        targets.push({ projectKey: project.key, cycleType: "pulse" });
      }
    }

    return targets;
  }

  async getDueReminderTargets(nowIso = new Date().toISOString()) {
    const levels = await this.pocLevels();
    const rows = await this.request("feedback_sessions", {
      query: `reminder_due_at=lte.${encodeURIComponent(nowIso)}&status=in.(started,no_response,partial)&select=*,client_pocs(name,salutation,honorific,contact_whatsapp,contact_email,poc_level_id,weight_percentage),feedback_cycles(cycle_type),projects(project_key,name)&order=reminder_due_at.asc`
    });

    return rows.filter((row) => row.feedback_cycles?.cycle_type !== "quick_checkin").map((row) => ({
      session: toSession(row, this.sessionExtras(row)),
      poc: row.client_pocs
        ? toClientPoc(
            { ...row.client_pocs, id: row.client_poc_id, project_id: row.project_id },
            levels.get(row.client_pocs.poc_level_id) || null
          )
        : null,
      projectKey: row.projects ? row.projects.project_key : null,
      projectName: row.projects ? row.projects.name : null,
      reminderKind: row.completion_status === "partial" ? "complete_partial_feedback" : "no_response",
      reminderAction: Number(row.reminder_count || 0) >= MAX_REMINDERS
        ? "close_after_grace"
        : "send_reminder"
    }));
  }

  // -------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------

  /**
   * Service feedback as captured in each cycle.
   *
   * project_services.score holds the LAST KNOWN score across all time, so
   * selecting a cycle where only SEO was rated still showed stale scores for
   * every other service. This reads service_feedback, which is per session and
   * therefore per cycle.
   */
  async serviceFeedbackByCycle(projectId) {
    const rows = await this.request("service_feedback", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&select=*,feedback_sessions(cycle_id)&order=created_at.asc`
    });
    const byCycle = new Map();
    for (const row of rows) {
      const cycleId = row.feedback_sessions ? row.feedback_sessions.cycle_id : null;
      if (!cycleId) continue;
      if (!byCycle.has(cycleId)) byCycle.set(cycleId, new Map());
      const services = byCycle.get(cycleId);
      const existing = services.get(row.service_key);
      // Several POCs can rate the same service in one cycle.
      if (existing) {
        existing.ratings.push(num(row.rating) === null ? num(row.predicted_rating) : num(row.rating));
        if (row.reason_text) existing.reasons.push(row.reason_text);
      } else {
        services.set(row.service_key, {
          serviceKey: row.service_key,
          serviceName: row.service_name,
          sentiment: row.sentiment,
          // Fall back to the predicted score where the client gave none —
          // which is now most services, since only one overall rating is asked.
          ratings: [num(row.rating) === null ? num(row.predicted_rating) : num(row.rating)],
          source: row.rating_source || null,
          confidence: row.predicted_confidence === null || row.predicted_confidence === undefined
            ? null
            : Number(row.predicted_confidence),
          reasons: row.reason_text ? [row.reason_text] : []
        });
      }
    }

    const result = {};
    for (const [cycleId, services] of byCycle) {
      result[cycleId] = [...services.values()].map((svc) => {
        const rated = svc.ratings.filter((value) => value !== null && value !== undefined);
        return {
          serviceKey: svc.serviceKey,
          serviceName: svc.serviceName,
          sentiment: svc.sentiment,
          source: svc.source,
          confidence: svc.confidence,
          score: rated.length
            ? Math.round((rated.reduce((sum, v) => sum + v, 0) / rated.length) * 10) / 10
            : null,
          pulse: svc.reasons.join(". ") || null
        };
      });
    }
    return result;
  }

  async getProjectWorkspace(projectKey) {
    const project = await this.getProject(projectKey);
    if (!project) return null;

    let cycles = await this.listProjectCycles(project.id);
    const sessions = await this.listProjectSessions(project.id);
    const issues = await this.listProjectIssues(project.id);
    const serviceFeedbackByCycle = await this.serviceFeedbackByCycle(project.id);
    const observations = await this.listProjectObservations(project.id);

    // EVERY POC, including deactivated ones. Feedback already given is a fact —
    // deactivating a contact should stop future sends, not erase what they
    // said. Filtering them out here made past conversations vanish from the
    // workspace along with the person.
    const allPocs = await this.pocsForProject(project.id, { activeOnly: false });

    // Self-heal cycles left stale by an older partial write: if every session
    // is already terminal, an Open parent is objectively wrong and also blocks
    // the next scheduled monthly cycle. Refreshing the workspace repairs the
    // aggregate once; subsequent reads are read-only because it is then closed.
    const staleOpenCycles = cycles.filter((cycle) => {
      if (cycle.status !== "open") return false;
      const cycleSessions = sessions.filter((session) => session.cycleId === cycle.id);
      return cycleSessions.length > 0 && cycleSessions.every(sessionIsTerminal);
    });
    if (staleOpenCycles.length) {
      for (const cycle of staleOpenCycles) {
        await this.recomputeCycle(cycle.id, project.id);
      }
      cycles = await this.listProjectCycles(project.id);
    }

    const cyclesWithSessions = cycles.map((cycle) => ({
      ...cycle,
      sessions: sessions.filter((session) => session.cycleId === cycle.id)
    }));

    const latestSession = sessions[0] || null;
    const messages = latestSession ? await this.getMessagesForSession(latestSession.id) : [];

    return {
      project,
      services: project.services,
      serviceFeedbackByCycle,
      observations,
      pocs: allPocs,
      cycles: cyclesWithSessions,
      sessions,
      issues,
      latestSession,
      messages
    };
  }

  async getSessionDetail(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) return null;
    return {
      session,
      messages: await this.getMessagesForSession(sessionId),
      poc: await this.getClientPocById(session.clientPocId),
      project: await this.getProjectById(session.projectId)
    };
  }

  // -------------------------------------------------------------------
  // Admin writes (PIN-gated at the API layer)
  //
  // Only fields the user owns are written here. Engine-owned columns
  // (csat_score, risk_level, next_cycle_due_at, service score/pulse) are
  // deliberately absent — a manual edit there would be overwritten by the
  // next conversation, or would make the dashboard disagree with the feedback.
  // -------------------------------------------------------------------

  async getDirectory() {
    const [clusters, clients, projects, pocLevelRows, departments, subDepartments, internalPocs, serviceCatalog] = await Promise.all([
      this.request("clusters", { query: "select=*&order=name.asc" }),
      this.request("clients", { query: "select=*&order=name.asc" }),
      this.request("projects", { query: "select=*&order=name.asc" }),
      this.request("poc_levels", { query: "select=*&order=weight.desc" }),
      this.request("departments", { query: "select=*&order=name.asc" }),
      this.request("sub_departments", { query: "select=*&order=name.asc" }),
      this.request("internal_pocs", { query: "select=*&order=name.asc" }),
      this.request("service_catalog", { query: "select=*&order=name.asc" })
    ]);

    return {
      clusters: clusters.map((row) => ({ id: row.id, name: row.name })),
      clients: clients.map((row) => ({
        id: row.id,
        key: row.client_key,
        name: row.name,
        clusterId: row.cluster_id,
        activeStatus: row.active_status
      })),
      projects: projects.map((row) => toProject(row)),
      pocLevels: pocLevelRows.map((row) => ({ id: row.id, name: row.name, weight: Number(row.weight) })),
      departments: departments.map((row) => ({ id: row.id, name: row.name })),
      subDepartments: subDepartments.map((row) => ({ id: row.id, name: row.name, departmentId: row.department_id })),
      internalPocs: internalPocs.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        clusterId: row.cluster_id,
        departmentId: row.department_id,
        subDepartmentId: row.sub_department_id,
        reportingManagerId: row.reporting_manager_id,
        active: row.active
      })),
      serviceCatalog: serviceCatalog.map((row) => ({
        id: row.id,
        serviceKey: row.service_key,
        name: row.name,
        active: row.active,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    };
  }

  /**
   * Legacy level metadata editor retained for backward API compatibility.
   * These values no longer participate in CSAT; client_pocs.weight_percentage
   * is the sole influence used by new cycles.
   */
  async updatePocLevelWeights(updates) {
    const currentRows = await this.request("poc_levels", {
      query: "select=id,name,weight&order=name.asc"
    });
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    if (updates.some((item) => !currentById.has(item.id))) return { status: "not_found" };

    const proposedRows = currentRows.map((row) => {
      const update = updates.find((item) => item.id === row.id);
      return update ? { ...row, weight: update.weight } : row;
    });
    const normal = proposedRows.find((row) => String(row.name || "").toLowerCase() === "normal");
    const important = proposedRows.find((row) => String(row.name || "").toLowerCase() === "important");
    if (normal && important && Number(important.weight) <= Number(normal.weight)) {
      return { status: "invalid_order" };
    }
    if (normal && important && Number(normal.weight) + Number(important.weight) !== 100) {
      return { status: "invalid_total" };
    }

    const saved = [];
    for (const item of updates) {
      const rows = await this.request("poc_levels", {
        method: "PATCH",
        query: `id=eq.${encodeURIComponent(item.id)}`,
        body: { weight: item.weight }
      });
      const row = rows[0] || { ...currentById.get(item.id), weight: item.weight };
      saved.push({ id: row.id, name: row.name, weight: Number(row.weight) });
    }

    // pocLevels() is cached because it is read on almost every inbound turn.
    // Clear it immediately so the next conversation sees the new values.
    this._levels = null;
    return { status: "updated", levels: saved };
  }

  /** Every POC and service for one client, across all of its projects. */
  async getClientDetail(clientId) {
    const clientRows = await this.request("clients", {
      query: `id=eq.${encodeURIComponent(clientId)}&select=*,clusters(id,name)&limit=1`
    });
    if (!clientRows.length) return null;
    const row = clientRows[0];

    const projectRows = await this.request("projects", {
      query: `client_id=eq.${encodeURIComponent(clientId)}&order=name.asc`
    });
    const projectIds = projectRows.map((item) => item.id);
    const inList = projectIds.length
      ? `project_id=in.(${projectIds.map((id) => encodeURIComponent(id)).join(",")})&`
      : "project_id=is.null&";

    const levels = await this.pocLevels();
    const [pocRows, serviceRows, catalogRows] = await Promise.all([
      this.request("client_pocs", { query: `${inList}order=name.asc` }),
      this.request("project_services", { query: `${inList}order=name.asc` }),
      this.request("service_catalog", { query: "select=id,service_key,name,active" })
    ]);
    const catalogByKey = new Map(catalogRows.map((item) => [item.service_key, item]));

    const internalIds = [...new Set(serviceRows.map((item) => item.internal_poc_id).filter(Boolean))];
    const owners = internalIds.length
      ? await this.request("internal_pocs", {
          query: `id=in.(${internalIds.map((id) => encodeURIComponent(id)).join(",")})&select=id,name,email,reporting_manager_id`
        })
      : [];
    const ownersById = new Map(owners.map((item) => [item.id, item]));
    const managerIds = [...new Set(owners.map((item) => item.reporting_manager_id).filter(Boolean))];
    const managers = managerIds.length
      ? await this.request("internal_pocs", {
          query: `id=in.(${managerIds.map((id) => encodeURIComponent(id)).join(",")})&select=id,name,email`
        })
      : [];
    const managersById = new Map(managers.map((item) => [item.id, item]));

    return {
      client: {
        id: row.id,
        key: row.client_key,
        name: row.name,
        clusterId: row.cluster_id,
        clusterName: row.clusters ? row.clusters.name : null,
        activeStatus: row.active_status
      },
      projects: projectRows.map((item) => toProject(item)),
      pocs: pocRows.map((item) => toClientPoc(item, levels.get(item.poc_level_id) || null)),
      services: serviceRows.map((item) => {
        const owner = ownersById.get(item.internal_poc_id) || null;
        const manager = owner ? managersById.get(owner.reporting_manager_id) || null : null;
        return {
          id: item.id,
          projectId: item.project_id,
          serviceKey: item.service_key,
          name: item.name,
          kpis: item.kpis,
          internalPocId: item.internal_poc_id,
          serviceCatalogId: item.service_catalog_id || catalogByKey.get(item.service_key)?.id || null,
          ownerName: owner ? owner.name : null,
          managerName: manager ? manager.name : null,
          score: num(item.score)
        };
      })
    };
  }

  async createInternalPoc(input) {
    const rows = await this.request("internal_pocs", {
      method: "POST",
      body: [{
        name: input.name,
        email: input.email || null,
        phone: input.phone ? digits(input.phone) : null,
        cluster_id: input.clusterId || null,
        department_id: input.departmentId || null,
        sub_department_id: input.subDepartmentId || null,
        reporting_manager_id: input.reportingManagerId || null,
        active: input.active === undefined ? true : Boolean(input.active)
      }]
    });
    return toInternalPocRow(rows[0]);
  }

  async createDepartment(input) {
    const rows = await this.request("departments", {
      method: "POST",
      body: [{ name: input.name }]
    });
    return { id: rows[0].id, name: rows[0].name };
  }

  async createSubDepartment(input) {
    const rows = await this.request("sub_departments", {
      method: "POST",
      body: [{ name: input.name, department_id: input.departmentId }]
    });
    return { id: rows[0].id, name: rows[0].name, departmentId: rows[0].department_id };
  }

  async updateInternalPoc(internalPocId, input) {
    const body = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) body.name = input.name;
    if (input.email !== undefined) body.email = input.email || null;
    if (input.phone !== undefined) body.phone = input.phone ? digits(input.phone) : null;
    if (input.clusterId !== undefined) body.cluster_id = input.clusterId || null;
    if (input.departmentId !== undefined) body.department_id = input.departmentId || null;
    if (input.subDepartmentId !== undefined) body.sub_department_id = input.subDepartmentId || null;
    if (input.reportingManagerId !== undefined) body.reporting_manager_id = input.reportingManagerId || null;
    if (input.active !== undefined) body.active = Boolean(input.active);

    const rows = await this.request("internal_pocs", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(internalPocId)}`,
      body
    });
    return rows.length ? toInternalPocRow(rows[0]) : null;
  }

  /**
   * Walk the reporting chain upward. A loop (A reports to B, B reports to A)
   * would make manager lookup for alerts never terminate at a real person.
   */
  async managerChainWouldLoop(internalPocId, managerId) {
    if (!managerId) return false;
    // A self-manager assignment is intentionally allowed for directors or
    // standalone owners. Only loops involving two or more people are blocked.
    if (managerId === internalPocId) return false;
    const seen = new Set([internalPocId]);
    let cursor = managerId;
    for (let hop = 0; hop < 20 && cursor; hop += 1) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      const rows = await this.request("internal_pocs", {
        query: `id=eq.${encodeURIComponent(cursor)}&select=reporting_manager_id&limit=1`
      });
      if (!rows.length) return false;
      cursor = rows[0].reporting_manager_id;
    }
    return Boolean(cursor);
  }

  async subDepartmentBelongsTo(subDepartmentId, departmentId) {
    if (!subDepartmentId) return true;
    const rows = await this.request("sub_departments", {
      query: `id=eq.${encodeURIComponent(subDepartmentId)}&select=department_id&limit=1`
    });
    if (!rows.length) return false;
    return !departmentId || rows[0].department_id === departmentId;
  }

  async createProjectService(input) {
    let catalog = input.serviceCatalogId
      ? await this.getServiceCatalogItem(input.serviceCatalogId)
      : null;
    if (!catalog && input.serviceKey) {
      const rows = await this.request("service_catalog", {
        query: `service_key=eq.${encodeURIComponent(input.serviceKey)}&select=*&limit=1`
      });
      if (rows.length) {
        catalog = {
          id: rows[0].id,
          serviceKey: rows[0].service_key,
          name: rows[0].name,
          active: rows[0].active
        };
      }
    }
    if (!catalog) {
      catalog = await this.createServiceCatalogItem({
        serviceKey: input.serviceKey,
        name: input.name,
        active: true
      });
    }
    const rows = await this.request("project_services", {
      method: "POST",
      body: [{
        project_id: input.projectId,
        service_key: catalog.serviceKey,
        name: catalog.name,
        kpis: input.kpis || null,
        internal_poc_id: input.internalPocId || null,
        service_catalog_id: catalog.id
      }]
    });
    return toService(rows[0]);
  }

  async updateProjectService(serviceId, input) {
    const body = { updated_at: new Date().toISOString() };
    if (input.serviceKey !== undefined) body.service_key = input.serviceKey;
    if (input.name !== undefined) body.name = input.name;
    if (input.kpis !== undefined) body.kpis = input.kpis || null;
    if (input.internalPocId !== undefined) body.internal_poc_id = input.internalPocId || null;
    if (input.projectId !== undefined) body.project_id = input.projectId;
    if (input.serviceCatalogId !== undefined) {
      const catalog = input.serviceCatalogId
        ? await this.getServiceCatalogItem(input.serviceCatalogId)
        : null;
      body.service_catalog_id = catalog ? catalog.id : null;
      if (catalog) {
        body.service_key = catalog.serviceKey;
        body.name = catalog.name;
      }
    }

    const rows = await this.request("project_services", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(serviceId)}`,
      body
    });
    return rows.length ? toService(rows[0]) : null;
  }

  async deleteProjectService(serviceId) {
    const rows = await this.request("project_services", {
      method: "DELETE",
      query: `id=eq.${encodeURIComponent(serviceId)}`
    });
    return Array.isArray(rows) ? rows.length > 0 : true;
  }

  async serviceKeyExists(projectId, serviceKey, exceptId = null) {
    const rows = await this.request("project_services", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&service_key=eq.${encodeURIComponent(serviceKey)}&select=id&limit=2`
    });
    return rows.some((row) => row.id !== exceptId);
  }

  async getServiceCatalogItem(serviceCatalogId) {
    if (!serviceCatalogId) return null;
    const rows = await this.request("service_catalog", {
      query: `id=eq.${encodeURIComponent(serviceCatalogId)}&select=*&limit=1`
    });
    if (!rows.length) return null;
    const row = rows[0];
    return { id: row.id, serviceKey: row.service_key, name: row.name, active: row.active };
  }

  async serviceCatalogConflict(name, serviceKey, exceptId = null) {
    const rows = await this.request("service_catalog", {
      query: `service_key=eq.${encodeURIComponent(serviceKey)}&select=id,name,service_key&limit=5`
    });
    if (rows.some((row) => row.id !== exceptId)) return true;
    const nameRows = await this.request("service_catalog", {
      query: `name=ilike.${encodeURIComponent(name)}&select=id,name,service_key&limit=5`
    });
    return nameRows.some((row) => row.id !== exceptId);
  }

  async createServiceCatalogItem(input) {
    const rows = await this.request("service_catalog", {
      method: "POST",
      body: [{ service_key: input.serviceKey, name: input.name, active: input.active !== false }]
    });
    const row = rows[0];
    return { id: row.id, serviceKey: row.service_key, name: row.name, active: row.active };
  }

  async updateServiceCatalogItem(serviceCatalogId, input) {
    const current = await this.getServiceCatalogItem(serviceCatalogId);
    if (!current) return null;
    const body = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) body.name = input.name;
    if (input.active !== undefined) body.active = Boolean(input.active);
    const rows = await this.request("service_catalog", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(serviceCatalogId)}`,
      body
    });
    if (input.name !== undefined) {
      await this.request("project_services", {
        method: "PATCH",
        query: `service_catalog_id=eq.${encodeURIComponent(serviceCatalogId)}`,
        body: { name: input.name, updated_at: new Date().toISOString() }
      });
    }
    const row = rows[0];
    return row ? { id: row.id, serviceKey: row.service_key, name: row.name, active: row.active } : null;
  }

  async deleteOrArchiveServiceCatalogItem(serviceCatalogId) {
    const usage = await this.request("project_services", {
      query: `service_catalog_id=eq.${encodeURIComponent(serviceCatalogId)}&select=id&limit=1`
    });
    if (usage.length) {
      const item = await this.updateServiceCatalogItem(serviceCatalogId, { active: false });
      return { action: "archived", item };
    }
    const rows = await this.request("service_catalog", {
      method: "DELETE",
      query: `id=eq.${encodeURIComponent(serviceCatalogId)}&select=id`,
      prefer: "return=representation"
    });
    return { action: "deleted", deleted: Array.isArray(rows) ? rows.length : 0 };
  }

  async createCluster(input) {
    const rows = await this.request("clusters", {
      method: "POST",
      body: [{ name: input.name }]
    });
    return { id: rows[0].id, name: rows[0].name };
  }

  async updateCluster(clusterId, input) {
    const rows = await this.request("clusters", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(clusterId)}`,
      body: { name: input.name }
    });
    return rows.length ? { id: rows[0].id, name: rows[0].name } : null;
  }

  async deleteCluster(clusterId) {
    const encodedId = encodeURIComponent(clusterId);
    const [clients, internalPocs] = await Promise.all([
      this.request("clients", {
        query: `cluster_id=eq.${encodedId}&select=id`
      }),
      this.request("internal_pocs", {
        query: `cluster_id=eq.${encodedId}&select=id`
      })
    ]);
    const deleted = await this.request("clusters", {
      method: "DELETE",
      query: `id=eq.${encodedId}&select=id`,
      prefer: "return=representation"
    });
    return {
      clustersDeleted: Array.isArray(deleted) ? deleted.length : 0,
      clientsUnassigned: clients.length,
      internalPocsUnassigned: internalPocs.length
    };
  }

  async clusterNameExists(name, exceptId = null) {
    const rows = await this.request("clusters", {
      query: `name=eq.${encodeURIComponent(name)}&select=id&limit=2`
    });
    return rows.some((row) => row.id !== exceptId);
  }

  async createClient(input) {
    const rows = await this.request("clients", {
      method: "POST",
      body: [{
        client_key: input.key,
        name: input.name,
        cluster_id: input.clusterId || null,
        active_status: input.activeStatus || "active"
      }]
    });
    return {
      id: rows[0].id,
      key: rows[0].client_key,
      name: rows[0].name,
      clusterId: rows[0].cluster_id,
      activeStatus: rows[0].active_status
    };
  }

  async updateClient(clientId, input) {
    const body = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) body.name = input.name;
    if (input.key !== undefined) body.client_key = input.key;
    if (input.clusterId !== undefined) body.cluster_id = input.clusterId || null;
    if (input.activeStatus !== undefined) body.active_status = input.activeStatus;

    const rows = await this.request("clients", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(clientId)}`,
      body
    });
    return rows.length
      ? {
          id: rows[0].id,
          key: rows[0].client_key,
          name: rows[0].name,
          clusterId: rows[0].cluster_id,
          activeStatus: rows[0].active_status
        }
      : null;
  }

  async clientKeyExists(key, exceptId = null) {
    const rows = await this.request("clients", {
      query: `client_key=eq.${encodeURIComponent(key)}&select=id&limit=2`
    });
    return rows.some((row) => row.id !== exceptId);
  }

  /** Has this session already raised an issue for this service? */
  async hasIssueForService(sessionId, serviceKey) {
    const rows = await this.request("issues", {
      query: `session_id=eq.${encodeURIComponent(sessionId)}&service_key=eq.${encodeURIComponent(serviceKey)}&select=id&limit=1`
    });
    return rows.length > 0;
  }

  /**
   * Feedback that is not about a mapped service — billing, a named person, a
   * process. It has no owner and no SLA, so it cannot be an issue, but
   * dropping it loses real feedback: a client told us his invoices were wrong
   * and it went nowhere.
   */
  async recordObservations(session, observations = []) {
    if (!observations.length) return [];

    const existing = await this.request("observations", {
      query: `session_id=eq.${encodeURIComponent(session.id)}&select=topic`
    });
    const seen = new Set(existing.map((row) => String(row.topic).toLowerCase()));

    const fresh = observations.filter((item) => !seen.has(String(item.topic).toLowerCase()));
    if (!fresh.length) return [];

    const rows = await this.request("observations", {
      method: "POST",
      body: fresh.map((item) => ({
        project_id: session.projectId,
        session_id: session.id,
        client_poc_id: session.clientPocId,
        topic: item.topic,
        detail: item.detail,
        sentiment: item.sentiment || "neutral",
        severity: item.severity || "watch"
      }))
    });
    return rows;
  }

  async listProjectObservations(projectId) {
    const rows = await this.request("observations", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&order=created_at.desc`
    });
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      clientPocId: row.client_poc_id,
      topic: row.topic,
      detail: row.detail,
      sentiment: row.sentiment,
      severity: row.severity,
      status: row.status,
      createdAt: row.created_at
    }));
  }

  /**
   * Everything one cycle produced, in a single payload: issues with their
   * service owner and that owner's manager, appreciations, observations, and
   * the scores.
   *
   * Built because per-issue emails meant a manager received four separate
   * messages about one conversation, each with a half-finished picture. One
   * message per project, once the cycle ends, is what a person can act on.
   */
  /** Has every session in this cycle finished? One email, once, at the end. */
  async isCycleComplete(cycleId) {
    const sessions = await this.listCycleSessions(cycleId);
    if (!sessions.length) return false;
    return sessions.every(sessionIsTerminal);
  }

  async cycleSummary(cycleId) {
    const cycles = await this.request("feedback_cycles", {
      query: `id=eq.${encodeURIComponent(cycleId)}&limit=1`
    });
    if (!cycles.length) return null;
    const cycle = toCycle(cycles[0]);

    const project = await this.getProjectById(cycle.projectId);
    const sessions = await this.listCycleSessions(cycleId);
    const sessionIds = sessions.map((item) => item.id);
    if (!sessionIds.length) return { cycle, project, sessions: [], issues: [], appreciations: [], observations: [] };

    const inList = sessionIds.map((id) => encodeURIComponent(id)).join(",");

    const [issueRows, observationRows, serviceRows] = await Promise.all([
      this.request("issues", { query: `session_id=in.(${inList})&order=created_at.asc` }),
      this.request("observations", { query: `session_id=in.(${inList})&order=created_at.asc` }),
      this.request("service_feedback", { query: `session_id=in.(${inList})&order=created_at.asc` })
    ]);

    // Each issue carries the person who owns that service ON THIS PROJECT, and
    // their manager. Routing by service is the whole point — an SEO complaint
    // must not land with the design lead.
    const ownerIds = [...new Set((project.services || []).map((svc) => svc.internalPocId).filter(Boolean))];
    const owners = ownerIds.length
      ? await this.request("internal_pocs", {
        query: `id=in.(${ownerIds.map((id) => encodeURIComponent(id)).join(",")})&select=id,name,email,reporting_manager_id`
      })
      : [];
    const ownersById = new Map(owners.map((row) => [row.id, row]));

    const managerIds = [...new Set(owners.map((row) => row.reporting_manager_id).filter(Boolean))];
    const managers = managerIds.length
      ? await this.request("internal_pocs", {
        query: `id=in.(${managerIds.map((id) => encodeURIComponent(id)).join(",")})&select=id,name,email`
      })
      : [];
    const managersById = new Map(managers.map((row) => [row.id, row]));

    const serviceByKey = new Map((project.services || []).map((svc) => [svc.serviceKey, svc]));
    const pocById = new Map((project.pocs || []).map((poc) => [poc.id, poc]));

    const issues = issueRows.map((row) => {
      const service = serviceByKey.get(row.service_key);
      const owner = service && service.internalPocId ? ownersById.get(service.internalPocId) : null;
      const manager = owner && owner.reporting_manager_id ? managersById.get(owner.reporting_manager_id) : null;
      const poc = pocById.get(row.client_poc_id);
      return {
        id: row.id,
        serviceKey: row.service_key,
        serviceName: row.service_name,
        title: row.title,
        rootCause: row.root_cause,
        severity: row.severity,
        raisedBy: poc ? poc.name : null,
        owner: owner ? { name: owner.name, email: owner.email } : null,
        manager: manager ? { name: manager.name, email: manager.email } : null
      };
    });

    // Only explicit praise is an appreciation. "SEO is fine" and "Website is
    // good so far" are ordinary service feedback; treating every positive
    // sentiment as praise filled the Appreciation section with casual remarks.
    const appreciations = [
      ...observationRows
        .filter((row) => row.sentiment === "positive"
          && readsAsExplicitAppreciation(`${row.topic || ""} ${row.detail || ""}`))
        .map((row) => ({ subject: row.topic, detail: row.detail, owner: null })),
      ...serviceRows
        .filter((row) => row.sentiment === "positive" && row.reason_text
          && readsAsExplicitAppreciation(row.reason_text))
        .map((row) => {
          const service = serviceByKey.get(row.service_key);
          const owner = service && service.internalPocId ? ownersById.get(service.internalPocId) : null;
          return {
            subject: row.service_name,
            detail: row.reason_text,
            owner: owner ? { name: owner.name, email: owner.email } : null
          };
        })
    ];

    return {
      cycle,
      project,
      sessions,
      issues,
      appreciations,
      observations: observationRows
        .filter((row) => row.sentiment !== "positive")
        .map((row) => ({
          topic: row.topic, detail: row.detail, severity: row.severity
        })),
      // Every internal address this cycle should reach, de-duplicated.
      recipients: [...new Set([
        ...issues.map((issue) => issue.owner && issue.owner.email),
        ...issues.map((issue) => issue.manager && issue.manager.email),
        ...appreciations.map((item) => item.owner && item.owner.email)
      ].filter(Boolean))]
    };
  }

  async createProject(input) {
    const interval = Number(input.feedbackIntervalDays) || 30;
    const rows = await this.request("projects", {
      method: "POST",
      body: [{
        client_id: input.clientId,
        project_key: input.key,
        name: input.name,
        goal: input.goal || null,
        active_status: input.activeStatus || "active",
        start_date: input.startDate || null,
        end_date: input.endDate || null,
        feedback_interval_days: interval,
        next_cycle_due_at: (input.activeStatus || "active") === "active"
          ? firstPulseDueAt(input.startDate, interval)
          : null
      }]
    });
    return toProject(rows[0]);
  }

  async updateProject(projectId, input) {
    const body = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) body.name = input.name;
    if (input.key !== undefined) body.project_key = input.key;
    if (input.clientId !== undefined) body.client_id = input.clientId;
    if (input.goal !== undefined) body.goal = input.goal || null;
    if (input.activeStatus !== undefined) body.active_status = input.activeStatus;
    if (input.startDate !== undefined) body.start_date = input.startDate || null;
    if (input.endDate !== undefined) body.end_date = input.endDate || null;
    if (input.feedbackIntervalDays !== undefined) body.feedback_interval_days = input.feedbackIntervalDays;

    const rows = await this.request("projects", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(projectId)}`,
      body
    });
    return rows.length ? toProject(rows[0]) : null;
  }

  /**
   * Older/admin-created projects can have no first pulse date. Initialising only
   * a missing value preserves the engine-owned cadence of projects that have
   * already started while allowing n8n workflow 8 to discover new imports.
   */
  async ensureProjectSchedule(projectId) {
    const rows = await this.request("projects", {
      query: `id=eq.${encodeURIComponent(projectId)}&select=id,start_date,feedback_interval_days,active_status,next_cycle_due_at&limit=1`
    });
    if (!rows.length || rows[0].active_status !== "active" || rows[0].next_cycle_due_at) return false;
    await this.request("projects", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(projectId)}`,
      body: {
        next_cycle_due_at: firstPulseDueAt(rows[0].start_date, rows[0].feedback_interval_days),
        updated_at: new Date().toISOString()
      }
    });
    return true;
  }

  async createClientPoc(input) {
    const levels = await this.pocLevels();
    const rows = await this.request("client_pocs", {
      method: "POST",
      body: [{
        project_id: input.projectId,
        name: input.name,
        designation: input.designation || null,
        contact_whatsapp: input.contactWhatsapp ? digits(input.contactWhatsapp) : null,
        contact_email: input.contactEmail || null,
        birth_date: input.birthDate || null,
        salutation: input.salutation || input.name,
        honorific: input.honorific || null,
        poc_level_id: input.levelId || null,
        weight_percentage: Number(input.weightPercentage) || 0,
        active: input.active === undefined ? true : Boolean(input.active)
      }]
    });
    return toClientPoc(rows[0], levels.get(rows[0].poc_level_id) || null);
  }

  async updateClientPoc(pocId, input) {
    const levels = await this.pocLevels();
    const body = { updated_at: new Date().toISOString() };
    if (input.projectId !== undefined) body.project_id = input.projectId;
    if (input.name !== undefined) body.name = input.name;
    if (input.designation !== undefined) body.designation = input.designation || null;
    if (input.contactWhatsapp !== undefined) {
      body.contact_whatsapp = input.contactWhatsapp ? digits(input.contactWhatsapp) : null;
    }
    if (input.contactEmail !== undefined) body.contact_email = input.contactEmail || null;
    if (input.birthDate !== undefined) body.birth_date = input.birthDate || null;
    if (input.salutation !== undefined) body.salutation = input.salutation || null;
    if (input.honorific !== undefined) body.honorific = input.honorific || null;
    if (input.levelId !== undefined) body.poc_level_id = input.levelId || null;
    if (input.weightPercentage !== undefined) body.weight_percentage = Number(input.weightPercentage) || 0;
    if (input.active !== undefined) body.active = Boolean(input.active);

    const rows = await this.request("client_pocs", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(pocId)}`,
      body
    });
    return rows.length ? toClientPoc(rows[0], levels.get(rows[0].poc_level_id) || null) : null;
  }

  async deleteClientPocs(pocIds = []) {
    const ids = [...new Set(pocIds.filter(Boolean))];
    if (!ids.length) return { pocsDeleted: 0, cyclesRecalculated: 0 };
    const encoded = ids.map((id) => encodeURIComponent(id));
    const sessions = await this.request("feedback_sessions", {
      query: `client_poc_id=in.(${encoded.join(",")})&select=cycle_id,project_id`
    });
    const deleted = await this.request("client_pocs", {
      method: "DELETE",
      query: `id=in.(${encoded.join(",")})&select=id`,
      prefer: "return=representation"
    });
    const affected = new Map(sessions.map((row) => [row.cycle_id, row.project_id]));
    let emptyCyclesDeleted = 0;
    for (const [cycleId, projectId] of affected) {
      const remaining = await this.listCycleSessions(cycleId);
      if (remaining.length) {
        await this.recomputeCycle(cycleId, projectId);
      } else {
        const rows = await this.request("feedback_cycles", {
          method: "DELETE",
          query: `id=eq.${encodeURIComponent(cycleId)}&select=id`,
          prefer: "return=representation"
        });
        emptyCyclesDeleted += Array.isArray(rows) ? rows.length : 1;
      }
    }
    return {
      pocsDeleted: Array.isArray(deleted) ? deleted.length : ids.length,
      cyclesRecalculated: affected.size - emptyCyclesDeleted,
      emptyCyclesDeleted
    };
  }

  async deleteProjects(projectIds = []) {
    const ids = [...new Set(projectIds.filter(Boolean))];
    if (!ids.length) return {
      projectsDeleted: 0,
      pocsDeleted: 0,
      servicesDeleted: 0,
      cyclesDeleted: 0,
      sessionsDeleted: 0,
      messagesDeleted: 0,
      serviceFeedbackDeleted: 0,
      observationsDeleted: 0,
      issuesDeleted: 0,
      issueEventsDeleted: 0
    };

    const encodedIds = ids.map((id) => encodeURIComponent(id));
    const projectFilter = `project_id=in.(${encodedIds.join(",")})`;
    const counts = {
      projectsDeleted: 0,
      pocsDeleted: 0,
      servicesDeleted: 0,
      cyclesDeleted: 0,
      sessionsDeleted: 0,
      messagesDeleted: 0,
      serviceFeedbackDeleted: 0,
      observationsDeleted: 0,
      issuesDeleted: 0,
      issueEventsDeleted: 0
    };

    // Do not depend on each database installation having identical ON DELETE
    // rules. Older databases used RESTRICT for observations.project_id, which
    // made a whole-client delete fail while trying to cascade through projects.
    // Removing every child explicitly also keeps project deletion retry-safe if
    // a network failure interrupts one of these idempotent requests.
    const sessions = await this.request("feedback_sessions", {
      query: `${projectFilter}&select=id`
    });
    const sessionIds = sessions.map((row) => row.id).filter(Boolean);

    const projectOwnedTables = [
      ["issue_events", "issueEventsDeleted"],
      ["issues", "issuesDeleted"],
      ["observations", "observationsDeleted"],
      ["service_feedback", "serviceFeedbackDeleted"]
    ];
    for (const [table, countKey] of projectOwnedTables) {
      const deletedRows = await this.request(table, {
        method: "DELETE",
        query: `${projectFilter}&select=id`,
        prefer: "return=representation"
      });
      counts[countKey] += Array.isArray(deletedRows) ? deletedRows.length : 0;
    }

    // Messages have no project_id of their own, so delete them through the
    // sessions collected before removing those sessions.
    for (let index = 0; index < sessionIds.length; index += 100) {
      const batch = sessionIds.slice(index, index + 100).map((id) => encodeURIComponent(id));
      const deletedMessages = await this.request("messages", {
        method: "DELETE",
        query: `session_id=in.(${batch.join(",")})&select=id`,
        prefer: "return=representation"
      });
      counts.messagesDeleted += Array.isArray(deletedMessages) ? deletedMessages.length : 0;
    }

    const remainingProjectTables = [
      ["feedback_sessions", "sessionsDeleted"],
      ["feedback_cycles", "cyclesDeleted"],
      ["client_pocs", "pocsDeleted"],
      ["project_services", "servicesDeleted"]
    ];
    for (const [table, countKey] of remainingProjectTables) {
      const deletedRows = await this.request(table, {
        method: "DELETE",
        query: `${projectFilter}&select=id`,
        prefer: "return=representation"
      });
      counts[countKey] += Array.isArray(deletedRows) ? deletedRows.length : 0;
    }

    const deleted = await this.request("projects", {
      method: "DELETE",
      query: `id=in.(${encodedIds.join(",")})&select=id`,
      prefer: "return=representation"
    });
    counts.projectsDeleted = Array.isArray(deleted) ? deleted.length : ids.length;
    return counts;
  }

  async deleteClients(clientIds = []) {
    const ids = [...new Set(clientIds.filter(Boolean))];
    if (!ids.length) return { clientsDeleted: 0 };
    const encodedIds = ids.map((id) => encodeURIComponent(id));
    const projects = await this.request("projects", {
      query: `client_id=in.(${encodedIds.join(",")})&select=id`
    });
    const projectCleanup = await this.deleteProjects(projects.map((project) => project.id));
    const deleted = await this.request("clients", {
      method: "DELETE",
      query: `id=in.(${encodedIds.join(",")})&select=id`,
      prefer: "return=representation"
    });
    return {
      clientsDeleted: Array.isArray(deleted) ? deleted.length : ids.length,
      ...projectCleanup
    };
  }

  async projectKeyExists(key, exceptId = null) {
    const rows = await this.request("projects", {
      query: `project_key=ilike.${encodeURIComponent(key)}&select=id&limit=2`
    });
    return rows.some((row) => row.id !== exceptId);
  }

  async whatsappOwner(phone, exceptId = null) {
    const value = digits(phone);
    if (!value) return null;
    const rows = await this.request("client_pocs", {
      query: `contact_whatsapp=eq.${encodeURIComponent(value)}&select=id,name,project_id&limit=5`
    });
    return rows.find((row) => row.id !== exceptId) || null;
  }

  /**
   * Reusing a WhatsApp number is valid across projects of the same client. It
   * remains invalid twice on one project or anywhere under another client.
   */
  async whatsappConflict(phone, projectId, exceptId = null) {
    const value = digits(phone);
    if (!value || !projectId) return null;
    const projectRows = await this.request("projects", {
      query: `id=eq.${encodeURIComponent(projectId)}&select=id,client_id&limit=1`
    });
    if (!projectRows.length) return { kind: "unknown_project", owner: null };
    const targetClientId = projectRows[0].client_id;
    const rows = await this.request("client_pocs", {
      query: `contact_whatsapp=eq.${encodeURIComponent(value)}&select=id,name,project_id,projects(client_id)&limit=50`
    });
    for (const row of rows) {
      if (row.id === exceptId) continue;
      if (row.project_id === projectId) return { kind: "same_project", owner: row };
      if (row.projects?.client_id !== targetClientId) return { kind: "different_client", owner: row };
    }
    return null;
  }

  async whatsappConflictForClient(phone, clientId) {
    const value = digits(phone);
    if (!value || !clientId) return null;
    const rows = await this.request("client_pocs", {
      query: `contact_whatsapp=eq.${encodeURIComponent(value)}&select=id,name,project_id,projects(client_id)&limit=50`
    });
    const conflicting = rows.find((row) => row.projects?.client_id !== clientId);
    return conflicting ? { kind: "different_client", owner: conflicting } : null;
  }

  async getDashboard() {
    const projects = await this.listProjects();
    const clusters = await this.request("clusters", { query: "select=*&order=name.asc" });
    const clients = await this.request("clients", { query: "select=id,client_key,name,cluster_id&order=name.asc" });
    const [activePocRows, scheduleEventRows] = await Promise.all([
      this.request("client_pocs", { query: "active=is.true&select=id,project_id,name,contact_whatsapp" }),
      this.request("automation_events", {
        query: "event_type=in.(cycle_start_skipped,quick_checkin_start_skipped)&select=*&order=created_at.desc&limit=200"
      })
    ]);

    const openIssues = await this.request("issues", {
      query: "status=neq.closed&select=id,project_id,session_id,client_poc_id,service_key,service_name,severity,title,root_cause,due_at,created_at,client_pocs(name)&order=created_at.desc"
    });

    const openCycleRows = await this.request("feedback_cycles", {
      query: "status=eq.open&cycle_type=neq.quick_checkin&select=*&order=started_at.desc"
    });

    // Every cycle, not just the open ones. The dashboard table expands a project
    // row into its cycles, and the date-range filter needs the full history.
    const allCycleRows = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.request("feedback_cycles", {
        query: `cycle_type=neq.quick_checkin&select=*&order=started_at.desc&limit=1000&offset=${offset}`
      });
      allCycleRows.push(...page);
      if (page.length < 1000) break;
    }

    // The main dashboard tracks every POC session, not only sessions
    // currently waiting for a reminder. One feedback cycle can contain several
    // POC sessions, and that distinction must remain visible.
    const responseRows = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.request("feedback_sessions", {
        query: `select=id,cycle_id,project_id,client_poc_id,status,completion_status,conversation_state,started_at,completed_at,last_client_response_at,reminder_due_at,reminder_count,csat_score,predicted_csat,csat_source,client_pocs(name),projects(project_key,name),feedback_cycles(cycle_type,status,started_at,closed_at)&order=started_at.desc&limit=1000&offset=${offset}`
      });
      responseRows.push(...page);
      if (page.length < 1000) break;
    }

    // Read only the latest client bubble for each listed session. Chunking keeps
    // PostgREST URLs bounded while avoiding a separate request per POC.
    const fullFeedbackResponseRows = responseRows.filter((row) => row.feedback_cycles?.cycle_type !== "quick_checkin");
    const responseSessionIds = fullFeedbackResponseRows.map((row) => row.id).filter(Boolean);
    const latestClientMessage = new Map();
    for (let index = 0; index < responseSessionIds.length; index += 100) {
      const ids = responseSessionIds.slice(index, index + 100).map((id) => encodeURIComponent(id));
      for (let offset = 0; ; offset += 1000) {
        const rows = await this.request("messages", {
          query: `session_id=in.(${ids.join(",")})&side=eq.client&select=session_id,body,created_at&order=created_at.desc&limit=1000&offset=${offset}`
        });
        for (const row of rows) {
          if (!latestClientMessage.has(row.session_id)) latestClientMessage.set(row.session_id, row);
        }
        if (rows.length < 1000) break;
      }
    }

    const scored = projects.filter((project) => project.csatScore !== null);
    const avgCsat = scored.length
      ? Math.round((scored.reduce((sum, p) => sum + p.csatScore, 0) / scored.length) * 10) / 10
      : null;

    const responseTracker = fullFeedbackResponseRows.map((row) => {
      const state = row.conversation_state || {};
      const exhausted = Boolean(state.reminderExhausted);
      const latestReply = latestClientMessage.get(row.id) || null;
      const stopped = Boolean(
        state.stoppedByAdmin
        || state.optedOut
        || row.status === "opted_out"
        || state.closureReason === "stopped_by_admin"
      );
      const completed = !stopped && (
        row.completion_status === "completed"
        || row.status === "completed"
      );
      const hasReply = Boolean(row.last_client_response_at || latestReply || row.completion_status === "partial");
      const responseStatus = stopped
        ? "stopped"
        : completed
          ? "completed"
          : hasReply
            ? "partial"
            : "awaiting";
      return {
        id: row.id,
        cycleId: row.cycle_id,
        projectId: row.project_id,
        projectKey: row.projects ? row.projects.project_key : null,
        projectName: row.projects ? row.projects.name : null,
        clientPocId: row.client_poc_id,
        pocName: row.client_pocs ? row.client_pocs.name : null,
        status: row.status,
        responseStatus,
        completionStatus: row.completion_status,
        cycleType: row.feedback_cycles ? row.feedback_cycles.cycle_type : null,
        cycleStatus: row.feedback_cycles ? row.feedback_cycles.status : null,
        cycleStartedAt: row.feedback_cycles ? row.feedback_cycles.started_at : row.started_at,
        cycleClosedAt: row.feedback_cycles ? row.feedback_cycles.closed_at : null,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        lastClientResponseAt: row.last_client_response_at,
        latestClientReply: latestReply ? latestReply.body : null,
        latestClientReplyAt: latestReply ? latestReply.created_at : row.last_client_response_at,
        reminderDueAt: row.reminder_due_at,
        reminderCount: Number(row.reminder_count) || 0,
        reminderExhausted: exhausted,
        stoppedByAdmin: Boolean(state.stoppedByAdmin),
        stoppedAt: state.stoppedAt || null,
        closedAt: state.stoppedAt || state.reminderClosedAt || row.completed_at || null,
        closureReason: state.closureReason || null,
        csatScore: num(row.csat_score),
        predictedCsat: num(row.predicted_csat),
        csatSource: row.csat_source || null
      };
    });

    return {
      clusters: clusters.map((row) => ({ id: row.id, name: row.name })),
      clients: clients.map((row) => ({
        id: row.id,
        key: row.client_key,
        name: row.name,
        clusterId: row.cluster_id
      })),
      projects,
      metrics: {
        projectCount: projects.length,
        avgCsat,
        openIssues: openIssues.length,
        openCycles: openCycleRows.length,
        atRisk: projects.filter((project) => project.riskLevel === "High").length
      },
      openIssues,
      openCycles: openCycleRows.map(toCycle),
      cycles: allCycleRows.map(toCycle),
      responseTracker,
      projectPocCounts: activePocRows.reduce((counts, row) => {
        counts[row.project_id] = (counts[row.project_id] || 0) + 1;
        return counts;
      }, {}),
      scheduleEvents: scheduleEventRows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        status: row.status,
        projectKey: row.payload?.projectKey || null,
        cycleType: row.payload?.cycleType || null,
        reason: row.payload?.reason || row.error || null,
        attemptedAt: row.created_at
      })),
      // Backward-compatible subset for the older follow-up panel/consumers.
      responseQueue: responseTracker.filter((session) =>
        ["started", "no_response", "partial"].includes(session.status)
      )
    };
  }

  /** Persist the deliberately small two-step quick-check-in conversation. */
  async applyQuickCheckinResponse(sessionId, input = {}) {
    const session = await this.getSession(sessionId);
    if (!session || session.sessionType !== "quick_checkin") {
      throw new Error("Quick check-in session not found");
    }

    const nowDate = new Date();
    const now = nowDate.toISOString();
    const detail = String(input.detail || "").trim();
    const waitingForDetail = input.outcome === "needs_improvement" && !detail;
    const previousState = session.conversationState || {};
    const previousDetail = String(previousState.quickCheckinDetail || "").trim();
    const combinedDetail = detail
      ? [previousDetail, detail].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join("\n\n")
      : previousDetail || null;
    const existingWindowExpiry = Date.parse(previousState.quickCheckinWindowExpiresAt || "");
    const windowExpiresAt = waitingForDetail
      ? null
      : Number.isFinite(existingWindowExpiry) && existingWindowExpiry > nowDate.getTime()
        ? new Date(existingWindowExpiry).toISOString()
        : new Date(nowDate.getTime() + (10 * 60 * 1000)).toISOString();
    const outcome = waitingForDetail
      ? "needs_improvement"
      : detail || previousState.quickCheckinOutcome === "feedback_shared"
        ? "feedback_shared"
        : "all_good";
    const conversationState = {
      ...previousState,
      state: waitingForDetail ? "quick_checkin_detail" : "quick_checkin_window",
      quickCheckinOutcome: outcome,
      quickCheckinDetail: combinedDetail,
      quickCheckinRespondedAt: previousState.quickCheckinRespondedAt || now,
      quickCheckinLastResponseAt: now,
      quickCheckinWindowExpiresAt: windowExpiresAt
    };

    const rows = await this.request("feedback_sessions", {
      method: "PATCH",
      query: `id=eq.${encodeURIComponent(sessionId)}`,
      body: {
        status: "partial",
        completion_status: "partial",
        conversation_state: conversationState,
        last_client_response_at: now,
        completed_at: null,
        reminder_due_at: waitingForDetail ? session.reminderDueAt : windowExpiresAt
      }
    });

    let observation = null;
    let issue = null;
    let service = null;
    let sentiment = "neutral";
    if (detail) {
      const interpretation = input.interpretation || {};
      const captured = Array.isArray(interpretation.captured) ? interpretation.captured : [];
      const observations = Array.isArray(interpretation.observations) ? interpretation.observations : [];
      const serviceKey = interpretation.serviceKeys?.[0] || captured[0]?.serviceKey || null;
      service = serviceKey
        ? (await this.servicesForProject(session.projectId)).find((item) => item.serviceKey === serviceKey) || null
        : null;
      const sentiments = [interpretation.sentiment, ...captured.map((item) => item.sentiment), ...observations.map((item) => item.sentiment)];
      sentiment = sentiments.includes("negative") ? "negative" : sentiments.includes("positive") ? "positive" : "neutral";
      const severity = sentiment === "negative" ? "watch" : "info";

      const observationRows = await this.request("observations", {
        method: "POST",
        body: [{
          project_id: session.projectId,
          session_id: session.id,
          client_poc_id: session.clientPocId,
          topic: service ? service.name : "Quick check-in",
          detail,
          sentiment,
          severity,
          status: "open"
        }]
      });
      observation = observationRows[0] || null;

      if (sentiment === "negative") {
        const issueRows = await this.request("issues", {
          method: "POST",
          query: "on_conflict=session_id,service_key",
          prefer: "resolution=ignore-duplicates,return=representation",
          body: [{
            project_id: session.projectId,
            session_id: session.id,
            client_poc_id: session.clientPocId,
            service_key: service ? service.serviceKey : "quick_checkin",
            service_name: service ? service.name : "Quick check-in",
            severity,
            status: "open",
            title: detail.slice(0, 160),
            root_cause: detail,
            internal_poc_id: service ? service.internalPocId : null,
            sla: "48h",
            due_at: addHours(new Date(), 48)
          }]
        });
        issue = issueRows[0] || null;
        if (issue) {
          await this.request("issue_events", {
            method: "POST",
            body: [{
              issue_id: issue.id,
              project_id: session.projectId,
              session_id: session.id,
              action: "created",
              next_status: "open",
              note: "Created from quick check-in"
            }]
          });
        }
      }
    }

    const updatedSession = toSession(rows[0], {
      cycleType: session.sessionType,
      pocName: session.pocName,
      pocWeight: session.pocWeight
    });
    await this.recomputeCycle(session.cycleId, session.projectId);
    return { session: updatedSession, observation, issue, service, sentiment };
  }

  async hasScheduledQuickCheckin(projectId, scheduleKey) {
    const rows = await this.request("feedback_cycles", {
      query: `project_id=eq.${encodeURIComponent(projectId)}&cycle_type=eq.quick_checkin&schedule_key=eq.${encodeURIComponent(scheduleKey)}&select=id&limit=1`
    });
    return rows.length > 0;
  }

  async getDueQuickCheckinTargets(nowIso = new Date().toISOString()) {
    const scheduleKey = quickCheckinScheduleKey(nowIso);
    if (!scheduleKey) return { scheduleKey: null, targets: [] };
    const projects = await this.listProjects();
    const targets = [];
    for (const project of projects) {
      if (project.activeStatus !== "active" || project.clientActiveStatus !== "active") continue;
      if (await this.hasScheduledQuickCheckin(project.id, scheduleKey)) continue;
      targets.push({ projectKey: project.key, cycleType: "quick_checkin", scheduleKey });
    }
    return { scheduleKey, targets };
  }

  async expireDueQuickCheckins(nowIso = new Date().toISOString()) {
    const rows = await this.request("feedback_sessions", {
      query: `reminder_due_at=lte.${encodeURIComponent(nowIso)}&status=in.(started,partial)&select=*,feedback_cycles(cycle_type)&order=reminder_due_at.asc`
    });
    const due = rows.filter((row) => row.feedback_cycles?.cycle_type === "quick_checkin");
    const cycleIds = new Set();
    for (const row of due) {
      const state = row.conversation_state || {};
      const completedWindow = state.state === "quick_checkin_window";
      await this.request("feedback_sessions", {
        method: "PATCH",
        query: `id=eq.${encodeURIComponent(row.id)}`,
        body: {
          status: "completed",
          completion_status: completedWindow
            ? "completed"
            : state.state === "quick_checkin_detail" ? "partial" : "not_started",
          completed_at: nowIso,
          reminder_due_at: null,
          conversation_state: {
            ...state,
            state: "completed",
            reminderExhausted: !completedWindow,
            closureReason: completedWindow ? "quick_checkin_window_elapsed" : "quick_checkin_expired",
            quickCheckinWindowClosedAt: completedWindow ? nowIso : state.quickCheckinWindowClosedAt || null,
            quickCheckinOutcome: completedWindow
              ? state.quickCheckinOutcome
              : state.state === "quick_checkin_detail" ? "awaiting_details_expired" : "no_response"
          }
        }
      });
      cycleIds.add(row.cycle_id);
    }
    for (const cycleId of cycleIds) {
      const session = due.find((row) => row.cycle_id === cycleId);
      await this.recomputeCycle(cycleId, session.project_id);
    }
    return { expired: due.length };
  }
}

module.exports = {
  SupabaseStore,
  aggregateCycle,
  groupAllocationWeights,
  MAX_REMINDERS,
  REMINDER_INTERVAL_HOURS,
  sessionIsTerminal,
  quickCheckinScheduleKey
};
