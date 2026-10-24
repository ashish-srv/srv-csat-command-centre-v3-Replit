import { MultiSelect } from './Filters.jsx';

export default function UserClusterAccess({ user, clusters, onChange, isSuperAdmin }) {
  const rows = user.clusterAccess || [];
  return <div style={{ gridColumn: '1 / -1', padding: '12px', background: '#f2f6fc', borderRadius: '8px' }}>
    {user.role === 'super_admin' ? <strong>All Clusters · Always Receives CSAT Summary and Handoff Emails</strong> : <>
      <MultiSelect label="Assigned Clusters" options={clusters.map(row => row.id)} selected={rows.map(row => row.clusterId)} allLabel="No clusters assigned"
        renderOption={id => clusters.find(row => row.id === id)?.name || id}
        onChange={ids => onChange({ clusterAccess: ids.map(clusterId => ({ clusterId, emailEnabled: user.role === 'admin' && rows.find(row => row.clusterId === clusterId)?.emailEnabled === true })) })} />
      {user.role === 'admin' ? <>
        <p className="form-note">Access is limited to these clusters. Email switches do not change access. No clusters means no project data.</p>
        {rows.map(row => <label key={row.clusterId} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0' }}>
          <input type="checkbox" checked={row.emailEnabled === true} onChange={event => onChange({ clusterAccess: rows.map(item => item.clusterId === row.clusterId ? { ...item, emailEnabled: event.target.checked } : item) })} />
          Send CSAT Summary Emails — {clusters.find(cluster => cluster.id === row.clusterId)?.name || row.clusterId}
        </label>)}
      </> : <p className="form-note">Project Users see only their assigned Project Performance projects. These clusters do not grant CSAT access or email notifications.</p>}
    </>}
    {isSuperAdmin && user.role === 'project_user' ? <label style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' }}>
      <input type="checkbox" checked={user.externalLoginAllowed === true} onChange={event => onChange({ externalLoginAllowed: event.target.checked })} />
      Approve This Exact External Google Email (Including Gmail)
    </label> : null}
  </div>;
}
