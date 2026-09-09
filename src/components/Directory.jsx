import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiGet } from "../api";
import { formatDate, formatPocWeightShare } from "../format";
import { Button, EmptyState, LoadingBlock, Panel, SingleSelectRow } from "./Ui.jsx";

export default function Directory({ onOpenProject }) {
  const [directory, setDirectory] = useState(null);
  const [clientId, setClientId] = useState("");
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function loadDirectory() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet("/api/admin/directory");
      setDirectory(data);
      const first = (data.clients || [])[0];
      if (first) {
        setClientId(first.id);
        setDetail(await apiGet(`/api/admin/clients/${encodeURIComponent(first.id)}`));
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
    if (!id) return;
    try {
      setDetail(await apiGet(`/api/admin/clients/${encodeURIComponent(id)}`));
    } catch (loadError) {
      setError(loadError);
    }
  }

  const projectsById = useMemo(
    () => new Map((detail?.projects || []).map((project) => [project.id, project])),
    [detail]
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

  const clients = directory?.clients || [];

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
          label="Client"
          value={clientId}
          onChange={selectClient}
          placeholder="Select a client"
          options={clients.map((client) => ({ value: client.id, label: client.name }))}
        />
        {detail?.client ? (
          <div className="filter-field">
            <span className="filter-label">Cluster</span>
            <span className="filter-static">{detail.client.clusterName || "Not set"}</span>
          </div>
        ) : null}
        {detail?.client ? (
          <div className="filter-field">
            <span className="filter-label">Status</span>
            <span className="filter-static">{detail.client.activeStatus || "Not set"}</span>
          </div>
        ) : null}
      </div>

      {!detail ? (
        <EmptyState title="No client selected" text="Pick a client to see its records." />
      ) : (
        <>
          <Panel title="Projects" badge={`${detail.projects.length} total`} className="span-12">
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
              {detail.projects.map((project) => (
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
              {!detail.projects.length ? <EmptyState title="No projects" text="This client has no project yet." /> : null}
            </div>
          </Panel>

          <Panel title="Client POCs" badge={`${detail.pocs.length} total`} className="span-12">
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
              {detail.pocs.map((poc) => {
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
                    <span>{poc.levelName ? `${poc.levelName} · ${formatPocWeightShare(poc, detail.pocs)}` : "Not set"}</span>
                    <span className={poc.active ? "" : "missing"}>{poc.active ? "Yes" : "No"}</span>
                  </div>
                );
              })}
              {!detail.pocs.length ? (
                <EmptyState title="No POCs" text="Without a POC that has a WhatsApp number, no cycle can be sent." />
              ) : null}
            </div>
          </Panel>

          <Panel title="Services and owners" badge={`${detail.services.length} total`} className="span-12">
            <div className="dtable services">
              <div className="dtable-head">
                <span>Service</span>
                <span>Project</span>
                <span>Key</span>
                <span>Owner</span>
                <span>Reporting manager</span>
              </div>
              {detail.services.map((service) => {
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
              {!detail.services.length ? (
                <EmptyState title="No services mapped" text="Feedback cannot be routed until services have owners." />
              ) : null}
            </div>
          </Panel>
        </>
      )}
    </>
  );
}
