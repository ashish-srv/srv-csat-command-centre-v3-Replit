import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiGet } from "../api";
import { formatDate, formatPocWeightShare } from "../format";
import { MultiSelect } from "./Filters.jsx";
import { Button, EmptyState, LoadingBlock, Panel, SingleSelectRow } from "./Ui.jsx";

function statusLabel(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function Directory({ onOpenProject }) {
  const [directory, setDirectory] = useState(null);
  const [clusterId, setClusterId] = useState("");
  const [clientStatuses, setClientStatuses] = useState([]);
  const [clientId, setClientId] = useState("");
  const [detail, setDetail] = useState(null);
  const [projectStatuses, setProjectStatuses] = useState([]);
  const [projectIds, setProjectIds] = useState([]);
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
      setProjectStatuses([]);
      setProjectIds([]);
      const first = (data.clients || [])[0];
      if (first) {
        setClientId(first.id);
        setDetail(await apiGet(`/api/admin/clients/${encodeURIComponent(first.id)}`));
      } else {
        setClientId("");
        setDetail(null);
      }
    } catch (loadError) {
      setError(loadError);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadDirectory(); }, []);

  async function selectClient(id) {
    setClientId(id);
    setDetail(null);
    setProjectStatuses([]);
    setProjectIds([]);
    if (!id) return;
    try {
      setError(null);
      setDetail(await apiGet(`/api/admin/clients/${encodeURIComponent(id)}`));
    } catch (loadError) {
      setError(loadError);
    }
  }

  const clients = directory?.clients || [];
  const clusters = directory?.clusters || [];
  const clientStatusOptions = useMemo(
    () => [...new Set(clients.map((client) => client.activeStatus).filter(Boolean))].sort(),
    [clients]
  );
  const filteredClients = useMemo(
    () => clients.filter((client) => (
      (!clusterId || client.clusterId === clusterId)
      && (!clientStatuses.length || clientStatuses.includes(client.activeStatus))
    )),
    [clients, clusterId, clientStatuses]
  );

  function keepClientInScope(nextClusterId, nextClientStatuses) {
    const eligible = clients.filter((client) => (
      (!nextClusterId || client.clusterId === nextClusterId)
      && (!nextClientStatuses.length || nextClientStatuses.includes(client.activeStatus))
    ));
    if (!eligible.some((client) => client.id === clientId)) {
      void selectClient(eligible[0]?.id || "");
    }
  }

  function changeCluster(nextClusterId) {
    setClusterId(nextClusterId);
    keepClientInScope(nextClusterId, clientStatuses);
  }

  function changeClientStatuses(nextClientStatuses) {
    setClientStatuses(nextClientStatuses);
    keepClientInScope(clusterId, nextClientStatuses);
  }

  const projects = detail?.projects || [];
  const pocs = detail?.pocs || [];
  const services = detail?.services || [];
  const projectStatusOptions = useMemo(
    () => [...new Set(projects.map((project) => project.activeStatus).filter(Boolean))].sort(),
    [projects]
  );
  const projectNamesById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  );
  const visibleProjects = useMemo(
    () => projects.filter((project) => (
      (!projectStatuses.length || projectStatuses.includes(project.activeStatus))
      && (!projectIds.length || projectIds.includes(project.id))
    )),
    [projects, projectStatuses, projectIds]
  );
  const visibleProjectIds = useMemo(
    () => new Set(visibleProjects.map((project) => project.id)),
    [visibleProjects]
  );
  const visiblePocs = useMemo(
    () => pocs.filter((poc) => visibleProjectIds.has(poc.projectId)),
    [pocs, visibleProjectIds]
  );
  const visibleServices = useMemo(
    () => services.filter((service) => visibleProjectIds.has(service.projectId)),
    [services, visibleProjectIds]
  );
  const projectFilterActive = Boolean(projectStatuses.length || projectIds.length);

  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects]
  );

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
          <p className="topbar-sub">Client, project, POC and service records as they stand in the database</p>
        </div>
        <Button icon={RefreshCw} onClick={loadDirectory}>Refresh</Button>
      </div>

      <div className="filter-bar">
        <SingleSelectRow
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
        <SingleSelectRow
          label="Client"
          value={clientId}
          onChange={selectClient}
          placeholder="Select a client"
          options={filteredClients.map((client) => ({ value: client.id, label: client.name }))}
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
          options={projects.map((project) => project.id)}
          renderOption={(id) => projectNamesById.get(id) || id}
        />
      </div>

      {!detail ? (
        <EmptyState title="No client selected" text="Pick a client to see its records." />
      ) : (
        <>
          <Panel
            title="Projects"
            badge={projectFilterActive ? `${visibleProjects.length} of ${projects.length}` : `${projects.length} total`}
            className="span-12"
          >
            <div className="dtable projects">
              <div className="dtable-head">
                <span>Project</span>
                <span>Key</span>
                <span>Status</span>
                <span>Start</span>
                <span>End</span>
                <span>Interval</span>
                <span />
              </div>
              {visibleProjects.map((project) => (
                <div key={project.id} className="dtable-row">
                  <strong>{project.name}</strong>
                  <span className="mono">{project.key}</span>
                  <span>{project.activeStatus}</span>
                  <span>{formatDate(project.startDate)}</span>
                  <span>{formatDate(project.endDate)}</span>
                  <span>{project.feedbackIntervalDays} days</span>
                  <button type="button" className="row-link" onClick={() => onOpenProject(project.key)}>Open</button>
                </div>
              ))}
              {!visibleProjects.length ? (
                <EmptyState
                  title={projects.length ? "No matching projects" : "No projects"}
                  text={projects.length ? "Change the project filters to see more records." : "This client has no project yet."}
                />
              ) : null}
            </div>
          </Panel>

          <Panel
            title="Client POCs"
            badge={projectFilterActive ? `${visiblePocs.length} of ${pocs.length}` : `${pocs.length} total`}
            className="span-12"
          >
            <div className="dtable pocs">
              <div className="dtable-head">
                <span>Name</span>
                <span>Project</span>
                <span>Designation</span>
                <span>WhatsApp</span>
                <span>Email</span>
                <span>Level</span>
                <span>Active</span>
              </div>
              {visiblePocs.map((poc) => {
                const project = projectsById.get(poc.projectId);
                return (
                  <div key={poc.id} className="dtable-row">
                    <strong>{poc.name}</strong>
                    <span>{project ? project.name : "--"}</span>
                    <span>{poc.designation || "--"}</span>
                    <span className={`mono ${poc.contactWhatsapp ? "" : "missing"}`}>
                      {poc.contactWhatsapp || "not set"}
                    </span>
                    <span>{poc.contactEmail || "--"}</span>
                    <span>{poc.levelName ? `${poc.levelName} · ${formatPocWeightShare(poc, pocs)}` : "Not set"}</span>
                    <span className={poc.active ? "" : "missing"}>{poc.active ? "Yes" : "No"}</span>
                  </div>
                );
              })}
              {!visiblePocs.length ? (
                <EmptyState
                  title={pocs.length ? "No matching POCs" : "No POCs"}
                  text={pocs.length ? "No POCs belong to the selected projects." : "Without a POC that has a WhatsApp number, no cycle can be sent."}
                />
              ) : null}
            </div>
          </Panel>

          <Panel
            title="Services and owners"
            badge={projectFilterActive ? `${visibleServices.length} of ${services.length}` : `${services.length} total`}
            className="span-12"
          >
            <div className="dtable services">
              <div className="dtable-head">
                <span>Service</span>
                <span>Project</span>
                <span>Key</span>
                <span>Owner</span>
                <span>Reporting manager</span>
              </div>
              {visibleServices.map((service) => {
                const project = projectsById.get(service.projectId);
                return (
                  <div key={service.id} className="dtable-row">
                    <strong>{service.name}</strong>
                    <span>{project ? project.name : "--"}</span>
                    <span className="mono">{service.serviceKey}</span>
                    <span className={service.ownerName ? "" : "missing"}>{service.ownerName || "not set"}</span>
                    <span className={service.managerName ? "" : "missing"}>{service.managerName || "not set"}</span>
                  </div>
                );
              })}
              {!visibleServices.length ? (
                <EmptyState
                  title={services.length ? "No matching services" : "No services mapped"}
                  text={services.length ? "No services belong to the selected projects." : "Feedback cannot be routed until services have owners."}
                />
              ) : null}
            </div>
          </Panel>
        </>
      )}
    </>
  );
}
