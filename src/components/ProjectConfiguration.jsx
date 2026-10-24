import { SearchableSelect } from "./Filters.jsx";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Copy, Lock, Plus, Save, Trash2 } from "lucide-react";
import { apiAdminGet, apiWrite, hasAdminPin, setAdminPin } from "../api";
import { hasPermission } from "../permissions";
import { Button, EmptyState } from "./Ui.jsx";

const EMPTY_POC = {
  name: "", designation: "", contactWhatsapp: "", contactEmail: "",
  birthDate: "", salutation: "", honorific: "", levelId: "",
  weightPercentage: 0, active: true
};

const EMPTY_SERVICE = {
  serviceCatalogId: "", serviceKey: "", name: "", kpis: "", internalPocId: ""
};

function normalizePoc(poc, projectId) {
  return {
    id: poc.id,
    projectId: poc.projectId || projectId,
    name: poc.name || "",
    designation: poc.designation || "",
    contactWhatsapp: poc.contactWhatsapp || "",
    contactEmail: poc.contactEmail || "",
    birthDate: poc.birthDate ? String(poc.birthDate).slice(0, 10) : "",
    salutation: poc.salutation || "",
    honorific: poc.honorific || "",
    levelId: poc.levelId || poc.pocLevelId || "",
    weightPercentage: poc.weightPercentage ?? 0,
    active: poc.active !== false
  };
}

function normalizeService(service, projectId, serviceCatalog = []) {
  const catalogMatch = service.serviceCatalogId
    ? null
    : serviceCatalog.find((item) => (
      (service.serviceKey && item.serviceKey === service.serviceKey)
      || String(item.name || "").trim().toLowerCase() === String(service.name || "").trim().toLowerCase()
    ));
  return {
    id: service.id,
    projectId: service.projectId || projectId,
    serviceCatalogId: service.serviceCatalogId || catalogMatch?.id || "",
    serviceKey: service.serviceKey || "",
    name: service.name || "",
    kpis: service.kpis || "",
    internalPocId: service.internalPocId || ""
  };
}

function distributePocWeights(rows = []) {
  const activeIndexes = rows
    .map((row, index) => row.active !== false ? index : -1)
    .filter((index) => index >= 0);
  if (!activeIndexes.length) return rows.map((row) => ({ ...row, weightPercentage: 0 }));
  const regularShare = Math.floor(10000 / activeIndexes.length) / 100;
  const firstShare = Math.round((100 - (regularShare * (activeIndexes.length - 1))) * 100) / 100;
  const activeSet = new Set(activeIndexes);
  return rows.map((row, index) => ({
    ...row,
    weightPercentage: activeSet.has(index)
      ? (index === activeIndexes[0] ? firstShare : regularShare)
      : 0
  }));
}

function pocIdentity(poc) {
  const phone = String(poc.contactWhatsapp || "").replace(/\D/g, "");
  const email = String(poc.contactEmail || "").trim().toLowerCase();
  return phone
    ? `phone:${phone}`
    : email
      ? `email:${email}`
      : `name:${String(poc.name || "").trim().toLowerCase()}`;
}

function Field({ label, hint, children }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children}
      {hint ? <em>{hint}</em> : null}
    </label>
  );
}

