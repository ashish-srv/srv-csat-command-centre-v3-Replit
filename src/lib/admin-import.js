function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function booleanValue(value) {
  const normalized = lower(value);
  if (["yes", "true", "1", "active"].includes(normalized)) return true;
  if (["no", "false", "0", "inactive"].includes(normalized)) return false;
  return null;
}

function serviceIdentifier(value) {
  const normalized = lower(value).replace(/[^a-z0-9]+/g, " ").trim();
  const standard = new Map([
    ["account management", "account"],
    ["design", "design"],
    ["ppc media", "ppc"],
    ["seo", "seo"],
    ["website", "website"]
  ]);
  if (standard.has(normalized)) return standard.get(normalized);
  return normalized
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 70)
    .replace(/_+$/g, "");
}

function rowError(errors, sheet, row, message) {
  errors.push(`${sheet} row ${row}: ${message}`);
}

function statusOkay(value) {
  return ["active", "paused", "closed"].includes(value);
}

function mapBy(items, keyFn) {
  return new Map(items.map((item) => [keyFn(item), item]));
}

function findManagerCycles(directory, internalRows) {
  const emailById = new Map(
    directory.internalPocs.filter((item) => item.email).map((item) => [item.id, lower(item.email)])
  );
  const edges = new Map();
  for (const item of directory.internalPocs) {
    if (!item.email) continue;
    const email = lower(item.email);
    const managerEmail = item.reportingManagerId ? emailById.get(item.reportingManagerId) || null : null;
    edges.set(email, managerEmail === email ? null : managerEmail);
  }
  for (const row of internalRows) {
    edges.set(row.email, row.reportingManagerEmail === row.email ? null : row.reportingManagerEmail || null);
  }

  const cycles = new Set();
  for (const start of edges.keys()) {
    const path = [];
    const seenAt = new Map();
    let cursor = start;
    while (cursor && edges.has(cursor)) {
      if (seenAt.has(cursor)) {
        for (const email of path.slice(seenAt.get(cursor))) cycles.add(email);
        break;
      }
      seenAt.set(cursor, path.length);
      path.push(cursor);
      cursor = edges.get(cursor);
    }
  }
  return cycles;
}

async function loadSnapshot(store) {
  const directory = await store.getDirectory();
  const details = await Promise.all(directory.clients.map((client) => store.getClientDetail(client.id)));
  return {
    directory,
    details: details.filter(Boolean),
    pocs: details.flatMap((detail) => detail?.pocs || []),
    services: details.flatMap((detail) => detail?.services || [])
  };
}

