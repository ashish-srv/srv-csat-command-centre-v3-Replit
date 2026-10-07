import { useEffect, useRef, useState } from "react";
import { Download, Lock, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { apiAdminGet, apiGet, apiWrite, apiWriteWithAdminPin, hasAdminPin, setAdminPin } from "../api";
import { formatCycleType, formatDate, formatPocWeightShare } from "../format";
import { parseCsatWorkbook } from "../lib/workbook-import";
import { FilterBar, SingleSelect } from "./Filters.jsx";
import { Button, EmptyState, LoadingBlock, Panel } from "./Ui.jsx";
import {
  APP_PERMISSION_LABELS, defaultPermissions, hasPermission, permissionsForRole
} from "../permissions";

const EMPTY_INTERNAL = {
  name: "", email: "", phone: "", clusterId: "",
  departmentId: "", subDepartmentId: "", reportingManagerId: "", active: true
};
const EMPTY_SETUP_POC = {
  name: "", designation: "", contactWhatsapp: "", contactEmail: "",
  birthDate: "", salutation: "", honorific: "", levelId: "", weightPercentage: 100, active: true
};
const EMPTY_SETUP_SERVICE = { serviceCatalogId: "", name: "", kpis: "", internalPocId: "" };

const EMPTY_CLIENT = { key: "", name: "", clusterId: "", activeStatus: "active" };
const EMPTY_CLUSTER = { name: "" };

const EMPTY_PROJECT = {
  clientId: "", key: "", name: "",
  activeStatus: "active", startDate: "", endDate: "", feedbackIntervalDays: 30
};

const PERFORMANCE_STANDARD_LABELS = {
  client_group: "Client Group",
  client_category: "Client Category",
  project_type: "Project Type",
  revenue_category: "Revenue Category",
  portfolio_type: "Portfolio Type",
  currency: "Currency",
  performance_status: "Performance Status",
  current_phase: "Current Phase",
  campaign_status: "Campaign Status",
  client_sentiment: "Client Sentiment",
  relationship_strength: "Relationship Strength",
  meeting_cadence: "Meeting Cadence",
  suggestion_frequency: "Suggestion Frequency",
  kpi_name: "KPI Name"
};

let manageDraftSequence = 0;

function nextManageDraftId(prefix) {
  manageDraftSequence += 1;
  return `${prefix}-${manageDraftSequence}`;
}

function createAppUserDraft() {
  return {
    draftId: nextManageDraftId("app-user"),
    email: "",
    name: "",
    role: "project_user",
    internalPocId: "",
    active: true,
    permissions: defaultPermissions("project_user")
  };
}

function createStandardDraft() {
  return { draftId: nextManageDraftId("standard"), value: "", active: true };
}

function initialStandardDrafts() {
  return Object.fromEntries(Object.keys(PERFORMANCE_STANDARD_LABELS).map((category) => [category, [createStandardDraft()]]));
}

const EMPTY_POC = {
  projectId: "", name: "", designation: "", contactWhatsapp: "",
  contactEmail: "", birthDate: "", salutation: "", honorific: "", levelId: "", weightPercentage: 0, active: true
};

function distributePocWeights(rows = []) {
  const activeIndexes = rows.map((row, index) => row.active !== false ? index : -1).filter((index) => index >= 0);
  if (!activeIndexes.length) return rows.map((row) => ({ ...row, weightPercentage: 0 }));
  const regularShare = Math.floor((10000 / activeIndexes.length)) / 100;
  const firstShare = Math.round((100 - (regularShare * (activeIndexes.length - 1))) * 100) / 100;
  const activeSet = new Set(activeIndexes);
  return rows.map((row, index) => ({
    ...row,
    weightPercentage: activeSet.has(index) ? (index === activeIndexes[0] ? firstShare : regularShare) : 0
  }));
}

function slugIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
}

function serviceIdentifier(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const standard = new Map([
    ["account management", "account"],
    ["design", "design"],
    ["ppc media", "ppc"],
    ["seo", "seo"],
    ["website", "website"]
  ]);
  return standard.get(normalized) || slugIdentifier(value).replace(/-/g, "_");
}

function PinGate({ onUnlock }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    if (!pin.trim()) return;
    setAdminPin(pin.trim());
    try {
      const status = await apiAdminGet("/api/admin/status");
      if (!status.pinRequired) {
        setError("Editing is disabled on the server — ADMIN_PIN is not set.");
        setAdminPin("");
        return;
      }
      if (!status.authorized) {
        setError("Incorrect PIN.");
        setAdminPin("");
        return;
      }
      onUnlock();
    } catch {
      setError("Could not reach the server.");
    }
  }

  return (
    <div className="pin-gate">
      <Lock size={22} aria-hidden="true" />
      <h3>Enter the admin PIN</h3>
      <p>Editing writes directly to the database. The PIN is held for this tab only and is never stored.</p>
      <input
        type="password"
        value={pin}
        onChange={(event) => { setPin(event.target.value); setError(""); }}
        onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
        placeholder="PIN"
        aria-label="Admin PIN"
        autoFocus
      />
      {error ? <p className="pin-error">{error}</p> : null}
      <Button variant="primary" onClick={submit}>Unlock editing</Button>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children}
      {hint ? <em>{hint}</em> : null}
    </label>
  );
}

function ServiceCatalogForm({ value, onChange, onSave, onCancel, saving }) {
  const isNew = !value.id;
  return (
    <div className="edit-form">
      <div className="edit-form-head">
        <strong>{isNew ? "Add a standard service" : `Edit ${value.name}`}</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="form-grid">
        <Field label="Service name" hint="this name is used consistently on every project">
          <input value={value.name || ""} onChange={(event) => onChange({ ...value, name: event.target.value })} />
        </Field>
        {!isNew ? (
          <Field label="Available for new projects">
            <select value={value.active ? "yes" : "no"} onChange={(event) => onChange({ ...value, active: event.target.value === "yes" })}>
              <option value="yes">Yes</option>
              <option value="no">No — archived</option>
            </select>
          </Field>
        ) : null}
      </div>
      <div className="button-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : isNew ? "Add service" : "Save service"}</Button>
      </div>
    </div>
  );
}

function ServiceCatalogBatchForm({ rows, onChange, onSave, onCancel, saving }) {
  function updateRow(index, name) {
    onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, name } : row));
  }
  return (
    <div className="edit-form">
      <div className="edit-form-head">
        <strong>Add standard services together</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="batch-editor compact-batch-editor">
        {rows.map((row, index) => (
          <div className="batch-editor-row" key={`catalog-service-${index}`}>
            <Field label={`Service ${index + 1}`}>
              <input value={row.name || ""} onChange={(event) => updateRow(index, event.target.value)} autoFocus={index === 0} />
            </Field>
            <button type="button" className="icon-button danger" disabled={rows.length === 1}
              onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}
              aria-label={`Remove service ${index + 1}`}><Trash2 size={15} aria-hidden="true" /></button>
          </div>
        ))}
      </div>
      <Button icon={Plus} onClick={() => onChange([...rows, { name: "" }])}>Add another service</Button>
      <div className="button-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : `Add ${rows.length} service${rows.length === 1 ? "" : "s"}`}</Button>
      </div>
    </div>
  );
}

function InternalPocForm({ value, clusters, departments, subDepartments, people, onChange, onSave, onCancel, saving }) {
  const isNew = !value.id;
  const subs = subDepartments.filter(
    (item) => !value.departmentId || item.departmentId === value.departmentId
  );
  return (
    <div className="edit-form">
      <div className="edit-form-head">
        <strong>{isNew ? "Add an internal POC" : `Edit ${value.name}`}</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="form-grid">
        <Field label="Name">
          <input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} />
        </Field>
        <Field label="Email" hint="manager alerts are sent here">
          <input value={value.email || ""} onChange={(event) => onChange({ ...value, email: event.target.value })} />
        </Field>
        <Field label="Phone">
          <input value={value.phone || ""} onChange={(event) => onChange({ ...value, phone: event.target.value })} />
        </Field>
        <Field label="Cluster">
          <select value={value.clusterId || ""} onChange={(event) => onChange({ ...value, clusterId: event.target.value })}>
            <option value="">Not set</option>
            {clusters.map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.name}</option>)}
          </select>
        </Field>
        <Field label="Department">
          <select
            value={value.departmentId || ""}
            onChange={(event) => onChange({ ...value, departmentId: event.target.value, subDepartmentId: "" })}
          >
            <option value="">Not set</option>
            {departments.map((dept) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
          </select>
        </Field>
        <Field label="Sub-department">
          <select value={value.subDepartmentId || ""} onChange={(event) => onChange({ ...value, subDepartmentId: event.target.value })}>
            <option value="">Not set</option>
            {subs.map((sub) => <option key={sub.id} value={sub.id}>{sub.name}</option>)}
          </select>
        </Field>
        <Field label="Reporting manager" hint="receives the alert when this person's service scores badly">
          <select value={value.reportingManagerId || ""} onChange={(event) => onChange({ ...value, reportingManagerId: event.target.value })}>
            <option value="">Not set</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Active">
          <select value={value.active ? "yes" : "no"} onChange={(event) => onChange({ ...value, active: event.target.value === "yes" })}>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
      </div>
      <div className="button-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : isNew ? "Add internal POC" : "Save changes"}</Button>
      </div>
    </div>
  );
}

function serviceRowsForProject(services, projectId) {
  return services.filter((service) => service.projectId === projectId).map((service) => ({
    id: service.id,
    projectId: service.projectId,
    serviceKey: service.serviceKey,
    serviceCatalogId: service.serviceCatalogId || "",
    name: service.name,
    kpis: service.kpis || "",
    internalPocId: service.internalPocId || ""
  }));
}

