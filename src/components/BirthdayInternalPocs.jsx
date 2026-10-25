import { useState } from 'react';
import { apiWriteWithAdminPin } from '../api';
import { MultiSelect } from './Filters.jsx';
import { Button } from './Ui.jsx';
import BirthdaySection from './BirthdaySection.jsx';

const emptyOwner = () => ({ name: '', email: '', phone: '', clusterIds: [] });

export default function BirthdayInternalPocs({ directory, contacts = [], canAdd, onCreated }) {
  const [draft, setDraft] = useState(emptyOwner), [password, setPassword] = useState('');
  const [query, setQuery] = useState(''), [adding, setAdding] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const assignedContacts = person => contacts.filter(c => !c.removedAt && c.internalPocIds?.includes(person.id));
  const assigned = directory.internalPocs.filter(p => assignedContacts(p).length);
  const rows = assigned.filter(p => `${p.name} ${p.email} ${assignedContacts(p).map(c => `${c.name} ${c.organization}`).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
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
      setNotice('Internal POC saved. Assign this person in a birthday contact’s Responsible Internal POCs field; they will then appear in this list. No application access was created.');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <BirthdaySection id="birthday-internal-pocs" title="Internal Gift POCs — Email Recipients" notice={notice}>
    <p>Only Internal POCs assigned to birthday contacts are listed here. Active assigned POCs with a valid email receive gift-selection and reminder emails and can respond through the secure links, without an Application User account.</p>
    <label className="birthday-search">Search Assigned Gift POCs<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, email or assigned birthday contact" /></label>
    <div className="birthday-bounded" tabIndex={0} role="region" aria-label="Internal birthday POCs">
      {rows.map(p => <div key={p.id} className="birthday-owner-row"><strong>{p.name}</strong><span>{p.email || 'Email missing'}</span><span className={`birthday-badge ${p.active !== false ? 'good' : ''}`}>{p.active !== false ? 'Active' : 'Inactive'}</span><small className="birthday-owner-assignments">Assigned to: {assignedContacts(p).map(c => `${c.name} · ${c.organization}`).join('; ')}</small></div>)}
      {!rows.length ? <p>{assigned.length ? 'No assigned gift POCs match this search.' : 'No gift POCs have been assigned yet. Edit a birthday contact and select its Responsible Internal POCs.'}</p> : null}
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
