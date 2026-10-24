// Compare editable values, not server timestamps, display labels or key order.
export function appUserFingerprint(user) {
  return JSON.stringify({ name: user.name || '', role: user.role, active: user.active !== false,
    internalPocId: user.role === 'project_user' ? user.internalPocId || null : null,
    externalLoginAllowed: user.externalLoginAllowed === true,
    permissions: Object.entries(user.permissions || {}).filter(([, value]) => value === true).map(([key]) => key).sort(),
    clusterAccess: (user.clusterAccess || []).map(row => ({ clusterId: row.clusterId, emailEnabled: user.role === 'admin' && row.emailEnabled === true })).sort((a, b) => a.clusterId.localeCompare(b.clusterId))
  });
}

export function internalPocFingerprint(person) {
  return JSON.stringify([person.name || '', person.email || '', person.phone || '',
    [...(person.clusterIds || (person.clusterId ? [person.clusterId] : []))].sort(),
    person.departmentId || '', person.subDepartmentId || '', person.reportingManagerId || '', person.active !== false]);
}

export function standardFingerprint(item) {
  return JSON.stringify([item.value, Number(item.sortOrder) || 0, item.active !== false]);
}

export function pocControlFingerprint(item) {
  return JSON.stringify([item.salutation || '', item.active !== false, item.levelId || '', item.active !== false ? Number(item.weightPercentage) || 0 : 0]);
}

export function navigateManageSection(id) {
  const target = document.getElementById(id);
  if (!target) return;
  // Reveal the section before measuring. Its cards stay independently folded.
  const details = target.matches('details') ? target : target.querySelector(':scope > details');
  if (details) details.open = true;
  const nav = document.querySelector('.manage-section-nav');
  target.style.scrollMarginTop = `${(nav?.getBoundingClientRect().height || 0) + 20}px`;
  target.classList.remove('manage-section-highlight');
  window.requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('manage-section-highlight');
  });
}
