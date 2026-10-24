import { useState } from 'react';
import { FileText, ChevronDown } from 'lucide-react';
import { apiGet } from '../api';
import { projectFeedbackSections } from '../lib/consolidated-report';
import { formatCycleType } from '../format';
import { MultiSelect, DateRange, cycleInRange } from './Filters.jsx';
import ReportDownloads from './ReportDownloads.jsx';

export default function ConsolidatedFeedbackExport({ projects }) {
  const [clusters, setClusters] = useState([]);
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState([]);
  const [types, setTypes] = useState([]);
  const [range, setRange] = useState({ from: '', to: '', basis: 'started' });
  const [error, setError] = useState('');
  const [statuses, setStatuses] = useState([]);
  const [dateRevision, setDateRevision] = useState(0);
  const clusterProjects = projects.filter(row => !clusters.length || clusters.includes(row.clusterId));
  const candidates = clusterProjects.filter(row => (!clients.length || clients.includes(row.clientId)) && (!statuses.length || statuses.includes(row.activeStatus)));
  const chosen = candidates.filter(row => !selected.length || selected.includes(row.id));
  const clusterOptions = [...new Set(projects.map(row => row.clusterId).filter(Boolean))];
  const clientOptions = [...new Set(clusterProjects.map(row => row.clientId))];
  const label = (field, id) => projects.find(row => row[field + 'Id'] === id)?.[field + 'Name'] || id;
  const reset = () => { setClusters([]); setClients([]); setSelected([]); setTypes([]); setStatuses([]); setRange({ from: '', to: '', basis: 'started' }); setDateRevision(value => value + 1); setError(''); };

  async function buildReport() {
    setError('');
    if (!chosen.length) throw new Error('No accessible projects match these filters. Clear or change the filters.');
    if (range.from && range.to && range.from > range.to) throw new Error('The start date must be on or before the end date.');
    const sections = [];
    // Export only accessible matching projects; fail visibly if any request fails.
    for (const project of [...chosen].sort((a, b) => String(a.clientName).localeCompare(String(b.clientName)) || String(a.clientId).localeCompare(String(b.clientId)) || String(a.name).localeCompare(String(b.name)))) {
      const workspace = await apiGet('/api/projects/' + encodeURIComponent(project.key) + '/workspace');
      const cycles = (workspace.cycles || []).filter(cycle => (!types.length || types.includes(cycle.cycleType)) && cycleInRange(cycle, range));
      const groups = [];
      for (const cycle of cycles) {
        for (const session of cycle.sessions || []) {
          const result = await apiGet('/api/sessions/' + encodeURIComponent(session.id));
          groups.push({ session: { ...session, ...result.session }, poc: result.poc, messages: result.messages || [] });
        }
      }
      sections.push(...projectFeedbackSections(project, workspace, cycles, groups));
    }
    const dateLabel = value => new Date(value + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const reportingPeriod = range.from && range.to ? `${dateLabel(range.from)} to ${dateLabel(range.to)}`
      : range.from ? `From ${dateLabel(range.from)}` : range.to ? `Up to ${dateLabel(range.to)}` : 'All Dates';
    return { title: 'CSAT Report', consolidated: true,
      subtitle: 'Consolidated Feedback and Conversations', reportingPeriod,
      generatedAt: new Date().toISOString(), metrics: [
        { label: 'Clients', value: new Set(chosen.map(row => row.clientId)).size },
        { label: 'Projects', value: chosen.length },
        { label: 'POC Sessions', value: sections.filter(section => section.chatSessions).length }
      ], filters: [
        { label: 'Clusters', value: clusters.length ? clusters.map(id => label('cluster', id)).join(', ') : 'All Accessible' },
        { label: 'Clients', value: clients.length ? clients.map(id => label('client', id)).join(', ') : 'All Matching' },
        { label: 'Projects', value: selected.length ? chosen.map(row => row.name).join(', ') : 'All Matching' },
        { label: 'Project Status', value: statuses.length ? statuses.join(', ') : 'All' },
        { label: 'Feedback Type', value: types.length ? types.map(formatCycleType).join(', ') : 'All' },
        { label: 'Cycle Start Dates', value: (range.from || 'Any Start') + ' to ' + (range.to || 'Any End') }
      ], sections };
  }

  return <details className="consolidated-export">
    <summary className="consolidated-export-heading">
      <span className="consolidated-export-icon"><FileText size={23} aria-hidden="true" /></span>
      <span><strong>Consolidated Feedback and Chat Export</strong><small>One organised report across your clients and projects</small></span>
      <ChevronDown size={20} className="consolidated-export-chevron" aria-hidden="true" />
    </summary>
    <div className="consolidated-export-body">
      <p>Select what to include. An empty filter includes all accessible matching records. Dates filter the cycle start date.</p>
      <div className="filter-bar consolidated-export-filters">
        <MultiSelect label="Clusters" options={clusterOptions} selected={clusters} renderOption={id => label('cluster', id)} onChange={ids => { setClusters(ids); setClients([]); setSelected([]); }} />
        <MultiSelect label="Clients" options={clientOptions} selected={clients} renderOption={id => label('client', id)} onChange={ids => { setClients(ids); setSelected([]); }} />
        <MultiSelect label="Project Status" options={['active', 'paused', 'closed']} selected={statuses} renderOption={value => value[0].toUpperCase() + value.slice(1)} onChange={ids => { setStatuses(ids); setSelected([]); }} />
        <MultiSelect label="Projects" options={candidates.map(row => row.id)} selected={selected} renderOption={id => { const row = projects.find(item => item.id === id); return row ? row.name + ' · ' + row.clientName : id; }} onChange={setSelected} />
        <MultiSelect label="Feedback Type" options={['pulse', 'project_end', 'quick_checkin']} selected={types} renderOption={formatCycleType} onChange={setTypes} />
        <DateRange key={dateRevision} range={range} onChange={setRange} />
        <button type="button" className="filter-reset" onClick={reset}>Reset All</button>
      </div>
      <div className="consolidated-export-footer"><p><strong>{chosen.length} matching projects</strong><span>Ratings, saved feedback and separate POC conversations. PDF opens Print / Save as PDF.</span></p>
        <ReportDownloads getReport={buildReport} fileName="Consolidated_Feedback_Chats" onError={setError} />
      </div>
      {error ? <p role="alert" className="consolidated-export-error">{error}</p> : null}
    </div>
  </details>;
}
