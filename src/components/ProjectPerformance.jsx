import { useEffect, useMemo, useState } from "react";
import { Download, Plus, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { apiGet, apiPut } from "../api";
import { formatDate, formatDateTime } from "../format";
import { downloadProjectPerformanceWorkbook, parseProjectPerformanceWorkbook } from "../lib/project-performance-workbook.mjs";
import { FilterBar, SingleSelect } from "./Filters.jsx";
import { Button, EmptyState, ErrorBlock, LoadingBlock, MetricCard, Panel, StatusPill } from "./Ui.jsx";

const CURRENCY_SYMBOLS = { INR: "₹", AED: "د.إ", USD: "$", GBP: "£", EUR: "€", THB: "฿" };

function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function options(values = []) {
  return values.map((item) => ({ value: item.id || item.value, label: item.name || item.value }));
}

function referenceOptions(data, category) {
  return options(data?.referenceValues?.[category] || []);
}

function formFromProject(project, editor = "") {
  return {
    updatedBy: editor,
    clientGroup: project?.clientGroup || "",
    clientCategory: project?.clientCategory || "",
    financialYear: project?.financialYear || "",
    projectType: project?.projectType || "",
    revenueCategory: project?.revenueCategory || "",
    portfolioType: project?.portfolioType || "",
    projectDirectorId: project?.team?.projectDirectorId || "",
    amId: project?.team?.amId || "",
    tlId: project?.team?.tlId || "",
    adId: project?.team?.adId || "",
    avpId: project?.team?.avpId || "",
    currency: project?.currency || "INR",
    fxRateToInr: project?.fxRateToInr ?? "",
    poAmountLocal: project?.poAmountLocal ?? "",
    budgetAllocatedLocal: project?.budgetAllocatedLocal ?? "",
    budgetSpentLocal: project?.budgetSpentLocal ?? "",
    revenueGeneratedLocal: project?.revenueGeneratedLocal ?? "",
    performanceStatus: project?.performanceStatus || "",
    currentPhase: project?.currentPhase || "",
    campaignStatus: project?.campaignStatus || "",
    clientSentiment: project?.clientSentiment || "",
    mandates: project?.mandates || "",
    deliverablesStatus: project?.deliverablesStatus || "",
    relationshipStrength: project?.relationshipStrength || "",
    meetingCadence: project?.meetingCadence || "",
    lastMeetingDate: project?.lastMeetingDate ? String(project.lastMeetingDate).slice(0, 10) : "",
    suggestionFrequency: project?.suggestionFrequency || "",
    lastSuggestionDate: project?.lastSuggestionDate ? String(project.lastSuggestionDate).slice(0, 10) : "",
    clientFeedback: project?.clientFeedback || "",
    nextSteps: project?.nextSteps || "",
    comments: project?.comments || "",
    mom: project?.links?.mom || "",
    consolidatedSheet: project?.links?.consolidatedSheet || "",
    projectDriveFolder: project?.links?.projectDriveFolder || "",
    projectDataSheet: project?.links?.projectDataSheet || ""
  };
}

function blankKpi() {
  return {
    kpiName: "",
    unit: "number",
    direction: "higher_better",
    target: "",
    actual: "",
    previousYearActual: "",
    isPrimary: false
  };
}

function Field({ label, children, help, className = "" }) {
  return (
    <label className={`performance-field ${className}`.trim()}>
      <span>{label}</span>
      {children}
      {help ? <small>{help}</small> : null}
    </label>
  );
}

function NativeSelect({ value, onChange, items, placeholder = "Not set" }) {
  return (
    <select value={value || ""} onChange={(event) => onChange(event.target.value)}>
      <option value="">{placeholder}</option>
      {items.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  );
}

function money(value, currency = "INR") {
  if (value === null || value === undefined || value === "") return "Not set";
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
  return `${symbol}${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function valueOrDash(value) {
  return value === null || value === undefined || value === "" ? "—" : value;
}

function kpiAchievement(kpi) {
  const target = Number(kpi?.target);
  const actual = Number(kpi?.actual);
  if (!Number.isFinite(target) || !Number.isFinite(actual) || target === 0) return null;
  if (kpi.direction === "lower_better") {
    if (actual === 0) return 100;
    return Math.max(0, (target / actual) * 100);
  }
  return Math.max(0, (actual / target) * 100);
}

function previousYearVariance(kpi) {
  const actual = Number(kpi?.actual);
  const previous = Number(kpi?.previousYearActual);
  if (!Number.isFinite(actual) || !Number.isFinite(previous) || previous === 0) return null;
  return ((actual - previous) / Math.abs(previous)) * 100;
}

function KpiValue({ kpi, field }) {
  const value = kpi?.[field];
  if (value === null || value === undefined || value === "") return <>—</>;
  if (kpi.unit === "percent") return <>{Number(value).toLocaleString("en-IN")}%</>;
  if (kpi.unit === "currency") return <>{money(value, kpi.currency || "INR")}</>;
  return <>{Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</>;
}

function ProjectLink({ href, children }) {
  return href
    ? <a className="performance-project-link" href={href} target="_blank" rel="noreferrer">{children}</a>
    : <span>Not set</span>;
}

export default function ProjectPerformance({ currentUser = null }) {
  const editorIdentity = currentUser?.email || currentUser?.name || "";
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [cluster, setCluster] = useState("");
  const [client, setClient] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [status, setStatus] = useState("");
  const [sentiment, setSentiment] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [form, setForm] = useState(formFromProject(null, editorIdentity));
  const [kpis, setKpis] = useState([]);
  const [downloadingWorkbook, setDownloadingWorkbook] = useState(false);
  const [readingWorkbook, setReadingWorkbook] = useState(false);
  const [applyingWorkbook, setApplyingWorkbook] = useState(false);
  const [workbookPreview, setWorkbookPreview] = useState(null);
  const [selectedWorkbookRows, setSelectedWorkbookRows] = useState([]);
  const [workbookMessage, setWorkbookMessage] = useState("");
  const [bulkUpdatedBy, setBulkUpdatedBy] = useState(editorIdentity);

  async function load(preferredProjectId = selectedProjectId) {
    setLoading(true);
    setError(null);
    try {
      const next = await apiGet("/api/project-performance");
      setData(next);
      const found = next.projects.find((item) => item.id === preferredProjectId) || next.projects[0] || null;
      setSelectedProjectId(found?.id || "");
      setForm(formFromProject(found, editorIdentity));
      setKpis((found?.kpis || []).map((item) => ({ ...item })));
    } catch (loadError) {
      setError(loadError);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(""); }, []);

  const projects = useMemo(() => data?.projects || [], [data]);
  const clusterNames = useMemo(() => [...new Set(projects.map((item) => item.clusterName).filter(Boolean))].sort(), [projects]);
  const clientNames = useMemo(() => [...new Set(projects
    .filter((item) => !cluster || item.clusterName === cluster)
    .map((item) => item.clientName).filter(Boolean))].sort(), [projects, cluster]);
  const projectOptions = useMemo(() => projects
    .filter((item) => !cluster || item.clusterName === cluster)
    .filter((item) => !client || item.clientName === client)
    .map((item) => ({ value: item.id, label: item.name })), [projects, cluster, client]);
  const statusValues = useMemo(() => (data?.referenceValues?.performance_status || []).map((item) => item.value), [data]);
  const sentimentValues = useMemo(() => (data?.referenceValues?.client_sentiment || []).map((item) => item.value), [data]);

  const filteredProjects = useMemo(() => projects
    .filter((item) => !cluster || item.clusterName === cluster)
    .filter((item) => !client || item.clientName === client)
    .filter((item) => !projectFilter || item.id === projectFilter)
    .filter((item) => !status || item.performanceStatus === status)
    .filter((item) => !sentiment || item.clientSentiment === sentiment),
  [projects, cluster, client, projectFilter, status, sentiment]);

  const selectedProject = projects.find((item) => item.id === selectedProjectId) || null;
  const concernedCount = filteredProjects.filter((item) => ["Concerned", "Escalated"].includes(item.clientSentiment)).length;

  function chooseProject(projectId, move = false) {
    const project = projects.find((item) => item.id === projectId) || null;
    setSelectedProjectId(project?.id || "");
    setForm(formFromProject(project, editorIdentity));
    setKpis((project?.kpis || []).map((item) => ({ ...item })));
    setNotice("");
    if (move) scrollToSection("performance-project-details");
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setNotice("");
  }

  function updateKpi(index, field, value) {
    setKpis((current) => current.map((item, itemIndex) => {
      if (itemIndex !== index) return field === "isPrimary" && value ? { ...item, isPrimary: false } : item;
      return { ...item, [field]: value };
    }));
    setNotice("");
  }

  async function downloadWorkbook() {
    setDownloadingWorkbook(true);
    setError(null);
    setWorkbookMessage("");
    try {
      await downloadProjectPerformanceWorkbook(data);
      setWorkbookMessage("Excel template downloaded with one project per row and one worksheet only.");
    } catch (downloadError) {
      setError(downloadError);
    } finally {
      setDownloadingWorkbook(false);
    }
  }

  async function readWorkbook(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setReadingWorkbook(true);
    setError(null);
    setWorkbookMessage("");
    try {
      const preview = await parseProjectPerformanceWorkbook(file, data);
      setWorkbookPreview(preview);
      setSelectedWorkbookRows(preview.rows.filter((row) => row.eligible).map((row) => row.rowNumber));
      const eligible = preview.rows.filter((row) => row.eligible).length;
      const unchanged = preview.rows.filter((row) => !row.errors.length && !row.changed).length;
      setWorkbookMessage(`${eligible} changed project row${eligible === 1 ? "" : "s"} ready to update${unchanged ? `; ${unchanged} unchanged` : ""}.`);
      setTimeout(() => scrollToSection("performance-excel-upload"), 0);
    } catch (uploadError) {
      setWorkbookPreview(null);
      setSelectedWorkbookRows([]);
      setError(uploadError);
    } finally {
      setReadingWorkbook(false);
    }
  }

  async function applyWorkbook() {
    if (!selectedWorkbookRows.length) return;
    const updatedBy = editorIdentity || bulkUpdatedBy.trim();
    if (!updatedBy) {
      setError(new Error("Enter the name of the person applying this Excel update."));
      return;
    }
    setApplyingWorkbook(true);
    setError(null);
    setWorkbookMessage("");
    const selected = workbookPreview.rows.filter((row) => selectedWorkbookRows.includes(row.rowNumber) && row.eligible);
    const completed = [];
    const failed = [];
    for (const row of selected) {
      try {
        await apiPut(`/api/project-performance/${encodeURIComponent(row.projectId)}`, {
          ...row.payload,
          updatedBy
        });
        completed.push(row);
      } catch (applyError) {
        failed.push({ row, message: applyError.message });
      }
    }
    setApplyingWorkbook(false);
    if (failed.length) {
      setWorkbookPreview((current) => ({
        ...current,
        rows: current.rows.map((row) => {
          const failure = failed.find((item) => item.row.rowNumber === row.rowNumber);
          return failure ? { ...row, errors: [...row.errors, failure.message], eligible: false } : row;
        })
      }));
      setSelectedWorkbookRows([]);
      setWorkbookMessage(`${completed.length} project${completed.length === 1 ? "" : "s"} updated; ${failed.length} failed. Review the row errors below.`);
    } else {
      setWorkbookPreview(null);
      setSelectedWorkbookRows([]);
      setWorkbookMessage(`${completed.length} project${completed.length === 1 ? "" : "s"} updated successfully and added to audit history.`);
    }
    await load(selectedProjectId);
  }

  async function save() {
    if (!selectedProject) return;
    setSaving(true);
    setError(null);
    setNotice("");
    try {
      await apiPut(`/api/project-performance/${encodeURIComponent(selectedProject.id)}`, {
        updatedBy: form.updatedBy,
        expectedVersion: selectedProject.version || 0,
        clientProfile: { clientGroup: form.clientGroup, clientCategory: form.clientCategory },
        profile: {
          financialYear: form.financialYear,
          projectType: form.projectType,
          revenueCategory: form.revenueCategory,
          portfolioType: form.portfolioType,
          team: {
            projectDirectorId: form.projectDirectorId,
            amId: form.amId,
            tlId: form.tlId,
            adId: form.adId,
            avpId: form.avpId
          },
          currency: form.currency,
          fxRateToInr: form.fxRateToInr,
          poAmountLocal: form.poAmountLocal,
          budgetAllocatedLocal: form.budgetAllocatedLocal,
          budgetSpentLocal: form.budgetSpentLocal,
          revenueGeneratedLocal: form.revenueGeneratedLocal,
          performanceStatus: form.performanceStatus,
          currentPhase: form.currentPhase,
          campaignStatus: form.campaignStatus,
          clientSentiment: form.clientSentiment,
          mandates: form.mandates,
          deliverablesStatus: form.deliverablesStatus,
          relationshipStrength: form.relationshipStrength,
          meetingCadence: form.meetingCadence,
          lastMeetingDate: form.lastMeetingDate,
          suggestionFrequency: form.suggestionFrequency,
          lastSuggestionDate: form.lastSuggestionDate,
          clientFeedback: form.clientFeedback,
          nextSteps: form.nextSteps,
          comments: form.comments,
          links: {
            mom: form.mom,
            consolidatedSheet: form.consolidatedSheet,
            projectDriveFolder: form.projectDriveFolder,
            projectDataSheet: form.projectDataSheet
          }
        },
        kpis
      });
      setNotice("Project performance saved and added to audit history.");
      await load(selectedProject.id);
    } catch (saveError) {
      setError(saveError);
    } finally {
      setSaving(false);
    }
  }

  if (loading && !data) return <LoadingBlock label="Loading project performance" />;
  if (error && !data) return <ErrorBlock error={error} onRetry={() => load("")} />;

  const internalPocOptions = options((data?.internalPocs || []).filter((item) => item.active !== false));
  const allFiltersClear = !cluster && !client && !projectFilter && !status && !sentiment;
  const currencySymbol = CURRENCY_SYMBOLS[selectedProject?.currency || "INR"] || selectedProject?.currency || "";

  return (
    <div className="performance-page">
      <header className="page-heading performance-heading">
        <div>
          <p className="eyebrow">Portfolio and delivery data</p>
          <h2>Project Performance</h2>
          <p>Current project information, delivery health, commercial details and an auditable update history.</p>
        </div>
        <div className="performance-heading-actions">
          <Button icon={Download} onClick={downloadWorkbook} disabled={downloadingWorkbook || !data?.projects?.length}>{downloadingWorkbook ? "Preparing…" : "Download Excel"}</Button>
          <label className={`button ${readingWorkbook ? "disabled" : ""}`}>
            <Upload size={16} />{readingWorkbook ? "Reading…" : "Upload Excel"}
            <input type="file" accept=".xlsx" onChange={readWorkbook} disabled={readingWorkbook} hidden />
          </label>
          <Button icon={RefreshCw} onClick={() => load()} disabled={loading}>Refresh</Button>
        </div>
      </header>

      <nav className="performance-section-nav" aria-label="Project performance sections">
        <button type="button" onClick={() => scrollToSection("performance-portfolio")}>Portfolio Overview</button>
        <button type="button" onClick={() => scrollToSection("performance-project-details")}>Project Details</button>
        <button type="button" onClick={() => scrollToSection("performance-update")}>Update Project</button>
        <button type="button" onClick={() => scrollToSection("performance-excel-upload")}>Excel Upload</button>
        <button type="button" onClick={() => scrollToSection("performance-audit")}>Audit History</button>
      </nav>

      <section id="performance-excel-upload" className="performance-section-anchor">
        <div className="section-heading-inline">
          <div><p className="eyebrow">Excel Upload</p><h3>Update multiple projects from one worksheet</h3></div>
        </div>
        <Panel title="Single-sheet Project Performance Upload" badge={workbookPreview ? workbookPreview.fileName : "One project per row"}>
          <div className="performance-excel-intro">
            <p>Download the current template, edit the performance columns, then upload it here. Project ID is the match key; Cluster, Client, Project Name, dates, services and CSAT Active Status are never overwritten.</p>
            <div>
              <Button icon={Download} onClick={downloadWorkbook} disabled={downloadingWorkbook}>{downloadingWorkbook ? "Preparing…" : "Download current data"}</Button>
              <label className={`button primary ${readingWorkbook ? "disabled" : ""}`}>
                <Upload size={16} />{readingWorkbook ? "Reading workbook…" : "Choose .xlsx file"}
                <input type="file" accept=".xlsx" onChange={readWorkbook} disabled={readingWorkbook} hidden />
              </label>
            </div>
          </div>
          {workbookMessage ? <p className="success-message performance-workbook-message">{workbookMessage}</p> : null}
          {workbookPreview ? (
            <div className="performance-workbook-preview">
              {workbookPreview.ignoredSheets.length ? <p className="performance-upload-warning">Only “{workbookPreview.sheetName}” was read. Other worksheets were ignored: {workbookPreview.ignoredSheets.join(", ")}.</p> : null}
              {!editorIdentity ? (
                <Field label="Updated By" help="Required because this session is not using a verified Google Workspace login.">
                  <input value={bulkUpdatedBy} onChange={(event) => setBulkUpdatedBy(event.target.value)} placeholder="Your full name" />
                </Field>
              ) : <p className="field-caption">Audit owner: {editorIdentity}</p>}
              <div className="bulk-preview-summary">
                <strong>{selectedWorkbookRows.length} selected</strong>
                <span>{workbookPreview.rows.filter((row) => row.eligible).length} changed and valid</span>
                <span>{workbookPreview.rows.filter((row) => !row.errors.length && !row.changed).length} unchanged</span>
                <span>{workbookPreview.rows.filter((row) => row.errors.length).length} with errors</span>
              </div>
              <div className="performance-workbook-table-scroll">
                <div className="performance-workbook-row head"><span></span><span>Excel Row</span><span>Project</span><span>Client</span><span>Result</span></div>
                {workbookPreview.rows.map((row) => {
                  const checked = selectedWorkbookRows.includes(row.rowNumber);
                  return (
                    <div className={`performance-workbook-row ${row.errors.length ? "blocked" : row.changed ? "" : "unchanged"}`} key={row.rowNumber}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!row.eligible || applyingWorkbook}
                        onChange={() => setSelectedWorkbookRows(checked
                          ? selectedWorkbookRows.filter((rowNumber) => rowNumber !== row.rowNumber)
                          : [...selectedWorkbookRows, row.rowNumber])}
                        aria-label={`Select Excel row ${row.rowNumber}`}
                      />
                      <span>{row.rowNumber}</span>
                      <span><strong>{row.projectName || row.projectKey || "Unknown project"}</strong><small>{row.projectKey || "No Project ID"}</small></span>
                      <span>{row.clientName || "—"}</span>
                      <span>
                        {row.errors.length ? <strong className="error-message">{row.errors.join("; ")}</strong> : row.changed ? <strong>Ready to update</strong> : <strong>No changes detected</strong>}
                        {row.warnings.length ? <small>{row.warnings.join("; ")}</small> : null}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="performance-workbook-actions">
                <Button onClick={() => setSelectedWorkbookRows(workbookPreview.rows.filter((row) => row.eligible).map((row) => row.rowNumber))} disabled={applyingWorkbook}>Select all changed rows</Button>
                <Button onClick={() => { setWorkbookPreview(null); setSelectedWorkbookRows([]); setWorkbookMessage(""); }} disabled={applyingWorkbook}>Cancel upload</Button>
                <Button variant="primary" icon={Save} onClick={applyWorkbook} disabled={applyingWorkbook || !selectedWorkbookRows.length || (!editorIdentity && !bulkUpdatedBy.trim())}>
                  {applyingWorkbook ? "Applying…" : `Apply ${selectedWorkbookRows.length} selected row${selectedWorkbookRows.length === 1 ? "" : "s"}`}
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>
      </section>

      <section id="performance-portfolio" className="performance-section-anchor">
        <div className="section-heading-inline">
          <div><p className="eyebrow">Portfolio Overview</p><h3>Current performance position</h3></div>
        </div>
        <FilterBar
          showReset={!allFiltersClear}
          onReset={() => { setCluster(""); setClient(""); setProjectFilter(""); setStatus(""); setSentiment(""); }}
        >
          <SingleSelect label="Cluster" options={clusterNames.map((value) => ({ value, label: value }))} value={cluster} onChange={(value) => { setCluster(value); setClient(""); setProjectFilter(""); }} placeholder="All clusters" />
          <SingleSelect label="Client" options={clientNames.map((value) => ({ value, label: value }))} value={client} onChange={(value) => { setClient(value); setProjectFilter(""); }} placeholder="All clients" />
          <SingleSelect label="Project" options={projectOptions} value={projectFilter} onChange={setProjectFilter} placeholder="All projects" />
          <SingleSelect label="Performance Status" options={statusValues.map((value) => ({ value, label: value }))} value={status} onChange={setStatus} placeholder="All statuses" />
          <SingleSelect label="Client Sentiment" options={sentimentValues.map((value) => ({ value, label: value }))} value={sentiment} onChange={setSentiment} placeholder="All sentiments" />
        </FilterBar>

        <div className="performance-metrics">
          <MetricCard label="Projects" value={filteredProjects.length} caption="matching current filters" />
          <MetricCard label="On Track" value={filteredProjects.filter((item) => item.performanceStatus === "On Track").length} caption="current delivery status" tone="strong" />
          <MetricCard label="Needs Attention" value={filteredProjects.filter((item) => item.performanceStatus === "Needs Attention").length} caption="requires closer review" tone="watch" />
          <MetricCard label="At Risk / Off Track" value={filteredProjects.filter((item) => ["At Risk", "Off Track"].includes(item.performanceStatus)).length} caption="delivery intervention needed" tone="weak" />
          <MetricCard label="Concerned / Escalated" value={concernedCount} caption="client sentiment" tone={concernedCount ? "weak" : "strong"} />
        </div>

        <Panel title="Projects" badge={`${filteredProjects.length} shown`} className="performance-portfolio-panel">
          <div className="performance-table-scroll">
            <table className="data-table performance-table">
              <thead><tr><th>Client / Project</th><th>Cluster</th><th>Performance</th><th>Phase</th><th>Sentiment</th><th>Account Manager</th><th>Primary KPI</th><th>Updated</th></tr></thead>
              <tbody>
                {filteredProjects.map((project) => (
                  <tr key={project.id} className={selectedProjectId === project.id ? "selected-row" : ""} onClick={() => chooseProject(project.id, true)}>
                    <td><strong>{project.name}</strong><small>{project.clientName}</small></td>
                    <td>{project.clusterName || "—"}</td>
                    <td><StatusPill value={project.performanceStatus || "Not set"} /></td>
                    <td>{project.currentPhase || "—"}</td>
                    <td><StatusPill value={project.clientSentiment || "Not set"} /></td>
                    <td>{project.team?.am?.name || "—"}</td>
                    <td>{project.primaryKpi ? `${project.primaryKpi.kpiName}: ${valueOrDash(project.primaryKpi.actual)}` : "—"}</td>
                    <td>{formatDateTime(project.performanceUpdatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filteredProjects.length ? <EmptyState title="No projects match these filters" text="Clear or change a filter to see portfolio data." /> : null}
          </div>
        </Panel>
      </section>

      <section id="performance-project-details" className="performance-section-anchor">
        <div className="section-heading-inline">
          <div><p className="eyebrow">Project Details</p><h3>{selectedProject?.name || "Select a project"}</h3></div>
          <div className="performance-project-picker">
            <SingleSelect label="Project" options={options(projects)} value={selectedProjectId} onChange={(value) => chooseProject(value)} placeholder="Select project" />
          </div>
        </div>
        {!selectedProject ? <EmptyState title="No project selected" /> : (
          <div className="performance-details-scroll">
            <div className="performance-detail-grid">
              <Panel title="Existing Project Identity">
                <dl className="detail-list">
                  <div><dt>Cluster</dt><dd>{selectedProject.clusterName || "Not set"}</dd></div>
                  <div><dt>Client</dt><dd>{selectedProject.clientName || "Not set"}</dd></div>
                  <div><dt>Project ID</dt><dd>{selectedProject.key}</dd></div>
                  <div><dt>Project Name</dt><dd>{selectedProject.name}</dd></div>
                  <div><dt>Start Date</dt><dd>{formatDate(selectedProject.startDate)}</dd></div>
                  <div><dt>End Date</dt><dd>{formatDate(selectedProject.endDate)}</dd></div>
                  <div><dt>CSAT Active Status</dt><dd><StatusPill value={selectedProject.activeStatus} /></dd></div>
                </dl>
              </Panel>
              <Panel title="Client and Project Profile">
                <dl className="detail-list">
                  <div><dt>Client Group</dt><dd>{selectedProject.clientGroup || "Not set"}</dd></div>
                  <div><dt>Client Category</dt><dd>{selectedProject.clientCategory || "Not set"}</dd></div>
                  <div><dt>Financial Year</dt><dd>{selectedProject.financialYear || "Not set"}</dd></div>
                  <div><dt>Project Type</dt><dd>{selectedProject.projectType || "Not set"}</dd></div>
                  <div><dt>Revenue Category</dt><dd>{selectedProject.revenueCategory || "Not set"}</dd></div>
                  <div><dt>Portfolio Type</dt><dd>{selectedProject.portfolioType || "Not set"}</dd></div>
                </dl>
              </Panel>
              <Panel title="Project Team">
                <dl className="detail-list">
                  <div><dt>Project Director</dt><dd>{selectedProject.team?.projectDirector?.name || "Not set"}</dd></div>
                  <div><dt>AM</dt><dd>{selectedProject.team?.am?.name || "Not set"}</dd></div>
                  <div><dt>TL</dt><dd>{selectedProject.team?.tl?.name || "Not set"}</dd></div>
                  <div><dt>AD</dt><dd>{selectedProject.team?.ad?.name || "Not set"}</dd></div>
                  <div><dt>AVP</dt><dd>{selectedProject.team?.avp?.name || "Not set"}</dd></div>
                </dl>
              </Panel>
              <Panel title="Commercial Profile">
                <dl className="detail-list">
                  <div><dt>Currency</dt><dd>{selectedProject.currency || "INR"}</dd></div>
                  <div><dt>FX Rate to INR</dt><dd>{valueOrDash(selectedProject.fxRateToInr)}</dd></div>
                  <div><dt>PO Amount</dt><dd>{money(selectedProject.poAmountLocal, selectedProject.currency)}</dd></div>
                  <div><dt>Budget Allocated</dt><dd>{money(selectedProject.budgetAllocatedLocal, selectedProject.currency)}</dd></div>
                  <div><dt>Budget Spent</dt><dd>{money(selectedProject.budgetSpentLocal, selectedProject.currency)}</dd></div>
                  <div><dt>Revenue Generated</dt><dd>{money(selectedProject.revenueGeneratedLocal, selectedProject.currency)}</dd></div>
                </dl>
              </Panel>
              <Panel title="Current Performance">
                <dl className="detail-list">
                  <div><dt>Performance Status</dt><dd><StatusPill value={selectedProject.performanceStatus || "Not set"} /></dd></div>
                  <div><dt>Current Phase</dt><dd>{selectedProject.currentPhase || "Not set"}</dd></div>
                  <div><dt>Campaign Status</dt><dd>{selectedProject.campaignStatus || "Not set"}</dd></div>
                  <div><dt>Client Sentiment</dt><dd><StatusPill value={selectedProject.clientSentiment || "Not set"} /></dd></div>
                  <div><dt>Relationship</dt><dd>{selectedProject.relationshipStrength || "Not set"}</dd></div>
                  <div><dt>Last Updated</dt><dd>{formatDateTime(selectedProject.performanceUpdatedAt)}</dd></div>
                </dl>
              </Panel>
              <Panel title="Delivery and Client Context">
                <dl className="detail-list">
                  <div><dt>Deliverables Status</dt><dd>{selectedProject.deliverablesStatus || "Not set"}</dd></div>
                  <div><dt>Meeting Cadence</dt><dd>{selectedProject.meetingCadence || "Not set"}</dd></div>
                  <div><dt>Last Meeting</dt><dd>{formatDate(selectedProject.lastMeetingDate)}</dd></div>
                  <div><dt>Suggestion Frequency</dt><dd>{selectedProject.suggestionFrequency || "Not set"}</dd></div>
                  <div><dt>Last Suggestion</dt><dd>{formatDate(selectedProject.lastSuggestionDate)}</dd></div>
                  <div><dt>Updated By</dt><dd>{selectedProject.updatedBy || "Not set"}</dd></div>
                </dl>
              </Panel>
              <Panel title="Project Links">
                <dl className="detail-list">
                  <div><dt>MoM</dt><dd><ProjectLink href={selectedProject.links?.mom}>Open MoM</ProjectLink></dd></div>
                  <div><dt>Consolidated Sheet</dt><dd><ProjectLink href={selectedProject.links?.consolidatedSheet}>Open Sheet</ProjectLink></dd></div>
                  <div><dt>Project Drive</dt><dd><ProjectLink href={selectedProject.links?.projectDriveFolder}>Open Folder</ProjectLink></dd></div>
                  <div><dt>Project Data Sheet</dt><dd><ProjectLink href={selectedProject.links?.projectDataSheet}>Open Sheet</ProjectLink></dd></div>
                </dl>
              </Panel>
              <Panel title="Services and Mandates" className="performance-wide-panel">
                <p className="field-caption">Existing project services</p>
                <div className="service-chip-list">{selectedProject.services.length ? selectedProject.services.map((service) => <span key={service.id}>{service.name}</span>) : <em>No services configured</em>}</div>
                <p className="performance-long-text">{selectedProject.mandates || "No mandate, target or delivery detail recorded yet."}</p>
              </Panel>
              <Panel title="Feedback, Next Steps and Comments" className="performance-wide-panel">
                <div className="performance-note-grid">
                  <div><strong>Client Feedback</strong><p>{selectedProject.clientFeedback || "Not set"}</p></div>
                  <div><strong>Next Steps</strong><p>{selectedProject.nextSteps || "Not set"}</p></div>
                  <div><strong>Comments</strong><p>{selectedProject.comments || "Not set"}</p></div>
                </div>
              </Panel>
              <Panel title="Current KPI Performance" className="performance-wide-panel">
                <div className="performance-table-scroll compact">
                  <table className="data-table performance-table">
                    <thead><tr><th>KPI</th><th>Target</th><th>Actual</th><th>Achievement</th><th>Previous Year</th><th>Vs Previous Year</th><th>Direction</th></tr></thead>
                    <tbody>{selectedProject.kpis.map((kpi) => {
                      const achievement = kpiAchievement(kpi);
                      const variance = previousYearVariance(kpi);
                      return <tr key={kpi.id || kpi.kpiName}><td><strong>{kpi.kpiName}</strong>{kpi.isPrimary ? <small>Primary</small> : null}</td><td><KpiValue kpi={{ ...kpi, currency: selectedProject.currency }} field="target" /></td><td><KpiValue kpi={{ ...kpi, currency: selectedProject.currency }} field="actual" /></td><td>{achievement === null ? "—" : `${achievement.toFixed(1)}%`}</td><td><KpiValue kpi={{ ...kpi, currency: selectedProject.currency }} field="previousYearActual" /></td><td>{variance === null ? "—" : `${variance >= 0 ? "+" : ""}${variance.toFixed(1)}%`}</td><td>{kpi.direction === "lower_better" ? "Lower is better" : "Higher is better"}</td></tr>;
                    })}</tbody>
                  </table>
                  {!selectedProject.kpis.length ? <EmptyState title="No KPIs added" /> : null}
                </div>
              </Panel>
            </div>
          </div>
        )}
      </section>

      <section id="performance-update" className="performance-section-anchor">
        <div className="section-heading-inline"><div><p className="eyebrow">Update Project</p><h3>Maintain current project performance</h3></div></div>
        {!selectedProject ? <EmptyState title="Select a project before updating" /> : (
          <Panel title={`Update ${selectedProject.name}`} badge={`Version ${selectedProject.version || 0}`}>
            <div className="performance-form-scroll">
              <div className="performance-form-section">
                <h4>Update owner</h4>
                <Field label="Updated By" help={editorIdentity ? "Taken from your verified Google Workspace session." : "Required for this audit entry."}><input value={form.updatedBy} onChange={(event) => updateField("updatedBy", event.target.value)} placeholder="Your full name" readOnly={Boolean(editorIdentity)} /></Field>
              </div>

              <div className="performance-form-section">
                <h4>Client and Project Profile</h4>
                <div className="performance-form-grid">
                  <Field label="Client Group"><NativeSelect value={form.clientGroup} onChange={(value) => updateField("clientGroup", value)} items={referenceOptions(data, "client_group")} placeholder="Not yet standardized" /></Field>
                  <Field label="Client Category"><NativeSelect value={form.clientCategory} onChange={(value) => updateField("clientCategory", value)} items={referenceOptions(data, "client_category")} /></Field>
                  <Field label="Financial Year"><NativeSelect value={form.financialYear} onChange={(value) => updateField("financialYear", value)} items={(data.financialYears || []).map((value) => ({ value, label: value }))} /></Field>
                  <Field label="Project Type"><NativeSelect value={form.projectType} onChange={(value) => updateField("projectType", value)} items={referenceOptions(data, "project_type")} /></Field>
                  <Field label="Revenue Category"><NativeSelect value={form.revenueCategory} onChange={(value) => updateField("revenueCategory", value)} items={referenceOptions(data, "revenue_category")} /></Field>
                  <Field label="Portfolio Type"><NativeSelect value={form.portfolioType} onChange={(value) => updateField("portfolioType", value)} items={referenceOptions(data, "portfolio_type")} /></Field>
                </div>
              </div>

              <div className="performance-form-section">
                <h4>Project Team</h4>
                <div className="performance-form-grid five">
                  <Field label="Project Director"><NativeSelect value={form.projectDirectorId} onChange={(value) => updateField("projectDirectorId", value)} items={internalPocOptions} /></Field>
                  <Field label="AM"><NativeSelect value={form.amId} onChange={(value) => updateField("amId", value)} items={internalPocOptions} /></Field>
                  <Field label="TL"><NativeSelect value={form.tlId} onChange={(value) => updateField("tlId", value)} items={internalPocOptions} /></Field>
                  <Field label="AD"><NativeSelect value={form.adId} onChange={(value) => updateField("adId", value)} items={internalPocOptions} /></Field>
                  <Field label="AVP"><NativeSelect value={form.avpId} onChange={(value) => updateField("avpId", value)} items={internalPocOptions} /></Field>
                </div>
              </div>

              <div className="performance-form-section">
                <h4>Commercial Profile</h4>
                <div className="performance-form-grid">
                  <Field label="Currency"><NativeSelect value={form.currency} onChange={(value) => updateField("currency", value)} items={referenceOptions(data, "currency")} placeholder="Select currency" /></Field>
                  <Field label="FX Rate to INR"><input type="number" min="0" step="0.000001" value={form.fxRateToInr} onChange={(event) => updateField("fxRateToInr", event.target.value)} /></Field>
                  <Field label={`PO Amount (${currencySymbol})`}><input type="number" min="0" step="0.01" value={form.poAmountLocal} onChange={(event) => updateField("poAmountLocal", event.target.value)} /></Field>
                  <Field label={`Budget Allocated (${currencySymbol})`}><input type="number" min="0" step="0.01" value={form.budgetAllocatedLocal} onChange={(event) => updateField("budgetAllocatedLocal", event.target.value)} /></Field>
                  <Field label={`Budget Spent (${currencySymbol})`}><input type="number" min="0" step="0.01" value={form.budgetSpentLocal} onChange={(event) => updateField("budgetSpentLocal", event.target.value)} /></Field>
                  <Field label={`Revenue Generated (${currencySymbol})`}><input type="number" min="0" step="0.01" value={form.revenueGeneratedLocal} onChange={(event) => updateField("revenueGeneratedLocal", event.target.value)} /></Field>
                </div>
              </div>

              <div className="performance-form-section">
                <h4>Current Performance</h4>
                <div className="performance-form-grid">
                  <Field label="Performance Status" help="This does not change the CSAT project's Active/Inactive status."><NativeSelect value={form.performanceStatus} onChange={(value) => updateField("performanceStatus", value)} items={referenceOptions(data, "performance_status")} /></Field>
                  <Field label="Current Phase"><NativeSelect value={form.currentPhase} onChange={(value) => updateField("currentPhase", value)} items={referenceOptions(data, "current_phase")} /></Field>
                  <Field label="Campaign Status"><NativeSelect value={form.campaignStatus} onChange={(value) => updateField("campaignStatus", value)} items={referenceOptions(data, "campaign_status")} /></Field>
                  <Field label="Client Sentiment"><NativeSelect value={form.clientSentiment} onChange={(value) => updateField("clientSentiment", value)} items={referenceOptions(data, "client_sentiment")} /></Field>
                  <Field label="Relationship Strength"><NativeSelect value={form.relationshipStrength} onChange={(value) => updateField("relationshipStrength", value)} items={referenceOptions(data, "relationship_strength")} /></Field>
                  <Field label="Deliverables Status"><input value={form.deliverablesStatus} onChange={(event) => updateField("deliverablesStatus", event.target.value)} /></Field>
                  <Field label="Meeting Cadence"><NativeSelect value={form.meetingCadence} onChange={(value) => updateField("meetingCadence", value)} items={referenceOptions(data, "meeting_cadence")} /></Field>
                  <Field label="Last Meeting Date"><input type="date" value={form.lastMeetingDate} onChange={(event) => updateField("lastMeetingDate", event.target.value)} /></Field>
                  <Field label="Suggestion Frequency"><NativeSelect value={form.suggestionFrequency} onChange={(value) => updateField("suggestionFrequency", value)} items={referenceOptions(data, "suggestion_frequency")} /></Field>
                  <Field label="Last Suggestion Date"><input type="date" value={form.lastSuggestionDate} onChange={(event) => updateField("lastSuggestionDate", event.target.value)} /></Field>
                </div>
              </div>

              <div className="performance-form-section">
                <h4>Services and Mandates</h4>
                <Field label="Existing Services" help="Services come from the existing project setup and cannot be renamed here."><div className="service-chip-list">{selectedProject.services.length ? selectedProject.services.map((service) => <span key={service.id}>{service.name}</span>) : <em>No services configured</em>}</div></Field>
                <Field label="Mandates, Targets and Service Details"><textarea rows="7" value={form.mandates} onChange={(event) => updateField("mandates", event.target.value)} placeholder="Add targets, deliverables or service-specific details. New lines are preserved." /></Field>
              </div>

              <div className="performance-form-section">
                <div className="performance-form-title-row"><h4>KPIs</h4><Button icon={Plus} onClick={() => setKpis((current) => [...current, blankKpi()])}>Add KPI</Button></div>
                <div className="performance-kpi-editor">
                  {kpis.map((kpi, index) => (
                    <div className="performance-kpi-row" key={kpi.id || `new-${index}`}>
                      <Field label="KPI"><NativeSelect value={kpi.kpiName} onChange={(value) => updateKpi(index, "kpiName", value)} items={referenceOptions(data, "kpi_name")} placeholder="Select KPI" /></Field>
                      <Field label="Unit"><NativeSelect value={kpi.unit} onChange={(value) => updateKpi(index, "unit", value)} items={[{ value: "number", label: "Number" }, { value: "percent", label: "Percentage" }, { value: "currency", label: "Currency" }, { value: "ratio", label: "Ratio" }]} /></Field>
                      <Field label="Direction"><NativeSelect value={kpi.direction} onChange={(value) => updateKpi(index, "direction", value)} items={[{ value: "higher_better", label: "Higher is better" }, { value: "lower_better", label: "Lower is better" }]} /></Field>
                      <Field label="Target"><input type="number" step="any" value={kpi.target ?? ""} onChange={(event) => updateKpi(index, "target", event.target.value)} /></Field>
                      <Field label="Actual"><input type="number" step="any" value={kpi.actual ?? ""} onChange={(event) => updateKpi(index, "actual", event.target.value)} /></Field>
                      <Field label="Previous Year"><input type="number" step="any" value={kpi.previousYearActual ?? ""} onChange={(event) => updateKpi(index, "previousYearActual", event.target.value)} /></Field>
                      <label className="performance-primary-check"><input type="checkbox" checked={Boolean(kpi.isPrimary)} onChange={(event) => updateKpi(index, "isPrimary", event.target.checked)} /><span>Primary</span></label>
                      <button type="button" className="icon-button danger" onClick={() => setKpis((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove KPI ${index + 1}`}><Trash2 size={16} /></button>
                    </div>
                  ))}
                  {!kpis.length ? <EmptyState title="No KPIs added" text="Add as many KPI rows as this project needs." /> : null}
                </div>
              </div>

              <div className="performance-form-section">
                <h4>Notes and Next Actions</h4>
                <div className="performance-form-grid textareas">
                  <Field label="Client Feedback"><textarea rows="5" value={form.clientFeedback} onChange={(event) => updateField("clientFeedback", event.target.value)} /></Field>
                  <Field label="Next Steps"><textarea rows="5" value={form.nextSteps} onChange={(event) => updateField("nextSteps", event.target.value)} /></Field>
                  <Field label="Comments"><textarea rows="5" value={form.comments} onChange={(event) => updateField("comments", event.target.value)} /></Field>
                </div>
              </div>

              <div className="performance-form-section">
                <h4>Project Links</h4>
                <div className="performance-form-grid">
                  <Field label="MoM Link"><input type="url" value={form.mom} onChange={(event) => updateField("mom", event.target.value)} placeholder="https://" /></Field>
                  <Field label="Consolidated Sheet Link"><input type="url" value={form.consolidatedSheet} onChange={(event) => updateField("consolidatedSheet", event.target.value)} placeholder="https://" /></Field>
                  <Field label="Project Drive Folder"><input type="url" value={form.projectDriveFolder} onChange={(event) => updateField("projectDriveFolder", event.target.value)} placeholder="https://" /></Field>
                  <Field label="Project Data Sheet"><input type="url" value={form.projectDataSheet} onChange={(event) => updateField("projectDataSheet", event.target.value)} placeholder="https://" /></Field>
                </div>
              </div>
            </div>
            <div className="performance-save-bar">
              <div>{notice ? <span className="success-message">{notice}</span> : error ? <span className="error-message">{error.message}</span> : <span>Saving updates the current record and creates one audit entry.</span>}</div>
              <Button icon={Save} variant="primary" onClick={save} disabled={saving || !form.updatedBy.trim()}>{saving ? "Saving…" : "Save Project Performance"}</Button>
            </div>
          </Panel>
        )}
      </section>

      <section id="performance-audit" className="performance-section-anchor">
        <div className="section-heading-inline"><div><p className="eyebrow">Audit History</p><h3>Who changed what</h3></div></div>
        <Panel title={selectedProject ? `${selectedProject.name} Updates` : "Project Updates"} badge={`${selectedProject?.auditHistory?.length || 0} entries`}>
          <div className="performance-audit-scroll">
            {(selectedProject?.auditHistory || []).map((entry) => (
              <article className="performance-audit-entry" key={entry.id}>
                <div><strong>{entry.updatedBy}</strong><span>{formatDateTime(entry.changedAt)}</span></div>
                <ul>{Object.keys(entry.changes || {}).map((field) => <li key={field}>{field.replace(/^client\.|^project\./, "").replace(/_/g, " ")}</li>)}</ul>
              </article>
            ))}
            {!selectedProject?.auditHistory?.length ? <EmptyState title="No performance updates yet" text="The first save will create the initial audit entry." /> : null}
          </div>
        </Panel>
      </section>
    </div>
  );
}
