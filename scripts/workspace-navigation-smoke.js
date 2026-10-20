// Exercise the real component effects with controlled browser events and
// deferred reads. No server, credentials or production data are involved.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  if (!tree || typeof tree !== "object" || !tree.props) return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...elements(tree.props.children, predicate),
    ...elements(tree.props.action, predicate)
  ];
}

class ComponentHarness {
  constructor(file, props, url, read, componentName = null, config = {}) {
    this.props = props;
    this.slots = [];
    this.dirty = true;
    this.calls = [];
    this.pushes = [];
    this.scrolls = [];
    this.timers = new Map();
    const listeners = new Map();
    const listen = (name, callback) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    };
    this.dispatch = (name, event = {}) => { for (const fn of listeners.get(name) || []) fn(event); };
    this.setUrl = (value) => {
      const parsed = new URL(value, "https://test.invalid");
      this.window.location = { pathname: parsed.pathname, search: parsed.search };
    };
    this.window = {
      innerWidth: 1200,
      innerHeight: 800,
      scrollY: 350,
      scrollTo: (options) => this.scrolls.push(options.top),
      requestAnimationFrame: (fn) => { const key = Symbol(); this.timers.set(key, fn); return key; },
      cancelAnimationFrame: (key) => this.timers.delete(key),
      history: { pushState: (_state, _title, value) => { this.pushes.push(value); this.setUrl(value); } },
      addEventListener: listen,
      removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
      dispatchEvent: (event) => this.dispatch(event.type),
      setTimeout: (fn) => { const key = Symbol(); this.timers.set(key, fn); return key; },
      clearTimeout: (key) => this.timers.delete(key)
    };
    this.setUrl(url);
    const memo = (factory, deps) => {
      const index = this.cursor++;
      const previous = this.slots[index];
      const changed = !previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]));
      if (changed) this.slots[index] = { value: factory(), deps };
      return this.slots[index].value;
    };
    const react = {
      Children: { toArray: (nodes) => [nodes].flat(Infinity).filter((node) => node !== null && node !== undefined && node !== false) },
      Component: class {},
      useState: (initial) => {
        const index = this.cursor++;
        if (!this.slots[index]) this.slots[index] = { value: typeof initial === "function" ? initial() : initial };
        return [this.slots[index].value, (update) => {
          const previous = this.slots[index].value;
          const next = typeof update === "function" ? update(previous) : update;
          if (!Object.is(previous, next)) { this.slots[index].value = next; this.dirty = true; }
        }];
      },
      useRef: (value) => memo(() => ({ current: value }), []),
      useMemo: memo,
      useEffect: (effect, deps) => {
        const index = this.cursor++;
        const previous = this.slots[index];
        if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
          this.slots[index] = { deps, cleanup: previous?.cleanup };
          this.effects.push(() => {
            this.slots[index].cleanup?.();
            this.slots[index].cleanup = effect();
          });
        }
      }
    };
    const jsx = (type, nodeProps) => ({ type, props: nodeProps || {} });
    const api = { apiGet: (value) => { this.calls.push(value); return read(value); }, apiAdminGet: (value) => read(value), hasAdminPin: () => true, apiWrite: config.write || (async () => ({})), apiPut: config.write || (async () => ({})), apiPost: config.write || (async () => ({})) };
    const mocks = new Proxy({
      __esModule: true,
      cycleInRange: () => true,
      hasPermission: () => true,
      canOpenManage: () => true
    }, {
      get: (target, name) => name in target ? target[name]
        : /^[A-Z]/.test(String(name)) ? name
          : (value) => value == null ? "--" : String(value)
    });
    const compiled = transformSync(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
      loader: "jsx", format: "cjs", jsx: "automatic", sourcefile: file
    }).code;
    const module = { exports: {} };
    const document = this.document = {
      body: {},
      hidden: false,
      addEventListener: listen,
      removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
      getElementById: (id) => this.find((node) => node.props.id === id)
        ? { scrollIntoView: () => this.scrolls.push(id), querySelector: () => ({ scrollIntoView: () => this.scrolls.push(id) }) } : null
    };
    const testEntry = componentName ? `\nmodule.exports.testComponent = ${componentName};` : "";
    vm.runInNewContext(compiled + testEntry, {
      module, exports: module.exports, window: this.window, document,
      URLSearchParams, console,
      sessionStorage: config.storage || { getItem: () => null, setItem: () => {} },
      PopStateEvent: class { constructor(type) { this.type = type; } },
      require: (name) => name === "react" ? react
        : name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "Fragment" }
          : name === "react-dom" ? { createPortal: (node) => node }
          : name.includes("performance-metrics") ? (() => { const m = { exports: {} }; vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, "../src/lib/performance-metrics.js"), "utf8"), { format: "cjs" }).code, { module: m, exports: m.exports }); return m.exports; })()
          : config.modules?.[name] || (/(?:^|\/)api$/.test(name) ? api
            : name.includes("permissions") || name.includes("format") || name.includes("Filters")
              || name.includes("Ui") || name === "lucide-react" ? mocks
              : { __esModule: true, default: path.basename(name, ".jsx") })
    }, { filename: file });
    this.Component = module.exports.testComponent || module.exports.default;
  }

  flush() {
    let passes = 0;
    while (this.dirty) {
      assert.ok(++passes < 50, "component effects must converge");
      this.dirty = false;
      this.cursor = 0;
      this.effects = [];
      this.tree = this.Component(this.props);
      for (const node of elements(this.tree, (item) => item.props.ref)) {
        const ref = node.props.ref;
        if (!ref.current) ref.current = {
          scrollTop: 0, scrollHeight: 100,
          contains: () => false,
          getBoundingClientRect: () => ({ top: 100, bottom: 140, left: 30, width: 300 }),
          scrollIntoView: () => this.scrolls.push(node.props.id || node.type)
        };
      }
      for (const effect of this.effects) effect();
    }
  }

  async settle() {
    for (let round = 0; round < 5; round += 1) {
      this.flush();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const timers = [...this.timers.values()];
    this.timers.clear();
    timers.forEach((run) => run());
    this.flush();
  }

  navigate(url) {
    this.setUrl(url);
    this.props = { ...this.props, locationTick: (this.props.locationTick || 0) + 1 };
    this.dirty = true;
  }

  find(predicate) { return elements(this.tree, predicate)[0]; }
  selector(label) { return this.find((node) => ["select", "SearchableSelect"].includes(node.type) && node.props["aria-label"] === label); }
  loading(label) { return Boolean(this.find((node) => node.type === "LoadingBlock" && node.props.label === label)); }
}

