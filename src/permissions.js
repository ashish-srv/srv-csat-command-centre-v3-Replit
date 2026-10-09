export const APP_PERMISSION_LABELS = {
  dashboard: "Dashboard",
  project_workspace: "Project workspace",
  directory: "Directory",
  project_performance: "Project Performance",
  manage_records: "Clients, projects and project records",
  manage_pocs: "Client POCs and influence",
  manage_internal_pocs: "Internal POCs and reporting managers",
  manage_catalogues: "Standard services and reference catalogues",
  messaging_controls: "WhatsApp messaging controls",
  bulk_sends: "Bulk feedback sends",
  manage_project_users: "Project User management",
  add_projects: "Add projects from Project Performance",
  edit_project_performance: "Edit Project Performance",
  manage_project_services: "Add/remove catalogue services under a project"
};

export const ADMIN_PERMISSION_KEYS = Object.keys(APP_PERMISSION_LABELS);

export const PROJECT_USER_PERMISSION_KEYS = [
  "project_performance",
  "add_projects",
  "edit_project_performance"
];

export function defaultPermissions(role) {
  if (role === "super_admin") {
    return Object.fromEntries(ADMIN_PERMISSION_KEYS.map((key) => [key, true]));
  }
  if (role === "admin") {
    return Object.fromEntries(ADMIN_PERMISSION_KEYS.map((key) => [key, true]));
  }
  return Object.fromEntries(ADMIN_PERMISSION_KEYS.map((key) => [
    key,
    PROJECT_USER_PERMISSION_KEYS.includes(key)
  ]));
}

export function permissionsForRole(role) {
  return role === "project_user" ? PROJECT_USER_PERMISSION_KEYS : ADMIN_PERMISSION_KEYS;
}

export function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === "super_admin") return true;
  return user.permissions?.[permission] === true;
}

export function canOpenManage(user) {
  return [
    "manage_records",
    "manage_pocs",
    "manage_internal_pocs",
    "manage_catalogues",
    "bulk_sends",
    "manage_project_users"
  ].some((permission) => hasPermission(user, permission));
}
