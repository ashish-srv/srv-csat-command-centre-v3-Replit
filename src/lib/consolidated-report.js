import { conversationReportSections } from './report-export';
import { formatCycleType, formatDateTime, formatSessionOutcome } from '../format';

const recordColumns = [
  { key: 'subject', label: 'Subject', width: 28 },
  { key: 'status', label: 'Status / Classification', width: 30 },
  { key: 'when', label: 'Recorded', width: 24 },
  { key: 'detail', label: 'Saved Detail', width: 100 }
];
const titleCase = value => String(value || '').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());

// Cycle aggregates combine different people's feedback; never attribute those
// to an individual. Only exact session-linked records belong in a POC section.
export function projectFeedbackSections(project, workspace, cycles, groups) {
  const sections = [];
  const bySession = new Map(groups.map(group => [group.session.id, group]));
  const pocs = new Map((workspace.pocs || []).map(poc => [poc.id, poc.name]));
  const projectContext = { clientId: project.clientId, client: project.clientName,
    projectId: project.id, project: project.name, projectKey: project.key,
    cluster: project.clusterName, projectStatus: titleCase(project.activeStatus) };
  for (const cycle of [...cycles].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))) {
    const context = { ...projectContext, cycleId: cycle.id,
      cycle: `${formatCycleType(cycle.cycleType)} · ${formatDateTime(cycle.startedAt)}`,
      cycleStatus: titleCase(cycle.status) };
    if (!cycle.sessions?.length) sections.push({ title: 'POC Sessions', context, columns: recordColumns, rows: [], emptyText: 'No POC sessions saved for this cycle.' });
    for (const original of [...(cycle.sessions || [])].sort((a, b) => String(a.pocName || pocs.get(a.clientPocId) || '').localeCompare(String(b.pocName || pocs.get(b.clientPocId) || '')) || String(a.id).localeCompare(String(b.id)))) {
      const group = bySession.get(original.id);
      const session = group?.session || original;
      const poc = session.pocName || pocs.get(session.clientPocId) || group?.poc?.name || 'Unknown POC';
      const scope = { ...context, pocId: session.clientPocId || session.id, poc, sessionId: session.id };
      const quick = cycle.cycleType === 'quick_checkin';
      sections.push({ title: 'Ratings and Response', context: scope, columns: [
        { key: 'metric', label: 'Measure', width: 28 }, { key: 'value', label: 'Value', width: 30 },
        { key: 'when', label: 'Date', width: 24 }, { key: 'detail', label: 'Notes', width: 100 }
      ], rows: [
        { metric: 'Client CSAT / 10', value: quick ? 'Not collected' : session.csatSource === 'predicted' ? 'Not provided' : session.csatScore ?? 'Not provided', when: formatDateTime(session.startedAt), detail: 'Client-stated overall rating; not NPS or an estimate.' },
        { metric: 'NPS / 10', value: cycle.cycleType === 'project_end' ? session.npsScore ?? 'Not provided' : 'Not collected', detail: 'Client-stated recommendation score.' },
        { metric: 'Estimated CSAT / 10', value: quick ? 'Not collected' : session.predictedCsat ?? (session.csatSource === 'predicted' ? session.csatScore : null) ?? 'Not estimated', detail: 'System estimate — not a client rating.' },
        { metric: 'Response Status', value: formatSessionOutcome(session), when: session.completedAt ? formatDateTime(session.completedAt) : '', detail: `Session ID: ${session.id}` }
      ] });
      const belongs = item => item.sessionId === session.id;
      const issues = (workspace.issues || []).filter(belongs);
      const observations = (workspace.observations || []).filter(belongs);
      const services = Object.values(session.conversationState?.mentionedServices || {}).filter(service => service.reasonText);
      const records = [
        ['Concerns and Issues', issues.map(issue => ({ subject: issue.title, status: `${titleCase(issue.status)} · ${titleCase(issue.severity)}`, when: formatDateTime(issue.createdAt), detail: [issue.serviceName && `Service: ${issue.serviceName}`, issue.rootCause !== issue.title && issue.rootCause, issue.resolutionNote && `Resolution: ${issue.resolutionNote}`, issue.closedAt && `Closed: ${formatDateTime(issue.closedAt)}`].filter(Boolean).join('\n') }))],
        ['Appreciations', [
          ...observations.filter(item => item.sentiment === 'positive').map(item => ({ subject: item.topic, status: 'Appreciation', when: formatDateTime(item.createdAt), detail: item.detail })),
          ...services.filter(item => item.explicitAppreciation === true && !observations.some(obs => obs.detail === item.reasonText)).map(item => ({ subject: item.serviceName, status: 'Service Appreciation', detail: item.reasonText }))
        ]],
        ['Other Feedback', observations.filter(item => item.sentiment !== 'positive').map(item => ({ subject: item.topic, status: titleCase(item.sentiment), when: formatDateTime(item.createdAt), detail: item.detail }))],
        ['Service Feedback', services.filter(item => item.explicitAppreciation !== true).map(item => ({ subject: item.serviceName || item.serviceKey, status: titleCase(item.sentiment), detail: item.reasonText }))]
      ];
      for (const [title, rows] of records) sections.push({ title, context: scope, columns: recordColumns, rows,
        note: 'Saved system records for this POC and session; separate from the original transcript.', emptyText: `No ${title.toLowerCase()} recorded for this session.` });
      const [chat] = conversationReportSections([{ session: { ...session, reportCycle: cycle }, messages: group?.messages || [] }],
        { pocNameById: pocs, cycleLabel: formatCycleType, dateLabel: formatDateTime });
      sections.push({ ...chat, title: 'Original Conversation', context: scope,
        columns: [chat.columns[0], chat.columns[1], { key: 'spacer', label: '', width: 24 }, chat.columns[2]],
        note: 'Original saved messages only. No interpretation labels or added commentary.' });
    }
  }
  if (!cycles.length) sections.push({ title: 'Feedback Cycles', context: projectContext, columns: recordColumns, rows: [], emptyText: 'No feedback cycles match the selected type and date filters.' });
  return sections;
}