function CleanupPinModal({ confirmation, pin, error, busy, onPinChange, onCancel, onConfirm }) {
  if (!confirmation) return null;
  const isChatCleanup = confirmation.kind === "messages";
  const isCycleDeletion = confirmation.kind === "cycles";
  const isPocDeletion = confirmation.kind === "pocs";
  const isProjectDeletion = confirmation.kind === "projects";
  const isClientDeletion = confirmation.kind === "clients";
  const isClusterDeletion = confirmation.kind === "clusters";
  const selectedCount = isClusterDeletion
    ? 1
    : isPocDeletion
      ? confirmation.pocIds.length
      : isProjectDeletion
        ? confirmation.projectIds.length
        : isClientDeletion
          ? confirmation.clientIds.length
          : isChatCleanup || isCycleDeletion
            ? confirmation.cycleIds.length
            : confirmation.issueIds.length;
  const noun = isClusterDeletion
    ? "this cluster"
    : isPocDeletion
      ? `${selectedCount} selected POC${selectedCount === 1 ? "" : "s"}`
      : isProjectDeletion
        ? `${selectedCount} selected project${selectedCount === 1 ? "" : "s"}`
        : isClientDeletion
          ? `${selectedCount} selected client${selectedCount === 1 ? "" : "s"}`
          : isChatCleanup || isCycleDeletion
            ? `${selectedCount} selected cycle${selectedCount === 1 ? "" : "s"}`
            : `${selectedCount} selected issue${selectedCount === 1 ? "" : "s"}`;
  const targetName = confirmation.cluster?.name || confirmation.project?.name || confirmation.client?.name || "the selected records";
  const consequence = isChatCleanup
    ? " Ratings, scores, cycles and issues will be preserved."
    : isCycleDeletion
      ? " Their POC sessions, chats, ratings, service feedback, issues, issue history, appreciations and observations will also be deleted. Open sessions and reminders in those cycles will stop."
      : isPocDeletion
        ? " Their feedback sessions, chats, service feedback and ratings will also be deleted. Remaining cycle scores will be recalculated."
        : isProjectDeletion
          ? " Every POC, service, cycle, chat, rating, issue, schedule and feedback record under those projects will also be deleted."
          : isClientDeletion
            ? " Every project and all POCs, services, cycles, chats, ratings, issues and schedules under this client will also be deleted."
            : isClusterDeletion
              ? " Clients and internal POCs assigned to it will be kept and changed to Not set."
              : " Chats, ratings, scores and cycles will be preserved.";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <div className="modal-panel cleanup-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="cleanup-confirm-title">
        <h3 id="cleanup-confirm-title">Confirm permanent cleanup</h3>
        <p>
          You are about to {isChatCleanup ? "clear chat transcripts from" : "permanently delete"} {noun}{isClusterDeletion ? ": " : " for "}<strong>{targetName}</strong>.
          {consequence}
        </p>
        <p>This action cannot be undone from the app. Re-enter the Manage admin PIN to proceed.</p>
        <input
          className="cleanup-pin-input"
          type="password"
          value={pin}
          onChange={(event) => onPinChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !busy) onConfirm(); }}
          placeholder="Admin PIN"
          aria-label="Re-enter admin PIN"
          autoComplete="current-password"
          autoFocus
          disabled={busy}
        />
        {error ? <p className="pin-error">{error}</p> : null}
        <div className="modal-actions">
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button icon={Trash2} variant="danger" onClick={onConfirm} disabled={busy || !pin.trim()}>
            {busy ? "Deleting…" : isClusterDeletion ? "Delete cluster permanently" : isCycleDeletion ? "Delete cycles permanently" : isPocDeletion ? "Delete POCs permanently" : isProjectDeletion ? "Delete projects permanently" : isClientDeletion ? "Delete client permanently" : "Confirm cleanup"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function clientRowsForBatch(clients) {
  return clients.map((client) => ({
    id: client.id,
    key: client.key,
    name: client.name,
    clusterId: client.clusterId || "",
    activeStatus: client.activeStatus || "active"
  }));
}

function ClientBatchForm({ rows, clusters, onChange, onSave, onCancel, saving }) {
  function updateRow(index, patch) {
    onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  return (
    <div className="edit-form">
      <div className="edit-form-head">
        <strong>Edit all displayed clients in one save</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="batch-editor">
        {rows.map((row, index) => (
          <div className="batch-editor-row batch-editor-row-full" key={row.id}>
            <div className="form-grid">
              <Field label={`Client ${index + 1} name`}>
                <input value={row.name} onChange={(event) => updateRow(index, { name: event.target.value })} />
              </Field>
              <Field label="Client ID" hint="permanent and not editable">
                <input value={row.key} readOnly />
              </Field>
              <Field label="Cluster">
                <select value={row.clusterId} onChange={(event) => updateRow(index, { clusterId: event.target.value })}>
                  <option value="">Not set</option>
                  {clusters.map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.name}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <select value={row.activeStatus} onChange={(event) => updateRow(index, { activeStatus: event.target.value })}>
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                  <option value="closed">closed</option>
                </select>
              </Field>
            </div>
          </div>
        ))}
      </div>
      <p className="form-note">Nothing is written until Save displayed clients. The cluster filter controls which clients are included in this draft.</p>
      <div className="button-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving || !rows.length}>{saving ? "Saving…" : "Save displayed clients"}</Button>
      </div>
    </div>
  );
}

function internalPocRowsForBatch(people) {
  return people.map((person) => ({
    id: person.id,
    name: person.name,
    email: person.email || "",
    phone: person.phone || "",
    clusterId: person.clusterId || "",
    departmentId: person.departmentId || "",
    subDepartmentId: person.subDepartmentId || "",
    reportingManagerId: person.reportingManagerId || "",
    active: person.active !== false
  }));
}

function InternalPocBatchForm({ rows, clusters, departments, subDepartments, people, onChange, onSave, onCancel, saving }) {
  function updateRow(index, patch) {
    onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  return (
    <div className="edit-form">
      <div className="edit-form-head">
        <strong>Edit all displayed internal POCs in one save</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="batch-editor">
        {rows.map((row, index) => {
          const subs = subDepartments.filter((item) => !row.departmentId || item.departmentId === row.departmentId);
          return (
            <div className="batch-editor-row batch-editor-row-full" key={row.id}>
              <div className="form-grid">
                <Field label={`Internal POC ${index + 1}`}>
                  <input value={row.name} onChange={(event) => updateRow(index, { name: event.target.value })} />
                </Field>
                <Field label="Email">
                  <input value={row.email} onChange={(event) => updateRow(index, { email: event.target.value })} />
                </Field>
                <Field label="Phone">
                  <input value={row.phone} onChange={(event) => updateRow(index, { phone: event.target.value })} />
                </Field>
                <Field label="Cluster">
                  <select value={row.clusterId} onChange={(event) => updateRow(index, { clusterId: event.target.value })}>
                    <option value="">Not set</option>
                    {clusters.map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.name}</option>)}
                  </select>
                </Field>
                <Field label="Department">
                  <select value={row.departmentId} onChange={(event) => updateRow(index, { departmentId: event.target.value, subDepartmentId: "" })}>
                    <option value="">Not set</option>
                    {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                  </select>
                </Field>
                <Field label="Sub-department">
                  <select value={row.subDepartmentId} onChange={(event) => updateRow(index, { subDepartmentId: event.target.value })}>
                    <option value="">Not set</option>
                    {subs.map((sub) => <option key={sub.id} value={sub.id}>{sub.name}</option>)}
                  </select>
                </Field>
                <Field label="Reporting manager">
                  <select value={row.reportingManagerId} onChange={(event) => updateRow(index, { reportingManagerId: event.target.value })}>
                    <option value="">Not set</option>
                    {people.map((person) => (
                      <option key={person.id} value={person.id}>{person.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Active">
                  <select value={row.active ? "yes" : "no"} onChange={(event) => updateRow(index, { active: event.target.value === "yes" })}>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </Field>
              </div>
            </div>
          );
        })}
      </div>
      <p className="form-note">Nothing is written until Save displayed internal POCs. The current client and cluster filters control this draft.</p>
      <div className="button-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving || !rows.length}>{saving ? "Saving…" : "Save displayed internal POCs"}</Button>
      </div>
    </div>
  );
}

function PocControlCentre({ rows, levels, onChange, onSave, saving }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [client, setClient] = useState("");
  const [project, setProject] = useState("");
  const [selected, setSelected] = useState([]);
  const clients = [...new Set(rows.map((row) => row.clientName).filter(Boolean))].sort();
  const projects = [...new Set(rows
    .filter((row) => !client || row.clientName === client)
    .map((row) => row.projectName).filter(Boolean))].sort();
  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => (
    (!status || (status === "active" ? row.active : !row.active))
    && (!client || row.clientName === client)
    && (!project || row.projectName === project)
    && (!needle || [row.name, row.contactWhatsapp, row.clientName, row.projectName]
      .some((value) => String(value || "").toLowerCase().includes(needle)))
  ));
  const visibleIds = visible.map((row) => row.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  const selectedIds = new Set(selected);

  function patchSelected(patch) {
    onChange(rows.map((row) => selectedIds.has(row.id) ? { ...row, ...patch } : row));
  }

  function redistribute() {
    const projectIds = new Set(rows.filter((row) => selectedIds.has(row.id)).map((row) => row.projectId));
    onChange(rows.map((row) => {
      if (!projectIds.has(row.projectId) || !row.active) return row;
      const active = rows.filter((item) => item.projectId === row.projectId && item.active);
      const index = active.findIndex((item) => item.id === row.id);
      const share = Math.floor((10000 / active.length)) / 100;
      const first = Math.round((100 - share * (active.length - 1)) * 100) / 100;
      return { ...row, weightPercentage: index === 0 ? first : share };
    }));
  }

  const activeCount = rows.filter((row) => row.active).length;
  const inactiveCount = rows.length - activeCount;
  const uniqueContacts = new Set(rows.map((row) => String(row.contactWhatsapp || "").replace(/\D/g, "")).filter(Boolean)).size;
  const projectIds = new Set(rows.map((row) => row.projectId));
  const projectsWithoutActive = [...projectIds].filter((id) => !rows.some((row) => row.projectId === id && row.active)).length;

  return (
    <>
      <div className="metric-row four poc-control-metrics">
        <div className="metric-card strong"><span>Active assignments</span><strong>{activeCount}</strong><small>eligible when WhatsApp is valid</small></div>
        <div className="metric-card neutral"><span>Inactive assignments</span><strong>{inactiveCount}</strong><small>kept for history</small></div>
        <div className="metric-card neutral"><span>Unique contacts</span><strong>{uniqueContacts}</strong><small>across every project</small></div>
        <div className={`metric-card ${projectsWithoutActive ? "watch" : "strong"}`}><span>Projects without active POC</span><strong>{projectsWithoutActive}</strong><small>WhatsApp sends unavailable</small></div>
      </div>
      <div className="poc-control-filters">
        <Field label="Search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="POC, WhatsApp, client or project" /></Field>
        <Field label="Status"><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
        <Field label="Client"><select value={client} onChange={(event) => { setClient(event.target.value); setProject(""); }}><option value="">All clients</option>{clients.map((name) => <option key={name} value={name}>{name}</option>)}</select></Field>
        <Field label="Project"><select value={project} onChange={(event) => setProject(event.target.value)}><option value="">All projects</option>{projects.map((name) => <option key={name} value={name}>{name}</option>)}</select></Field>
        {(query || status || client || project) ? <Button onClick={() => { setQuery(""); setStatus(""); setClient(""); setProject(""); }}>Reset filters</Button> : null}
      </div>
      <div className="button-row poc-control-actions">
        <Button onClick={() => setSelected(allVisibleSelected ? selected.filter((id) => !visibleIds.includes(id)) : [...new Set([...selected, ...visibleIds])])}>
          {allVisibleSelected ? "Deselect displayed" : `Select all displayed (${visible.length})`}
        </Button>
        <Button onClick={() => patchSelected({ active: true })} disabled={!selected.length}>Activate selected</Button>
        <Button onClick={() => patchSelected({ active: false, weightPercentage: 0 })} disabled={!selected.length}>Deactivate selected</Button>
        <Button onClick={redistribute} disabled={!selected.length}>Redistribute affected projects equally</Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save all changed POCs"}</Button>
      </div>
      <p className="form-note">For manual percentages, edit the Influence column and save. Equal redistribution includes every active POC on each affected project, not only displayed rows.</p>
      <div className="poc-control-table">
        <div className="poc-control-row head"><span /><span>POC</span><span>Client</span><span>Project</span><span>Tag</span><span>Status</span><span>Influence</span></div>
        {visible.map((row) => (
          <div className="poc-control-row" key={row.id}>
            <input type="checkbox" checked={selected.includes(row.id)} onChange={() => setSelected(selected.includes(row.id) ? selected.filter((id) => id !== row.id) : [...selected, row.id])} aria-label={`Select ${row.name}`} />
            <span><strong>{row.name}</strong><small>{row.contactWhatsapp || "No WhatsApp"}</small></span>
            <span>{row.clientName || "--"}</span>
            <span><strong>{row.projectName || "--"}</strong><small>{row.projectKey || ""}</small></span>
            <select value={row.levelId || ""} onChange={(event) => onChange(rows.map((item) => item.id === row.id ? { ...item, levelId: event.target.value } : item))} aria-label={`POC tag for ${row.name}`}>
              <option value="">Select tag</option>
              {levels.map((level) => <option key={level.id} value={level.id}>{level.name}</option>)}
            </select>
            <select value={row.active ? "active" : "inactive"} onChange={(event) => onChange(rows.map((item) => item.id === row.id ? { ...item, active: event.target.value === "active", weightPercentage: event.target.value === "active" ? item.weightPercentage : 0 } : item))}><option value="active">Active</option><option value="inactive">Inactive</option></select>
            <input type="number" min="0" max="100" step="0.01" disabled={!row.active} value={row.active ? row.weightPercentage ?? "" : 0} onChange={(event) => onChange(rows.map((item) => item.id === row.id ? { ...item, weightPercentage: event.target.value } : item))} />
          </div>
        ))}
        {!visible.length ? <EmptyState title="No POC assignments match" text="Reset filters to see all client POCs." /> : null}
      </div>
    </>
  );
}

function pocRowsForProject(pocs, projectId) {
  const rows = pocs.filter((poc) => poc.projectId === projectId).map((poc) => ({
    id: poc.id,
    projectId: poc.projectId,
    name: poc.name,
    designation: poc.designation || "",
    contactWhatsapp: poc.contactWhatsapp || "",
    contactEmail: poc.contactEmail || "",
    birthDate: poc.birthDate || "",
    salutation: poc.salutation || "",
    honorific: poc.honorific || "",
    levelId: poc.levelId || "",
    weightPercentage: poc.weightPercentage ?? 0,
    active: poc.active !== false
  }));
  const hasConfiguredWeight = rows.some((row) => row.active && Number(row.weightPercentage) > 0);
  return hasConfiguredWeight ? rows : distributePocWeights(rows);
}

function PocBatchForm({ value, projects, pocs, levels, onChange, onSave, onCancel, saving }) {
  const rows = value.rows || [];
  const defaultLevelId = levels.find((level) => String(level.name || "").toLowerCase() === "normal")?.id || levels[0]?.id || "";
  function updateRow(index, patch) {
    onChange({ ...value, rows: rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row) });
  }
  function removeRow(index) {
    const row = rows[index];
    onChange({
      ...value,
      rows: rows.filter((_, rowIndex) => rowIndex !== index),
      removedIds: row.id ? [...(value.removedIds || []), row.id] : (value.removedIds || [])
    });
  }

  const activeWeightTotal = Math.round(rows.reduce(
    (sum, row) => sum + (row.active ? Number(row.weightPercentage) || 0 : 0),
    0
  ) * 100) / 100;

  return (
    <div className="edit-form">
      <div className="edit-form-head">
        <strong>Add, edit or remove project POCs in one save</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="form-grid service-project-picker">
        <Field label="Project" hint="the draft below contains every POC saved on this project">
          <select value={value.projectId} onChange={(event) => onChange({
            projectId: event.target.value,
            rows: pocRowsForProject(pocs, event.target.value),
            removedIds: []
          })}>
            <option value="">Select a project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="batch-editor">
        {rows.map((row, index) => {
          return (
            <div className="batch-editor-row" key={row.id || `new-poc-${index}`}>
              <div className="form-grid">
                <Field label={`POC ${index + 1} name`}>
                  <input value={row.name} onChange={(event) => updateRow(index, { name: event.target.value })} />
                </Field>
                <Field label="Designation">
                  <input value={row.designation} onChange={(event) => updateRow(index, { designation: event.target.value })} />
                </Field>
                <Field label="WhatsApp number" hint="optional; feedback cannot be sent until a valid number is added">
                  <input value={row.contactWhatsapp} onChange={(event) => updateRow(index, { contactWhatsapp: event.target.value })} />
                </Field>
                <Field label="Email">
                  <input value={row.contactEmail} onChange={(event) => updateRow(index, { contactEmail: event.target.value })} />
                </Field>
                <Field label="Birthday" hint="optional">
                  <input type="date" value={row.birthDate || ""} onChange={(event) => updateRow(index, { birthDate: event.target.value })} />
                </Field>
                <Field label="Salutation">
                  <input value={row.salutation} onChange={(event) => updateRow(index, { salutation: event.target.value })} />
                </Field>
                <Field label="POC tag" hint="descriptive only; it does not calculate influence">
                  <select value={row.levelId} onChange={(event) => updateRow(index, { levelId: event.target.value })}>
                    <option value="">Select Normal or Important</option>
                    {levels.map((level) => <option key={level.id} value={level.id}>{level.name}</option>)}
                  </select>
                </Field>
                <Field label="CSAT influence (%)" hint={row.active ? "all active POCs on this project must total 100%" : "inactive POCs always have 0% influence"}>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={row.active ? row.weightPercentage : 0}
                    disabled={!row.active}
                    onChange={(event) => updateRow(index, { weightPercentage: event.target.value })}
                  />
                </Field>
                <Field label="Active">
                  <select value={row.active ? "yes" : "no"} onChange={(event) => {
                    const active = event.target.value === "yes";
                    updateRow(index, { active, weightPercentage: active ? row.weightPercentage : 0 });
                  }}>
                    <option value="yes">Yes — include in future sends</option>
                    <option value="no">No — exclude from future sends</option>
                  </select>
                </Field>
              </div>
              <button type="button" className="icon-button danger" onClick={() => removeRow(index)} aria-label={`Remove POC ${index + 1}`}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {!rows.length ? <EmptyState title="No POCs in this draft" text="You can save an empty or inactive list; future feedback sends will stay unavailable until an active WhatsApp POC is added." /> : null}
      </div>
      <Button icon={Plus} disabled={!value.projectId} onClick={() => onChange({
        ...value,
        rows: [...rows, { ...EMPTY_POC, projectId: value.projectId, levelId: defaultLevelId }]
      })}>Add another POC</Button>
      <Button disabled={!rows.length} onClick={() => onChange({ ...value, rows: distributePocWeights(rows) })}>
        Distribute equally
      </Button>
      <p className={`form-note ${!rows.some((row) => row.active) || Math.abs(activeWeightTotal - 100) <= 0.01 ? "success" : "missing"}`}>
        Active POC influence total: <strong>{activeWeightTotal}%</strong> {!rows.some((row) => row.active) ? "— allowed; future sends are paused" : Math.abs(activeWeightTotal - 100) <= 0.01 ? "— ready to save" : "— adjust to exactly 100%"}
      </p>
      <p className="form-note">
        Normal and Important are tags only. The percentage entered for each POC directly controls that person's share of the project CSAT. Nothing is written until Save all POCs. Removing an existing POC safely makes it inactive, so future cycles and reminders stop while past feedback remains available.
      </p>
      <div className="button-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving || !value.projectId}>{saving ? "Saving…" : "Save all POCs"}</Button>
      </div>
    </div>
  );
}

function ServiceBatchForm({ value, projects, services, serviceCatalog, people, onChange, onSave, onCancel, saving }) {
  const rows = value.rows || [];
  function updateRow(index, patch) {
    onChange({ ...value, rows: rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row) });
  }
  function removeRow(index) {
    onChange({ ...value, rows: rows.filter((_, rowIndex) => rowIndex !== index) });
  }
  return (
    <div className="edit-form">
      <div className="edit-form-head">
        <strong>Add, edit or remove services in one save</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="form-grid service-project-picker">
        <Field label="Project" hint="the list below contains all services saved on this project">
          <select value={value.projectId} onChange={(event) => onChange({
            projectId: event.target.value,
            rows: serviceRowsForProject(services, event.target.value)
          })}>
            <option value="">Select a project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="batch-editor">
        {rows.map((row, index) => {
          const selectedCatalog = serviceCatalog.find((item) => item.id === row.serviceCatalogId);
          const generatedKey = selectedCatalog?.serviceKey || row.serviceKey || "";
          return (
            <div className="batch-editor-row" key={row.id || `new-service-${index}`}>
              <div className="form-grid">
                <Field label={`Service ${index + 1}`}>
                  <select value={row.serviceCatalogId || ""} onChange={(event) => {
                    const selected = serviceCatalog.find((item) => item.id === event.target.value);
                    updateRow(index, {
                      serviceCatalogId: event.target.value,
                      name: selected?.name || "",
                      serviceKey: selected?.serviceKey || ""
                    });
                  }}>
                    <option value="">Select from service catalogue</option>
                    {serviceCatalog.filter((item) => item.active || item.id === row.serviceCatalogId).map((item) => (
                      <option key={item.id} value={item.id}>{item.name}{item.active ? "" : " — archived"}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Generated service key" hint="automatic and not editable">
                  <input value={generatedKey} readOnly placeholder="generated_automatically" />
                </Field>
                <Field label="Owner (internal POC)" hint="alerts go to this person's reporting manager">
                  <select value={row.internalPocId || ""} onChange={(event) => updateRow(index, { internalPocId: event.target.value })}>
                    <option value="">Not set</option>
                    {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                  </select>
                </Field>
                <Field label="KPIs">
                  <input value={row.kpis || ""} onChange={(event) => updateRow(index, { kpis: event.target.value })} />
                </Field>
              </div>
              <button type="button" className="icon-button danger" onClick={() => removeRow(index)} aria-label={`Remove service ${index + 1}`}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {!rows.length ? <EmptyState title="No services in this draft" text="Add at least one service before saving." /> : null}
      </div>
      <Button icon={Plus} onClick={() => onChange({
        ...value,
        rows: [...rows, { ...EMPTY_SETUP_SERVICE, projectId: value.projectId }]
      })}>Add another service</Button>
      <p className="form-note">
        Nothing is written until Save all services. Removing a row deletes that project-service mapping; historical feedback remains in its past cycles.
      </p>
      <div className="button-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving || !value.projectId || !rows.length}>{saving ? "Saving…" : "Save all services"}</Button>
      </div>
    </div>
  );
}

function ClientForm({ value, clusters, onChange, onSave, onCancel, saving }) {
  const isNew = !value.id;
  return (
    <div className="edit-form">
      <div className="edit-form-head">
        <strong>{isNew ? "Add a client" : `Edit ${value.name}`}</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="form-grid">
        <Field label="Client name">
          <input value={value.name} onChange={(event) => onChange({
            ...value,
            name: event.target.value,
            key: isNew ? slugIdentifier(event.target.value) : value.key
          })} />
        </Field>
        <Field label="Client ID" hint="generated automatically from the client name">
          <input value={value.key} readOnly placeholder="generated-from-name" />
        </Field>
        <Field label="Cluster">
          <select value={value.clusterId || ""} onChange={(event) => onChange({ ...value, clusterId: event.target.value })}>
            <option value="">Not set</option>
            {clusters.map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.name}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={value.activeStatus} onChange={(event) => onChange({ ...value, activeStatus: event.target.value })}>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="closed">closed</option>
          </select>
        </Field>
      </div>
      <div className="button-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : isNew ? "Add client" : "Save changes"}</Button>
      </div>
    </div>
  );
}

function ClusterForm({ value, onChange, onSave, onCancel, saving }) {
  const isNew = !value.id;
  return (
    <div className="edit-form">
      <div className="edit-form-head">
        <strong>{isNew ? "Add a cluster" : `Edit ${value.name}`}</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="form-grid">
        <Field label="Cluster name">
          <input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} autoFocus />
        </Field>
      </div>
      <div className="button-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : isNew ? "Add cluster" : "Save changes"}</Button>
      </div>
    </div>
  );
}

function ProjectForm({ value, clients, onChange, onSave, onCancel, saving }) {
  const isNew = !value.id;
  return (
    <div className="edit-form">
      <div className="edit-form-head">
        <strong>{isNew ? "Add a project" : `Edit ${value.name}`}</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="form-grid">
        <Field label="Client">
          <select value={value.clientId} onChange={(event) => onChange({ ...value, clientId: event.target.value })}>
            <option value="">Select a client</option>
            {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
          </select>
        </Field>
        <Field label="Project name">
          <input value={value.name} onChange={(event) => onChange({
            ...value,
            name: event.target.value
          })} />
        </Field>
        <Field label="Project ID" hint="any stable ID using letters, numbers or hyphens; dates are not part of validation">
          <input
            value={value.key}
            placeholder="MITWPU or mitwpu-website"
            onChange={(event) => onChange({
              ...value,
              key: event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "")
            })}
          />
        </Field>
        <Field label="Status">
          <select value={value.activeStatus} onChange={(event) => onChange({ ...value, activeStatus: event.target.value })}>
            <option value="active">active — scheduler can start cycles</option>
            <option value="paused">paused — no new scheduled cycles</option>
            <option value="closed">closed — project finished</option>
          </select>
        </Field>
        <Field label="Start date">
          <input type="date" value={value.startDate || ""} onChange={(event) => onChange({ ...value, startDate: event.target.value })} />
        </Field>
        <Field label="End date" hint="the project-end cycle fires after this">
          <input type="date" value={value.endDate || ""} onChange={(event) => onChange({ ...value, endDate: event.target.value })} />
        </Field>
        <Field label="Feedback interval (days)">
          <input
            type="number" min="1" max="365"
            value={value.feedbackIntervalDays}
            onChange={(event) => onChange({ ...value, feedbackIntervalDays: Number(event.target.value) })}
          />
        </Field>
      </div>
      <p className="form-note">
        Changing a Project ID keeps the former ID as an alias, so existing links and feedback history continue to work. CSAT and risk are written by the feedback engine; the first pulse is scheduled for start date + feedback interval.
      </p>
      <div className="button-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : isNew ? "Add project" : "Save changes"}</Button>
      </div>
    </div>
  );
}

function ProjectSetupForm({ value, clients, levels, people, serviceCatalog, copySource, onClientChange, onChange, onSave, onCancel, saving }) {
  const pocs = value.pocs || [];
  const services = value.services || [];
  const activePocWeightTotal = Math.round(pocs.reduce(
    (sum, poc) => sum + (poc.active !== false ? Number(poc.weightPercentage) || 0 : 0),
    0
  ) * 100) / 100;
  const updateProject = (patch) => onChange({ ...value, project: { ...value.project, ...patch } });
  const updatePoc = (index, patch) => onChange({
    ...value,
    pocs: pocs.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row)
  });
  const updateService = (index, patch) => onChange({
    ...value,
    services: services.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row)
  });

  function copyProject(projectId) {
    if (!projectId) {
      onChange({ ...value, copyProjectId: "" });
      return;
    }
    const sourcePocs = (copySource?.pocs || []).filter((poc) => poc.projectId === projectId);
    const sourceServices = (copySource?.services || []).filter((service) => service.projectId === projectId);
    onChange({
      ...value,
      copyProjectId: projectId,
      pocs: sourcePocs.map((poc) => ({
        ...EMPTY_SETUP_POC,
        name: poc.name || "",
        designation: poc.designation || "",
        contactWhatsapp: poc.contactWhatsapp || "",
        contactEmail: poc.contactEmail || "",
        birthDate: poc.birthDate || "",
        salutation: poc.salutation || "",
        honorific: poc.honorific || "",
        levelId: poc.levelId || "",
        weightPercentage: poc.active === false ? 0 : poc.weightPercentage ?? 0,
        active: poc.active !== false
      })),
      services: sourceServices.map((service) => ({
        ...EMPTY_SETUP_SERVICE,
        serviceCatalogId: service.serviceCatalogId || "",
        name: service.name || "",
        kpis: service.kpis || "",
        internalPocId: service.internalPocId || ""
      }))
    });
  }

  return (
    <div className="edit-form complete-project-setup">
      <div className="edit-form-head">
        <strong>Complete project setup — one save</strong>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={15} aria-hidden="true" /></button>
      </div>
      <p className="form-note">
        Fill the project, all client POCs and all services below. The project remains unscheduled until the complete setup saves successfully.
      </p>

      <h4>1. Project</h4>
      <div className="form-grid">
        <Field label="Client">
          <select value={value.project.clientId || ""} onChange={(event) => {
            const nextClientId = event.target.value;
            onChange({
              ...value,
              project: { ...value.project, clientId: nextClientId },
              copyProjectId: "",
              pocs: [{ ...EMPTY_SETUP_POC, levelId: levels[0]?.id || "" }],
              services: [{ ...EMPTY_SETUP_SERVICE }]
            });
            onClientChange(nextClientId);
          }}>
            <option value="">Select client</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}{client.activeStatus && client.activeStatus !== "active" ? ` - ${client.activeStatus}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Copy from an existing project" hint="copies POCs, services, owners and KPIs only; history and schedules are never copied">
          <select value={value.copyProjectId || ""} disabled={!value.project.clientId} onChange={(event) => copyProject(event.target.value)}>
            <option value="">Start with a blank project</option>
            {(copySource?.projects || []).map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Project name">
          <input value={value.project.name} onChange={(event) => updateProject({ name: event.target.value })} />
        </Field>
        <Field label="Project ID" hint="letters, numbers or hyphens; it does not need to match the dates">
          <input value={value.project.key} onChange={(event) => updateProject({ key: event.target.value })} />
        </Field>
        <Field label="Status">
          <select value={value.project.activeStatus} onChange={(event) => updateProject({ activeStatus: event.target.value })}>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="closed">closed</option>
          </select>
        </Field>
        <Field label="Start date">
          <input type="date" value={value.project.startDate} onChange={(event) => updateProject({ startDate: event.target.value })} />
        </Field>
        <Field label="End date">
          <input type="date" value={value.project.endDate} onChange={(event) => updateProject({ endDate: event.target.value })} />
        </Field>
        <Field label="Feedback interval (days)">
          <input type="number" min="1" max="365" value={value.project.feedbackIntervalDays}
            onChange={(event) => updateProject({ feedbackIntervalDays: Number(event.target.value) })} />
        </Field>
      </div>

      <div className="setup-subhead">
        <h4>2. Client POCs</h4>
        <Button icon={Plus} onClick={() => onChange({
          ...value,
          pocs: [...pocs, { ...EMPTY_SETUP_POC, levelId: levels[0]?.id || "", weightPercentage: 0 }]
        })}>Add another POC</Button>
      </div>
      <div className="batch-editor">
        {pocs.map((poc, index) => (
          <div className="batch-editor-row" key={`setup-poc-${index}`}>
            <div className="form-grid">
              <Field label={`POC ${index + 1} name`}><input value={poc.name} onChange={(event) => updatePoc(index, { name: event.target.value })} /></Field>
              <Field label="Designation"><input value={poc.designation || ""} onChange={(event) => updatePoc(index, { designation: event.target.value })} /></Field>
              <Field label="WhatsApp" hint="optional; feedback sending stays unavailable without it"><input value={poc.contactWhatsapp || ""} onChange={(event) => updatePoc(index, { contactWhatsapp: event.target.value })} /></Field>
              <Field label="Email"><input value={poc.contactEmail || ""} onChange={(event) => updatePoc(index, { contactEmail: event.target.value })} /></Field>
              <Field label="Birthday" hint="optional"><input type="date" value={poc.birthDate || ""} onChange={(event) => updatePoc(index, { birthDate: event.target.value })} /></Field>
              <Field label="Salutation"><input value={poc.salutation || ""} onChange={(event) => updatePoc(index, { salutation: event.target.value })} /></Field>
              <Field label="POC tag" hint="descriptive only">
                <select value={poc.levelId || ""} onChange={(event) => updatePoc(index, { levelId: event.target.value })}>
                  <option value="">Select Normal or Important</option>
                  {levels.map((level) => <option key={level.id} value={level.id}>{level.name}</option>)}
                </select>
              </Field>
              <Field label="CSAT influence (%)" hint="all POCs on this project must total 100%">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={poc.active !== false ? poc.weightPercentage : 0}
                  disabled={poc.active === false}
                  onChange={(event) => updatePoc(index, { weightPercentage: event.target.value })}
                />
              </Field>
              <Field label="Active" hint="inactive POCs are copied for reference but receive no feedback">
                <select value={poc.active !== false ? "yes" : "no"} onChange={(event) => {
                  const active = event.target.value === "yes";
                  updatePoc(index, { active, weightPercentage: active ? poc.weightPercentage : 0 });
                }}>
                  <option value="yes">Yes — include in future sends</option>
                  <option value="no">No — keep inactive</option>
                </select>
              </Field>
            </div>
            <button type="button" className="icon-button danger" disabled={pocs.length === 1}
              onClick={() => onChange({ ...value, pocs: pocs.filter((_, rowIndex) => rowIndex !== index) })}
              aria-label={`Remove POC ${index + 1}`}><Trash2 size={15} aria-hidden="true" /></button>
          </div>
        ))}
      </div>
      <Button icon={Plus} onClick={() => onChange({
        ...value,
        pocs: [...pocs, { ...EMPTY_SETUP_POC, levelId: levels[0]?.id || "", weightPercentage: 0 }]
      })}>Add another POC</Button>
      <div className="button-row">
        <Button disabled={!pocs.length} onClick={() => onChange({ ...value, pocs: distributePocWeights(pocs) })}>
          Distribute equally
        </Button>
        <span className={!pocs.some((poc) => poc.active !== false) || Math.abs(activePocWeightTotal - 100) <= 0.01 ? "" : "missing"}>
          Active POC influence total: <strong>{activePocWeightTotal}%</strong>{!pocs.some((poc) => poc.active !== false) ? " — allowed; messaging unavailable until a POC is activated" : ""}
        </span>
      </div>
      <p className="form-note">Normal and Important are tags only. Set each POC's direct influence so the project total is exactly 100%.</p>

      <div className="setup-subhead">
        <h4>3. Services and owners</h4>
        <Button icon={Plus} onClick={() => onChange({ ...value, services: [...services, { ...EMPTY_SETUP_SERVICE }] })}>Add another service</Button>
      </div>
      <div className="batch-editor">
        {services.map((service, index) => (
          <div className="batch-editor-row" key={`setup-service-${index}`}>
            <div className="form-grid">
              <Field label={`Service ${index + 1}`}>
                <select value={service.serviceCatalogId || ""} onChange={(event) => {
                  const selected = serviceCatalog.find((item) => item.id === event.target.value);
                  updateService(index, { serviceCatalogId: event.target.value, name: selected?.name || "" });
                }}>
                  <option value="">Select from service catalogue</option>
                  {serviceCatalog.filter((item) => item.active || item.id === service.serviceCatalogId).map((item) => (
                    <option key={item.id} value={item.id}>{item.name}{item.active ? "" : " — archived"}</option>
                  ))}
                </select>
              </Field>
              <Field label="Generated key" hint="automatic and not editable">
                <input value={serviceIdentifier(service.name)} readOnly placeholder="generated_automatically" />
              </Field>
              <Field label="Owner (internal POC)">
                <select value={service.internalPocId || ""} onChange={(event) => updateService(index, { internalPocId: event.target.value })}>
                  <option value="">Not set</option>
                  {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                </select>
              </Field>
              <Field label="KPIs"><input value={service.kpis || ""} onChange={(event) => updateService(index, { kpis: event.target.value })} /></Field>
            </div>
            <button type="button" className="icon-button danger" disabled={services.length === 1}
              onClick={() => onChange({ ...value, services: services.filter((_, rowIndex) => rowIndex !== index) })}
              aria-label={`Remove service ${index + 1}`}><Trash2 size={15} aria-hidden="true" /></button>
          </div>
        ))}
      </div>

      <Button icon={Plus} onClick={() => onChange({ ...value, services: [...services, { ...EMPTY_SETUP_SERVICE }] })}>Add another service</Button>

      <div className="button-row setup-save-row">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>{saving ? "Saving complete setup…" : "Save project, POCs and services"}</Button>
      </div>
    </div>
  );
}

export default function Manage({ onReload, currentUser = null }) {
  const canManageRecords = hasPermission(currentUser, "manage_records");
  const canManagePocs = hasPermission(currentUser, "manage_pocs");
  const canManageInternalPocs = hasPermission(currentUser, "manage_internal_pocs");
  const canManageCatalogues = hasPermission(currentUser, "manage_catalogues");
  const canBulkSend = hasPermission(currentUser, "bulk_sends");
  const canManageUsers = hasPermission(currentUser, "manage_project_users");
  const isSuperAdmin = currentUser?.role === "super_admin";
  const [unlocked, setUnlocked] = useState(hasAdminPin());
  const [directory, setDirectory] = useState(null);
  const [clusterFilterId, setClusterFilterId] = useState("");
  const [clientId, setClientId] = useState("");
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");
  const [saving, setSaving] = useState(false);
  const [projectForm, setProjectForm] = useState(null);
  const [clientForm, setClientForm] = useState(null);
  const [clusterForm, setClusterForm] = useState(null);
  const [showAllInternal, setShowAllInternal] = useState(true);
  const [internalForm, setInternalForm] = useState(null);
  const [internalBatch, setInternalBatch] = useState(null);
  const [clientBatch, setClientBatch] = useState(null);
  const [pocBatch, setPocBatch] = useState(null);
  const [serviceBatch, setServiceBatch] = useState(null);
  const [serviceCatalogForm, setServiceCatalogForm] = useState(null);
  const [serviceCatalogBatch, setServiceCatalogBatch] = useState(null);
  const [pocControlRows, setPocControlRows] = useState([]);
  const [bulkCycleType, setBulkCycleType] = useState("pulse");
  const [bulkPreview, setBulkPreview] = useState(null);
  const [bulkSelectedProjectIds, setBulkSelectedProjectIds] = useState([]);
  const [bulkSending, setBulkSending] = useState(false);
  const [setupForm, setSetupForm] = useState(null);
  const [setupCopySource, setSetupCopySource] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState([]);
  const [cleanupProjectId, setCleanupProjectId] = useState("");
  const [cleanupWorkspace, setCleanupWorkspace] = useState(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupLoadError, setCleanupLoadError] = useState("");
  const [selectedCleanupCycleIds, setSelectedCleanupCycleIds] = useState([]);
  const [selectedCleanupIssueIds, setSelectedCleanupIssueIds] = useState([]);
  const [selectedDeletePocIds, setSelectedDeletePocIds] = useState([]);
  const [selectedDeleteProjectIds, setSelectedDeleteProjectIds] = useState([]);
  const [cleanupConfirmation, setCleanupConfirmation] = useState(null);
  const [cleanupPin, setCleanupPin] = useState("");
  const [cleanupPinError, setCleanupPinError] = useState("");
  const [cleaning, setCleaning] = useState("");
  const [appUsers, setAppUsers] = useState([]);
  const [performanceStandards, setPerformanceStandards] = useState([]);
  const [newAppUsers, setNewAppUsers] = useState(() => [createAppUserDraft()]);
  const [standardDrafts, setStandardDrafts] = useState(initialStandardDrafts);
  const [selectedStandardIds, setSelectedStandardIds] = useState([]);
  const [projectSearch, setProjectSearch] = useState("");
  const [serviceCatalogSearch, setServiceCatalogSearch] = useState("");
  const [internalPocSearch, setInternalPocSearch] = useState("");
  const formRef = useRef(null);
  const workbookInputRef = useRef(null);

  function closeForms() {
    setProjectForm(null);
    setClientForm(null);
    setClusterForm(null);
    setInternalForm(null);
    setInternalBatch(null);
    setClientBatch(null);
    setPocBatch(null);
    setServiceBatch(null);
    setServiceCatalogForm(null);
    setServiceCatalogBatch(null);
    setSetupForm(null);
    setSetupCopySource(null);
  }

  function showToast(message) {
    setToast(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(""), 5000);
  }

  async function loadAll(keepClient = clientId) {
    setLoading(true);
    try {
      const [data, userData, standardData] = await Promise.all([
        apiGet("/api/admin/directory"),
        canManageUsers ? apiAdminGet("/api/admin/app-users") : Promise.resolve({ users: [] }),
        canManageCatalogues ? apiAdminGet("/api/admin/performance-standards") : Promise.resolve({ values: [] })
      ]);
      setDirectory(data);
      setAppUsers(userData.users || []);
      setPerformanceStandards(standardData.values || []);
      setPocControlRows((data.clientPocs || []).map((poc) => ({ ...poc })));
      const target = keepClient || "";
      setClientId(target);
      const clientDetail = target ? await apiGet(`/api/admin/clients/${encodeURIComponent(target)}`) : null;
      setDetail(clientDetail);
      setCleanupProjectId((current) => (
        clientDetail?.projects?.some((project) => project.id === current)
          ? current
          : (clientDetail?.projects?.[0]?.id || "")
      ));
    } catch (loadError) {
      showToast(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  function updateNewAppUser(draftId, patch) {
    setNewAppUsers((current) => current.map((row) => (
      row.draftId === draftId ? { ...row, ...patch } : row
    )));
  }

  async function addAppUsers() {
    const pending = newAppUsers.filter((row) => row.email.trim() || row.internalPocId);
    if (!pending.length) {
      showToast("Select at least one Internal POC or enter an Admin email.");
      return;
    }
    const missingInternalPoc = pending.find((row) => row.role === "project_user" && !row.internalPocId);
    if (missingInternalPoc) {
      showToast(`Select an Internal POC for ${missingInternalPoc.email}.`);
      return;
    }
    const missingGoogleEmail = pending.find((row) => !row.email.trim());
    if (missingGoogleEmail) {
      showToast("That Internal POC does not have an email. Add their Google Workspace email under Internal POCs first.");
      return;
    }
    setSaving(true);
    let added = 0;
    try {
      for (const row of pending) {
        const result = await apiWrite("/api/admin/app-users", {
          email: row.email,
          name: row.name,
          role: row.role,
          internalPocId: row.role === "project_user" ? row.internalPocId : null,
          active: row.active,
          permissions: row.permissions
        }, "POST");
        added += 1;
        setAppUsers((current) => [...current, result.user].sort((left, right) => left.email.localeCompare(right.email)));
        setNewAppUsers((current) => current.filter((item) => item.draftId !== row.draftId));
      }
      setNewAppUsers((current) => current.length ? current : [createAppUserDraft()]);
      showToast(`${added} application user${added === 1 ? "" : "s"} added. They can now sign in with Google.`);
    } catch (saveError) {
      showToast(`${added ? `${added} added. ` : ""}${saveError.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveAllAppUsers() {
    const invalid = appUsers.find((user) => user.role === "project_user" && !user.internalPocId);
    if (invalid) {
      showToast(`Select an Internal POC for ${invalid.email}.`);
      return;
    }
    setSaving(true);
    let savedCount = 0;
    try {
      for (const user of appUsers) {
        const result = await apiWrite(`/api/admin/app-users/${encodeURIComponent(user.id)}`, {
          name: user.name,
          role: user.role,
          permissions: user.permissions,
          internalPocId: user.role === "project_user" ? user.internalPocId || null : null,
          active: user.active
        }, "PATCH");
        savedCount += 1;
        setAppUsers((current) => current.map((item) => item.id === user.id ? result.user : item));
      }
      showToast(`${savedCount} application user${savedCount === 1 ? "" : "s"} updated without leaving this section.`);
    } catch (saveError) {
      showToast(`${savedCount ? `${savedCount} updated. ` : ""}${saveError.message}`);
    } finally {
      setSaving(false);
    }
  }

  function updateStandardDraft(category, draftId, patch) {
    setStandardDrafts((current) => ({
      ...current,
      [category]: (current[category] || []).map((row) => row.draftId === draftId ? { ...row, ...patch } : row)
    }));
  }

  function addStandardDraft(category) {
    setStandardDrafts((current) => ({
      ...current,
      [category]: [...(current[category] || []), createStandardDraft()]
    }));
  }

  function removeStandardDraft(category, draftId) {
    setStandardDrafts((current) => {
      const remaining = (current[category] || []).filter((row) => row.draftId !== draftId);
      return { ...current, [category]: remaining.length ? remaining : [createStandardDraft()] };
    });
  }

  async function savePerformanceStandardCategory(category) {
    const existing = performanceStandards.filter((item) => item.category === category);
    const drafts = (standardDrafts[category] || []).filter((item) => item.value.trim());
    const allValues = [...existing.map((item) => item.value.trim()), ...drafts.map((item) => item.value.trim())];
    const duplicate = allValues.find((value, index) => allValues.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) !== index);
    if (existing.some((item) => !item.value.trim())) {
      showToast(`${PERFORMANCE_STANDARD_LABELS[category]} contains an empty existing value.`);
      return;
    }
    if (duplicate) {
      showToast(`${duplicate} appears more than once in ${PERFORMANCE_STANDARD_LABELS[category]}.`);
      return;
    }
    setSaving(true);
    let updatedCount = 0;
    let addedCount = 0;
    try {
      for (const item of existing) {
        const result = await apiWrite(`/api/admin/performance-standards/${encodeURIComponent(item.id)}`, {
          value: item.value,
          sortOrder: item.sortOrder,
          active: item.active
        }, "PATCH");
        updatedCount += 1;
        setPerformanceStandards((current) => current.map((value) => value.id === item.id ? result.value : value));
      }
      for (const [index, draft] of drafts.entries()) {
        const result = await apiWrite("/api/admin/performance-standards", {
          category,
          value: draft.value,
          active: draft.active,
          sortOrder: existing.length + index
        }, "POST");
        addedCount += 1;
        setPerformanceStandards((current) => [...current, result.value]);
        setStandardDrafts((current) => ({
          ...current,
          [category]: (current[category] || []).filter((item) => item.draftId !== draft.draftId)
        }));
      }
      setStandardDrafts((current) => ({
        ...current,
        [category]: (current[category] || []).some((item) => !item.value.trim())
          ? current[category]
          : [...(current[category] || []), createStandardDraft()]
      }));
      showToast(`${PERFORMANCE_STANDARD_LABELS[category]} saved: ${updatedCount} updated, ${addedCount} added.`);
    } catch (saveError) {
      showToast(`${updatedCount} updated and ${addedCount} added before this error: ${saveError.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeSelectedPerformanceStandards(category) {
    const selected = performanceStandards.filter((item) => item.category === category && selectedStandardIds.includes(item.id));
    if (!selected.length) {
      showToast(`Select one or more ${PERFORMANCE_STANDARD_LABELS[category]} values to remove.`);
      return;
    }
    if (!window.confirm(`Remove ${selected.length} selected value${selected.length === 1 ? "" : "s"}? Values already used by projects will be archived, not erased.`)) return;
    setSaving(true);
    let deleted = 0;
    let archived = 0;
    try {
      for (const item of selected) {
        const result = await apiWrite(`/api/admin/performance-standards/${encodeURIComponent(item.id)}`, {}, "DELETE");
        if (result.action === "archived") {
          archived += 1;
          setPerformanceStandards((current) => current.map((value) => value.id === item.id ? { ...value, active: false } : value));
        } else {
          deleted += 1;
          setPerformanceStandards((current) => current.filter((value) => value.id !== item.id));
        }
        setSelectedStandardIds((current) => current.filter((id) => id !== item.id));
      }
      showToast(`${deleted} deleted and ${archived} safely archived because they are already in use.`);
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => { if (unlocked) loadAll(); }, [unlocked]);

  useEffect(() => {
    const project = (detail?.projects || []).find((item) => item.id === cleanupProjectId);
    setSelectedCleanupCycleIds([]);
    setSelectedCleanupIssueIds([]);
    setCleanupConfirmation(null);
    setCleanupPin("");
    setCleanupPinError("");
    if (!unlocked || !project) {
      setCleanupWorkspace(null);
      setCleanupLoading(false);
      setCleanupLoadError("");
      return undefined;
    }

    let active = true;
    setCleanupLoading(true);
    setCleanupWorkspace(null);
    setCleanupLoadError("");
    apiGet(`/api/projects/${encodeURIComponent(project.key)}/workspace`)
      .then((workspace) => {
        if (active) setCleanupWorkspace(workspace);
      })
      .catch((workspaceError) => {
        if (active) {
          setCleanupLoadError(workspaceError.message);
          showToast(workspaceError.message);
        }
      })
      .finally(() => {
        if (active) setCleanupLoading(false);
      });
    return () => { active = false; };
  }, [unlocked, cleanupProjectId, detail]);

  useEffect(() => {
    if (!projectForm && !clientForm && !clusterForm && !internalForm && !internalBatch && !clientBatch && !pocBatch && !serviceBatch && !serviceCatalogForm && !serviceCatalogBatch && !setupForm) return;
    window.requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [Boolean(projectForm), Boolean(clientForm), Boolean(clusterForm), Boolean(internalForm), Boolean(internalBatch), Boolean(clientBatch), Boolean(pocBatch), Boolean(serviceBatch), Boolean(serviceCatalogForm), Boolean(serviceCatalogBatch), Boolean(setupForm)]);

  async function selectClient(id) {
    setClientId(id);
    closeForms();
    const clientDetail = id ? await apiGet(`/api/admin/clients/${encodeURIComponent(id)}`) : null;
    setDetail(clientDetail);
    setSelectedDeletePocIds([]);
    setSelectedDeleteProjectIds([]);
    setCleanupProjectId(clientDetail?.projects?.[0]?.id || "");
  }

  async function loadSetupCopySource(id) {
    if (!id) {
      setSetupCopySource(null);
      return;
    }
    if (detail?.client?.id === id) {
      setSetupCopySource(detail);
      return;
    }
    try {
      setSetupCopySource(await apiGet(`/api/admin/clients/${encodeURIComponent(id)}`));
    } catch (copyError) {
      setSetupCopySource(null);
      showToast(copyError.message);
    }
  }

  function issuesForCleanupCycles(cycleIds) {
    const selectedCycleIds = new Set(cycleIds);
    const cycleIdBySessionId = new Map();
    for (const cycle of cleanupWorkspace?.cycles || []) {
      for (const session of cycle.sessions || []) cycleIdBySessionId.set(session.id, cycle.id);
    }
    return (cleanupWorkspace?.issues || [])
      .map((issue) => ({ ...issue, cycleId: cycleIdBySessionId.get(issue.sessionId) || "" }))
      .filter((issue) => selectedCycleIds.has(issue.cycleId));
  }

  function updateCleanupCycleSelection(nextCycleIds) {
    const uniqueCycleIds = [...new Set(nextCycleIds)];
    const allowedIssueIds = new Set(issuesForCleanupCycles(uniqueCycleIds).map((issue) => issue.id));
    setSelectedCleanupCycleIds(uniqueCycleIds);
    setSelectedCleanupIssueIds((current) => current.filter((issueId) => allowedIssueIds.has(issueId)));
  }

  function toggleCleanupCycle(cycleId) {
    updateCleanupCycleSelection(
      selectedCleanupCycleIds.includes(cycleId)
        ? selectedCleanupCycleIds.filter((id) => id !== cycleId)
        : [...selectedCleanupCycleIds, cycleId]
    );
  }

  function toggleCleanupIssue(issueId) {
    setSelectedCleanupIssueIds((current) => (
      current.includes(issueId)
        ? current.filter((id) => id !== issueId)
        : [...current, issueId]
    ));
  }

  function openCleanupConfirmation(kind) {
    const project = (detail?.projects || []).find((item) => item.id === cleanupProjectId);
    if (!project) {
      showToast("Select a project first.");
      return;
    }
    if (!selectedCleanupCycleIds.length) {
      showToast("Select at least one feedback cycle first.");
      return;
    }
    if (kind === "issues" && !selectedCleanupIssueIds.length) {
      showToast("Select at least one issue to delete.");
      return;
    }
    setCleanupPin("");
    setCleanupPinError("");
    setCleanupConfirmation({
      kind,
      project: { id: project.id, key: project.key, name: project.name },
      cycleIds: [...selectedCleanupCycleIds],
      issueIds: kind === "issues" ? [...selectedCleanupIssueIds] : []
    });
  }

  function openRecordDeleteConfirmation(kind) {
    const client = (directory?.clients || []).find((item) => item.id === clientId) || null;
    if (!client) {
      showToast("Select a client first.");
      return;
    }
    const pocIds = kind === "pocs" ? [...selectedDeletePocIds] : [];
    const projectIds = kind === "projects" ? [...selectedDeleteProjectIds] : [];
    const clientIds = kind === "clients" ? [client.id] : [];
    if (kind === "pocs" && !pocIds.length) {
      showToast("Select at least one POC to delete.");
      return;
    }
    if (kind === "projects" && !projectIds.length) {
      showToast("Select at least one project to delete.");
      return;
    }
    setCleanupPin("");
    setCleanupPinError("");
    setCleanupConfirmation({
      kind,
      client: { id: client.id, name: client.name },
      pocIds,
      projectIds,
      clientIds
    });
  }

  function openClusterDeleteConfirmation(cluster) {
    closeForms();
    setCleanupPin("");
    setCleanupPinError("");
    setCleanupConfirmation({
      kind: "clusters",
      cluster: { id: cluster.id, name: cluster.name }
    });
  }

  async function runConfirmedCleanup() {
    if (!cleanupConfirmation || !cleanupPin.trim()) return;
    const { kind, project, cycleIds, issueIds, client, pocIds, projectIds, clientIds, cluster } = cleanupConfirmation;

    setCleaning(kind);
    setCleanupPinError("");
    try {
      const path = kind === "clusters"
        ? `/api/admin/clusters/${encodeURIComponent(cluster.id)}`
        : kind === "pocs"
          ? "/api/admin/client-pocs"
          : kind === "projects"
            ? "/api/admin/projects"
            : kind === "clients"
              ? "/api/admin/clients"
              : kind === "messages"
                ? `/api/admin/projects/${encodeURIComponent(project.id)}/chat-messages`
                : kind === "cycles"
                  ? `/api/admin/projects/${encodeURIComponent(project.id)}/feedback-cycles`
                  : `/api/admin/projects/${encodeURIComponent(project.id)}/issues`;
      const result = await apiWriteWithAdminPin(
        path,
        kind === "clusters"
          ? {}
          : kind === "pocs"
            ? { clientId: client.id, pocIds }
            : kind === "projects"
              ? { clientId: client.id, projectIds }
              : kind === "clients"
                ? { clientIds }
                : kind === "issues" ? { cycleIds, issueIds } : { cycleIds },
        "DELETE",
        cleanupPin.trim()
      );
      setCleanupConfirmation(null);
      setCleanupPin("");
      setSelectedDeletePocIds([]);
      setSelectedDeleteProjectIds([]);
      if (kind === "clusters" && clusterFilterId === cluster.id) setClusterFilterId("");
      await loadAll(kind === "clients" ? "" : clientId);
      onReload();
      showToast(kind === "clusters"
        ? `${result.clustersDeleted} cluster${result.clustersDeleted === 1 ? "" : "s"} permanently deleted. Assigned clients and internal POCs were kept without a cluster.`
        : kind === "pocs"
          ? `${result.pocsDeleted} client POC${result.pocsDeleted === 1 ? "" : "s"} permanently deleted.`
          : kind === "projects"
            ? `${result.projectsDeleted} project${result.projectsDeleted === 1 ? "" : "s"} and all related records permanently deleted.`
            : kind === "clients"
              ? `${result.clientsDeleted} client${result.clientsDeleted === 1 ? "" : "s"} and all related records permanently deleted.`
              : kind === "messages"
                ? `${result.messagesDeleted} chat message${result.messagesDeleted === 1 ? "" : "s"} cleared from ${result.cyclesAffected} selected cycle${result.cyclesAffected === 1 ? "" : "s"}. Ratings and issues were preserved.`
                : kind === "cycles"
                  ? `${result.cyclesDeleted} feedback cycle${result.cyclesDeleted === 1 ? "" : "s"} and all dependent feedback data were permanently deleted from ${project.name}.`
                  : `${result.issuesDeleted} selected issue${result.issuesDeleted === 1 ? "" : "s"} deleted from ${project.name}. Chats and ratings were preserved.`);
    } catch (cleanupError) {
      setCleanupPinError(cleanupError.status === 403 ? "Incorrect admin PIN." : cleanupError.message);
    } finally {
      setCleaning("");
    }
  }

  async function saveInternalPoc() {
    setSaving(true);
    try {
      const payload = { ...internalForm };
      if (payload.id) {
        await apiWrite(`/api/admin/internal-pocs/${encodeURIComponent(payload.id)}`, payload, "PATCH");
        showToast("Internal POC updated.");
      } else {
        await apiWrite("/api/admin/internal-pocs", payload, "POST");
        showToast("Internal POC added.");
      }
      setInternalForm(null);
      await loadAll(clientId);
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveServices() {
    setSaving(true);
    try {
      const payload = { services: serviceBatch.rows || [] };
      await apiWrite(`/api/admin/projects/${encodeURIComponent(serviceBatch.projectId)}/services`, payload, "PUT");
      showToast("All service changes saved.");
      setServiceBatch(null);
      await loadAll(clientId);
      onReload();
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveServiceCatalog() {
    const name = String(serviceCatalogForm?.name || "").trim();
    if (!name) {
      showToast("Enter a service name.");
      return;
    }
    setSaving(true);
    try {
      if (serviceCatalogForm.id) {
        await apiWrite(`/api/admin/service-catalog/${encodeURIComponent(serviceCatalogForm.id)}`, {
          name,
          active: serviceCatalogForm.active
        }, "PATCH");
        showToast("Standard service updated across its projects.");
      } else {
        await apiWrite("/api/admin/service-catalog", { name, active: true }, "POST");
        showToast("Standard service added.");
      }
      setServiceCatalogForm(null);
      await loadAll(clientId);
      onReload();
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveServiceCatalogBatch() {
    const names = (serviceCatalogBatch || []).map((row) => String(row.name || "").trim());
    if (!names.length || names.some((name) => !name)) {
      showToast("Enter a name for every service.");
      return;
    }
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      showToast("The same service appears more than once in this list.");
      return;
    }
    setSaving(true);
    try {
      const result = await apiWrite("/api/admin/service-catalog/bulk", { services: names.map((name) => ({ name })) }, "POST");
      setServiceCatalogBatch(null);
      await loadAll(clientId);
      onReload();
      showToast(`${result.services.length} standard service${result.services.length === 1 ? "" : "s"} added.`);
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeServiceCatalog(item) {
    if (!window.confirm(`Remove ${item.name} from the service catalogue?\n\nIf a project already uses it, the service will be archived instead so historical records remain valid.`)) return;
    setSaving(true);
    try {
      const result = await apiWrite(`/api/admin/service-catalog/${encodeURIComponent(item.id)}`, {}, "DELETE");
      showToast(result.action === "archived"
        ? `${item.name} is archived because existing projects use it.`
        : `${item.name} was deleted from the catalogue.`);
      await loadAll(clientId);
      onReload();
    } catch (removeError) {
      showToast(removeError.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveClient() {
    setSaving(true);
    try {
      const payload = { ...clientForm };
      if (payload.id) {
        await apiWrite(`/api/admin/clients/${encodeURIComponent(payload.id)}`, payload, "PATCH");
        showToast("Client updated.");
      } else {
        await apiWrite("/api/admin/clients", payload, "POST");
        showToast("Client added.");
      }
      setClientForm(null);
      await loadAll(payload.id ? clientId : "");
      onReload();
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveCluster() {
    setSaving(true);
    try {
      const payload = { ...clusterForm };
      if (payload.id) {
        await apiWrite(`/api/admin/clusters/${encodeURIComponent(payload.id)}`, payload, "PATCH");
        showToast("Cluster updated.");
      } else {
        await apiWrite("/api/admin/clusters", payload, "POST");
        showToast("Cluster added.");
      }
      setClusterForm(null);
      await loadAll(clientId);
      onReload();
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveProject() {
    setSaving(true);
    try {
      const payload = { ...projectForm };
      if (payload.id) {
        await apiWrite(`/api/admin/projects/${encodeURIComponent(payload.id)}`, payload, "PATCH");
        showToast("Project updated.");
      } else {
        await apiWrite("/api/admin/projects", payload, "POST");
        showToast("Project added.");
      }
      setProjectForm(null);
      await loadAll(clientId);
      onReload();
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function selectCluster(id) {
    setClusterFilterId(id);
    const allClients = directory?.clients || [];
    const available = id ? allClients.filter((client) => client.clusterId === id) : allClients;
    const currentStillAvailable = available.some((client) => client.id === clientId);
    await selectClient(currentStillAvailable ? clientId : "");
  }

  async function saveClientBatch() {
    const rows = clientBatch || [];
    if (rows.some((row) => !String(row.name || "").trim())) {
      showToast("Every client needs a name.");
      return;
    }
    setSaving(true);
    try {
      for (const row of rows) {
        await apiWrite(`/api/admin/clients/${encodeURIComponent(row.id)}`, row, "PATCH");
      }
      const selectedRow = rows.find((row) => row.id === clientId);
      if (clusterFilterId && selectedRow && selectedRow.clusterId !== clusterFilterId) setClusterFilterId("");
      setClientBatch(null);
      await loadAll(clientId);
      onReload();
      showToast(`${rows.length} client${rows.length === 1 ? "" : "s"} saved together.`);
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveInternalBatch() {
    const rows = internalBatch || [];
    if (rows.some((row) => !String(row.name || "").trim())) {
      showToast("Every internal POC needs a name.");
      return;
    }
    setSaving(true);
    try {
      for (const row of rows) {
        await apiWrite(`/api/admin/internal-pocs/${encodeURIComponent(row.id)}`, row, "PATCH");
      }
      setInternalBatch(null);
      await loadAll(clientId);
      onReload();
      showToast(`${rows.length} internal POC${rows.length === 1 ? "" : "s"} saved together.`);
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function savePocBatch() {
    const rows = pocBatch?.rows || [];
    const project = (detail?.projects || []).find((item) => item.id === pocBatch?.projectId);
    if (!project) {
      showToast("Select a project first.");
      return;
    }
    if (rows.some((row) => !String(row.name || "").trim())) {
      showToast("Every POC needs a name.");
      return;
    }
    if (rows.some((row) => row.active && !row.levelId)) {
      showToast("Select a Normal or Important tag for every active POC.");
      return;
    }
    const invalidWeightIndex = rows.findIndex((row) => row.active && (
      !Number.isFinite(Number(row.weightPercentage))
      || Number(row.weightPercentage) <= 0
      || Number(row.weightPercentage) > 100
    ));
    if (invalidWeightIndex >= 0) {
      showToast(`POC ${invalidWeightIndex + 1}: influence must be more than 0% and no more than 100%.`);
      return;
    }
    const activeWeightTotal = Math.round(rows.reduce(
      (sum, row) => sum + (row.active ? Number(row.weightPercentage) || 0 : 0),
      0
    ) * 100) / 100;
    if (rows.some((row) => row.active) && Math.abs(activeWeightTotal - 100) > 0.01) {
      showToast(`Active POC influence must total exactly 100%. It currently totals ${activeWeightTotal}%.`);
      return;
    }
    const normalizedPhones = rows.map((row) => String(row.contactWhatsapp || "").replace(/\D/g, ""));
    const invalidPhoneIndex = normalizedPhones.findIndex((phone, index) => phone && (phone.length < 10 || phone.length > 15) && rows[index].active);
    if (invalidPhoneIndex >= 0) {
      showToast(`POC ${invalidPhoneIndex + 1}: WhatsApp number must be 10-15 digits including country code.`);
      return;
    }
    const usedPhones = new Set();
    const duplicatePhoneIndex = normalizedPhones.findIndex((phone) => {
      if (!phone) return false;
      if (usedPhones.has(phone)) return true;
      usedPhones.add(phone);
      return false;
    });
    if (duplicatePhoneIndex >= 0) {
      showToast(`POC ${duplicatePhoneIndex + 1}: that WhatsApp number appears twice on this project.`);
      return;
    }
    setSaving(true);
    try {
      await apiWrite(
        `/api/admin/projects/${encodeURIComponent(pocBatch.projectId)}/pocs`,
        { pocs: rows, removedIds: pocBatch.removedIds || [] },
        "PUT"
      );
      const removedCount = (pocBatch.removedIds || []).length;
      setPocBatch(null);
      await loadAll(clientId);
      onReload();
      showToast(`All project POCs saved${removedCount ? `; ${removedCount} removed from future sends` : ""}.`);
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function savePocControl() {
    setSaving(true);
    try {
      const result = await apiWrite("/api/admin/pocs/bulk-control", {
        updates: pocControlRows.map((row) => ({
          id: row.id,
          active: row.active,
          levelId: row.levelId || "",
          weightPercentage: row.active ? Number(row.weightPercentage) : 0
        }))
      }, "PUT");
      await loadAll(clientId);
      onReload();
      showToast(`${result.updated} POC assignment${result.updated === 1 ? "" : "s"} saved.`);
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function previewBulkSend() {
    setBulkSending(true);
    try {
      const preview = await apiWrite("/api/admin/bulk-feedback/preview", { cycleType: bulkCycleType }, "POST");
      setBulkPreview(preview);
      setBulkSelectedProjectIds(preview.projects.filter((project) => project.eligible).map((project) => project.projectId));
      if (!preview.messaging.enabled) showToast("WhatsApp messaging is paused. You can review the preview, but sending is disabled.");
    } catch (previewError) {
      showToast(previewError.message);
    } finally {
      setBulkSending(false);
    }
  }

  async function executeBulkSend() {
    if (!bulkSelectedProjectIds.length) { showToast("Select at least one eligible project from the preview."); return; }
    const label = bulkCycleType === "quick_checkin" ? "quick check-in" : "30-day feedback";
    if (!window.confirm(`Send ${label} for ${bulkSelectedProjectIds.length} selected project(s)?\n\nThe preview rules will be checked again before sending.`)) return;
    setBulkSending(true);
    try {
      const result = await apiWrite("/api/admin/bulk-feedback/send", {
        cycleType: bulkCycleType,
        projectIds: bulkSelectedProjectIds
      }, "POST");
      showToast(`${result.projectsStarted} project${result.projectsStarted === 1 ? "" : "s"} started · ${result.messagesQueued} WhatsApp message${result.messagesQueued === 1 ? "" : "s"} queued.`);
      setBulkPreview(null);
      setBulkSelectedProjectIds([]);
      await loadAll(clientId);
      onReload();
    } catch (sendError) {
      showToast(sendError.message);
    } finally {
      setBulkSending(false);
    }
  }

  function downloadWorkbookTemplate() {
    const link = document.createElement("a");
    link.href = "/templates/csat-multi-client-import.xlsx";
    link.download = "csat-multi-client-import.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function importWorkbook(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportErrors([]);
    setImporting(true);
    try {
      const payload = await parseCsatWorkbook(file);
      const result = await apiWrite("/api/admin/import-workbook", payload, "POST");
      const changed = Object.entries(result.counts || {})
        .filter(([, count]) => count && typeof count === "object")
        .reduce((sum, [, count]) => sum + (count.created || 0) + (count.updated || 0), 0);
      showToast(`${changed} record${changed === 1 ? "" : "s"} created or updated. Scheduling is ready.`);
      await loadAll("");
      onReload();
    } catch (importError) {
      setImportErrors(Array.isArray(importError.details) ? importError.details : [importError.message]);
      showToast(importError.message);
    } finally {
      setImporting(false);
      event.target.value = "";
    }
  }

  async function saveCompleteProject() {
    setSaving(true);
    try {
      await apiWrite("/api/admin/project-setups", setupForm, "POST");
      showToast("Project, POCs and services saved together. Scheduling is ready.");
      setSetupForm(null);
      await loadAll(clientId);
      onReload();
    } catch (saveError) {
      showToast(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  if (!unlocked) return <PinGate onUnlock={() => setUnlocked(true)} />;
  if (loading) return <LoadingBlock label="Loading records" />;

  const clients = directory?.clients || [];
  const clusters = directory?.clusters || [];
  const filteredClients = clusterFilterId
    ? clients.filter((client) => client.clusterId === clusterFilterId)
    : clients;
  const levels = directory?.pocLevels || [];
  const serviceCatalog = directory?.serviceCatalog || [];
  const normalLevel = levels.find((level) =>
    String(level.name || "").toLowerCase() === "normal"
  ) || levels[0] || null;
  const selectedClient = clients.find((item) => item.id === clientId) || null;
  const projects = detail?.projects || [];
  const allProjects = directory?.projects || [];
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const visibleProjects = allProjects.filter((project) => {
    if (clientId) return project.clientId === clientId;
    if (!clusterFilterId) return true;
    return clientsById.get(project.clientId)?.clusterId === clusterFilterId;
  });
  const pocs = detail?.pocs || [];
  const services = detail?.services || [];
  const people = directory?.internalPocs || [];
  const cleanupCycles = cleanupWorkspace?.cycles || [];
  const cleanupIssues = issuesForCleanupCycles(selectedCleanupCycleIds);
  const cleanupCyclesById = new Map(cleanupCycles.map((cycle) => [cycle.id, cycle]));

  // Internal POCs reach a project through its services: project -> service ->
  // internal_poc_id. Showing every SRV person on every project made it look as
  // though staff were shared across clients, and made it easy to route an
  // issue to somebody with no involvement.
  const projectIds = new Set(projects.map((item) => item.id));
  const internalPocIdsOnThisClient = new Set(
    services.filter((svc) => projectIds.has(svc.projectId) && svc.internalPocId)
      .map((svc) => svc.internalPocId)
  );
  const peopleOnThisClient = people.filter((person) => internalPocIdsOnThisClient.has(person.id));
  const peopleBeforeClusterFilter = showAllInternal ? people : peopleOnThisClient;
  const visiblePeople = clusterFilterId
    ? peopleBeforeClusterFilter.filter((person) => person.clusterId === clusterFilterId)
    : peopleBeforeClusterFilter;

  const departments = directory?.departments || [];
  const subDepartments = directory?.subDepartments || [];
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const projectNeedle = projectSearch.trim().toLowerCase();
  const displayedProjects = visibleProjects.filter((project) => !projectNeedle || [
    project.name,
    project.key,
    project.activeStatus,
    clientsById.get(project.clientId)?.name,
    project.startDate,
    project.endDate
  ].some((value) => String(value || "").toLowerCase().includes(projectNeedle)));
  const serviceCatalogNeedle = serviceCatalogSearch.trim().toLowerCase();
  const displayedServiceCatalog = serviceCatalog.filter((item) => !serviceCatalogNeedle || [
    item.name,
    item.serviceKey,
    item.active ? "active" : "archived"
  ].some((value) => String(value || "").toLowerCase().includes(serviceCatalogNeedle)));
  const internalPocNeedle = internalPocSearch.trim().toLowerCase();
  const displayedPeople = visiblePeople.filter((person) => {
    const department = departments.find((item) => item.id === person.departmentId);
    const subDepartment = subDepartments.find((item) => item.id === person.subDepartmentId);
    const manager = peopleById.get(person.reportingManagerId);
    return !internalPocNeedle || [
      person.name,
      person.email,
      person.phone,
      department?.name,
      subDepartment?.name,
      manager?.name,
      person.active ? "active" : "inactive"
    ].some((value) => String(value || "").toLowerCase().includes(internalPocNeedle));
  });
  const manageAccessClasses = [
    !canManageRecords && "deny-manage-records",
    !canManagePocs && "deny-manage-pocs",
    !canManageInternalPocs && "deny-manage-internal-pocs",
    !canManageCatalogues && "deny-manage-catalogues",
    !canBulkSend && "deny-bulk-sends",
    !canManageUsers && "deny-manage-users"
  ].filter(Boolean).join(" ");

  return (
    <div className={`manage-page ${manageAccessClasses}`}>
      <div className="topbar">
        <div>
          <h2>Manage records</h2>
          <p className="topbar-sub">
            Insert and edit clusters, clients, projects, POCs, services and internal owners
            {selectedClient ? ` · viewing ${selectedClient.name}` : ""}
          </p>
        </div>
        <Button icon={RefreshCw} onClick={() => loadAll(clientId)}>Refresh</Button>
      </div>

      <FilterBar
        showReset={Boolean(clusterFilterId || clientId)}
        onReset={() => { setClusterFilterId(""); void selectClient(""); }}
      >
        <SingleSelect
          label="Cluster"
          value={clusterFilterId}
          onChange={selectCluster}
          placeholder="All clusters"
          options={clusters.map((cluster) => ({ value: cluster.id, label: cluster.name }))}
        />
        <SingleSelect
          label="Client"
          value={clientId}
          onChange={selectClient}
          placeholder="All clients"
          options={filteredClients.map((client) => ({ value: client.id, label: client.name }))}
        />
      </FilterBar>

      <nav className="manage-section-nav" aria-label="Manage sections">
        {canManageRecords ? <button type="button" onClick={() => document.getElementById("manage-projects")?.scrollIntoView({ behavior: "smooth" })}>Projects</button> : null}
        {canManagePocs ? <button type="button" onClick={() => document.getElementById("manage-poc-control")?.scrollIntoView({ behavior: "smooth" })}>POC Control</button> : null}
        {canManagePocs ? <button type="button" onClick={() => document.getElementById("manage-client-pocs")?.scrollIntoView({ behavior: "smooth" })}>Client POCs</button> : null}
        {canManageCatalogues ? <button type="button" onClick={() => document.getElementById("manage-service-catalog")?.scrollIntoView({ behavior: "smooth" })}>Standard Services</button> : null}
        {canManageRecords ? <button type="button" onClick={() => document.getElementById("manage-services")?.scrollIntoView({ behavior: "smooth" })}>Project Services</button> : null}
        {canManageInternalPocs ? <button type="button" onClick={() => document.getElementById("manage-internal-pocs")?.scrollIntoView({ behavior: "smooth" })}>Internal POCs</button> : null}
        {canBulkSend ? <button type="button" onClick={() => document.getElementById("manage-bulk-sends")?.scrollIntoView({ behavior: "smooth" })}>Bulk Sends</button> : null}
        {canManageUsers ? <button type="button" onClick={() => document.getElementById("manage-app-users")?.scrollIntoView({ behavior: "smooth" })}>Application Users</button> : null}
        {canManageCatalogues ? <button type="button" onClick={() => document.getElementById("manage-performance-standards")?.scrollIntoView({ behavior: "smooth" })}>Performance Standards</button> : null}
      </nav>

      {canManageUsers ? <section id="manage-app-users" className="admin-collapsible-panel">
        <details>
          <summary>
            <span><strong>Application Users</strong><small>Google access · {appUsers.filter((user) => user.active).length} active</small></span>
          </summary>
          <div className="admin-collapsible-body">
            <p className="form-note">Super Admin always has full access. Super Admin can configure Admins and Project Users. Admins with this permission can manage Project Users only and can never change an Admin or Super Admin account.</p>
            <div className="bulk-editor-block">
              <div className="bulk-editor-heading">
                <span><strong>Add multiple users</strong><small>For a Project User, select the Internal POC and their saved name and email are used automatically. Enter details manually only for Admin or Super Admin.</small></span>
              </div>
              <div className="app-user-draft-list">
                {newAppUsers.map((row) => (
                  <div className="app-user-draft-row" key={row.draftId}>
                    <select value={row.role} onChange={(event) => { const role = event.target.value; updateNewAppUser(row.draftId, { role, internalPocId: role === "project_user" ? row.internalPocId : "", permissions: defaultPermissions(role) }); }} aria-label="Application role">
                      <option value="project_user">Project User</option>{isSuperAdmin ? <option value="admin">Admin</option> : null}{isSuperAdmin ? <option value="super_admin">Super Admin</option> : null}
                    </select>
                    {row.role === "project_user" ? <select value={row.internalPocId} onChange={(event) => { const internalPocId = event.target.value; const person = people.find((item) => item.id === internalPocId); updateNewAppUser(row.draftId, { internalPocId, name: person?.name || "", email: person?.email || "" }); }} aria-label="Internal POC"><option value="">Select Internal POC</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select> : <span className="bulk-row-placeholder">Access across projects</span>}
                    {row.role === "project_user" ? <span className={`app-user-linked-identity ${row.internalPocId && !row.email ? "missing-email" : ""}`}><strong>{row.name || "Select a person"}</strong><small>{row.email || (row.internalPocId ? "Email missing in Internal POCs" : "Name and email will load automatically")}</small></span> : <span className="app-user-manual-identity"><input value={row.name} onChange={(event) => updateNewAppUser(row.draftId, { name: event.target.value })} placeholder="Name" aria-label="User name" /><input type="email" value={row.email} onChange={(event) => updateNewAppUser(row.draftId, { email: event.target.value })} placeholder="name@srvmedia.com" aria-label="Google Workspace email" /></span>}
                    <select value={row.active ? "active" : "inactive"} onChange={(event) => updateNewAppUser(row.draftId, { active: event.target.value === "active" })} aria-label="User status"><option value="active">Active</option><option value="inactive">Inactive</option></select>
                    <button type="button" className="icon-button danger" disabled={newAppUsers.length === 1} onClick={() => setNewAppUsers((current) => current.filter((item) => item.draftId !== row.draftId))} aria-label="Remove pending user"><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
              <div className="button-row bulk-editor-actions">
                <Button icon={Plus} onClick={() => setNewAppUsers((current) => [...current, createAppUserDraft()])}>Add another user</Button>
                <Button variant="primary" onClick={addAppUsers} disabled={saving || !newAppUsers.some((row) => row.email.trim() || row.internalPocId)}>{saving ? "Adding users…" : `Add ${newAppUsers.filter((row) => row.email.trim() || row.internalPocId).length || ""} user${newAppUsers.filter((row) => row.email.trim() || row.internalPocId).length === 1 ? "" : "s"}`.trim()}</Button>
              </div>
            </div>
            <div className="bulk-editor-heading existing-users-heading">
              <span><strong>Edit users and roles together</strong><small>Make all required role, status and permission changes, then save once.</small></span>
              <Button variant="primary" onClick={saveAllAppUsers} disabled={saving || !appUsers.length}>{saving ? "Saving users…" : "Save all user changes"}</Button>
            </div>
            <div className="admin-control-scroll">
              {appUsers.map((user) => (
                <details className="app-user-card" key={user.id}>
                  <summary><span><strong>{user.email}</strong><small>{user.name || "Name not set"}</small></span><span className={`role-badge role-${user.role}`}>{user.role.replace("_", " ")}</span></summary>
                  <div className="app-user-card-body">
                    <div className="app-user-row">
                      <input value={user.name || ""} onChange={(event) => setAppUsers((current) => current.map((item) => item.id === user.id ? { ...item, name: event.target.value } : item))} aria-label={`Name for ${user.email}`} />
                      <select value={user.role} disabled={!isSuperAdmin} onChange={(event) => { const role = event.target.value; setAppUsers((current) => current.map((item) => item.id === user.id ? { ...item, role, permissions: defaultPermissions(role) } : item)); }} aria-label={`Role for ${user.email}`}><option value="project_user">Project User</option>{isSuperAdmin ? <option value="admin">Admin</option> : null}{isSuperAdmin ? <option value="super_admin">Super Admin</option> : null}</select>
                      {user.role === "project_user" ? <select value={user.internalPocId || ""} onChange={(event) => setAppUsers((current) => current.map((item) => item.id === user.id ? { ...item, internalPocId: event.target.value } : item))} aria-label={`Internal POC for ${user.email}`}><option value="">Select Internal POC</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select> : null}
                      <select value={user.active ? "active" : "inactive"} onChange={(event) => setAppUsers((current) => current.map((item) => item.id === user.id ? { ...item, active: event.target.value === "active" } : item))} aria-label={`Status for ${user.email}`}><option value="active">Active</option><option value="inactive">Inactive</option></select>
                    </div>
                    <div className="app-permission-grid">
                      {permissionsForRole(user.role).map((permission) => <label key={permission}><input type="checkbox" checked={user.role === "super_admin" || user.permissions?.[permission] === true} disabled={user.role === "super_admin"} onChange={(event) => setAppUsers((current) => current.map((item) => item.id === user.id ? { ...item, permissions: { ...item.permissions, [permission]: event.target.checked } } : item))} /><span>{APP_PERMISSION_LABELS[permission]}</span></label>)}
                    </div>
                  </div>
                </details>
              ))}
              {!appUsers.length ? <EmptyState title="No Google users assigned yet" text="Add your own Google email as Super Admin before removing the password-login secret." /> : null}
            </div>
          </div>
        </details>
      </section> : null}

      {canManageCatalogues ? <section id="manage-performance-standards" className="admin-collapsible-panel">
        <details>
          <summary>
            <span><strong>Project Performance Standards</strong><small>Controlled dropdown values · Super Admin only</small></span>
          </summary>
          <div className="admin-collapsible-body">
            <p className="form-note">Open any standard below. Add multiple new rows, edit existing values or statuses, select values for removal, and save that standard once. The page and scroll position remain unchanged.</p>
            <div className="admin-control-scroll standards-scroll">
              {Object.entries(PERFORMANCE_STANDARD_LABELS).map(([category, label]) => {
                const values = performanceStandards.filter((item) => item.category === category);
                const drafts = standardDrafts[category] || [];
                const selectedIds = values.filter((item) => selectedStandardIds.includes(item.id)).map((item) => item.id);
                return (
                  <details className="standard-category" key={category}>
                    <summary><strong>{label}</strong><small>{values.filter((item) => item.active).length} active · {values.length} saved</small></summary>
                    <div className="standard-value-list">
                      {values.length ? <label className="standard-select-all"><input type="checkbox" checked={selectedIds.length === values.length} onChange={(event) => setSelectedStandardIds((current) => event.target.checked ? [...new Set([...current, ...values.map((item) => item.id)])] : current.filter((id) => !values.some((item) => item.id === id)))} /><span>Select all saved values</span></label> : null}
                      {values.map((item) => (
                        <div className="standard-value-row" key={item.id}>
                          <input type="checkbox" className="standard-row-checkbox" checked={selectedStandardIds.includes(item.id)} onChange={(event) => setSelectedStandardIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} aria-label={`Select ${item.value}`} />
                          <input value={item.value} onChange={(event) => setPerformanceStandards((current) => current.map((value) => value.id === item.id ? { ...value, value: event.target.value } : value))} aria-label={`${label} value`} />
                          <select value={item.active ? "active" : "inactive"} onChange={(event) => setPerformanceStandards((current) => current.map((value) => value.id === item.id ? { ...value, active: event.target.value === "active" } : value))}><option value="active">Active</option><option value="inactive">Archived</option></select>
                        </div>
                      ))}
                      {drafts.map((item) => (
                        <div className="standard-value-row standard-draft-row" key={item.draftId}>
                          <span className="standard-new-badge">New</span>
                          <input value={item.value} onChange={(event) => updateStandardDraft(category, item.draftId, { value: event.target.value })} placeholder={`New ${label}`} aria-label={`New ${label}`} />
                          <select value={item.active ? "active" : "inactive"} onChange={(event) => updateStandardDraft(category, item.draftId, { active: event.target.value === "active" })}><option value="active">Active</option><option value="inactive">Archived</option></select>
                          <button type="button" className="icon-button danger" onClick={() => removeStandardDraft(category, item.draftId)} disabled={saving || drafts.length === 1} aria-label={`Remove new ${label} row`}><Trash2 size={15} /></button>
                        </div>
                      ))}
                      <div className="button-row standard-bulk-actions">
                        <Button icon={Plus} onClick={() => addStandardDraft(category)} disabled={saving}>Add another value</Button>
                        <Button variant="danger" onClick={() => removeSelectedPerformanceStandards(category)} disabled={saving || !selectedIds.length}>Remove selected ({selectedIds.length})</Button>
                        <Button variant="primary" onClick={() => savePerformanceStandardCategory(category)} disabled={saving}>{saving ? "Saving…" : `Save all ${label}`}</Button>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          </div>
        </details>
      </section> : null}

      {/* Setting a project up has an order, and doing it out of order leaves
          a project that cannot be sent: no POC means no recipient, no service
          owner means an issue nobody hears about. */}
      {clientId && (canManageRecords || canManagePocs || canManageInternalPocs) ? (
        <nav className="setup-steps" aria-label="Manage section shortcuts">
          {canManageRecords ? <button type="button" className={projects.length ? "done" : "todo"} onClick={() => document.getElementById("manage-projects")?.scrollIntoView({ behavior: "smooth" })}>
            1. Projects{projects.length ? ` (${projects.length})` : ""}
          </button> : null}
          {canManagePocs ? <button type="button" className={pocs.length ? "done" : "todo"} onClick={() => document.getElementById("manage-client-pocs")?.scrollIntoView({ behavior: "smooth" })}>
            2. Client POCs{pocs.length ? ` (${pocs.length})` : ""}
          </button> : null}
          {canManageRecords ? <button type="button" className={services.length ? "done" : "todo"} onClick={() => document.getElementById("manage-services")?.scrollIntoView({ behavior: "smooth" })}>
            3. Services{services.length ? ` (${services.length})` : ""}
          </button> : null}
          {canManageInternalPocs ? <button type="button" className={peopleOnThisClient.length ? "done" : "todo"} onClick={() => document.getElementById("manage-internal-pocs")?.scrollIntoView({ behavior: "smooth" })}>
            4. Internal owners{peopleOnThisClient.length ? ` (${peopleOnThisClient.length})` : ""}
          </button> : null}
        </nav>
      ) : null}

      <Panel
        id="manage-poc-control"
        title="POC Control Centre"
        badge={`${pocControlRows.filter((poc) => poc.active).length} active · ${pocControlRows.filter((poc) => !poc.active).length} inactive`}
        className="span-12"
      >
        <PocControlCentre rows={pocControlRows} levels={levels} onChange={setPocControlRows} onSave={savePocControl} saving={saving} />
      </Panel>

      <Panel
        id="manage-bulk-sends"
        title="Bulk Feedback Sends"
        badge="PIN protected · preview required"
        className="span-12"
      >
        <p className="form-note">
          Preview every active project before sending. Projects can be selected or deselected. The system blocks simultaneous sessions for the same WhatsApp number and rechecks eligibility immediately before sending.
        </p>
        <div className="bulk-send-controls">
          <Field label="Feedback type">
            <select value={bulkCycleType} onChange={(event) => { setBulkCycleType(event.target.value); setBulkPreview(null); setBulkSelectedProjectIds([]); }}>
              <option value="pulse">30-day feedback</option>
              <option value="quick_checkin">Quick check-in</option>
            </select>
          </Field>
          <Button variant="primary" onClick={previewBulkSend} disabled={bulkSending}>{bulkSending ? "Checking…" : "Preview eligible projects"}</Button>
        </div>
        {bulkPreview ? (
          <>
            <div className="bulk-preview-summary">
              <strong>{bulkSelectedProjectIds.length} selected projects</strong>
              <span>{bulkPreview.eligiblePocs} eligible POC messages before your project selections</span>
              <span>{bulkPreview.projects.filter((project) => !project.eligible).length} projects blocked</span>
            </div>
            {!bulkPreview.messaging.enabled ? (
              <p className="manual-whatsapp-warning">WhatsApp messaging is paused. Email remains active. Resume WhatsApp from Dashboard before sending.</p>
            ) : null}
            <div className="bulk-preview-table">
              <div className="bulk-preview-row head"><span /><span>Project</span><span>Client</span><span>Eligible POCs</span><span>Skipped / conflicts</span><span>Result</span></div>
              {bulkPreview.projects.map((project) => {
                const checked = bulkSelectedProjectIds.includes(project.projectId);
                return (
                  <div className={`bulk-preview-row ${project.eligible ? "" : "blocked"}`} key={project.projectId}>
                    <input type="checkbox" checked={checked} disabled={!project.eligible} onChange={() => setBulkSelectedProjectIds(checked ? bulkSelectedProjectIds.filter((id) => id !== project.projectId) : [...bulkSelectedProjectIds, project.projectId])} aria-label={`Select ${project.projectName}`} />
                    <span><strong>{project.projectName}</strong><small>{project.projectKey}</small></span>
                    <span>{project.clientName || "--"}</span>
                    <span>{project.eligiblePocs.length ? project.eligiblePocs.map((poc) => poc.name).join(", ") : "None"}</span>
                    <span>{[...project.invalidPocs.map((poc) => `${poc.name}: ${poc.reason}`), ...project.conflicts.map((item) => `${item.pocName}: ${item.reason}`)].join(" · ") || "None"}</span>
                    <span className={project.eligible ? "success" : "missing"}>{project.eligible ? "Ready" : project.reasons.join(" · ")}</span>
                  </div>
                );
              })}
            </div>
            <div className="button-row section-bottom-actions">
              <Button onClick={() => setBulkSelectedProjectIds(bulkPreview.projects.filter((project) => project.eligible).map((project) => project.projectId))}>Select all eligible</Button>
              <Button onClick={() => setBulkSelectedProjectIds([])}>Deselect all</Button>
              <Button variant="primary" onClick={executeBulkSend} disabled={bulkSending || !bulkSelectedProjectIds.length || !bulkPreview.messaging.enabled}>
                {bulkSending ? "Sending…" : `Send to ${bulkSelectedProjectIds.length} selected project${bulkSelectedProjectIds.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </>
        ) : null}
      </Panel>

      <Panel
        id="manage-poc-influence"
        title="POC scoring influence"
        badge="Per project"
        className="span-12"
      >
        <p className="form-note">
          Normal and Important are descriptive tags only. Open <strong>Manage project POCs</strong> below and enter
          each active POC's direct CSAT influence. The active percentages for each project must total exactly 100%.
          Use <strong>Distribute equally</strong> as a starting point, then adjust individual values if needed.
        </p>
        <div className="influence-examples">
          <div>
            <strong>Example: five POCs</strong>
            <span>40% + 20% + 15% + 15% + 10% = 100%</span>
          </div>
          <div>
            <strong>Tags do not change those numbers</strong>
            <span>A Normal POC may be 40%; an Important POC may be 10%.</span>
          </div>
        </div>
        <p className="form-note">
          A cycle stores the percentages that were active when it started. Changing a POC later affects future cycles only; completed feedback history is preserved.
        </p>
      </Panel>

      <Panel
        id="manage-workbook"
        title="Bulk Excel onboarding and updates"
        badge="Multiple clients in one upload"
        className="span-12"
        action={
          <div className="button-row">
            <Button icon={Download} onClick={downloadWorkbookTemplate}>Excel template</Button>
            <input
              ref={workbookInputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              onChange={importWorkbook}
            />
            <Button
              icon={Upload}
              disabled={importing}
              onClick={() => workbookInputRef.current?.click()}
            >
              {importing ? "Validating and importing…" : "Upload Excel"}
            </Button>
          </div>
        }
      >
        <p className="form-note">
          The workbook can contain multiple clients, projects, client POCs, services, and internal POCs. It matches
          clients by client ID, projects by project ID, client POCs by WhatsApp number, internal POCs by email, and
          services by project ID + service key. Missing rows never delete existing records.
        </p>
        <p className="form-note">
          For the simpler route, fill only <strong>Quick Project Upload</strong>: repeat the client/project columns and add
          one POC and one service per row. Use Internal POCs only when an owner email is new. Alternatively, use the
          detailed Clients, Projects, Client POCs and Services sheets. Do not fill both project-data methods in the same upload.
        </p>
        {importErrors.length ? (
          <div className="import-errors" role="alert">
            <strong>Correct these workbook rows, then upload again:</strong>
            <ul>
              {importErrors.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}
            </ul>
          </div>
        ) : null}
      </Panel>

      <Panel
        id="manage-clients"
        title="Clients and clusters"
        badge={`${filteredClients.length} displayed · ${clients.length} clients · ${clusters.length} clusters`}
        className="span-12"
        action={
          <div className="button-row">
            <Button icon={Plus} onClick={() => { closeForms(); setClusterForm({ ...EMPTY_CLUSTER }); }}>Add cluster</Button>
            <Button icon={Plus} onClick={() => { closeForms(); setClientForm({ ...EMPTY_CLIENT, clusterId: clusterFilterId }); }}>Add client</Button>
            <Button
              icon={Pencil}
              disabled={!filteredClients.length}
              onClick={() => { closeForms(); setClientBatch(clientRowsForBatch(filteredClients)); }}
            >
              Edit displayed clients
            </Button>
          </div>
        }
      >
        {clusterForm ? (
          <div ref={formRef}>
            <ClusterForm
              value={clusterForm}
              saving={saving}
              onChange={setClusterForm}
              onSave={saveCluster}
              onCancel={() => setClusterForm(null)}
            />
          </div>
        ) : null}
        {clientForm ? (
          <div ref={formRef}>
            <ClientForm
              value={clientForm}
              clusters={clusters}
              saving={saving}
              onChange={setClientForm}
              onSave={saveClient}
              onCancel={() => setClientForm(null)}
            />
          </div>
        ) : null}
        {clientBatch ? (
          <div ref={formRef}>
            <ClientBatchForm
              rows={clientBatch}
              clusters={clusters}
              saving={saving}
              onChange={setClientBatch}
              onSave={saveClientBatch}
              onCancel={() => setClientBatch(null)}
            />
          </div>
        ) : null}
        <div className="manage-clients-scroll">
        <div className="dtable manage-clients">
          <div className="dtable-head">
            <span>Client</span>
            <span>Client ID</span>
            <span>Cluster</span>
            <span>Status</span>
            <span />
          </div>
          {filteredClients.map((client) => {
            const cluster = clusters.find((item) => item.id === client.clusterId);
            return (
              <div key={client.id} className={`dtable-row ${client.id === clientId ? "selected" : ""}`}>
                <strong>{client.name}</strong>
                <span className="mono">{client.key}</span>
                <span className={cluster ? "" : "missing"}>{cluster ? cluster.name : "not set"}</span>
                <span>{client.activeStatus}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Edit ${client.name}`}
                  onClick={() => {
                    closeForms();
                    setClientForm({
                      id: client.id,
                      key: client.key,
                      name: client.name,
                      clusterId: client.clusterId || "",
                      activeStatus: client.activeStatus || "active"
                    });
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {!filteredClients.length ? (
            <EmptyState
              title={clusterFilterId ? "No clients in this cluster" : "No clients"}
              text={clusterFilterId ? "Choose another cluster or add a client to this one." : "Add a cluster, then a client, then its projects."}
            />
          ) : null}
        </div>
        </div>
        {clusters.length ? (
          <div className="cluster-chips">
            {clusters.map((cluster) => (
              <div key={cluster.id} className="cluster-chip-group">
                <button
                  type="button"
                  className="cluster-chip"
                  onClick={() => { closeForms(); setClusterForm({ id: cluster.id, name: cluster.name }); }}
                >
                  {cluster.name}
                  <Pencil size={11} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="cluster-chip-delete"
                  aria-label={`Delete ${cluster.name}`}
                  title={`Delete ${cluster.name}`}
                  disabled={Boolean(cleaning)}
                  onClick={() => openClusterDeleteConfirmation(cluster)}
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel
        id="manage-service-catalog"
        title="Service catalogue"
        badge={`${displayedServiceCatalog.length} displayed · ${serviceCatalog.filter((item) => item.active).length} active · ${serviceCatalog.length} total`}
        className="span-12"
        action={<Button icon={Plus} onClick={() => { closeForms(); setServiceCatalogBatch([{ name: "" }]); }}>Add standard services</Button>}
      >
        <p className="form-note">
          Projects select services from this controlled list. Renaming a service updates its name on every linked project. Services already used in history are archived instead of being deleted.
        </p>
        {serviceCatalogForm ? (
          <div ref={formRef}>
            <ServiceCatalogForm
              value={serviceCatalogForm}
              onChange={setServiceCatalogForm}
              onSave={saveServiceCatalog}
              onCancel={() => setServiceCatalogForm(null)}
              saving={saving}
            />
          </div>
        ) : null}
        {serviceCatalogBatch ? (
          <div ref={formRef}>
            <ServiceCatalogBatchForm
              rows={serviceCatalogBatch}
              onChange={setServiceCatalogBatch}
              onSave={saveServiceCatalogBatch}
              onCancel={() => setServiceCatalogBatch(null)}
              saving={saving}
            />
          </div>
        ) : null}
        <div className="manage-section-search">
          <Field label="Search services"><input value={serviceCatalogSearch} onChange={(event) => setServiceCatalogSearch(event.target.value)} placeholder="Service name, key or status" /></Field>
          {serviceCatalogSearch ? <Button onClick={() => setServiceCatalogSearch("")}>Clear search</Button> : null}
        </div>
        <div className="manage-service-catalog-scroll">
        <div className="dtable manage-service-catalog">
          <div className="dtable-head">
            <span>Standard service</span>
            <span>Service key</span>
            <span>Status</span>
            <span />
          </div>
          {displayedServiceCatalog.map((item) => (
            <div className="dtable-row" key={item.id}>
              <strong>{item.name}</strong>
              <span className="mono">{item.serviceKey}</span>
              <span className={item.active ? "" : "missing"}>{item.active ? "Active" : "Archived"}</span>
              <span className="button-row">
                <button type="button" className="icon-button" aria-label={`Edit ${item.name}`} onClick={() => {
                  closeForms();
                  setServiceCatalogForm({ ...item });
                }}><Pencil size={14} aria-hidden="true" /></button>
                <button type="button" className="icon-button danger" aria-label={`Delete or archive ${item.name}`} disabled={saving}
                  onClick={() => removeServiceCatalog(item)}><Trash2 size={14} aria-hidden="true" /></button>
              </span>
            </div>
          ))}
          {!displayedServiceCatalog.length ? <EmptyState title={serviceCatalog.length ? "No services match this search" : "No standard services"} text={serviceCatalog.length ? "Clear the search to see every standard service." : "Add the services that projects can use."} /> : null}
        </div>
        </div>
      </Panel>

      <Panel
        id="manage-projects"
        title="Projects"
        badge={`${displayedProjects.length} displayed · ${allProjects.length} total`}
        className="span-12"
        action={
          <div className="button-row">
            <Button
              icon={Plus}
              variant="primary"
              disabled={!clients.length}
              onClick={() => {
                closeForms();
                setSetupForm({
                  project: { ...EMPTY_PROJECT, clientId },
                  copyProjectId: "",
                  pocs: [{ ...EMPTY_SETUP_POC, levelId: normalLevel?.id || "" }],
                  services: [{ ...EMPTY_SETUP_SERVICE }]
                });
                loadSetupCopySource(clientId);
              }}
            >
              Add complete project
            </Button>
            <Button
              icon={Plus}
              disabled={!clientId}
              onClick={() => { closeForms(); setProjectForm({ ...EMPTY_PROJECT, clientId }); }}
            >
              Project only
            </Button>
          </div>
        }
      >
        {setupForm ? (
          <div ref={formRef}>
            <ProjectSetupForm
              value={setupForm}
              clients={clients}
              levels={levels}
              people={people}
              serviceCatalog={serviceCatalog}
              copySource={setupCopySource}
              onClientChange={loadSetupCopySource}
              saving={saving}
              onChange={setSetupForm}
              onSave={saveCompleteProject}
              onCancel={() => setSetupForm(null)}
            />
          </div>
        ) : null}
        {projectForm ? (
          <div ref={formRef}>
            <ProjectForm
              value={projectForm}
              clients={clients}
              saving={saving}
              onChange={setProjectForm}
              onSave={saveProject}
              onCancel={() => setProjectForm(null)}
            />
          </div>
        ) : null}
        <div className="manage-section-search">
          <Field label="Search projects"><input value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Project, ID, client, status or date" /></Field>
          {projectSearch ? <Button onClick={() => setProjectSearch("")}>Clear search</Button> : null}
        </div>
        <div className="manage-projects-scroll">
        <div className="dtable manage-projects">
          <div className="dtable-head">
            <span>Project</span>
            <span>Project ID</span>
            <span>Client</span>
            <span>Status</span>
            <span>Start</span>
            <span>End</span>
            <span>Interval</span>
            <span />
          </div>
          {displayedProjects.map((project) => (
            <div key={project.id} className="dtable-row">
              <strong>{project.name}</strong>
              <span className="mono">{project.key}</span>
              <span>{clientsById.get(project.clientId)?.name || "Client not found"}</span>
              <span>{project.activeStatus}</span>
              <span>{formatDate(project.startDate)}</span>
              <span>{formatDate(project.endDate)}</span>
              <span>{project.feedbackIntervalDays} days</span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Edit ${project.name}`}
                onClick={() => {
                  closeForms();
                  setProjectForm({
                    id: project.id,
                    clientId: project.clientId,
                    key: project.key,
                    name: project.name,
                    activeStatus: project.activeStatus,
                    startDate: project.startDate || "",
                    endDate: project.endDate || "",
                    feedbackIntervalDays: project.feedbackIntervalDays
                  });
                }}
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
          {!displayedProjects.length ? (
            <EmptyState
              title={visibleProjects.length ? "No projects match this search" : "No projects match these filters"}
              text={visibleProjects.length ? "Clear the project search to see all filtered projects." : "Clear the client or cluster filter, or add a project for the selected client."}
            />
          ) : null}
        </div>
        </div>
      </Panel>

      <Panel
        id="manage-client-pocs"
        title="Client POCs"
        badge={`${pocs.length} total`}
        className="span-12"
        action={
          <div className="button-row">
            <Button
              icon={Pencil}
              variant="primary"
              disabled={!projects.length}
              onClick={() => {
                closeForms();
                const projectId = projects[0]?.id || "";
                setPocBatch({ projectId, rows: pocRowsForProject(pocs, projectId), removedIds: [] });
              }}
            >
              Manage project POCs
            </Button>
          </div>
        }
      >
        {pocBatch ? (
          <div ref={formRef}>
            <PocBatchForm
              value={pocBatch}
              projects={projects}
              pocs={pocs}
              levels={levels}
              saving={saving}
              onChange={setPocBatch}
              onSave={savePocBatch}
              onCancel={() => setPocBatch(null)}
            />
          </div>
        ) : null}
        <div className="dtable manage-pocs">
          <div className="dtable-head">
            <span>Name</span>
            <span>Project</span>
            <span>Designation</span>
            <span>WhatsApp</span>
            <span>Birthday</span>
            <span>Tag & influence</span>
            <span>Active</span>
            <span />
          </div>
          {pocs.map((poc) => {
            const project = projects.find((item) => item.id === poc.projectId);
            return (
              <div key={poc.id} className="dtable-row">
                <strong>{poc.name}</strong>
                <span>{project ? project.name : "--"}</span>
                <span>{poc.designation || "--"}</span>
                <span className={`mono ${poc.contactWhatsapp ? "" : "missing"}`}>{poc.contactWhatsapp || "not set"}</span>
                <span>{poc.birthDate ? formatDate(poc.birthDate) : "--"}</span>
                <span>{poc.levelName ? `${poc.levelName} · ${formatPocWeightShare(poc, pocs)}` : "Not set"}</span>
                <span className={poc.active ? "" : "missing"}>{poc.active ? "Yes" : "No"}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Edit ${poc.name}`}
                  onClick={() => {
                    closeForms();
                    setPocBatch({
                      projectId: poc.projectId,
                      rows: pocRowsForProject(pocs, poc.projectId),
                      removedIds: []
                    });
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {!pocs.length ? (
            <EmptyState title="No POCs" text="POCs may be stored without a WhatsApp number. Add a valid number before sending feedback." />
          ) : null}
        </div>
      </Panel>

      <Panel
        id="manage-services"
        title="Services and owners"
        badge={`${services.length} on this client`}
        className="span-12"
        action={
          <Button
            icon={Plus}
            disabled={!projects.length}
            onClick={() => {
              closeForms();
              const projectId = projects[0]?.id || "";
              setServiceBatch({ projectId, rows: serviceRowsForProject(services, projectId) });
            }}
          >
            Manage services
          </Button>
        }
      >
        {serviceBatch ? (
          <div ref={formRef}>
            <ServiceBatchForm
              value={serviceBatch}
              projects={projects}
              services={services}
              serviceCatalog={serviceCatalog}
              people={people}
              saving={saving}
              onChange={setServiceBatch}
              onSave={saveServices}
              onCancel={() => setServiceBatch(null)}
            />
          </div>
        ) : null}
        <div className="dtable manage-services">
          <div className="dtable-head">
            <span>Service</span>
            <span>Project</span>
            <span>Key</span>
            <span>Owner</span>
            <span>Reporting manager</span>
            <span />
          </div>
          {services.map((service) => {
            const project = projects.find((item) => item.id === service.projectId);
            const owner = peopleById.get(service.internalPocId);
            const manager = owner ? peopleById.get(owner.reportingManagerId) : null;
            return (
              <div key={service.id} className="dtable-row">
                <strong>{service.name}</strong>
                <span>{project ? project.name : "--"}</span>
                <span className="mono">{service.serviceKey}</span>
                <span className={owner ? "" : "missing"}>{owner ? owner.name : "not set"}</span>
                <span className={manager ? "" : "missing"}>{manager ? manager.name : "not set"}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Edit ${service.name}`}
                  onClick={() => {
                    closeForms();
                    setServiceBatch({
                      projectId: service.projectId,
                      rows: serviceRowsForProject(services, service.projectId)
                    });
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {!services.length ? (
            <EmptyState title="No services on this client" text="Feedback cannot be routed to an owner until services exist." />
          ) : null}
        </div>
      </Panel>

      <Panel
        id="manage-internal-pocs"
        title="Internal POCs"
        badge={`${displayedPeople.length} displayed${showAllInternal ? ` · ${people.length} across the agency` : ` · ${peopleOnThisClient.length} on this client`}`}
        className="span-12"
        action={
          <div className="button-row">
            <button type="button" className="row-link" onClick={() => setShowAllInternal((value) => !value)}>
              {showAllInternal ? "Show this client only" : "Show everyone"}
            </button>
            <Button
              icon={Pencil}
              disabled={!displayedPeople.length}
              onClick={() => { closeForms(); setInternalBatch(internalPocRowsForBatch(displayedPeople)); }}
            >
              Edit displayed internal POCs
            </Button>
            <Button icon={Plus} onClick={() => { closeForms(); setInternalForm({ ...EMPTY_INTERNAL, clusterId: clusterFilterId }); }}>
              Add internal POC
            </Button>
          </div>
        }
      >
        {internalForm ? (
          <div ref={formRef}>
            <InternalPocForm
              value={internalForm}
              clusters={clusters}
              departments={departments}
              subDepartments={subDepartments}
              people={people}
              saving={saving}
              onChange={setInternalForm}
              onSave={saveInternalPoc}
              onCancel={() => setInternalForm(null)}
            />
          </div>
        ) : null}
        {internalBatch ? (
          <div ref={formRef}>
            <InternalPocBatchForm
              rows={internalBatch}
              clusters={clusters}
              departments={departments}
              subDepartments={subDepartments}
              people={people}
              saving={saving}
              onChange={setInternalBatch}
              onSave={saveInternalBatch}
              onCancel={() => setInternalBatch(null)}
            />
          </div>
        ) : null}
        <div className="manage-section-search">
          <Field label="Search internal POCs"><input value={internalPocSearch} onChange={(event) => setInternalPocSearch(event.target.value)} placeholder="Name, email, phone, department or manager" /></Field>
          {internalPocSearch ? <Button onClick={() => setInternalPocSearch("")}>Clear search</Button> : null}
        </div>
        <div className="manage-internal-pocs-scroll">
        <div className="dtable manage-internal">
          <div className="dtable-head">
            <span>Name</span>
            <span>Email</span>
            <span>Department</span>
            <span>Reports to</span>
            <span>Active</span>
            <span />
          </div>
          {displayedPeople.map((person) => {
            const dept = departments.find((item) => item.id === person.departmentId);
            const manager = peopleById.get(person.reportingManagerId);
            return (
              <div key={person.id} className="dtable-row">
                <strong>{person.name}</strong>
                <span className={person.email ? "" : "missing"}>{person.email || "not set"}</span>
                <span>{dept ? dept.name : "--"}</span>
                <span className={manager ? "" : "missing"}>{manager ? manager.name : "not set"}</span>
                <span className={person.active ? "" : "missing"}>{person.active ? "Yes" : "No"}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Edit ${person.name}`}
                  onClick={() => {
                    closeForms();
                    setInternalForm({
                      id: person.id,
                      name: person.name,
                      email: person.email || "",
                      phone: person.phone || "",
                      clusterId: person.clusterId || "",
                      departmentId: person.departmentId || "",
                      subDepartmentId: person.subDepartmentId || "",
                      reportingManagerId: person.reportingManagerId || "",
                      active: person.active
                    });
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {!displayedPeople.length ? (
            <EmptyState
              title={visiblePeople.length ? "No internal POCs match this search" : clusterFilterId ? "No internal POCs match this cluster" : showAllInternal ? "No internal POCs" : "Nobody assigned to this client"}
              text={visiblePeople.length ? "Clear the search to see all filtered Internal POCs." : showAllInternal ? "Add your service owners so alerts have somewhere to go." : "Internal POCs appear here once they own a service on one of this client's projects."}
            />
          ) : null}
        </div>
        </div>
        <div className="button-row section-bottom-actions">
          <Button icon={Plus} onClick={() => { closeForms(); setInternalForm({ ...EMPTY_INTERNAL, clusterId: clusterFilterId }); }}>
            Add another internal POC
          </Button>
        </div>
      </Panel>

      <Panel
        id="manage-cleanup"
        title="Project data cleanup"
        badge="Permanent"
        className="span-12"
      >
        <p className="form-note warning-note">
          Choose one project from the selected client, then select one or more feedback cycles. Cleanup removes
          only the records selected in sections 1–3. Section 4 separately provides permanent POC, project and client deletion.
        </p>
        <div className="form-grid service-project-picker">
          <Field label="Project to clean" hint="only cycles and issues belonging to this project can be selected">
            <select value={cleanupProjectId} onChange={(event) => setCleanupProjectId(event.target.value)}>
              <option value="">Select a project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.key}</option>)}
            </select>
          </Field>
        </div>
        {cleanupLoading ? <LoadingBlock label="Loading project cycles and issues" /> : null}
        {!cleanupLoading && cleanupProjectId && cleanupLoadError ? (
          <EmptyState title="Could not load cleanup data" text={cleanupLoadError} />
        ) : null}
        {!cleanupLoading && cleanupProjectId && cleanupWorkspace ? (
          <div className="cleanup-actions">
            <div className="cleanup-action">
              <div className="cleanup-action-head">
                <div>
                  <strong>1. Select feedback cycles</strong>
                  <p>Choose one or more cycles. The same selection can clear chats, filter issues, or delete the complete cycle.</p>
                </div>
                {cleanupCycles.length ? (
                  <div className="cleanup-select-actions">
                    <button type="button" onClick={() => updateCleanupCycleSelection(cleanupCycles.map((cycle) => cycle.id))}>Select all</button>
                    <button type="button" onClick={() => updateCleanupCycleSelection([])}>Clear</button>
                  </div>
                ) : null}
              </div>
              {cleanupCycles.length ? (
                <div className="cleanup-list" role="group" aria-label="Feedback cycles to clean">
                  {cleanupCycles.map((cycle) => (
                    <label className="cleanup-check-row" key={cycle.id}>
                      <input
                        type="checkbox"
                        checked={selectedCleanupCycleIds.includes(cycle.id)}
                        onChange={() => toggleCleanupCycle(cycle.id)}
                      />
                      <span>
                        <strong>{formatCycleType(cycle.cycleType, cleanupWorkspace.project?.feedbackIntervalDays)}</strong>
                        <small>{formatDate(cycle.startedAt)} · {cycle.status || "unknown"} · {(cycle.sessions || []).length} POC session{(cycle.sessions || []).length === 1 ? "" : "s"}</small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <EmptyState title="No feedback cycles" text="This project has no cycle history to clean." />
              )}
              <small>Clearing chats does not stop active sessions. Ratings, scores, cycles, issues, appreciations and observations remain.</small>
              <Button
                icon={Trash2}
                variant="danger"
                disabled={!selectedCleanupCycleIds.length || Boolean(cleaning)}
                onClick={() => openCleanupConfirmation("messages")}
              >
                Clear chats in {selectedCleanupCycleIds.length || 0} selected cycle{selectedCleanupCycleIds.length === 1 ? "" : "s"}
              </Button>
            </div>
            <div className="cleanup-action">
              <div className="cleanup-action-head">
                <div>
                  <strong>2. Select issues in those cycles</strong>
                  <p>Issues appear after you select cycles on the left. Select only the issues you want removed.</p>
                </div>
                {cleanupIssues.length ? (
                  <div className="cleanup-select-actions">
                    <button type="button" onClick={() => setSelectedCleanupIssueIds(cleanupIssues.map((issue) => issue.id))}>Select all</button>
                    <button type="button" onClick={() => setSelectedCleanupIssueIds([])}>Clear</button>
                  </div>
                ) : null}
              </div>
              {cleanupIssues.length ? (
                <div className="cleanup-list" role="group" aria-label="Issues to delete">
                  {cleanupIssues.map((issue) => {
                    const cycle = cleanupCyclesById.get(issue.cycleId);
                    return (
                      <label className="cleanup-check-row" key={issue.id}>
                        <input
                          type="checkbox"
                          checked={selectedCleanupIssueIds.includes(issue.id)}
                          onChange={() => toggleCleanupIssue(issue.id)}
                        />
                        <span>
                          <strong>{issue.title || "Untitled issue"}</strong>
                          <small>{issue.serviceName || "General"} · {formatCycleType(cycle?.cycleType, cleanupWorkspace.project?.feedbackIntervalDays)} · {formatDate(cycle?.startedAt)}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  title={selectedCleanupCycleIds.length ? "No issues in selected cycles" : "Select cycle(s) first"}
                  text={selectedCleanupCycleIds.length
                    ? "The selected cycles have no issues to remove."
                    : "You can select multiple cycles, then choose individual issues from all of them."}
                />
              )}
              <small>Deleting issues also deletes their status history. Chats, ratings, scores and cycles remain.</small>
              <Button
                icon={Trash2}
                variant="danger"
                disabled={!selectedCleanupIssueIds.length || Boolean(cleaning)}
                onClick={() => openCleanupConfirmation("issues")}
              >
                Delete {selectedCleanupIssueIds.length || 0} selected issue{selectedCleanupIssueIds.length === 1 ? "" : "s"}
              </Button>
            </div>
            <div className="cleanup-action cleanup-action-cycles">
              <div className="cleanup-action-head">
                <div>
                  <strong>3. Delete selected cycles completely</strong>
                  <p>
                    {selectedCleanupCycleIds.length
                      ? `${selectedCleanupCycleIds.length} cycle${selectedCleanupCycleIds.length === 1 ? " is" : "s are"} selected above.`
                      : "Select one or more cycles in section 1 first."}
                  </p>
                </div>
              </div>
              <small>
                This removes every POC session, chat, rating, predicted score, service feedback record, issue and issue history,
                appreciation and observation belonging to those cycles. The client, project, POCs, services, feedback schedule and other cycles remain.
              </small>
              <Button
                icon={Trash2}
                variant="danger"
                disabled={!selectedCleanupCycleIds.length || Boolean(cleaning)}
                onClick={() => openCleanupConfirmation("cycles")}
              >
                Delete {selectedCleanupCycleIds.length || 0} selected cycle{selectedCleanupCycleIds.length === 1 ? "" : "s"} permanently
              </Button>
            </div>
          </div>
        ) : null}
        {!cleanupLoading && !cleanupProjectId ? (
          <EmptyState title="Select a project" text="Its feedback cycles and issues will appear here for multi-selection." />
        ) : null}
        <div className="cleanup-action cleanup-action-records">
          <div className="cleanup-action-head">
            <div>
              <strong>4. Delete POCs, projects or the whole client</strong>
              <p>Select individual POCs or projects below. Deleting the client removes every project and all related records under it.</p>
            </div>
          </div>
          <div className="record-delete-grid">
            <div>
              <div className="cleanup-action-head">
                <strong>Client POCs</strong>
                {pocs.length ? (
                  <div className="cleanup-select-actions">
                    <button type="button" onClick={() => setSelectedDeletePocIds(pocs.map((poc) => poc.id))}>Select all</button>
                    <button type="button" onClick={() => setSelectedDeletePocIds([])}>Clear</button>
                  </div>
                ) : null}
              </div>
              <div className="cleanup-list" role="group" aria-label="Client POCs to delete permanently">
                {pocs.map((poc) => {
                  const project = projects.find((item) => item.id === poc.projectId);
                  return (
                    <label className="cleanup-check-row" key={poc.id}>
                      <input
                        type="checkbox"
                        checked={selectedDeletePocIds.includes(poc.id)}
                        onChange={() => setSelectedDeletePocIds((current) => current.includes(poc.id)
                          ? current.filter((id) => id !== poc.id)
                          : [...current, poc.id])}
                      />
                      <span><strong>{poc.name}</strong><small>{project?.name || "Unknown project"} · {poc.active ? "active" : "inactive"}</small></span>
                    </label>
                  );
                })}
                {!pocs.length ? <small>No POCs exist for this client.</small> : null}
              </div>
              <Button icon={Trash2} variant="danger" disabled={!selectedDeletePocIds.length || Boolean(cleaning)} onClick={() => openRecordDeleteConfirmation("pocs")}>
                Delete {selectedDeletePocIds.length || 0} selected POC{selectedDeletePocIds.length === 1 ? "" : "s"}
              </Button>
            </div>
            <div>
              <div className="cleanup-action-head">
                <strong>Projects</strong>
                {projects.length ? (
                  <div className="cleanup-select-actions">
                    <button type="button" onClick={() => setSelectedDeleteProjectIds(projects.map((project) => project.id))}>Select all</button>
                    <button type="button" onClick={() => setSelectedDeleteProjectIds([])}>Clear</button>
                  </div>
                ) : null}
              </div>
              <div className="cleanup-list" role="group" aria-label="Projects to delete permanently">
                {projects.map((project) => (
                  <label className="cleanup-check-row" key={project.id}>
                    <input
                      type="checkbox"
                      checked={selectedDeleteProjectIds.includes(project.id)}
                      onChange={() => setSelectedDeleteProjectIds((current) => current.includes(project.id)
                        ? current.filter((id) => id !== project.id)
                        : [...current, project.id])}
                    />
                    <span><strong>{project.name}</strong><small>{project.key} · {project.activeStatus}</small></span>
                  </label>
                ))}
                {!projects.length ? <small>No projects exist for this client.</small> : null}
              </div>
              <Button icon={Trash2} variant="danger" disabled={!selectedDeleteProjectIds.length || Boolean(cleaning)} onClick={() => openRecordDeleteConfirmation("projects")}>
                Delete {selectedDeleteProjectIds.length || 0} selected project{selectedDeleteProjectIds.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
          <div className="delete-client-row">
            <div>
              <strong>Whole client: {selectedClient?.name || "none selected"}</strong>
              <small>This includes all its projects, contacts, services, schedules and feedback history.</small>
            </div>
            <Button icon={Trash2} variant="danger" disabled={!selectedClient || Boolean(cleaning)} onClick={() => openRecordDeleteConfirmation("clients")}>
              Delete whole client
            </Button>
          </div>
        </div>
      </Panel>

      <CleanupPinModal
        confirmation={cleanupConfirmation}
        pin={cleanupPin}
        error={cleanupPinError}
        busy={Boolean(cleaning)}
        onPinChange={(value) => { setCleanupPin(value); setCleanupPinError(""); }}
        onCancel={() => {
          setCleanupConfirmation(null);
          setCleanupPin("");
          setCleanupPinError("");
        }}
        onConfirm={runConfirmedCleanup}
      />
      {toast ? <div className="toast visible">{toast}</div> : null}
    </div>
  );
}
