import { useState } from 'react';
import { apiWriteWithAdminPin } from '../api';
import { MultiSelect } from './Filters.jsx';
import { Button } from './Ui.jsx';
import BirthdaySection from './BirthdaySection.jsx';

const emptyOwner = () => ({ name: '', email: '', phone: '', clusterIds: [] });

export default function BirthdayInternalPocs({ directory, canAdd, onCreated }) {
  const [draft, setDraft] = useState(emptyOwner), [password, setPassword] = useState('');
  const [query, setQuery] = useState(''), [adding, setAdding] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const rows = directory.internalPocs.filter(p => `${p.name} ${p.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  async function save(event) {
    event.preventDefault(); setError(''); setNotice('');
    if (directory.internalPocs.some(p => p.email?.trim().toLowerCase() === draft.email.trim().toLowerCase())) {
      setError('This email already belongs to an Internal POC. Select that existing person when editing the birthday contact; inactive records can be updated in Manage.'); return;
    }
    setBusy(true);
    try {
      // Reuse the existing Internal POC permission, cluster checks and Manage
      // password protection. This endpoint never creates an application user.
      const result = await apiWriteWithAdminPin('/api/admin/internal-pocs', {
        name: draft.name.trim(), email: draft.email.trim().toLowerCase(), phone: draft.phone.trim(),
        clusterIds: draft.clusterIds, active: true
      }, 'POST', password);
      onCreated(result.internalPoc);
      setDraft(emptyOwner()); setPassword(''); setAdding(false);
      setNotice('Internal POC saved. No application access was created. Assign this person to the relevant birthday contacts.');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <BirthdaySection id="birthday-internal-pocs" title="Internal Gift POCs — Email Recipients" notice={notice}>
    <p>These people can receive gift-selection and reminder emails without an Application User account. Assign one or more active POCs to each birthday contact. They can respond using the secure links in their emails; this does not grant dashboard or CSAT access.</p>
    <label className="birthday-search">Search Internal POCs<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name or email" /></label>
    <div className="birthday-bounded" tabIndex={0} role="region" aria-label="Internal birthday POCs">
      {rows.map(p => <div key={p.id} className="birthday-owner-row"><strong>{p.name}</strong><span>{p.email || 'Email missing'}</span><span className={`birthday-badge ${p.active !== false ? 'good' : ''}`}>{p.active !== false ? 'Active' : 'Inactive'}</span></div>)}
      {!rows.length ? <p>No Internal POCs match this search.</p> : null}
    </div>
    {canAdd ? <div className="birthday-actions"><Button disabled={busy} onClick={() => { setAdding(value => !value); setError(''); setPassword(''); }}>{adding ? 'Minimise Add Form' : 'Add Internal POC Without App Access'}</Button></div> : <p>An authorised user with Internal POC management permission can add new people. Existing POCs remain available for birthday assignments.</p>}
    {canAdd && adding ? <form onSubmit={save} className="birthday-owner-form">
      <div className="birthday-form-grid">
        <label>Name<input required maxLength={250} value={draft.name} onChange={e => setDraft(old => ({ ...old, name: e.target.value }))} /></label>
        <label>Email<input required type="email" maxLength={250} value={draft.email} onChange={e => setDraft(old => ({ ...old, email: e.target.value }))} /></label>
        <label>Phone (Optional)<input type="tel" value={draft.phone} onChange={e => setDraft(old => ({ ...old, phone: e.target.value }))} /></label>
        <MultiSelect label="Assigned Clusters" options={directory.clusters.map(c => c.id)} selected={draft.clusterIds} allLabel="Select Clusters" renderOption={id => directory.clusters.find(c => c.id === id)?.name || id} onChange={clusterIds => setDraft(old => ({ ...old, clusterIds }))} />
        <label>Manage Password<input required type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      </div>
      {error ? <p className="birthday-reason" role="alert">{error}</p> : null}
      <div className="birthday-actions"><button type="submit" className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save Internal POC Only'}</button><Button disabled={busy} onClick={() => { setAdding(false); setDraft(emptyOwner()); setPassword(''); setError(''); }}>Cancel</Button></div>
    </form> : null}
  </BirthdaySection>;
}