const project = { id: "p1", key: "alpha", name: "Alpha Project", clientName: "Client A", clusterName: "East", services: [], feedbackIntervalDays: 30 };
const otherProject = { ...project, id: "p2", key: "beta", name: "Beta Project", clientName: "Client B", clusterName: "West" };
const dashboard = { projects: [project, otherProject], messaging: { enabled: true } };
const message = (id) => ({ id, body: id, side: "client", speaker: "Client", createdAt: "2026-10-18T10:00:00Z" });
function workspace(selectedProject = project) {
  const sessions = ["new", "old"].map((name) => ({
    id: `${selectedProject.key}-${name}`, cycleId: `${selectedProject.key}-${name}-cycle`,
    projectId: selectedProject.id, clientPocId: name, pocName: name,
    status: "completed", conversationState: { state: "completed" }
  }));
  return {
    project: selectedProject, services: [], issues: [], observations: [], sessions,
    pocs: sessions.map((session) => ({ id: session.clientPocId, name: session.pocName })),
    cycles: sessions.map((session, i) => ({
      id: session.cycleId, cycleType: i ? "project_end" : "pulse", status: "closed",
      startedAt: "2026-10-18T10:00:00Z", sessions: [session]
    })),
    latestSession: sessions[0], messages: [message(sessions[0].id)]
  };
}
function component(url, read, data = dashboard) {
  return new ComponentHarness("src/components/ProjectWorkspace.jsx", {
    dashboard: data, locationTick: 0, currentUser: { role: "super_admin" }, onReload: () => {}
  }, url, read);
}
function selectedSession(harness) { return harness.selector("Client POC")?.props.value; }

