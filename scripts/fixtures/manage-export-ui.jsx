// Isolated browser fixture: fake records only, no database or external requests.
import React from 'react';
import { createRoot } from 'react-dom/client';
import ConsolidatedFeedbackExport from '../../src/components/ConsolidatedFeedbackExport';
import Manage from '../../src/components/Manage';
import { setAdminPin } from '../../src/api';
import '../../src/styles.css';

const clusters = Array.from({ length: 20 }, (_, i) => ({ id: `cl${i}`, name: `Cluster ${String(i + 1).padStart(2, '0')}` }));
const projects = clusters.map((cluster, i) => ({ id: `p${i}`, key: `project-${i}`, name: `Admissions Project ${i + 1}`, clientId: `c${i}`, clientName: `University ${i + 1}`, clusterId: cluster.id, clusterName: cluster.name, activeStatus: i % 2 ? 'paused' : 'active' }));
const directory = { clusters, projects, clients: projects.map(project => ({ id: project.clientId, key: project.clientId, name: project.clientName, clusterId: project.clusterId })),
  internalPocs: [{ id: 'i1', name: 'Sample Internal POC', clusterId: 'cl0', clusterIds: ['cl0', 'cl1'], active: true }], clientPocs: [], projectServices: [], departments: [], subDepartments: [], pocLevels: [], serviceCatalog: [] };
const users = ['super_admin', 'admin', 'project_user'].map((role, i) => ({ id: `u${i}`, name: ['Example Super Admin', 'Example Admin', 'Example Project User'][i], email: `sample${i}@example.com`, role, active: true, internalPocId: role === 'project_user' ? 'i1' : null, permissions: {}, clusterAccess: [{ clusterId: 'cl0', emailEnabled: false }] }));
window.fetch = async url => ({ ok: true, text: async () => JSON.stringify(String(url).includes('/directory') ? directory : String(url).includes('/app-users') ? { users } : { values: [], projects: [], requests: [], cycles: [] }) });
setAdminPin('fixture-only');
createRoot(document.getElementById('root')).render(<main style={{ maxWidth: 1280, margin: '24px auto', padding: '0 20px' }}>
  <ConsolidatedFeedbackExport projects={projects} />
  <Manage currentUser={{ role: 'super_admin', appUserId: 'u0', email: 'sample0@example.com' }} onReload={() => {}} />
</main>);