function ProjectConfigurationPin({ onUnlock }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function unlock() {
    if (!pin.trim() || checking) return;
    setChecking(true);
    setError("");
    setAdminPin(pin.trim());
    try {
      const status = await apiAdminGet("/api/admin/status");
      if (!status.pinRequired) throw new Error("Editing is disabled because ADMIN_PIN is not configured.");
      if (!status.authorized) throw new Error("Incorrect admin PIN.");
      onUnlock();
    } catch (unlockError) {
      setAdminPin("");
      setError(unlockError.message || "Could not verify the admin PIN.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="project-configuration-pin">
      <Lock size={20} aria-hidden="true" />
      <div>
        <strong>Unlock project editing</strong>
        <p>The same Manage PIN is required. It is kept only for this browser tab.</p>
      </div>
      <input
        type="password"
        value={pin}
        onChange={(event) => { setPin(event.target.value); setError(""); }}
        onKeyDown={(event) => { if (event.key === "Enter") unlock(); }}
        placeholder="Admin PIN"
        aria-label="Admin PIN"
      />
      <Button variant="primary" onClick={unlock} disabled={!pin.trim() || checking}>
        {checking ? "Checking…" : "Unlock"}
      </Button>
      {error ? <p className="pin-error project-configuration-pin-error">{error}</p> : null}
    </div>
  );
}

export default function ProjectConfiguration({ workspace, currentUser, onRefresh, onReload, showToast }) {
  const project = workspace?.project;
  const roleAllowed = ["admin", "super_admin"].includes(currentUser?.role);
  const canManageProject = roleAllowed && hasPermission(currentUser, "manage_records");
  const canManagePocs = roleAllowed && hasPermission(currentUser, "manage_pocs");
  const canManageServices = roleAllowed && hasPermission(currentUser, "manage_records");
  const visible = roleAllowed && (canManageProject || canManagePocs || canManageServices);
  const [open, setOpen] = useState(false);
  const [unlocked, setUnlocked] = useState(hasAdminPin());
  const [directory, setDirectory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState("");
  const [status, setStatus] = useState(project?.activeStatus || "active");
  const [pocRows, setPocRows] = useState([]);
  const [removedPocIds, setRemovedPocIds] = useState([]);
  const [pocCopySource, setPocCopySource] = useState("");
  const [serviceRows, setServiceRows] = useState([]);
  const [serviceCopySource, setServiceCopySource] = useState("");

  const resetDrafts = () => {
    if (!project) return;
    setStatus(project.activeStatus || "active");
    setPocRows((workspace.pocs || []).map((poc) => normalizePoc(poc, project.id)));
    setRemovedPocIds([]);
    setPocCopySource("");
    setServiceRows((workspace.services || []).map((service) => normalizeService(service, project.id, directory?.serviceCatalog || [])));
    setServiceCopySource("");
  };

  async function loadConfigurationData() {
    if (!project || !unlocked) return;
    setLoading(true);
    setLoadError("");
    try {
      const loadedDirectory = await apiAdminGet("/api/admin/directory");
      setDirectory(loadedDirectory);
      setStatus(project.activeStatus || "active");
      setPocRows((workspace.pocs || []).map((poc) => normalizePoc(poc, project.id)));
      setRemovedPocIds([]);
      setPocCopySource("");
      setServiceRows((workspace.services || []).map((service) => normalizeService(service, project.id, loadedDirectory.serviceCatalog || [])));
      setServiceCopySource("");
    } catch (error) {
      setLoadError(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setOpen(false);
    setDirectory(null);
    resetDrafts();
  }, [project?.id]);

  useEffect(() => {
    if (open && unlocked && !directory && !loading) loadConfigurationData();
  }, [open, unlocked, project?.id]);

  const sameClientProjects = useMemo(() => (directory?.projects || [])
    .filter((item) => item.clientId === project?.clientId && item.id !== project?.id), [directory, project]);
  const sourceProjectIds = useMemo(() => new Set(sameClientProjects.map((item) => item.id)), [sameClientProjects]);
  const sourcePocs = (directory?.clientPocs || []).filter((poc) => sourceProjectIds.has(poc.projectId));
  const sourceServices = (directory?.projectServices || []).filter((service) => sourceProjectIds.has(service.projectId));
  const levels = directory?.pocLevels || [];
  const activeCatalog = (directory?.serviceCatalog || []).filter((item) => item.active !== false);
  const people = directory?.internalPocs || [];
  const activePocTotal = Math.round(pocRows.reduce(
    (sum, poc) => sum + (poc.active ? Number(poc.weightPercentage) || 0 : 0), 0
  ) * 100) / 100;

  function updatePoc(index, patch) {
    setPocRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function removePoc(index) {
    const row = pocRows[index];
    if (row?.id) setRemovedPocIds((ids) => ids.includes(row.id) ? ids : [...ids, row.id]);
    setPocRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
  }

  function copyPocs() {
    if (!pocCopySource) return;
    const identities = new Set(pocRows.map(pocIdentity));
    const copied = sourcePocs
      .filter((poc) => poc.projectId === pocCopySource)
      .map((poc) => normalizePoc(poc, project.id))
      .filter((poc) => {
        const identity = pocIdentity(poc);
        if (identities.has(identity)) return false;
        identities.add(identity);
        return true;
      })
      .map((poc) => ({ ...poc, id: undefined, projectId: project.id }));
    setPocRows((rows) => distributePocWeights([...rows, ...copied]));
    setPocCopySource("");
    showToast(copied.length ? `${copied.length} POC${copied.length === 1 ? "" : "s"} copied into the draft.` : "No new POCs were found to copy.");
  }

  function updateService(index, patch) {
    setServiceRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function copyServices() {
    if (!serviceCopySource) return;
    const identities = new Set(serviceRows.map((row) => row.serviceCatalogId || row.serviceKey || row.name.toLowerCase()));
    const copied = sourceServices
      .filter((service) => service.projectId === serviceCopySource)
      .map((service) => normalizeService(service, project.id))
      .filter((service) => {
        const identity = service.serviceCatalogId || service.serviceKey || service.name.toLowerCase();
        if (identities.has(identity)) return false;
        identities.add(identity);
        return true;
      })
      .map((service) => ({ ...service, id: undefined, projectId: project.id }));
    setServiceRows((rows) => [...rows, ...copied]);
    setServiceCopySource("");
    showToast(copied.length ? `${copied.length} service${copied.length === 1 ? "" : "s"} copied into the draft.` : "No new services were found to copy.");
  }

  async function finishSave(message) {
    await onRefresh?.();
    await onReload?.();
    const refreshedDirectory = await apiAdminGet("/api/admin/directory");
    const refreshedProject = (refreshedDirectory.projects || []).find((item) => item.id === project.id);
    setDirectory(refreshedDirectory);
    setStatus(refreshedProject?.activeStatus || status);
    setPocRows((refreshedDirectory.clientPocs || [])
      .filter((poc) => poc.projectId === project.id)
      .map((poc) => normalizePoc(poc, project.id)));
    setServiceRows((refreshedDirectory.projectServices || [])
      .filter((service) => service.projectId === project.id)
      .map((service) => normalizeService(service, project.id, refreshedDirectory.serviceCatalog || [])));
    setRemovedPocIds([]);
    setPocCopySource("");
    setServiceCopySource("");
    showToast(message);
  }

  async function saveStatus() {
    if (!project || saving) return;
    if (status !== project.activeStatus && !window.confirm(
      `Change ${project.name} from ${project.activeStatus || "active"} to ${status}?\n\nExisting feedback sessions will not be deleted or stopped.`
    )) return;
    setSaving("status");
    try {
      await apiWrite(`/api/admin/projects/${encodeURIComponent(project.id)}`, { activeStatus: status }, "PATCH");
      await finishSave(`Project status changed to ${status}.`);
    } catch (error) {
      showToast(error.message);
    } finally {
      setSaving("");
    }
  }

  async function savePocs() {
    if (saving) return;
    if (pocRows.some((row) => !String(row.name || "").trim())) {
      showToast("Every POC needs a name.");
      return;
    }
    if (pocRows.some((row) => row.active && !row.levelId)) {
      showToast("Select a POC tag for every active POC.");
      return;
    }
    if (pocRows.some((row) => row.active && (!Number.isFinite(Number(row.weightPercentage)) || Number(row.weightPercentage) <= 0 || Number(row.weightPercentage) > 100))) {
      showToast("Every active POC needs an influence above 0% and no more than 100%.");
      return;
    }
    if (pocRows.some((row) => row.active) && Math.abs(activePocTotal - 100) > 0.01) {
      showToast(`Active POC influence must total exactly 100%. It currently totals ${activePocTotal}%.`);
      return;
    }
    setSaving("pocs");
    try {
      const result = await apiWrite(`/api/admin/projects/${encodeURIComponent(project.id)}/pocs`, {
        pocs: pocRows.map((row) => ({
          ...row,
          contactWhatsapp: String(row.contactWhatsapp || "").replace(/\D/g, ""),
          weightPercentage: row.active ? Number(row.weightPercentage) : 0
        })),
        removedIds: removedPocIds
      }, "PUT");
      await finishSave(`Project POCs saved${result.removed ? `; ${result.removed} removed from this project` : ""}.`);
      setRemovedPocIds([]);
    } catch (error) {
      showToast(error.message);
    } finally {
      setSaving("");
    }
  }

  async function saveServices() {
    if (saving) return;
    if (!serviceRows.length) {
      showToast("Keep at least one service on an active project.");
      return;
    }
    if (serviceRows.some((row) => !row.serviceCatalogId)) {
      showToast("Select every service from the Standard Service Catalogue.");
      return;
    }
    setSaving("services");
    try {
      await apiWrite(`/api/admin/projects/${encodeURIComponent(project.id)}/services`, { services: serviceRows }, "PUT");
      await finishSave("Project services and owners saved.");
    } catch (error) {
      showToast(error.message);
    } finally {
      setSaving("");
    }
  }

  if (!visible || !project) return null;

  return (
    <section className={`project-configuration ${open ? "open" : ""}`} aria-labelledby="project-configuration-title">
      <button type="button" className="project-configuration-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>
          <small>Admin and Super Admin only</small>
          <strong id="project-configuration-title">Project Configuration</strong>
          <em>Project status, client POCs, influence and project services</em>
        </span>
        {open ? <ChevronUp size={20} aria-hidden="true" /> : <ChevronDown size={20} aria-hidden="true" />}
      </button>

      {open ? (
        <div className="project-configuration-body">
          {!unlocked ? <ProjectConfigurationPin onUnlock={() => { setUnlocked(true); setDirectory(null); }} /> : loading ? (
            <p className="form-note">Loading project configuration…</p>
          ) : loadError ? (
            <div className="error-block"><strong>Could not load project configuration</strong><p>{loadError}</p><Button onClick={loadConfigurationData}>Try again</Button></div>
          ) : directory ? (
            <>
              {canManageProject ? (
                <details className="project-configuration-section" open>
                  <summary>Project Status</summary>
                  <div className="project-configuration-section-body compact-configuration-row">
                    <Field label="Status" hint="Inactive projects do not start new automatic feedback or quick check-ins.">
                      <SearchableSelect value={status} onChange={(event) => setStatus(event.target.value)}>
                        <option value="active">Active</option>
                        <option value="paused">Inactive / paused</option>
                        <option value="closed">Closed</option>
                      </SearchableSelect>
                    </Field>
                    <Button variant="primary" icon={Save} onClick={saveStatus} disabled={saving === "status" || status === project.activeStatus}>
                      {saving === "status" ? "Saving…" : "Save project status"}
                    </Button>
                  </div>
                </details>
              ) : null}

              {canManagePocs ? (
                <details className="project-configuration-section" open>
                  <summary>Client POCs and Influence</summary>
                  <div className="project-configuration-section-body">
                    <div className="project-configuration-copy-row">
                      <Field label="Copy POCs from another project" hint="Only projects for this client are listed.">
                        <SearchableSelect value={pocCopySource} onChange={(event) => setPocCopySource(event.target.value)}>
                          <option value="">Select source project</option>
                          {sameClientProjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </SearchableSelect>
                      </Field>
                      <Button icon={Copy} onClick={copyPocs} disabled={!pocCopySource}>Copy into draft</Button>
                    </div>
                    <div className="batch-editor project-configuration-scroll">
                      {pocRows.map((poc, index) => (
                        <div className="batch-editor-row" key={poc.id || `new-poc-${index}`}>
                          <div className="form-grid project-configuration-poc-grid">
                            <Field label={`POC ${index + 1} name`}><input value={poc.name} onChange={(event) => updatePoc(index, { name: event.target.value })} /></Field>
                            <Field label="Designation"><input value={poc.designation} onChange={(event) => updatePoc(index, { designation: event.target.value })} /></Field>
                            <Field label="WhatsApp" hint="Optional until feedback is sent"><input value={poc.contactWhatsapp} onChange={(event) => updatePoc(index, { contactWhatsapp: event.target.value })} /></Field>
                            <Field label="Email"><input type="email" value={poc.contactEmail} onChange={(event) => updatePoc(index, { contactEmail: event.target.value })} /></Field>
                            <Field label="Birthday"><input type="date" value={poc.birthDate} onChange={(event) => updatePoc(index, { birthDate: event.target.value })} /></Field>
                            <Field label="Salutation"><input value={poc.salutation} onChange={(event) => updatePoc(index, { salutation: event.target.value })} /></Field>
                            <Field label="POC tag"><SearchableSelect value={poc.levelId} onChange={(event) => updatePoc(index, { levelId: event.target.value })}><option value="">Select tag</option>{levels.map((level) => <option key={level.id} value={level.id}>{level.name}</option>)}</SearchableSelect></Field>
                            <Field label="Influence (%)"><input type="number" min="0" max="100" step="0.01" disabled={!poc.active} value={poc.active ? poc.weightPercentage : 0} onChange={(event) => updatePoc(index, { weightPercentage: event.target.value })} /></Field>
                            <Field label="Active"><SearchableSelect value={poc.active ? "yes" : "no"} onChange={(event) => { const active = event.target.value === "yes"; updatePoc(index, { active, weightPercentage: active ? poc.weightPercentage : 0 }); }}><option value="yes">Yes</option><option value="no">No</option></SearchableSelect></Field>
                          </div>
                          <button type="button" className="icon-button danger" onClick={() => removePoc(index)} aria-label={`Remove ${poc.name || `POC ${index + 1}`} from this project`} title="Remove this project's POC assignment; preserve past feedback"><Trash2 size={15} aria-hidden="true" /></button>
                        </div>
                      ))}
                      {!pocRows.length ? <EmptyState title="No POCs in this draft" text="The project can be saved without an active POC, but feedback cannot be sent." /> : null}
                    </div>
                    <div className="project-configuration-actions">
                      <Button icon={Plus} onClick={() => setPocRows((rows) => [...rows, { ...EMPTY_POC, projectId: project.id, levelId: levels[0]?.id || "" }])}>Add another POC</Button>
                      <Button disabled={!pocRows.some((poc) => poc.active)} onClick={() => setPocRows((rows) => distributePocWeights(rows))}>Distribute equally</Button>
                      <span className={pocRows.some((poc) => poc.active) && Math.abs(activePocTotal - 100) > 0.01 ? "missing" : "success"}>Active influence: <strong>{activePocTotal}%</strong></span>
                      <Button onClick={resetDrafts}>Reset changes</Button>
                      <Button variant="primary" icon={Save} onClick={savePocs} disabled={saving === "pocs"}>{saving === "pocs" ? "Saving…" : "Save all POCs"}</Button>
                    </div>
                    <p className="form-note">Remove deletes the assignment from this project's current POC list and stops its open sessions. Historical feedback, recorded scores and assignments on other projects are preserved. Set Active to No instead to keep a POC listed but pause future sends.</p>
                  </div>
                </details>
              ) : null}

              {canManageServices ? (
                <details className="project-configuration-section" open>
                  <summary>Project Services and Owners</summary>
                  <div className="project-configuration-section-body">
                    <div className="project-configuration-copy-row">
                      <Field label="Copy services from another project" hint="Only projects for this client are listed.">
                        <SearchableSelect value={serviceCopySource} onChange={(event) => setServiceCopySource(event.target.value)}>
                          <option value="">Select source project</option>
                          {sameClientProjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </SearchableSelect>
                      </Field>
                      <Button icon={Copy} onClick={copyServices} disabled={!serviceCopySource}>Copy into draft</Button>
                    </div>
                    <div className="batch-editor project-configuration-scroll">
                      {serviceRows.map((service, index) => (
                        <div className="batch-editor-row" key={service.id || `new-service-${index}`}>
                          <div className="form-grid project-configuration-service-grid">
                            <Field label={`Service ${index + 1}`}>
                              <SearchableSelect value={service.serviceCatalogId} onChange={(event) => { const selected = activeCatalog.find((item) => item.id === event.target.value); updateService(index, { serviceCatalogId: selected?.id || "", serviceKey: selected?.serviceKey || "", name: selected?.name || "" }); }}>
                                <option value="">Select standard service</option>
                                {(directory.serviceCatalog || []).filter((item) => (item.active !== false || item.id === service.serviceCatalogId) && !serviceRows.some((other, otherIndex) => otherIndex !== index && (other.serviceCatalogId === item.id || other.serviceKey === item.serviceKey))).map((item) => <option key={item.id} value={item.id}>{item.name}{item.active === false ? " — archived" : ""}</option>)}
                              </SearchableSelect>
                            </Field>
                            <Field label="Internal owner"><SearchableSelect value={service.internalPocId} onChange={(event) => updateService(index, { internalPocId: event.target.value })}><option value="">Not set</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}{person.active === false ? " — inactive" : ""}</option>)}</SearchableSelect></Field>
                            <Field label="KPIs"><input value={service.kpis} onChange={(event) => updateService(index, { kpis: event.target.value })} /></Field>
                          </div>
                          <button type="button" className="icon-button danger" disabled={serviceRows.length === 1} onClick={() => setServiceRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))} aria-label={`Remove ${service.name || `service ${index + 1}`}`}><Trash2 size={15} aria-hidden="true" /></button>
                        </div>
                      ))}
                    </div>
                    <div className="project-configuration-actions">
                      <Button icon={Plus} onClick={() => setServiceRows((rows) => [...rows, { ...EMPTY_SERVICE, projectId: project.id }])}>Add another service</Button>
                      <Button onClick={resetDrafts}>Reset changes</Button>
                      <Button variant="primary" icon={Save} onClick={saveServices} disabled={saving === "services" || !serviceRows.length}>{saving === "services" ? "Saving…" : "Save all services"}</Button>
                    </div>
                    <p className="form-note">Services come only from the Standard Service Catalogue. Adding or removing a service is blocked while a feedback cycle is open, so an in-progress conversation cannot change midway.</p>
                  </div>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