function validateWorkbook(snapshot, raw) {
  const data = {
    clients: Array.isArray(raw.clients) ? raw.clients.map((item) => ({ ...item })) : [],
    projects: Array.isArray(raw.projects) ? raw.projects.map((item) => ({ ...item })) : [],
    clientPocs: Array.isArray(raw.clientPocs) ? raw.clientPocs.map((item) => ({ ...item })) : [],
    services: Array.isArray(raw.services) ? raw.services.map((item) => ({ ...item })) : [],
    internalPocs: Array.isArray(raw.internalPocs) ? raw.internalPocs.map((item) => ({ ...item })) : []
  };
  const errors = [];
  for (const [name, rows] of Object.entries(data)) {
    if (rows.length > 250) errors.push(`${name}: a workbook can contain at most 250 rows per sheet`);
  }
  if (Object.values(data).every((rows) => rows.length === 0)) errors.push("The workbook has no data rows");

  const directory = snapshot.directory;
  const existingClientByKey = mapBy(directory.clients, (item) => lower(item.key));
  const existingProjectByKey = mapBy(directory.projects, (item) => lower(item.key));
  const existingInternalByEmail = mapBy(directory.internalPocs.filter((item) => item.email), (item) => lower(item.email));
  const knownClientKeys = new Set(existingClientByKey.keys());
  const knownProjectKeys = new Set(existingProjectByKey.keys());
  const knownInternalEmails = new Set(existingInternalByEmail.keys());
  const levelByName = mapBy(directory.pocLevels, (item) => lower(item.name));
  const serviceCatalogByName = mapBy((directory.serviceCatalog || []).filter((item) => item.active !== false), (item) => lower(item.name));
  const seenClientKeys = new Set();
  const seenProjectKeys = new Set();
  const seenInternalEmails = new Set();
  const seenServiceKeys = new Set();

  for (const row of data.clients) {
    row.key = lower(row.key);
    row.name = String(row.name || "").trim();
    row.clusterName = String(row.clusterName || "").trim();
    row.activeStatus = lower(row.activeStatus);
    if (!row.key) rowError(errors, "Clients", row.row, "client_id is required");
    else if (!/^[a-z0-9-]+$/.test(row.key)) rowError(errors, "Clients", row.row, "client_id must use lowercase letters, numbers and hyphens");
    else if (seenClientKeys.has(row.key)) rowError(errors, "Clients", row.row, "client_id appears more than once");
    if (!row.name) rowError(errors, "Clients", row.row, "client_name is required");
    if (!row.clusterName) rowError(errors, "Clients", row.row, "cluster is required");
    if (!statusOkay(row.activeStatus)) rowError(errors, "Clients", row.row, "status must be active, paused or closed");
    seenClientKeys.add(row.key);
    knownClientKeys.add(row.key);
  }

  for (const row of data.projects) {
    row.clientKey = lower(row.clientKey);
    row.key = String(row.key || "").trim();
    row.name = String(row.name || "").trim();
    row.activeStatus = lower(row.activeStatus);
    row.feedbackIntervalDays = Number(row.feedbackIntervalDays);
    const normalizedKey = lower(row.key);
    if (!row.clientKey) rowError(errors, "Projects", row.row, "client_id is required");
    else if (!knownClientKeys.has(row.clientKey)) rowError(errors, "Projects", row.row, `client_id ${row.clientKey} is neither existing nor listed on Clients`);
    if (!row.key) rowError(errors, "Projects", row.row, "project_id is required");
    else if (!/^[A-Za-z0-9-]+$/.test(row.key)) {
      rowError(errors, "Projects", row.row, "project_id contains unsupported characters");
    }
    if (seenProjectKeys.has(normalizedKey)) rowError(errors, "Projects", row.row, "project_id appears more than once");
    if (!row.name) rowError(errors, "Projects", row.row, "project_name is required");
    if (!statusOkay(row.activeStatus)) rowError(errors, "Projects", row.row, "status must be active, paused or closed");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.startDate || "")) rowError(errors, "Projects", row.row, "start_date is required in YYYY-MM-DD format");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.endDate || "")) rowError(errors, "Projects", row.row, "end_date is required in YYYY-MM-DD format");
    if (row.startDate && row.endDate && row.endDate < row.startDate) rowError(errors, "Projects", row.row, "end_date cannot be before start_date");
    if (!Number.isInteger(row.feedbackIntervalDays) || row.feedbackIntervalDays < 1 || row.feedbackIntervalDays > 365) {
      rowError(errors, "Projects", row.row, "feedback_interval_days must be a whole number from 1 to 365");
    }
    seenProjectKeys.add(normalizedKey);
    knownProjectKeys.add(normalizedKey);
  }

  for (const row of data.internalPocs) {
    row.name = String(row.name || "").trim();
    row.email = lower(row.email);
    row.phone = digits(row.phone);
    row.clusterName = String(row.clusterName || "").trim();
    row.departmentName = String(row.departmentName || "").trim();
    row.subDepartmentName = String(row.subDepartmentName || "").trim();
    row.reportingManagerEmail = lower(row.reportingManagerEmail);
    row.activeValue = booleanValue(row.active);
    if (!row.name) rowError(errors, "Internal POCs", row.row, "name is required");
    if (!row.email) rowError(errors, "Internal POCs", row.row, "email is required");
    else if (!validEmail(row.email)) rowError(errors, "Internal POCs", row.row, "email is not valid");
    else if (seenInternalEmails.has(row.email)) rowError(errors, "Internal POCs", row.row, "email appears more than once");
    if (row.phone && (row.phone.length < 10 || row.phone.length > 15)) rowError(errors, "Internal POCs", row.row, "phone must be 10-15 digits including country code");
    if (!row.clusterName) rowError(errors, "Internal POCs", row.row, "cluster is required");
    if (!row.departmentName) rowError(errors, "Internal POCs", row.row, "department is required");
    if (row.reportingManagerEmail && !validEmail(row.reportingManagerEmail)) rowError(errors, "Internal POCs", row.row, "reporting_manager_email is not valid");
    if (row.activeValue === null) rowError(errors, "Internal POCs", row.row, "active must be yes or no");
    seenInternalEmails.add(row.email);
    knownInternalEmails.add(row.email);
  }
  for (const row of data.internalPocs) {
    if (row.reportingManagerEmail && !knownInternalEmails.has(row.reportingManagerEmail)) {
      rowError(errors, "Internal POCs", row.row, `reporting manager ${row.reportingManagerEmail} is neither existing nor listed in this workbook`);
    }
  }
  const managerCycles = findManagerCycles(directory, data.internalPocs);
  for (const row of data.internalPocs) {
    if (managerCycles.has(row.email)) rowError(errors, "Internal POCs", row.row, "reporting line creates a management loop");
  }

  const seenProjectPhones = new Set();

  for (const row of data.clientPocs) {
    row.projectKey = String(row.projectKey || "").trim();
    row.name = String(row.name || "").trim();
    row.contactWhatsapp = digits(row.contactWhatsapp);
    row.contactEmail = lower(row.contactEmail);
    row.birthDate = String(row.birthDate || "").trim();
    row.levelName = String(row.levelName || "").trim();
    row.level = levelByName.get(lower(row.levelName));
    row.activeValue = booleanValue(row.active);
    row.weightPercentage = Number(row.weightPercentage);
    if (!row.projectKey) rowError(errors, "Client POCs", row.row, "project_id is required");
    else if (!knownProjectKeys.has(lower(row.projectKey))) rowError(errors, "Client POCs", row.row, `project_id ${row.projectKey} is neither existing nor listed on Projects`);
    if (!row.name) rowError(errors, "Client POCs", row.row, "poc_name is required");
    if (!row.contactWhatsapp) rowError(errors, "Client POCs", row.row, "whatsapp_number is required because it is the update key");
    else if (row.contactWhatsapp.length < 10 || row.contactWhatsapp.length > 15) rowError(errors, "Client POCs", row.row, "WhatsApp number must be 10-15 digits including country code");
    const projectPhoneKey = `${lower(row.projectKey)}|${row.contactWhatsapp}`;
    if (row.contactWhatsapp && seenProjectPhones.has(projectPhoneKey)) {
      rowError(errors, "Client POCs", row.row, "WhatsApp number appears more than once on this project");
    }
    if (row.contactEmail && !validEmail(row.contactEmail)) rowError(errors, "Client POCs", row.row, "email is not valid");
    if (row.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(row.birthDate)) {
      rowError(errors, "Client POCs", row.row, "birth_date must be an Excel date or YYYY-MM-DD");
    }
    if (!row.level) rowError(errors, "Client POCs", row.row, "poc_level must match a configured tag such as Normal or Important");
    if (row.activeValue === null) rowError(errors, "Client POCs", row.row, "active must be yes or no");
    if (row.activeValue === true && (!Number.isFinite(row.weightPercentage) || row.weightPercentage <= 0 || row.weightPercentage > 100)) {
      rowError(errors, "Client POCs", row.row, "weight_percent must be more than 0 and no more than 100 for an active POC");
    }
    if (row.activeValue === false && (!Number.isFinite(row.weightPercentage) || row.weightPercentage < 0 || row.weightPercentage > 100)) {
      rowError(errors, "Client POCs", row.row, "weight_percent must be from 0 to 100");
    }
    seenProjectPhones.add(projectPhoneKey);
  }

  for (const row of data.services) {
    row.projectKey = String(row.projectKey || "").trim();
    row.name = String(row.name || "").trim();
    const catalogItem = serviceCatalogByName.get(lower(row.name));
    row.serviceCatalogId = catalogItem?.id || null;
    row.name = catalogItem?.name || row.name;
    row.serviceKey = catalogItem?.serviceKey || lower(row.serviceKey) || serviceIdentifier(row.name);
    row.internalOwnerEmail = lower(row.internalOwnerEmail);
    row.kpis = String(row.kpis || "").trim();
    const combined = `${lower(row.projectKey)}|${row.serviceKey}`;
    if (!row.projectKey) rowError(errors, "Services", row.row, "project_id is required");
    else if (!knownProjectKeys.has(lower(row.projectKey))) rowError(errors, "Services", row.row, `project_id ${row.projectKey} is neither existing nor listed on Projects`);
    if (!row.name) rowError(errors, "Services", row.row, "service_name is required");
    else if (!catalogItem) rowError(errors, "Services", row.row, `${row.name} is not an active Standard Service`);
    if (!row.serviceKey || !/^[a-z0-9_]+$/.test(row.serviceKey)) rowError(errors, "Services", row.row, "service_key must use lowercase letters, numbers and underscores");
    if (seenServiceKeys.has(combined)) rowError(errors, "Services", row.row, "service_key appears more than once for this project");
    if (!row.internalOwnerEmail) rowError(errors, "Services", row.row, "internal_owner_email is required");
    else if (!knownInternalEmails.has(row.internalOwnerEmail)) rowError(errors, "Services", row.row, `owner ${row.internalOwnerEmail} is neither existing nor listed on Internal POCs`);
    seenServiceKeys.add(combined);
  }

  // Compute the final POC placement/active status after all WhatsApp upserts.
  const projectKeyById = new Map(directory.projects.map((item) => [item.id, lower(item.key)]));
  const finalPocsByProjectPhone = new Map();
  for (const poc of snapshot.pocs) {
    const phone = digits(poc.contactWhatsapp);
    if (!phone) continue;
    finalPocsByProjectPhone.set(`${projectKeyById.get(poc.projectId)}|${phone}`, {
      projectKey: projectKeyById.get(poc.projectId), active: Boolean(poc.active), phone,
      weightPercentage: Number(poc.weightPercentage) || 0
    });
  }
  for (const row of data.clientPocs) {
    if (!row.contactWhatsapp) continue;
    finalPocsByProjectPhone.set(`${lower(row.projectKey)}|${row.contactWhatsapp}`, {
      projectKey: lower(row.projectKey), active: row.activeValue, phone: row.contactWhatsapp,
      weightPercentage: row.activeValue ? row.weightPercentage : 0
    });
  }
  const serviceKeysByProject = new Map();
  for (const service of snapshot.services) {
    const projectKey = projectKeyById.get(service.projectId);
    if (!projectKey) continue;
    if (!serviceKeysByProject.has(projectKey)) serviceKeysByProject.set(projectKey, new Set());
    serviceKeysByProject.get(projectKey).add(service.serviceKey);
  }
  for (const row of data.services) {
    const projectKey = lower(row.projectKey);
    if (!serviceKeysByProject.has(projectKey)) serviceKeysByProject.set(projectKey, new Set());
    serviceKeysByProject.get(projectKey).add(row.serviceKey);
  }
  const statusByProject = new Map(directory.projects.map((item) => [lower(item.key), item.activeStatus]));
  for (const row of data.projects) statusByProject.set(lower(row.key), row.activeStatus);
  const touchedProjects = new Set([
    ...data.projects.map((row) => lower(row.key)),
    ...data.clientPocs.map((row) => lower(row.projectKey)),
    ...data.services.map((row) => lower(row.projectKey))
  ].filter(Boolean));
  for (const projectKey of touchedProjects) {
    if (statusByProject.get(projectKey) !== "active") continue;
    if (!(serviceKeysByProject.get(projectKey)?.size)) {
      errors.push(`Project ${projectKey}: an active project must have at least one service after import`);
    }
    // An inactive contact is valid master data. Scheduling simply skips the
    // project until an active, reachable POC is available.
    const activePocs = [...finalPocsByProjectPhone.values()]
      .filter((poc) => poc.projectKey === projectKey && poc.active);
    const activeWeightTotal = activePocs
      .reduce((sum, poc) => sum + (Number(poc.weightPercentage) || 0), 0);
    if (activePocs.length && Math.abs(activeWeightTotal - 100) > 0.01) {
      errors.push(`Project ${projectKey}: active client POC weight_percent values must total exactly 100% after import (current total ${Math.round(activeWeightTotal * 100) / 100}%)`);
    }
  }

  return { data, errors, snapshot };
}

