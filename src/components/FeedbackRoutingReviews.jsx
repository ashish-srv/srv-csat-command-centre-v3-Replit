import { useState } from 'react';
import { apiPost } from '../api';
import { formatDateTime } from '../format';
import { Button, Panel } from './Ui.jsx';

export default function FeedbackRoutingReviews({ reviews = [], onReload, onOpenProject }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  async function resolve(id) {
    setBusy(id); setError('');
    try { await apiPost(`/api/feedback-routing-reviews/${encodeURIComponent(id)}/resolve`); await onReload(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(null); }
  }
  if (!reviews.length) return null;
  return <Panel title="Feedback routing needs review" badge={`${reviews.length} pending`} id="dashboard-routing-reviews" className="dashboard-anchor-section">
    <p>These messages could not be attached safely to one feedback session. Check the project, contact the POC if needed, then mark reviewed. Reviewing does not send a message or change their feedback.</p>
    {error ? <p role="alert">{error}</p> : null}
    <div style={{ maxHeight: 400, overflow: 'auto' }} tabIndex={0} role="region" aria-label="Feedback routing reviews">
      {reviews.map(review => <article key={review.id} style={{ padding: 16, borderBottom: '1px solid #ddd' }}>
        <strong>{review.pocName} · {review.from}</strong>
        <p>{formatDateTime(review.createdAt)} · {review.reason}</p>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.clientText}</p>
        {review.replyText ? <details><summary>Automated response prepared</summary><p>{review.replyText}</p></details> : null}
        <div className="button-row">
          {review.projects.map(project => <Button key={project.id} onClick={() => onOpenProject(project.key, { section: 'tracker' })}>Open {project.name}</Button>)}
          <Button disabled={Boolean(busy)} onClick={() => resolve(review.id)}>{busy === review.id ? 'Saving…' : 'Mark reviewed'}</Button>
        </div>
      </article>)}
    </div>
  </Panel>;
}
