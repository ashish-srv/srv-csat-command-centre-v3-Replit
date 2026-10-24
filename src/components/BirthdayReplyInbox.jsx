import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../api';
import { SingleSelect } from './Filters.jsx';
import { Button, Panel } from './Ui.jsx';

const stamp = value => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

export default function BirthdayReplyInbox({ year, canManage, refreshToken }) {
  const [status, setStatus] = useState('awaiting_review'), [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [page, setPage] = useState(0), [result, setResult] = useState({ replies: [], hasMore: false });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const requestRef = useRef(0);
  const filterKey = `${year}:${status}:${query}:${page}`;
  const viewRef = useRef(filterKey);
  viewRef.current = filterKey;
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 250); return () => window.clearTimeout(timer); }, [search]);
  async function load() {
    if (viewRef.current !== filterKey) return;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const next = await apiGet(`/api/birthdays/replies?${new URLSearchParams({ year: String(year), status, search: query, offset: String(page * 50) })}`);
      if (request === requestRef.current && viewRef.current === filterKey) { setResult(next); setError(''); }
    } catch (e) { if (request === requestRef.current && viewRef.current === filterKey) setError(e.message); }
    finally { if (request === requestRef.current && viewRef.current === filterKey) setLoading(false); }
  }
  useEffect(() => {
    load();
    const refresh = () => { if (!document.hidden) load(); };
    const timer = window.setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', refresh);
    return () => { requestRef.current++; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [year, status, query, page, refreshToken]);
  async function review(id) {
    setBusy(id); setError(''); setNotice('');
    try { const saved = await apiPost(`/api/birthdays/replies/${id}/review`, {}); setNotice(saved.message); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }
  return <Panel id="birthday-replies" title="Birthday Replies & Manual Review" className="birthday-section">
    <p>These messages are kept outside CSAT. No automatic reply, issue, rating update or handoff email is generated. Marking Reviewed only records your review.</p>
    <p className="birthday-muted">Year: {year}. Reply filters are independent of the birthday table above.</p>
    <div className="birthday-actions">
      <SingleSelect label="Reply Review Status" value={status} allowClear={false} options={[
        { value: 'awaiting_review', label: 'Awaiting Review' }, { value: 'reviewed', label: 'Reviewed' }, { value: 'all', label: 'All Replies' }
      ]} onChange={value => { setStatus(value); setPage(0); }} />
      <label className="birthday-reply-search">Search Birthday Replies<input maxLength={250} value={search} placeholder="Contact, organisation or message" onChange={e => { setSearch(e.target.value); setPage(0); }} /></label>
      <Button onClick={() => { setStatus('awaiting_review'); setSearch(''); setQuery(''); setPage(0); }}>Reset Reply Filters</Button>
      <Button disabled={loading} onClick={load}>Refresh Replies</Button>
    </div>
    {error ? <p className="birthday-reason" role="alert">{error}</p> : null}
    {notice ? <p className="birthday-notice" role="status">{notice}</p> : null}
    {loading ? <p role="status">Loading birthday replies…</p> : null}
    <div className="birthday-reply-list" role="region" aria-label="Birthday replies">
      {result.replies.map(reply => <article key={reply.id} className="birthday-reply-card">
        <h4>{reply.contact_name} · {reply.organization}</h4>
        <span className={`birthday-badge ${reply.status === 'reviewed' ? 'good' : 'attention'}`}>{reply.status === 'reviewed' ? 'Reviewed' : 'Awaiting Review'}</span>
        <span className="birthday-badge">{reply.classification === 'birthday' ? 'Reply to Birthday Wish' : 'Unthreaded — Needs Manual Review'}</span>
        <p className="birthday-muted">{stamp(reply.provider_sent_at || reply.created_at)} · Birthday Year {reply.birthday_year}</p>
        <div className="birthday-reply-body">{reply.body}</div>
        {reply.reviewed_at ? <p>Reviewed by {reply.reviewed_by} · {stamp(reply.reviewed_at)}</p> : canManage ? <Button disabled={!!busy || loading} onClick={() => review(reply.id)}>Mark Reviewed</Button> : <p>An authorised birthday manager can mark this reviewed.</p>}
      </article>)}
      {!loading && !result.replies.length ? <p>No birthday replies match these reply filters.</p> : null}
    </div>
    <div className="birthday-actions"><Button disabled={loading || page === 0} onClick={() => setPage(value => value - 1)}>Previous Replies</Button><span>Page {page + 1} · Up to 50 replies per page</span><Button disabled={loading || !result.hasMore} onClick={() => setPage(value => value + 1)}>Next Replies</Button></div>
  </Panel>;
}
