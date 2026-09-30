import { useEffect, useRef, useState } from "react";
import { Calendar, Check, ChevronDown, Search, X } from "lucide-react";

function useOutsideClose(onClose) {
  const ref = useRef(null);
  useEffect(() => {
    function handler(event) {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
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
  const ref = useOutsideClose(() => { setOpen(false); setQuery(""); });

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
        onClick={() => setOpen((value) => {
          if (value) setQuery("");
          return !value;
        })}
        aria-expanded={open}
      >
        <span>{summary}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="filter-menu" role="listbox">
          <label className="filter-search">
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${String(label || "options").toLowerCase()}`}
              aria-label={`Search ${label}`}
              autoFocus
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
          </label>
          {selected.length ? (
            <button type="button" className="filter-clear" onClick={() => onChange([])}>
              <X size={12} aria-hidden="true" /> Clear
            </button>
          ) : null}
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
      ) : null}
    </div>
  );
}

export function SingleSelect({ label, options, value, onChange, placeholder = "Select" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useOutsideClose(() => { setOpen(false); setQuery(""); });
  const selectedOption = options.find((option) => String(option.value) === String(value));
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = normalizedQuery
    ? options.filter((option) => String(option.label || "").toLowerCase().includes(normalizedQuery))
    : options;

  function choose(nextValue) {
    onChange(nextValue);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="filter-field" ref={ref}>
      <span className="filter-label">{label}</span>
      <button
        type="button"
        className={`filter-trigger ${value ? "active" : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span>{selectedOption?.label || placeholder || "Select"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="filter-menu filter-menu-single" role="listbox">
          <label className="filter-search">
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${String(label || "options").toLowerCase()}`}
              aria-label={`Search ${label}`}
              autoFocus
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
          </label>
          {placeholder ? (
            <button
              type="button"
              className={`filter-option single ${!value ? "checked" : ""}`}
              onClick={() => choose("")}
              role="option"
              aria-selected={!value}
            >
              <i>{!value ? <Check size={12} aria-hidden="true" /> : null}</i>
              <span>{placeholder}</span>
            </button>
          ) : null}
          {visibleOptions.map((option) => {
            const checked = String(option.value) === String(value);
            return (
              <button
                key={option.value}
                type="button"
                className={`filter-option single ${checked ? "checked" : ""}`}
                onClick={() => choose(option.value)}
                role="option"
                aria-selected={checked}
              >
                <i>{checked ? <Check size={12} aria-hidden="true" /> : null}</i>
                <span>{option.label}</span>
              </button>
            );
          })}
          {!visibleOptions.length ? <span className="filter-empty">No matching options</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Date range on cycle start date. `basis` is still honoured by cycleInRange if
 * a caller sets it to "completed", but there is no picker cluttering the bar.
 */
export function DateRange({ range, onChange }) {
  const active = range.from || range.to;
  return (
    <div className="filter-field date-range">
      <span className="filter-label">
        <Calendar size={12} aria-hidden="true" /> Date range
      </span>
      <div className={`date-range-inputs ${active ? "active" : ""}`}>
        <input
          type="date"
          value={range.from || ""}
          max={range.to || undefined}
          onChange={(event) => onChange({ ...range, from: event.target.value })}
          aria-label="From date"
        />
        <span className="date-dash">to</span>
        <input
          type="date"
          value={range.to || ""}
          min={range.from || undefined}
          onChange={(event) => onChange({ ...range, to: event.target.value })}
          aria-label="To date"
        />
        {active ? (
          <button
            type="button"
            className="date-clear"
            onClick={() => onChange({ from: "", to: "", basis: range.basis })}
            aria-label="Clear date range"
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
