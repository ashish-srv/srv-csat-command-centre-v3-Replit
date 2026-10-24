import { useState } from 'react';
import { apiGet } from '../api';
import { conversationReportSections } from '../lib/report-export';
import { formatCycleType, formatDateTime } from '../format';
import { MultiSelect, DateRange, cycleInRange } from './Filters.jsx';
import ReportDownloads from './ReportDownloads.jsx';

export default function ConsolidatedFeedbackExport({ projects }) {
  const [clusters, setClusters] = useState([]);
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState([]);
  const [types, setTypes] = useState([]);
  const [range, setRange] = useState({ from: '', to: '', basis: 'started' });
  const [error, setError] = useState('');
  const clusterProjects = projects.filter(row => !clusters.length || clusters.includes(row.clusterId));
  const candidates = clusterProjects.filter(row => !clients.length || clients.includes(row.clientId));
  const chosen = candidates.filter(row => !selected.length || selected.includes(row.id));
  const clusterOptions = [...new Set(projects.map(row => row.clusterId).filter(Boolean))];
  const clientOptions = [...new Set(clusterProjects.map(row => row.clientId))];

  async function buildReport() {
    setError('');
    if (!chosen.length) throw new Error('Select at least one accessible project.');
    const sections = [];
    // Bound network concurrency and fail visibly rather than silently exporting
    // an incomplete report. Every request is checked again by the server.
    for (const project of chosen) {
      const workspace = await apiGet(`/api/projects/${encodeURIComponent(project.key)}/workspace`);
      const cycles = (workspace.cycles || []).filter(cycle => (!types.length || types.includes(cycle.cycleType)) && cycleInRange(cycle, range));
      const sessions = cycles.flatMap(cycle => (cycle.sessions || []).map(session => ({ ...session, reportCycle: cycle })));
      const pocNames = new Map((workspace.pocs || []).map(poc => [poc.id, poc.name]));
      sections.push({ title: `${project.clientName} — ${project.name}`, sheetName: `Ratings ${project.key}`, columns: [
        { key: 'cluster', label: 'Cluster', width: 20 }, { key: 'client', label: 'Client', width: 24 },
        { key: 'project', label: 'Project', width: 30 }, { key: 'poc', label: 'Client POC', width: 25 },
        { key: 'type', label: 'Feedback Type', width: 24 }, { key: 'date', label: 'Started', width: 24 },
        { key: 'csat', label: 'Client CSAT / 10', width: 20 }, { key: 'nps', label: 'NPS / 10', width: 18 },
        { key: 'estimatedCsat', label: 'Estimated CSAT / 10 (Not Client Rating)', width: 28 }, { key: 'status', label: 'Status', width: 20 }
      ], rows: sessions.map(session => ({ cluster: project.clusterName, client: project.clientName, project: project.name,
        poc: session.pocName || pocNames.get(session.clientPocId), type: formatCycleType(session.reportCycle.cycleType), date: formatDateTime(session.startedAt),
        csat: session.reportCycle.cycleType === 'quick_checkin' ? 'Not collected' : session.csatSource === 'predicted' ? 'Not provided' : session.csatScore ?? 'Not provided',
        estimatedCsat: session.reportCycle.cycleType === 'quick_checkin' ? 'Not collected' : session.predictedCsat ?? (session.csatSource === 'predicted' ? session.csatScore : null) ?? 'Not estimated',
        nps: session.reportCycle.cycleType !== 'project_end' ? 'Not collected' : session.npsScore ?? 'Not provided', status: session.completionStatus || session.status })) });
      const groups = [];
      for (const session of sessions) {
        const result = await apiGet(`/api/sessions/${encodeURIComponent(session.id)}`);
        groups.push({ session, messages: result.messages || [] });
      }
      sections.push(...conversationReportSections(groups, { pocNameById: pocNames, cycleLabel: formatCycleType, dateLabel: formatDateTime })
        .map(section => ({ ...section, title: `${project.name} — ${section.title}`, sheetName: `${project.key} ${section.sheetName}` })));
    }
    return { title: 'Consolidated Feedback and Conversations', subtitle: `${chosen.length} projects · Original saved messages, grouped by project, POC and session`, generatedAt: new Date().toISOString(), sections };
  }

  return <details className="admin-collapsible-panel" style={{ marginBottom: '16px' }}>
    <summary><strong>Consolidated Feedback and Chat Export</strong></summary>
    <div className="admin-collapsible-body">
      <p>Select the clusters, clients, projects, feedback types and dates to include. An empty filter means all accessible matching records.</p>
      <div className="filter-bar">
        <MultiSelect label="Clusters" options={clusterOptions} selected={clusters} renderOption={id => projects.find(row => row.clusterId === id)?.clusterName || id} onChange={ids => { setClusters(ids); setClients([]); setSelected([]); }} />
        <MultiSelect label="Clients" options={clientOptions} selected={clients} renderOption={id => projects.find(row => row.clientId === id)?.clientName || id} onChange={ids => { setClients(ids); setSelected([]); }} />
        <MultiSelect label="Projects" options={candidates.map(row => row.id)} selected={selected} renderOption={id => projects.find(row => row.id === id)?.name || id} onChange={setSelected} />
        <MultiSelect label="Feedback Type" options={['pulse', 'project_end', 'quick_checkin']} selected={types} renderOption={formatCycleType} onChange={setTypes} />
        <DateRange range={range} onChange={setRange} />
      </div>
      <p>{chosen.length} matching projects. Transcripts contain the original conversation only, without interpretation labels.</p>
      <ReportDownloads getReport={buildReport} fileName="Consolidated_Feedback_Chats" onError={setError} />
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </details>;
}