async function createLookups(store, snapshot, data) {
  const directory = snapshot.directory;
  const clusters = mapBy(directory.clusters, (item) => lower(item.name));
  const departments = mapBy(directory.departments, (item) => lower(item.name));
  const subDepartments = mapBy(directory.subDepartments, (item) => {
    const department = directory.departments.find((candidate) => candidate.id === item.departmentId);
    return `${lower(department?.name)}|${lower(item.name)}`;
  });

  const clusterNames = [...new Set([
    ...data.clients.map((row) => row.clusterName),
    ...data.internalPocs.map((row) => row.clusterName)
  ].filter(Boolean))];
  for (const name of clusterNames) {
    if (!clusters.has(lower(name))) clusters.set(lower(name), await store.createCluster({ name }));
  }
  for (const row of data.internalPocs) {
    const departmentKey = lower(row.departmentName);
    if (!departments.has(departmentKey)) {
      departments.set(departmentKey, await store.createDepartment({ name: row.departmentName }));
    }
    if (row.subDepartmentName) {
      const subKey = `${departmentKey}|${lower(row.subDepartmentName)}`;
      if (!subDepartments.has(subKey)) {
        subDepartments.set(subKey, await store.createSubDepartment({
          name: row.subDepartmentName,
          departmentId: departments.get(departmentKey).id
        }));
      }
    }
  }
  return { clusters, departments, subDepartments };
}

