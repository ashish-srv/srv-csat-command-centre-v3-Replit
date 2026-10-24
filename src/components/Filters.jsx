import { Children, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, Check, ChevronDown, Search, X } from "lucide-react";

function useOutsideClose(onClose, menuRef) {
  const ref = useRef(null);
  useEffect(() => {
    function handler(event) {
      if (ref.current && !ref.current.contains(event.target) && !menuRef?.current?.contains(event.target)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, menuRef]);
  return ref;
}

/**
 * Multi-select where "nothing selected" means "all". There is no fake
 * "All clusters" option in the list — an empty selection already says that.
 */
/**
 * `renderOption` lets a caller filter on the STORED value while showing a
 * friendlier label — the cycle type is stored as "pulse" but reads
 * "30-Day Feedback", and matching on the label would break the filter.
 */
export function MultiSelect({ label, options, selected, onChange, allLabel = "All", renderOption }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);

  function closeMenu() {
    setOpen(false);
    setQuery("");
  }

  const ref = useOutsideClose(closeMenu, menuRef);
  function positionMenu() {
    const rect = ref.current?.querySelector('button')?.getBoundingClientRect();
    if (!rect) return;
    const height = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 300), window.innerWidth - 24);
    const below = height - rect.bottom;
    const above = below < 320 && rect.top > below;
    setPosition({ position: 'fixed', top: above ? 'auto' : rect.bottom + 4,
      bottom: above ? height - rect.top + 4 : 'auto',
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width,
      maxHeight: Math.min(420, Math.max(100, (above ? rect.top : below) - 16)), zIndex: 10000 });
  }
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
    const reposition = event => {
      if (!event?.target?.nodeType || !menuRef.current?.contains(event.target)) positionMenu();
    };
    const escape = event => { if (event.key === 'Escape') closeMenu(); };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function toggle(value) {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  const show = (value) => (renderOption ? renderOption(value) : value);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = normalizedQuery
    ? options.filter((option) => String(show(option) || "").toLowerCase().includes(normalizedQuery))
    : options;
  const summary = !selected.length
    ? allLabel
    : selected.length === 1
      ? show(selected[0])
      : `${selected.length} selected`;

  return (
    <div className="filter-field" ref={ref}>
      <span className="filter-label">{label}</span>
      <button
        type="button"
        className={`filter-trigger ${selected.length ? "active" : ""}`}
        onClick={() => { positionMenu(); setOpen((value) => {
          if (value) setQuery("");
          return !value;
        }); }}
        aria-expanded={open}
        aria-label={label}
        aria-haspopup="listbox"
        onKeyDown={(event) => { if ((event.key === "Backspace" || event.key === "Delete") && selected.length) { event.preventDefault(); onChange(selected.slice(0, -1)); } if (event.key === "Escape") closeMenu(); }}
      >
        <span>{summary}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? createPortal((
        <div ref={menuRef} className="filter-menu filter-menu-portal" style={position}>
          <label className="filter-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${String(label || "options").toLowerCase()}`}
              aria-label={`Search ${label}`}
              onKeyDown={(event) => { if (event.key === "Escape") closeMenu(); if (event.key === "Backspace" && !query && selected.length) { event.preventDefault(); onChange(selected.slice(0, -1)); } }}
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
          </label>
          <div className="filter-option-list" role="listbox" aria-multiselectable="true" aria-label={label}>
            {visibleOptions.map((option) => (
              <button
                key={option}
                type="button"
                className={`filter-option ${selected.includes(option) ? "checked" : ""}`}
                onClick={() => toggle(option)}
                role="option"
                aria-selected={selected.includes(option)}
              >
                <i>{selected.includes(option) ? <Check size={12} aria-hidden="true" /> : null}</i>
                <span>{show(option)}</span>
              </button>
            ))}
            {!visibleOptions.length ? <span className="filter-empty">No matching options</span> : null}
          </div>
          <div className="filter-menu-actions">
            <button
              type="button"
              className="filter-clear"
              onClick={() => onChange([])}
              disabled={!selected.length}
            >
              Clear
            </button>
            <button type="button" className="filter-apply" onClick={closeMenu}>OK</button>
          </div>
        </div>
      ), document.body) : null}
    </div>
  );
}

