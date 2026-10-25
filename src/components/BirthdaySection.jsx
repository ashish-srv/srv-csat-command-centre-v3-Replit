import { useState } from 'react';

// Native details keeps unfinished form values mounted when minimised. Section
// links can open it before scrolling; onToggle synchronises the button label.
export default function BirthdaySection({ id, title, children, defaultOpen = false, sectionRef, notice = '', className = '' }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details id={id} ref={sectionRef} className={`panel birthday-section birthday-collapsible ${className}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="birthday-section-heading">
      <h3>{title}</h3>
      {notice ? <span className="birthday-section-notice" role="status">{notice}</span> : null}
      <span className="birthday-toggle-label">{open ? 'Minimise' : 'Expand'}</span>
    </summary>
    <div className="birthday-section-body">{children}</div>
  </details>;
}

export function revealBirthdaySection(id) {
  const section = document.getElementById(id);
  if (!section) return;
  const details = section.tagName === 'DETAILS' ? section : section.querySelector(':scope > details');
  if (details) details.open = true;
  window.requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