function emptyCounts() {
  return {
    clients: { created: 0, updated: 0 },
    projects: { created: 0, updated: 0 },
    clientPocs: { created: 0, updated: 0 },
    services: { created: 0, updated: 0 },
    internalPocs: { created: 0, updated: 0 },
    schedulesInitialized: 0
  };
}

async function applyWorkbook(store, validated) {
  const { data, snapshot } = validated;
  const counts = emptyCounts();
  const lookups = await createLookups(store, snapshot, data);
  const internalByEmail = mapBy(snapshot.directory.internalPocs.filter((item) => item.email), (item) => lower(item.email));

  // Owners first, without reporting managers. A second pass can then link two
  // people who were both created by this workbook.
  for (const row of data.internalPocs) {
    const department = lookups.departments.get(lower(row.departmentName));
    const subDepartment = row.subDepartmentName
      ? lookups.subDepartments.get(`${lower(row.departmentName)}|${lower(row.subDepartmentName)}`)
      : null;
    const payload = {
      name: row.name,
      email: row.email,
      phone: row.phone,
      clusterId: lookups.clusters.get(lower(row.clusterName)).id,
      departmentId: department.id,
      subDepartmentId: subDepartment?.id || null,
      active: row.activeValue
    };
    const existing = internalByEmail.get(row.email);
    const saved = existing
      ? await store.updateInternalPoc(existing.id, payload)
      : await store.createInternalPoc(payload);
    counts.internalPocs[existing ? "updated" : "created"] += 1;
    internalByEmail.set(row.email, saved);
  }
  for (const row of data.internalPocs) {
    const person = internalByEmail.get(row.email);
    const manager = row.reportingManagerEmail ? internalByEmail.get(row.reportingManagerEmail) : null;
    const saved = await store.updateInternalPoc(person.id, { reportingManagerId: manager?.id || null });
    internalByEmail.set(row.email, saved);
  }

  const clientByKey = mapBy(snapshot.directory.clients, (item) => lower(item.key));
  for (const row of data.clients) {
    const payload = {
      key: row.key,
      name: row.name,
      clusterId: lookups.clusters.get(lower(row.clusterName)).id,
      activeStatus: row.activeStatus
    };
    const existing = clientByKey.get(row.key);
    const saved = existing
      ? await store.updateClient(existing.id, payload)
      : await store.createClient(payload);
    counts.clients[existing ? "updated" : "created"] += 1;
    clientByKey.set(row.key, saved);
  }

  const projectByKey = mapBy(snapshot.directory.projects, (item) => lower(item.key));
  for (const row of data.projects) {
    const payload = {
      clientId: clientByKey.get(row.clientKey).id,
      key: row.key,
      name: row.name,
      activeStatus: row.activeStatus,
      startDate: row.startDate,
      endDate: row.endDate,
      feedbackIntervalDays: row.feedbackIntervalDays
    };
    const existing = projectByKey.get(lower(row.key));
    const saved = existing
      ? await store.updateProject(existing.id, payload)
      : await store.createProject(payload);
    counts.projects[existing ? "updated" : "created"] += 1;
    projectByKey.set(lower(row.key), saved);
    if (typeof store.ensureProjectSchedule === "function" && await store.ensureProjectSchedule(saved.id)) {
      counts.schedulesInitialized += 1;
    }
  }

  const pocByProjectAndPhone = mapBy(
    snapshot.pocs.filter((item) => digits(item.contactWhatsapp)),
    (item) => `${item.projectId}|${digits(item.contactWhatsapp)}`
  );
  for (const row of data.clientPocs) {
    const payload = {
      projectId: projectByKey.get(lower(row.projectKey)).id,
      name: row.name,
      designation: row.designation,
      contactWhatsapp: row.contactWhatsapp,
      contactEmail: row.contactEmail,
      birthDate: row.birthDate,
      salutation: row.salutation || row.name,
      honorific: row.honorific,
      levelId: row.level.id,
      weightPercentage: row.activeValue ? row.weightPercentage : 0,
      active: row.activeValue
    };
    const pocMapKey = `${payload.projectId}|${row.contactWhatsapp}`;
    const existing = pocByProjectAndPhone.get(pocMapKey);
    const saved = existing
      ? await store.updateClientPoc(existing.id, payload)
      : await store.createClientPoc(payload);
    counts.clientPocs[existing ? "updated" : "created"] += 1;
    pocByProjectAndPhone.set(pocMapKey, saved);
  }

  const serviceByProjectAndKey = new Map(snapshot.services.map((item) => [
    `${item.projectId}|${item.serviceKey}`, item
  ]));
  for (const row of data.services) {
    const project = projectByKey.get(lower(row.projectKey));
    const mapKey = `${project.id}|${row.serviceKey}`;
    const payload = {
      projectId: project.id,
      serviceKey: row.serviceKey,
      name: row.name,
      kpis: row.kpis,
      internalPocId: internalByEmail.get(row.internalOwnerEmail).id,
      serviceCatalogId: row.serviceCatalogId
    };
    const existing = serviceByProjectAndKey.get(mapKey);
    const saved = existing
      ? await store.updateProjectService(existing.id, payload)
      : await store.createProjectService(payload);
    counts.services[existing ? "updated" : "created"] += 1;
    serviceByProjectAndKey.set(mapKey, saved);
  }
  return counts;
}

async function importAdminWorkbook(store, raw) {
  const snapshot = await loadSnapshot(store);
  const validated = validateWorkbook(snapshot, raw || {});
  if (validated.errors.length) return { ok: false, errors: validated.errors };
  const counts = await applyWorkbook(store, validated);
  return { ok: true, counts };
}

module.exports = {
  importAdminWorkbook,
  validateWorkbook,
  serviceIdentifier,
  booleanValue
};
