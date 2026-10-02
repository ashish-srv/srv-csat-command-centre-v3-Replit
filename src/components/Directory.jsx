import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { apiGet } from "../api";
import { formatDate, formatPocWeightShare } from "../format";
import { FilterBar, MultiSelect, SingleSelect } from "./Filters.jsx";
import { Button, EmptyState, LoadingBlock, Panel } from "./Ui.jsx";

function statusLabel(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ProjectDetail({ project, detail }) {
  const pocs = (detail?.pocs || []).filter((poc) => poc.projectId === project.id);
  const services = (detail?.services || []).filter((service) => service.projectId === project.id);

  return (
    <div className="directory-project-detail">
      <section className="directory-record-group">
        <div className="directory-record-title">
          <h5>Services and owners</h5>
          <span>{services.length} {services.length === 1 ? "service" : "services"}</span>
        </div>
        {services.length ? (
          <div className="dtable directory-services">
            <div className="dtable-head">
              <span>Service</span>
              <span>Key</span>
              <span>Owner</span>
              <span>Reporting manager</span>
            </div>
            {services.map((service) => (
              <div key={service.id} className="dtable-row">
                <strong>{service.name}</strong>
                <span className="mono">{service.serviceKey}</span>
                <span className={service.ownerName ? "" : "missing"}>{service.ownerName || "not set"}</span>
                <span className={service.managerName ? "" : "missing"}>{service.managerName || "not set"}</span>
              </div>
            ))}
          </div>
        ) : <p className="directory-empty">No services are mapped to this project.</p>}
      </section>

      <section className="directory-record-group">
        <div className="directory-record-title">
          <h5>Client POCs</h5>
          <span>{pocs.length} {pocs.length === 1 ? "POC" : "POCs"}</span>
        </div>
        {pocs.length ? (
          <div className="dtable directory-pocs">
            <div className="dtable-head">
              <span>Name</span>
              <span>Designation</span>
              <span>WhatsApp</span>
              <span>Email</span>
              <span>Level</span>
              <span>Active</span>
            </div>
            {pocs.map((poc) => (
              <div key={poc.id} className="dtable-row">
                <strong>{poc.name}</strong>
                <span>{poc.designation || "--"}</span>
                <span className={`mono ${poc.contactWhatsapp ? "" : "missing"}`}>
                  {poc.contactWhatsapp || "not set"}
                </span>
                <span className="poc-email">{poc.contactEmail || "--"}</span>
                <span className="poc-level">
                  {poc.levelName ? `${poc.levelName} · ${formatPocWeightShare(poc, pocs)}` : "Not set"}
                </span>
                <span className={poc.active ? "" : "missing"}>{poc.active ? "Yes" : "No"}</span>
              </div>
            ))}
          </div>
        ) : <p className="directory-empty">No client POCs are mapped to this project.</p>}
      </section>
    </div>
  );
}

function ProjectNode({ project, detail, expanded, onToggle, onOpenProject }) {
  const pocs = (detail?.pocs || []).filter((poc) => poc.projectId === project.id);
  const services = (detail?.services || []).filter((service) => service.projectId === project.id);

  return (
    <div className={`directory-project-node ${expanded ? "expanded" : ""}`}>
      <div className="directory-project-row">
        <button
          type="button"
          className="directory-project-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} services and POCs for ${project.name}`}
        >
          <span className="directory-chevron">
            {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          </span>
          <span className="directory-project-name">
            <strong>{project.name}</strong>
            <small className="mono">{project.key}</small>
          </span>
          <span className="directory-project-status">{statusLabel(project.activeStatus)}</span>
          <span className="directory-project-dates">
            {formatDate(project.startDate)} – {formatDate(project.endDate)}
          </span>
          <span className="directory-project-interval">Every {project.feedbackIntervalDays} days</span>
          <span className="directory-project-counts">
            {services.length} services · {pocs.length} POCs
          </span>
        </button>
        <button type="button" className="row-link" onClick={() => onOpenProject(project.key)}>Open</button>
      </div>
      {expanded ? <ProjectDetail project={project} detail={detail} /> : null}
    </div>
  );
}

export default function Directory({ onOpenProject }) {
  const [directory, setDirectory] = useState(null);
  const [clusterId, setClusterId] = useState("");
  const [clientStatuses, setClientStatuses] = useState([]);
  const [clientId, setClientId] = useState("");
  const [projectStatuses, setProjectStatuses] = useState([]);
  const [projectIds, setProjectIds] = useState([]);
  const [expandedClients, setExpandedClients] = useState({});
  const [expandedProjects, setExpandedProjects] = useState({});
  const [detailsByClient, setDetailsByClient] = useState({});
  const [detailLoading, setDetailLoading] = useState({});
  const [detailErrors, setDetailErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function loadDirectory() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet("/api/admin/directory");
      setDirectory(data);
      setClusterId("");
      setClientStatuses([]);
      setClientId("");
      setProjectStatuses([]);
      setProjectIds([]);
      setExpandedClients({});
      setExpandedProjects({});
      setDetailsByClient({});
      setDetailLoading({});
      setDetailErrors({});
    } catch (loadError) {
      setError(loadError);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadDirectory(); }, []);

  const clients = directory?.clients || [];
  const projects = directory?.projects || [];
  const clusters = directory?.clusters || [];
  const clustersById = useMemo(
    () => new Map(clusters.map((cluster) => [cluster.id, cluster.name])),
    [clusters]
  );
  const clientStatusOptions = useMemo(
    () => [...new Set(clients.map((client) => client.activeStatus).filter(Boolean))].sort(),
    [clients]
  );
  const eligibleClients = useMemo(
    () => clients.filter((client) => (
      (!clusterId || client.clusterId === clusterId)
      && (!clientStatuses.length || clientStatuses.includes(client.activeStatus))
    )),
    [clients, clusterId, clientStatuses]
  );
  const scopedClients = useMemo(
    () => eligibleClients.filter((client) => !clientId || client.id === clientId),
    [eligibleClients, clientId]
  );
  const scopedClientIds = useMemo(
    () => new Set(scopedClients.map((client) => client.id)),
    [scopedClients]
  );
  const scopedProjects = useMemo(
    () => projects.filter((project) => scopedClientIds.has(project.clientId)),
    [projects, scopedClientIds]
  );
  const projectStatusOptions = useMemo(
    () => [...new Set(scopedProjects.map((project) => project.activeStatus).filter(Boolean))].sort(),
    [scopedProjects]
  );
  const projectNamesById = useMemo(
    () => new Map(scopedProjects.map((project) => [project.id, project.name])),
    [scopedProjects]
  );
  const projectOptions = useMemo(
    () => scopedProjects.filter((project) => (
      !projectStatuses.length || projectStatuses.includes(project.activeStatus)
    )),
    [scopedProjects, projectStatuses]
  );
  const filteredProjects = useMemo(
    () => scopedProjects.filter((project) => (
      (!projectStatuses.length || projectStatuses.includes(project.activeStatus))
      && (!projectIds.length || projectIds.includes(project.id))
    )),
    [scopedProjects, projectStatuses, projectIds]
  );
  const filteredProjectsByClient = useMemo(() => {
    const map = new Map();
    for (const project of filteredProjects) {
      if (!map.has(project.clientId)) map.set(project.clientId, []);
      map.get(project.clientId).push(project);
    }
    return map;
  }, [filteredProjects]);
  const projectFilterActive = Boolean(projectStatuses.length || projectIds.length);
  const visibleClients = useMemo(
    () => scopedClients.filter((client) => (
      !projectFilterActive || (filteredProjectsByClient.get(client.id) || []).length
    )),
    [scopedClients, projectFilterActive, filteredProjectsByClient]
  );
  const filtersActive = Boolean(clusterId || clientStatuses.length || clientId || projectStatuses.length || projectIds.length);

  function resetFilters() {
    setClusterId("");
    setClientStatuses([]);
    setClientId("");
    setProjectStatuses([]);
    setProjectIds([]);
  }

  useEffect(() => {
    const validProjectIds = new Set(scopedProjects.map((project) => project.id));
    setProjectIds((current) => current.filter((id) => validProjectIds.has(id)));
  }, [scopedProjects]);

  function keepClientInScope(nextClusterId, nextClientStatuses) {
    if (!clientId) return;
    const stillEligible = clients.some((client) => (
      client.id === clientId
      && (!nextClusterId || client.clusterId === nextClusterId)
      && (!nextClientStatuses.length || nextClientStatuses.includes(client.activeStatus))
    ));
    if (!stillEligible) setClientId("");
  }

  function changeCluster(nextClusterId) {
    setClusterId(nextClusterId);
    keepClientInScope(nextClusterId, clientStatuses);
  }

  function changeClientStatuses(nextClientStatuses) {
    setClientStatuses(nextClientStatuses);
    keepClientInScope(clusterId, nextClientStatuses);
  }

  async function loadClientDetail(id) {
    if (!id || detailsByClient[id] || detailLoading[id]) return;
    setDetailLoading((current) => ({ ...current, [id]: true }));
    setDetailErrors((current) => ({ ...current, [id]: null }));
    try {
      const detail = await apiGet(`/api/admin/clients/${encodeURIComponent(id)}`);
      setDetailsByClient((current) => ({ ...current, [id]: detail }));
    } catch (loadError) {
      setDetailErrors((current) => ({ ...current, [id]: loadError }));
    } finally {
      setDetailLoading((current) => ({ ...current, [id]: false }));
    }
  }

  function toggleClient(id) {
    const willExpand = !expandedClients[id];
    setExpandedClients((current) => ({ ...current, [id]: willExpand }));
    if (willExpand) void loadClientDetail(id);
  }

  function toggleProject(projectId) {
    setExpandedProjects((current) => ({ ...current, [projectId]: !current[projectId] }));
  }

  if (loading) return <LoadingBlock label="Loading directory" />;
  if (error) {
    return (
      <div className="error-block">
        <strong>Could not load the directory</strong>
        <p>{error.message}</p>
        <Button icon={RefreshCw} variant="primary" onClick={loadDirectory}>Try again</Button>
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h2>Directory</h2>
          <p className="topbar-sub">Browse every client, project, service and client POC in one expandable directory</p>
        </div>
        <Button icon={RefreshCw} onClick={loadDirectory}>Refresh</Button>
      </div>

      <FilterBar showReset={filtersActive} onReset={resetFilters}>
        <SingleSelect
          label="Cluster"
          value={clusterId}
          onChange={changeCluster}
          placeholder="All clusters"
          options={clusters.map((cluster) => ({ value: cluster.id, label: cluster.name }))}
        />
        <MultiSelect
          label="Client status"
          allLabel="All statuses"
          selected={clientStatuses}
          onChange={changeClientStatuses}
          options={clientStatusOptions}
          renderOption={statusLabel}
        />
        <SingleSelect
          label="Client"
          value={clientId}
          onChange={setClientId}
          placeholder="All clients"
          options={eligibleClients.map((client) => ({ value: client.id, label: client.name }))}
        />
        <MultiSelect
          label="Project status"
          allLabel="All statuses"
          selected={projectStatuses}
          onChange={setProjectStatuses}
          options={projectStatusOptions}
          renderOption={statusLabel}
        />
        <MultiSelect
          label="Project"
          allLabel="All projects"
          selected={projectIds}
          onChange={setProjectIds}
          options={projectOptions.map((project) => project.id)}
          renderOption={(id) => projectNamesById.get(id) || id}
        />
      </FilterBar>

      <Panel
        title="Client directory"
        badge={`${visibleClients.length} clients · ${filteredProjects.length} projects`}
        className="span-12"
      >
        {visibleClients.length ? (
          <div className="directory-tree">
            {visibleClients.map((client) => {
              const clientProjects = filteredProjectsByClient.get(client.id) || [];
              const expanded = Boolean(expandedClients[client.id]);
              const detail = detailsByClient[client.id] || null;
              return (
                <section key={client.id} className={`directory-client-node ${expanded ? "expanded" : ""}`}>
                  <button
                    type="button"
                    className="directory-client-toggle"
                    onClick={() => toggleClient(client.id)}
                    aria-expanded={expanded}
                  >
                    <span className="directory-chevron">
                      {expanded ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronRight size={18} aria-hidden="true" />}
                    </span>
                    <span className="directory-client-name">
                      <strong>{client.name}</strong>
                      <small>{client.key}</small>
                    </span>
                    <span className="directory-client-cluster">{clustersById.get(client.clusterId) || "No cluster"}</span>
                    <span className="directory-client-status">{statusLabel(client.activeStatus)}</span>
                    <span className="directory-client-count">{clientProjects.length} {clientProjects.length === 1 ? "project" : "projects"}</span>
                  </button>

                  {expanded ? (
                    <div className="directory-client-content">
                      {detailLoading[client.id] ? <LoadingBlock label={`Loading ${client.name}`} /> : null}
                      {detailErrors[client.id] ? (
                        <div className="directory-inline-error">
                          <span>{detailErrors[client.id].message}</span>
                          <Button onClick={() => loadClientDetail(client.id)}>Retry</Button>
                        </div>
                      ) : null}
                      {detail && clientProjects.map((project) => (
                        <ProjectNode
                          key={project.id}
                          project={project}
                          detail={detail}
                          expanded={Boolean(expandedProjects[project.id])}
                          onToggle={() => toggleProject(project.id)}
                          onOpenProject={onOpenProject}
                        />
                      ))}
                      {detail && !clientProjects.length ? (
                        <p className="directory-empty">
                          {projectFilterActive ? "No projects match the selected project filters." : "This client has no projects yet."}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No matching directory records"
            text="Change the cluster, client or project filters to see more records."
          />
        )}
      </Panel>
    </>
  );
}