export function SingleSelect({ label, options, value, onChange, placeholder = "Select", allowClear = true, compact = false, disabled = false, portal = true }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);

  function closeMenu() {
    setOpen(false);
    setQuery("");
  }

  const ref = useRef(null);
  function positionMenu() {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportHeight = window.innerHeight || 800;
    const viewportWidth = window.innerWidth || 1200;
    const width = Math.min(Math.max(rect.width, 280), viewportWidth - 24);
    const below = viewportHeight - rect.bottom;
    const openAbove = below < 220 && rect.top > below;
    // Both edges must be explicit: .filter-menu's normal top rule otherwise
    // places upward-opening portalled menus below the entire viewport.
    setPosition({ position: "fixed", top: openAbove ? "auto" : rect.bottom + 4, bottom: openAbove ? viewportHeight - rect.top + 4 : "auto", left: Math.max(12, Math.min(rect.left, viewportWidth - width - 12)), width, maxHeight: Math.min(400, Math.max(100, (openAbove ? rect.top : below) - 16)), zIndex: 10000 });
  }
  useEffect(() => {
    if (open && !disabled) searchRef.current?.focus?.({ preventScroll: true });
  }, [open, disabled]);
  useEffect(() => {
    function outside(event) {
      if (!ref.current?.contains(event.target) && !menuRef.current?.contains(event.target)) closeMenu();
    }
    const reposition = (event) => {
      // Resize targets Window, which is not a DOM Node accepted by contains().
      if (!event?.target?.nodeType || !menuRef.current?.contains(event.target)) positionMenu();
    };
    document.addEventListener("mousedown", outside);
    const onResize = portal ? reposition : closeMenu;
    window.addEventListener("resize", onResize);
    if (portal && open) window.addEventListener("scroll", reposition, true);
    return () => { document.removeEventListener("mousedown", outside); window.removeEventListener("resize", onResize); window.removeEventListener("scroll", reposition, true); };
  }, [portal, open]);
  const selectedOption = options.find((option) => String(option.value) === String(value));
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = normalizedQuery
    ? options.filter((option) => String(option.label || "").toLowerCase().includes(normalizedQuery))
    : options;

  function choose(nextValue) {
    if (disabled) return;
    onChange(nextValue);
    closeMenu();
  }

  const menu = open && !disabled ? (
        <div ref={menuRef} className={`filter-menu filter-menu-single ${portal ? "filter-menu-portal" : ""}`} style={portal ? position : undefined}>
          <label className="filter-search">
            <Search size={14} aria-hidden="true" />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${String(label || "options").toLowerCase()}`} aria-label={`Search ${label || "options"}`}
              onKeyDown={(event) => { if (event.key === "Escape") closeMenu(); if (event.key === "Backspace" && !query && allowClear) { event.preventDefault(); choose(""); } }} />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={12} /></button> : null}
          </label>
          <div className="filter-option-list" role="listbox" aria-label={label || "Options"}>
            {allowClear ? <button type="button" className={`filter-option single ${!value ? "checked" : ""}`} onClick={() => choose("")} role="option" aria-selected={!value}><i>{!value ? <Check size={12} /> : null}</i><span>{placeholder}</span></button> : null}
            {visibleOptions.map((option) => <button key={option.value} type="button" disabled={option.disabled} className={`filter-option single ${String(option.value) === String(value) ? "checked" : ""}`} onClick={() => choose(option.value)} role="option" aria-selected={String(option.value) === String(value)}><i>{String(option.value) === String(value) ? <Check size={12} /> : null}</i><span>{option.label}</span></button>)}
            {!visibleOptions.length ? <span className="filter-empty">No matching options</span> : null}
          </div>
          <div className="filter-menu-actions">{allowClear ? <button type="button" className="filter-clear" onClick={() => choose("")} disabled={!value}>Clear</button> : <span />}<button type="button" className="filter-apply" onClick={closeMenu}>OK</button></div>
        </div>
      ) : null;
  return (
    <div className={`filter-field ${compact ? "filter-field-compact" : ""}`} ref={ref}>
      <span className="filter-label">{label}</span>
      <button
        type="button"
        className={`filter-trigger ${value ? "active" : ""}`}
        disabled={disabled}
        onClick={() => {
          positionMenu();
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => { if ((event.key === "Backspace" || event.key === "Delete") && allowClear && !disabled) { event.preventDefault(); choose(""); } if (event.key === "Escape") closeMenu(); }}
        aria-expanded={open}
        aria-label={label}
      >
        <span>{selectedOption?.label || placeholder || "Select"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {portal ? (menu ? createPortal(menu, document.body) : null) : menu}
    </div>
  );
}

// Native-select-compatible adapter so existing form handlers retain their
// event.target.value contract while all record pickers gain search/clearing.
export function SearchableSelect({ children, value, onChange, disabled, name, "aria-label": ariaLabel, ...props }) {
  const flatten = (nodes, groupDisabled = false) => Children.toArray(nodes).flatMap((node) => {
    if (!node?.props) return [];
    if (node.type === "option") return [{ value: String(node.props.value ?? node.props.children ?? ""), label: Children.toArray(node.props.children).join(""), disabled: groupDisabled || node.props.disabled }];
    return flatten(node.props.children, groupDisabled || node.props.disabled);
  });
  const allOptions = flatten(children);
  const empty = allOptions.find((option) => option.value === "");
  return <div className={`searchable-select ${props.className || ""}`} id={props.id}>
    <SingleSelect label={ariaLabel || name || ""} compact portal options={allOptions.filter((option) => option.value !== "")} value={value ?? ""} disabled={disabled} placeholder={empty?.label || "Select"} allowClear={Boolean(empty)} onChange={(next) => onChange?.({ target: { value: next, name }, currentTarget: { value: next, name } })} />
  </div>;
}

/**
 * Date range on cycle start date. `basis` is still honoured by cycleInRange if
 * a caller sets it to "completed", but there is no picker cluttering the bar.
 */
export function DateRange({ range, onChange }) {
  const active = range.from || range.to;
  const [inputRevision, setInputRevision] = useState(0);
  const [inputTouched, setInputTouched] = useState(false);

  function resetDates() {
    onChange({ from: "", to: "", basis: range.basis });
    // Chromium date controls can retain partially typed dd/mm/yyyy segments
    // even while their DOM value is empty. Remounting both inputs is the only
    // reliable way to clear that visible draft.
    setInputRevision((value) => value + 1);
    setInputTouched(false);
  }

  return (
    <div className="filter-field date-range">
      <span className="filter-label">
        <Calendar size={12} aria-hidden="true" /> Date range
      </span>
      <div className={`date-range-inputs ${active ? "active" : ""}`}>
        <input
          key={`from-${inputRevision}`}
          type="date"
          value={range.from || ""}
          max={range.to || undefined}
          onInput={() => setInputTouched(true)}
          onChange={(event) => onChange({ ...range, from: event.target.value })}
          aria-label="From date"
        />
        <span className="date-dash">to</span>
        <input
          key={`to-${inputRevision}`}
          type="date"
          value={range.to || ""}
          min={range.from || undefined}
          onInput={() => setInputTouched(true)}
          onChange={(event) => onChange({ ...range, to: event.target.value })}
          aria-label="To date"
        />
        {active || inputTouched ? (
          <button
            type="button"
            className="date-clear"
            onClick={resetDates}
            aria-label="Reset date range"
            title="Reset date range"
          >
            <X size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function FilterBar({ children, onReset, showReset }) {
  return (
    <div className="filter-bar">
      {children}
      {showReset ? (
        <button type="button" className="filter-reset" onClick={onReset}>Reset filters</button>
      ) : null}
    </div>
  );
}

/** Does a cycle fall inside the selected range, on the selected basis? */
export function cycleInRange(cycle, range) {
  if (!range.from && !range.to) return true;
  const stamp = range.basis === "completed" ? cycle.closedAt || cycle.completedAt : cycle.startedAt;
  if (!stamp) return false;
  const value = String(stamp).slice(0, 10);
  if (range.from && value < range.from) return false;
  if (range.to && value > range.to) return false;
  return true;
}