async function main() {
  let passed = 0;
  async function scenario(name, run) {
    await run();
    passed += 1;
    console.log(`PASS  ${name}`);
  }

  await scenario("newest reply uses the workspace transcript and scrolls to its conversation", async () => {
    const h = component("/project?project=alpha&cycle=alpha-new-cycle&session=alpha-new&section=tracker", async () => workspace());
    await h.settle();
    assert.equal(selectedSession(h), "alpha-new");
    assert.equal(h.calls.filter((call) => call.startsWith("/api/sessions/")).length, 0);
    assert.ok(h.scrolls.includes("project-conversation"));
  });

  await scenario("project displays while an older conversation is still loading", async () => {
    const pending = deferred();
    const h = component("/project?project=alpha&session=alpha-old&section=tracker", (url) =>
      url.includes("/workspace") ? Promise.resolve(workspace()) : pending.promise);
    await h.settle();
    assert.equal(h.loading("Loading project workspace"), false);
    assert.equal(h.loading("Loading conversation"), true);
    assert.equal(selectedSession(h), "alpha-old");
    pending.resolve({ messages: [message("older reply")] });
    await h.settle();
    assert.equal(h.loading("Loading conversation"), false);
  });

  await scenario("another activity in the same project switches cycle and POC without refetching the workspace", async () => {
    const h = component("/project?project=alpha", async (url) =>
      url.includes("/workspace") ? workspace() : { messages: [message("old reply")] });
    await h.settle();
    h.navigate("/project?project=alpha&cycle=alpha-old-cycle&session=alpha-old&section=tracker");
    await h.settle();
    assert.equal(selectedSession(h), "alpha-old");
    assert.equal(h.selector("Feedback cycle").props.value, "alpha-old-cycle");
    assert.equal(h.calls.filter((call) => call.includes("/workspace")).length, 1);
  });

  await scenario("switching clients cannot redirect back through the previous client filters", async () => {
    const h = component("/project?project=alpha", async (url) => workspace(url.includes("beta") ? otherProject : project));
    await h.settle();
    h.navigate("/project?project=beta&session=beta-new&section=tracker");
    await h.settle();
    assert.equal(h.window.location.search.includes("project=beta"), true);
    assert.equal(h.pushes.length, 0);
    assert.equal(selectedSession(h), "beta-new");
    assert.equal(h.find((node) => node.type === "SingleSelect" && node.props.label === "Client").props.value, "Client B");
  });

  await scenario("a delayed older transcript cannot overwrite a more recent activity selection", async () => {
    const older = deferred();
    const newer = deferred();
    const h = component("/project?project=alpha", (url) => url.includes("/workspace") ? Promise.resolve(workspace())
      : url.endsWith("alpha-old") ? older.promise : newer.promise);
    await h.settle();
    h.navigate("/project?project=alpha&session=alpha-old");
    await h.settle();
    h.navigate("/project?project=alpha&session=alpha-new");
    await h.settle();
    newer.resolve({ messages: [message("newest selected reply")] });
    await h.settle();
    older.resolve({ messages: [message("stale reply")] });
    await h.settle();
    assert.equal(selectedSession(h), "alpha-new");
    assert.ok(h.find((node) => node.type === "p" && node.props.children === "newest selected reply"));
    assert.equal(Boolean(h.find((node) => node.type === "p" && node.props.children === "stale reply")), false);
  });

  await scenario("an activity link clears filters that would hide its cycle", async () => {
    const h = component("/project?project=alpha", async (url) => url.includes("/workspace") ? workspace() : { messages: [] });
    await h.settle();
    h.find((node) => node.type === "MultiSelect" && node.props.label === "Cycle type").props.onChange(["pulse"]);
    await h.settle();
    h.navigate("/project?project=alpha&session=alpha-old");
    await h.settle();
    assert.equal(selectedSession(h), "alpha-old");
    assert.equal(h.find((node) => node.type === "MultiSelect" && node.props.label === "Cycle type").props.selected.length, 0);
  });

  await scenario("a direct workspace link displays before the dashboard aggregate is available", async () => {
    const h = component("/project?project=alpha", async () => workspace(), null);
    await h.settle();
    assert.equal(h.loading("Loading project workspace"), false);
    assert.equal(selectedSession(h), "alpha-new");
  });

  await scenario("conversation failure keeps the project visible and offers a retry", async () => {
    const h = component("/project?project=alpha&session=alpha-old", (url) => url.includes("/workspace")
      ? Promise.resolve(workspace()) : Promise.reject(new Error("Conversation temporarily unavailable")));
    await h.settle();
    assert.equal(h.loading("Loading project workspace"), false);
    assert.ok(h.find((node) => node.type === "strong" && node.props.children === "Could not load this conversation"));
  });

  await scenario("workspace navigation does not refresh the dashboard; returning to Dashboard refreshes once", async () => {
    const refresh = deferred();
    let reads = 0;
    const h = new ComponentHarness("src/App.jsx", { currentUser: { role: "super_admin" } }, "/dashboard", () => {
      reads += 1;
      return reads === 1 ? Promise.resolve(dashboard) : refresh.promise;
    });
    await h.settle();
    const rail = h.find((node) => typeof node.type === "function" && node.type.name === "AttentionRail");
    rail.props.onOpenProject("alpha", { cycleId: "alpha-old-cycle", sessionId: "alpha-old", section: "tracker" });
    await h.settle();
    assert.equal(reads, 1);
    assert.ok(h.window.location.search.includes("session=alpha-old"));
    h.find((node) => node.type === "button" && node.props.children === "Dashboard").props.onClick();
    await h.settle();
    h.dispatch("visibilitychange");
    await h.settle();
    assert.equal(reads, 2, "an in-flight dashboard refresh must not be duplicated");
    refresh.resolve(dashboard);
    await h.settle();
  });

  await scenario("Needs Attention summaries and collapsed icons open their correct Dashboard sections", async () => {
    for (const collapsed of [false, true]) {
      const opened = [];
      const h = new ComponentHarness("src/App.jsx", {
        collapsed, dashboard, onToggle: () => {}, onOpenProject: () => {},
        onOpenDashboard: (section) => opened.push(section)
      }, "/project?project=alpha", async () => dashboard, "AttentionRail");
      await h.settle();
      for (const [label, section] of [["Go to Open Issues", "dashboard-open-issues"], ["Go to Open Cycles", "dashboard-open-cycles"]]) {
        const button = h.find((node) => node.type === "button" && node.props["aria-label"] === label);
        assert.ok(button, label);
        button.props.onClick();
        assert.equal(opened.at(-1), section);
      }
    }
  });

  await scenario("a single high-risk project opens its own workspace, including from the collapsed rail", async () => {
    for (const collapsed of [false, true]) {
      const opened = [];
      const h = new ComponentHarness("src/App.jsx", {
        collapsed, dashboard: { projects: [{ ...otherProject, riskLevel: "High" }, project] },
        onToggle: () => {}, onOpenProject: (key) => opened.push(key), onOpenDashboard: () => {}
      }, "/dashboard", async () => dashboard, "AttentionRail");
      await h.settle();
      h.find((node) => node.type === "button" && node.props["aria-label"] === "View high-risk projects").props.onClick();
      assert.deepEqual(opened, ["beta"]);
    }
  });

  await scenario("multiple high-risk projects offer every project rather than choosing an arbitrary workspace", async () => {
    const opened = [];
    const riskyProjects = Array.from({ length: 8 }, (_, index) => ({ ...project, key: `risk-${index}`, name: `Risk ${index}`, riskLevel: "High" }));
    const h = new ComponentHarness("src/App.jsx", {
      collapsed: false, dashboard: { projects: [...riskyProjects, otherProject] }, onToggle: () => {},
      onOpenProject: (key) => opened.push(key), onOpenDashboard: () => {}
    }, "/dashboard", async () => dashboard, "AttentionRail");
    await h.settle();
    h.find((node) => node.type === "button" && node.props["aria-label"] === "View high-risk projects").props.onClick();
    await h.settle();
    assert.equal(opened.length, 0);
    assert.equal(h.find((node) => node.props["aria-label"] === "View high-risk projects").props["aria-expanded"], true);
    assert.equal(elements(h.tree, (node) => node.type === "button" && /^Open Risk /.test(node.props["aria-label"] || "")).length, 8);
    h.find((node) => node.props["aria-label"] === "Open Risk 7 workspace").props.onClick();
    assert.deepEqual(opened, ["risk-7"]);
  });

  await scenario("sidebar Dashboard links carry their section without a browser reload", async () => {
    const h = new ComponentHarness("src/App.jsx", { currentUser: { role: "super_admin" } }, "/project?project=alpha", async () => dashboard);
    await h.settle();
    const rail = h.find((node) => typeof node.type === "function" && node.type.name === "AttentionRail");
    rail.props.onOpenDashboard("dashboard-open-issues");
    await h.settle();
    assert.equal(h.window.location.pathname, "/dashboard");
    assert.equal(new URLSearchParams(h.window.location.search).get("section"), "dashboard-open-issues");
    const dashboardPage = h.find((node) => node.type === "Dashboard");
    assert.ok(dashboardPage.props.locationTick > 0);
  });

  await scenario("Dashboard section navigation clears stale filters, scrolls after loading, and works repeatedly on the same page", async () => {
    const h = new ComponentHarness("src/components/Dashboard.jsx", {
      dashboard: null, locationTick: 0, currentUser: { role: "super_admin" }, onReload: () => {}, onOpenProject: () => {}
    }, "/dashboard?section=dashboard-open-issues", async () => ({}));
    await h.settle();
    assert.equal(h.scrolls.length, 0);
    h.props = { ...h.props, dashboard };
    h.dirty = true;
    await h.settle();
    assert.deepEqual(h.scrolls, ["dashboard-open-issues"]);
    for (const [label, value] of [["Cluster", "East"], ["Client", "Client A"], ["Project", "Alpha Project"], ["Risk", "High"]]) {
      h.find((node) => node.type === "MultiSelect" && node.props.label === label).props.onChange([value]);
      await h.settle();
    }
    h.navigate("/dashboard?section=dashboard-open-cycles");
    await h.settle();
    for (const label of ["Cluster", "Client", "Project", "Risk", "Project Status"]) {
      assert.equal(h.find((node) => node.type === "MultiSelect" && node.props.label === label).props.selected.length, 0, label);
    }
    assert.equal(h.scrolls.at(-1), "dashboard-open-cycles");
    const previousScrolls = h.scrolls.length;
    h.props = { ...h.props, dashboard: { ...dashboard } };
    h.dirty = true;
    await h.settle();
    assert.equal(h.scrolls.length, previousScrolls, "background refresh must not scroll the reader again");
    h.navigate("/dashboard?section=dashboard-open-cycles");
    await h.settle();
    assert.equal(h.scrolls.length, previousScrolls + 1, "a repeated explicit click must still scroll");
  });

  console.log(`\n${passed}/${passed} workspace navigation scenarios passed`);
}

module.exports = { ComponentHarness, elements };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
