import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Responsive, WidthProvider } from 'react-grid-layout/legacy';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, Cell, LineChart, Line, Legend
} from 'recharts';
import {
  X, Settings, GripVertical, Info, Plus, Trash2, Lock, Unlock,
  ChevronDown, ChevronRight, Search, BarChart2, Activity, Gauge, TrendingUp
} from 'lucide-react';
import { formatCount, formatBytes, formatDuration, formatPercent } from './formatters';
import { parsePrometheusMetricsWithMetadata, buildMetricsCatalog } from './metricsParser';

import 'react-grid-layout/css/styles.css';

const ResponsiveGridLayout = WidthProvider(Responsive);

// Storage key for localStorage
const STORAGE_KEY = 'influx-explorer-dashboard';

// Type badge colors
const TYPE_COLORS = {
  gauge: { bg: 'bg-blue-100 dark:bg-blue-900/50', text: 'text-blue-700 dark:text-blue-300', label: 'Gauge' },
  counter: { bg: 'bg-green-100 dark:bg-green-900/50', text: 'text-green-700 dark:text-green-300', label: 'Counter' },
  histogram: { bg: 'bg-yellow-100 dark:bg-yellow-900/50', text: 'text-yellow-700 dark:text-yellow-300', label: 'Histogram' },
  summary: { bg: 'bg-purple-100 dark:bg-purple-900/50', text: 'text-purple-700 dark:text-purple-300', label: 'Summary' },
  untyped: { bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-gray-700 dark:text-gray-300', label: 'Unknown' }
};

// Unit format options
const UNIT_FORMATS = [
  { value: 'raw', label: 'Raw Number' },
  { value: 'count', label: 'Count (k, M, B)' },
  { value: 'memory', label: 'Memory (KB, MB, GB)' },
  { value: 'time', label: 'Duration (ms, s, m)' },
  { value: 'percent', label: 'Percentage (%)' }
];

/**
 * Infer the appropriate unit format based on metric name suffix.
 * Analyzes the last word(s) of the metric name to determine the best display unit.
 * @param {string} metricName - The name of the metric
 * @returns {string} The inferred unit format ('raw', 'count', 'memory', 'time', 'percent')
 */
const inferUnitFromMetricName = (metricName) => {
  if (!metricName) return 'raw';

  const name = metricName.toLowerCase();

  // Memory units - metrics ending in 'bytes'
  if (name.endsWith('_bytes') || name.endsWith('_bytes_total')) {
    return 'memory';
  }

  // Time units - ONLY metrics explicitly ending in 'seconds' (value is guaranteed to be in seconds)
  // Note: _duration, _latency, _delay without _seconds suffix may be in milliseconds or other units,
  // so we don't apply time formatting to those (formatDuration expects seconds as input)
  if (name.endsWith('_seconds') || name.endsWith('_duration')) {
    return 'time';
  }

  // Percentage units - metrics ending in 'fraction', 'ratio', 'usage', 'percent'
  if (name.endsWith('_fraction') ||
      name.endsWith('_ratio') ||
      name.endsWith('_usage') ||
      name.endsWith('_percent')) {
    return 'percent';
  }

  // Count units - metrics ending in common count suffixes
  if (name.endsWith('_total') ||
      name.endsWith('_count') ||
      name.endsWith('_num') ||
      name.endsWith('_active') ||
      name.endsWith('_counter') ||
      name.endsWith('_delta') ||
      name.endsWith('_points') ||
      name.endsWith('_complete') ||
      name.endsWith('_busy') ||
      name.endsWith('_calls') ||
      name.endsWith('_fails') ||
      name.endsWith('_failure') ||
      name.endsWith('_writes') ||
      name.endsWith('_reads') ||
      name.endsWith('_frees') ||
      name.endsWith('_mallocs') ||
      name.endsWith('_lookups') ||
      name.endsWith('_objects') ||
      name.endsWith('_queued') ||
      name.endsWith('_dropped') ||
      name.endsWith('_failed') ||
      name.endsWith('_err') ||
      name.endsWith('_timeouts') ||
      name.endsWith('_series')) {
    return 'count';
  }

  // Default to raw for other metrics (info, goroutines, threads, etc.)
  return 'raw';
};

// Chart colors
const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

/**
 * Format a value based on the specified unit format
 */
const formatValue = (value, unitFormat, maxValue = null) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  
  switch (unitFormat) {
    case 'memory': return formatBytes(value);
    case 'time': return formatDuration(value);
    case 'percent': return formatPercent(maxValue ? value / maxValue : value, 1, !maxValue);
    case 'count': return formatCount(value);
    default: return typeof value === 'number' ? value.toLocaleString() : String(value);
  }
};

/**
 * Tooltip Component - Shows on hover
 */
const Tooltip = ({ children, content }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);
  const tooltipRef = useRef(null);

  useEffect(() => {
    if (!isVisible || !triggerRef.current) return;

    const updatePosition = () => {
      if (!triggerRef.current || !tooltipRef.current) return;

      const triggerRect = triggerRef.current.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const gap = 8;
      const margin = 12;

      // Try to position below the trigger
      let top = triggerRect.bottom + gap;
      let left = triggerRect.left + (triggerRect.width / 2) - (tooltipRect.width / 2);

      // Adjust if would go off right edge
      if (left + tooltipRect.width > window.innerWidth - margin) {
        left = window.innerWidth - tooltipRect.width - margin;
      }
      // Adjust if would go off left edge
      if (left < margin) {
        left = margin;
      }

      // If would go off bottom, position above
      if (top + tooltipRect.height > window.innerHeight - margin) {
        top = triggerRect.top - tooltipRect.height - gap;
      }

      setPosition({ top, left });
    };

    // Use requestAnimationFrame for smooth positioning
    const rafId = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(rafId);
  }, [isVisible]);

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
        onFocus={() => setIsVisible(true)}
        onBlur={() => setIsVisible(false)}
      >
        {children}
      </div>
      {isVisible && content && createPortal(
        <div
          ref={tooltipRef}
          className="fixed z-[10000] max-w-xs px-3 py-2 text-sm bg-slate-800 dark:bg-slate-700 text-white rounded-lg shadow-lg pointer-events-none"
          style={{ top: position.top, left: position.left }}
        >
          {content}
        </div>,
        document.body
      )}
    </>
  );
};

/**
 * Type Badge Component
 */
const TypeBadge = ({ type, size = 'sm' }) => {
  const colors = TYPE_COLORS[type] || TYPE_COLORS.untyped;
  const sizeClasses = size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-sm px-2 py-1';
  
  return (
    <span className={`${colors.bg} ${colors.text} ${sizeClasses} rounded font-medium`}>
      {colors.label}
    </span>
  );
};

/**
 * Custom Tooltip Component for charts
 * - Follows dark/light theme
 * - Filters out zero values
 * - Sorts in descending order
 * - Truncates long lists
 */
const CustomTooltip = ({ active, payload, label, unitFormat, maxItems = 8 }) => {
  if (!active || !payload || payload.length === 0) return null;

  // Filter out zero values and sort by value descending
  const filteredPayload = payload
    .filter(entry => entry.value !== 0 && entry.value !== undefined && entry.value !== null)
    .sort((a, b) => (b.value || 0) - (a.value || 0));

  if (filteredPayload.length === 0) return null;

  const displayItems = filteredPayload.slice(0, maxItems);
  const remainingCount = filteredPayload.length - maxItems;
  const remainingSum = remainingCount > 0
    ? filteredPayload.slice(maxItems).reduce((sum, item) => sum + (item.value || 0), 0)
    : 0;

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg shadow-lg p-3 text-sm max-w-xs">
      {label && (
        <p className="font-medium text-slate-800 dark:text-slate-200 mb-2 border-b border-slate-200 dark:border-slate-600 pb-2">
          {label}
        </p>
      )}
      <div className="space-y-1">
        {displayItems.map((entry, index) => (
          <div key={index} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: entry.color || entry.fill }}
              />
              <span className="text-slate-600 dark:text-slate-300 truncate">
                {entry.name || entry.dataKey}
              </span>
            </div>
            <span className="font-medium text-slate-800 dark:text-slate-200 flex-shrink-0">
              {formatValue(entry.value, unitFormat)}
            </span>
          </div>
        ))}
        {remainingCount > 0 && (
          <div className="pt-1 mt-1 border-t border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 text-xs">
            +{remainingCount} more ({formatValue(remainingSum, unitFormat)} total)
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Metric Selector Dropdown with grouping and search
 */
const MetricSelector = ({ catalog, onSelect, isOpen, onToggle }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  const filteredCatalog = useMemo(() => {
    if (!searchTerm.trim()) return catalog;
    
    const term = searchTerm.toLowerCase();
    return catalog.map(group => ({
      ...group,
      metrics: group.metrics.filter(m => 
        m.name.toLowerCase().includes(term) || 
        m.help.toLowerCase().includes(term)
      )
    })).filter(group => group.metrics.length > 0);
  }, [catalog, searchTerm]);

  const toggleGroup = (prefix) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  };

  // Auto-expand groups when searching
  useEffect(() => {
    if (searchTerm.trim()) {
      setExpandedGroups(new Set(filteredCatalog.map(g => g.prefix)));
    }
  }, [searchTerm, filteredCatalog]);

  if (!isOpen) return null;

  return (
    <div className="absolute top-full left-0 mt-2 w-96 max-h-[70vh] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 overflow-hidden">
      {/* Search input */}
      <div className="p-3 border-b border-slate-200 dark:border-slate-700">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search metrics by name or description..."
            className="w-full pl-9 pr-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            autoFocus
          />
        </div>
      </div>

      {/* Metrics list */}
      <div className="overflow-y-auto max-h-[50vh]">
        {filteredCatalog.length === 0 ? (
          <div className="p-4 text-center text-slate-400">No metrics found</div>
        ) : (
          filteredCatalog.map(group => (
            <div key={group.prefix} className="border-b border-slate-100 dark:border-slate-700 last:border-b-0">
              <button
                onClick={() => toggleGroup(group.prefix)}
                className="w-full px-3 py-2 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {expandedGroups.has(group.prefix) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="font-medium text-sm text-slate-700 dark:text-slate-300">{group.prefix}</span>
                  <span className="text-xs text-slate-400">({group.metrics.length})</span>
                </div>
              </button>
              
              {expandedGroups.has(group.prefix) && (
                <div className="pb-1">
                  {group.metrics.map(metric => (
                    <button
                      key={metric.name}
                      onClick={() => {
                        onSelect(metric);
                        onToggle();
                      }}
                      className="w-full px-4 py-2 text-left hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <TypeBadge type={metric.type} />
                        <span className="text-sm font-mono text-slate-800 dark:text-slate-200 truncate">{metric.name}</span>
                      </div>
                      {metric.help && (
                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate pl-0">{metric.help}</p>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/**
 * Widget Settings Popover - Uses portal to escape overflow:hidden containers
 */
const WidgetSettings = ({ config, metricMeta, onUpdate, onClose, anchorRef }) => {
  const [localConfig, setLocalConfig] = useState(config);
  const popoverRef = useRef(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [isPositioned, setIsPositioned] = useState(false);

  // Calculate and update position after render to account for actual popover height
  useEffect(() => {
    const updatePosition = () => {
      if (!anchorRef?.current || !popoverRef.current) return;

      const rect = anchorRef.current.getBoundingClientRect();
      const popoverWidth = 288; // w-72 = 18rem = 288px
      const popoverHeight = popoverRef.current.offsetHeight;
      const gap = 4;
      const margin = 16;

      // Calculate horizontal position
      let left = rect.right - popoverWidth;

      // Adjust if would go off right edge
      if (left + popoverWidth > window.innerWidth - margin) {
        left = window.innerWidth - popoverWidth - margin;
      }
      // Adjust if would go off left edge
      if (left < margin) {
        left = margin;
      }

      // Calculate vertical position - try below first, then above if needed
      let top = rect.bottom + gap;

      // Check if popover would go off bottom of viewport
      if (top + popoverHeight > window.innerHeight - margin) {
        // Position above the button instead
        top = rect.top - popoverHeight - gap;

        // If it would go off the top, just position at top margin
        if (top < margin) {
          top = margin;
        }
      }

      setPosition({ top, left });
      setIsPositioned(true);
    };

    // Use requestAnimationFrame to ensure the popover is rendered before measuring
    const rafId = requestAnimationFrame(updatePosition);

    // Recalculate on resize
    window.addEventListener('resize', updatePosition);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updatePosition);
    };
  }, [anchorRef]);

  const handleSave = () => {
    onUpdate(localConfig);
    onClose();
  };

  const popoverContent = (
    <>
      {/* Backdrop to close on click outside */}
      <div
        className="fixed inset-0 z-[9998]"
        onClick={onClose}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        role="button"
        tabIndex={0}
        aria-label="Close settings"
      />
      {/* Popover */}
      <div
        ref={popoverRef}
        className="fixed w-72 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl z-[9999] p-4"
        style={{
          top: position.top,
          left: position.left,
          visibility: isPositioned ? 'visible' : 'hidden'
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-medium text-slate-800 dark:text-slate-200">Widget Settings</h4>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded">
            <X size={16} className="text-slate-400" />
          </button>
        </div>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Display mode for gauges */}
          {metricMeta?.type === 'gauge' && (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Display Mode</label>
              <select
                value={localConfig.displayMode || 'value'}
                onChange={(e) => setLocalConfig({ ...localConfig, displayMode: e.target.value })}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-700 dark:text-slate-200 outline-none"
              >
                <option value="value">Single Value</option>
                <option value="doughnut">Gauge Chart</option>
                <option value="bar">Bar Chart</option>
                <option value="timeline">Timeline Chart</option>
              </select>
            </div>
          )}

          {/* Max value for gauge single-value mode */}
          {metricMeta?.type === 'gauge' && localConfig.displayMode === 'doughnut' && (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Maximum Value</label>
              <input
                type="number"
                value={localConfig.maxValue || ''}
                onChange={(e) => setLocalConfig({ ...localConfig, maxValue: e.target.value ? Number(e.target.value) : null })}
                placeholder="Auto-detect"
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none"
              />
              <p className="text-xs text-slate-400 mt-1">Leave empty to auto-detect from data</p>
            </div>
          )}

          {/* Unit format */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Unit Format</label>
            <select
              value={localConfig.unitFormat || 'raw'}
              onChange={(e) => setLocalConfig({ ...localConfig, unitFormat: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-700 dark:text-slate-200 outline-none"
            >
              {UNIT_FORMATS.map(u => (
                <option key={u.value} value={u.value}>{u.label}</option>
              ))}
            </select>
          </div>

          {/* Group by label (for metrics with labels) */}
          {metricMeta?.labels && metricMeta.labels.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Group By</label>
              <select
                value={localConfig.groupBy || 'none'}
                onChange={(e) => setLocalConfig({ ...localConfig, groupBy: e.target.value })}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-700 dark:text-slate-200 outline-none"
              >
                <option value="none">No Grouping (Aggregate)</option>
                {metricMeta.labels.map(label => (
                  <option key={label} value={label}>{label}</option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={handleSave}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Apply Settings
          </button>
        </div>
      </div>
    </>
  );

  return createPortal(popoverContent, document.body);
};

/**
 * Semi-doughnut gauge visualization for gauge metrics
 */
const GaugeChart = ({ value, max, label, unitFormat }) => {
  const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const circumference = Math.PI * 120;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  const getColor = (pct) => {
    if (pct >= 90) return '#ef4444';
    if (pct >= 70) return '#f59e0b';
    return '#8b5cf6';
  };

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <svg width="160" height="90" viewBox="0 0 160 90">
        <path
          d="M 20 80 A 60 60 0 0 1 140 80"
          fill="none"
          stroke="#e2e8f0"
          strokeWidth="12"
          strokeLinecap="round"
          className="dark:stroke-slate-700"
        />
        <path
          d="M 20 80 A 60 60 0 0 1 140 80"
          fill="none"
          stroke={getColor(percentage)}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{ transition: 'stroke-dashoffset 0.5s ease-out' }}
        />
        <text x="80" y="55" textAnchor="middle" className="fill-slate-800 dark:fill-white text-lg font-bold">
          {formatValue(value, unitFormat)}
        </text>
        <text x="80" y="75" textAnchor="middle" className="fill-slate-500 dark:fill-slate-400 text-xs">
          {formatPercent(percentage, 1, false)}
        </text>
      </svg>
      {label && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 text-center">{label}</p>}
    </div>
  );
};

/**
 * Single value display for gauge metrics
 */
const SingleValueDisplay = ({ value, unitFormat, label }) => {
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <p className="text-4xl font-bold text-slate-800 dark:text-white">
        {formatValue(value, unitFormat)}
      </p>
      {label && <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">{label}</p>}
    </div>
  );
};

/**
 * Multi-value display grid for grouped gauge metrics in value mode
 */
const MultiValueDisplay = ({ data, unitFormat }) => {
  if (!data || data.length === 0) return null;

  // Calculate grid columns based on item count
  const cols = data.length <= 2 ? data.length : data.length <= 4 ? 2 : data.length <= 6 ? 3 : 4;

  return (
    <div
      className="grid gap-2 h-full p-2 overflow-auto"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {data.map((item) => (
        <div
          key={item.name}
          className="flex flex-col items-center justify-center p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50"
        >
          <p className="text-lg font-bold text-slate-800 dark:text-white">
            {formatValue(item.value, unitFormat)}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 text-center truncate w-full" title={item.name}>
            {item.name}
          </p>
        </div>
      ))}
    </div>
  );
};

/**
 * Multi-gauge display grid for grouped gauge metrics in doughnut mode
 */
const MultiGaugeDisplay = ({ data, unitFormat, maxValue }) => {
  if (!data || data.length === 0) return null;

  // Calculate max value for all gauges (use provided max or find the max in data)
  const effectiveMax = maxValue || Math.max(...data.map(d => d.value)) * 1.2 || 100;

  // Calculate grid columns based on item count
  const cols = data.length <= 2 ? data.length : data.length <= 4 ? 2 : data.length <= 6 ? 3 : 4;

  return (
    <div
      className="grid gap-1 h-full p-1 overflow-auto"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {data.map((item, i) => (
        <div key={item.name} className="flex flex-col items-center justify-center min-h-0">
          <MiniGaugeChart
            value={item.value}
            max={effectiveMax}
            label={item.name}
            unitFormat={unitFormat}
            color={CHART_COLORS[i % CHART_COLORS.length]}
          />
        </div>
      ))}
    </div>
  );
};

/**
 * Smaller gauge chart for multi-gauge display
 */
const MiniGaugeChart = ({ value, max, label, unitFormat, color }) => {
  const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const circumference = Math.PI * 80; // Smaller arc
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  return (
    <div className="flex flex-col items-center justify-center">
      <svg width="100" height="60" viewBox="0 0 100 60">
        <path
          d="M 10 55 A 40 40 0 0 1 90 55"
          fill="none"
          stroke="#e2e8f0"
          strokeWidth="8"
          strokeLinecap="round"
          className="dark:stroke-slate-700"
        />
        <path
          d="M 10 55 A 40 40 0 0 1 90 55"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{ transition: 'stroke-dashoffset 0.5s ease-out' }}
        />
        <text x="50" y="40" textAnchor="middle" className="fill-slate-800 dark:fill-white text-xs font-bold">
          {formatValue(value, unitFormat)}
        </text>
      </svg>
      {label && (
        <p className="text-[10px] text-slate-500 dark:text-slate-400 text-center truncate w-full px-1" title={label}>
          {label}
        </p>
      )}
    </div>
  );
};

/**
 * Timeline Chart for gauge metrics - plots historical values over time
 */
const TimelineChart = ({ history, unitFormat }) => {
  // Debug logging
  console.log('[TimelineChart] history:', history);

  if (!history || history.length === 0) {
    return <div className="flex items-center justify-center h-full text-slate-400">Collecting data...</div>;
  }

  // Need at least 2 points to draw a line
  if (history.length < 2) {
    return <div className="flex items-center justify-center h-full text-slate-400">Collecting data... ({history.length}/2)</div>;
  }

  // Collect all unique data keys from the history (excluding 'time')
  const allKeys = new Set();
  history.forEach(point => {
    Object.keys(point).forEach(key => {
      if (key !== 'time') allKeys.add(key);
    });
  });
  const dataKeys = Array.from(allKeys);

  // Single line if only 'value' key, multiple lines otherwise
  const isMultiLine = dataKeys.length > 1 || (dataKeys.length === 1 && dataKeys[0] !== 'value');

  // Build lines array to avoid Fragment issues with Recharts
  const lines = dataKeys.map((key, i) => (
    <Line
      key={key}
      type="monotone"
      dataKey={key}
      name={isMultiLine ? key : 'Value'}
      stroke={isMultiLine ? CHART_COLORS[i % CHART_COLORS.length] : '#8b5cf6'}
      strokeWidth={2}
      dot={false}
      activeDot={{ r: 4 }}
      connectNulls
      isAnimationActive={true}
    />
  ));

  return (
    <ResponsiveContainer width="100%" height="100%" debounce={50}>
      <LineChart data={history} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 10 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tickFormatter={(v) => formatValue(v, unitFormat)}
          tick={{ fontSize: 10 }}
          width={50}
          tickLine={false}
          axisLine={false}
        />
        <RechartsTooltip
          content={<CustomTooltip unitFormat={unitFormat} />}
        />
        {isMultiLine && <Legend />}
        {lines}
      </LineChart>
    </ResponsiveContainer>
  );
};

/**
 * Compute data for different metric types
 */
const computeWidgetData = (metrics, metricName, metricType, config) => {
  const groupBy = config.groupBy && config.groupBy !== 'none' ? config.groupBy : null;

  if (metricType === 'histogram') {
    const bucketName = `${metricName}_bucket`;
    const series = metrics.get(bucketName);
    if (!series) return { type: 'empty' };

    const groups = {};
    const allLe = new Set();

    series.forEach(item => {
      const le = item.labels.le;
      if (!le) return;
      allLe.add(le);
      const groupKey = groupBy ? (item.labels[groupBy] || 'Other') : 'All';
      if (!groups[groupKey]) groups[groupKey] = {};
      groups[groupKey][le] = (groups[groupKey][le] || 0) + item.value;
    });

    const sortedLe = Array.from(allLe)
      .map(l => l === '+Inf' ? Infinity : Number.parseFloat(l))
      .sort((a, b) => a - b);
    const sortedLeStr = sortedLe.map(l => l === Infinity ? '+Inf' : l.toString());

    const data = sortedLe.map((leVal, idx) => {
      const leStr = sortedLeStr[idx];
      const prevLeLabel = idx === 0 ? '0' : sortedLeStr[idx - 1];
      let rangeLabel = '';
      if (leVal === Infinity) rangeLabel = `> ${prevLeLabel}`;
      else if (idx === 0) rangeLabel = `≤ ${leStr}`;
      else rangeLabel = `${prevLeLabel}-${leStr}`;

      const row = { range: rangeLabel, le: leVal };
      Object.keys(groups).forEach(gKey => {
        const currVal = groups[gKey][leStr] || 0;
        const prevVal = idx > 0 ? groups[gKey][sortedLeStr[idx - 1]] || 0 : 0;
        row[gKey] = Math.max(0, currVal - prevVal);
      });
      return row;
    }).filter(r => r.le !== Infinity);

    return { type: 'histogram', data, keys: Object.keys(groups) };
  }

  if (metricType === 'summary') {
    const series = metrics.get(metricName);
    const sumSeries = metrics.get(`${metricName}_sum`);
    const countSeries = metrics.get(`${metricName}_count`);

    // Get quantiles from base series (if exists)
    const quantiles = series ? series.filter(s => s.labels.quantile !== undefined) : [];

    // Calculate global sum/count/avg
    const sum = sumSeries ? sumSeries.reduce((acc, s) => acc + s.value, 0) : 0;
    const count = countSeries ? countSeries.reduce((acc, s) => acc + s.value, 0) : 0;
    const avg = count > 0 ? sum / count : 0;

    // If no base series and no sum/count, return empty
    if (!series && !sumSeries && !countSeries) {
      return { type: 'empty' };
    }

    if (groupBy) {
      // Build per-group averages from sum/count series
      const groupAvgs = {};
      if (sumSeries && countSeries) {
        const groupSums = {};
        const groupCounts = {};
        sumSeries.forEach(item => {
          const gKey = item.labels[groupBy] || 'Other';
          groupSums[gKey] = (groupSums[gKey] || 0) + item.value;
        });
        countSeries.forEach(item => {
          const gKey = item.labels[groupBy] || 'Other';
          groupCounts[gKey] = (groupCounts[gKey] || 0) + item.value;
        });
        Object.keys(groupSums).forEach(gKey => {
          const s = groupSums[gKey] || 0;
          const c = groupCounts[gKey] || 0;
          groupAvgs[gKey] = c > 0 ? s / c : 0;
        });
      }

      // Check if we have quantile data with the groupBy label
      if (quantiles.length > 0) {
        // Group quantile data by the selected label
        const groups = {};
        const allQuantiles = new Set();

        quantiles.forEach(item => {
          const quantile = item.labels.quantile;
          allQuantiles.add(quantile);
          const groupKey = item.labels[groupBy] || 'Other';

          if (!groups[groupKey]) groups[groupKey] = {};
          groups[groupKey][quantile] = (groups[groupKey][quantile] || 0) + item.value;
        });

        const groupKeys = Object.keys(groups);
        const sortedQuantiles = Array.from(allQuantiles)
          .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b));

        // Build data rows for each quantile, filtering out rows where all values are zero/NaN
        const quantileData = sortedQuantiles
          .map(q => {
            const row = { name: `P${Number.parseFloat(q) * 100}` };
            groupKeys.forEach(gKey => {
              row[gKey] = groups[gKey][q] || 0;
            });
            return row;
          })
          .filter(row => {
            // Keep row only if at least one group has a non-zero, valid value
            return groupKeys.some(gKey => row[gKey] > 0 && Number.isFinite(row[gKey]));
          });

        // If all quantile rows were NaN/zero, fall back to showing grouped averages as bar chart
        if (quantileData.length === 0 && Object.keys(groupAvgs).length > 0) {
          const data = Object.entries(groupAvgs)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value);

          return { type: 'bar', data };
        }

        // Add Avg row at the beginning using per-group averages from sum/count
        const avgRow = { name: 'Avg' };
        groupKeys.forEach(gKey => {
          avgRow[gKey] = groupAvgs[gKey] || 0;
        });
        quantileData.unshift(avgRow);

        return { type: 'summary-grouped', data: quantileData, keys: groupKeys, avg, sum, count };
      }

      // No quantile data, but we have sum/count - show grouped averages
      if (Object.keys(groupAvgs).length > 0) {
        const data = Object.entries(groupAvgs)
          .map(([name, value]) => ({ name, value }))
          .sort((a, b) => b.value - a.value);

        return { type: 'bar', data };
      }
    }

    // No grouping - aggregate by quantile percentile
    if (quantiles.length > 0) {
      const quantileGroups = {};
      quantiles.forEach(q => {
        const pctKey = `P${Number.parseFloat(q.labels.quantile) * 100}`;
        quantileGroups[pctKey] = Math.max(quantileGroups[pctKey] || 0, q.value);
      });

      const data = Object.entries(quantileGroups)
        .sort((a, b) => Number.parseFloat(a[0].slice(1)) - Number.parseFloat(b[0].slice(1)))
        .map(([name, value]) => ({ name, value }));
      data.unshift({ name: 'Avg', value: avg, isAvg: true });

      return { type: 'summary', data, avg, sum, count };
    }

    // Only have sum/count, no quantiles - show single average value
    return { type: 'single', value: avg };
  }

  // Counter or Gauge
  const series = metrics.get(metricName);
  if (!series) return { type: 'empty' };

  if (groupBy) {
    const groups = {};
    series.forEach(item => {
      const key = item.labels[groupBy] || 'Other';
      groups[key] = (groups[key] || 0) + item.value;
    });
    const data = Object.entries(groups)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    return { type: 'bar', data };
  }

  // Single value
  const total = series.reduce((acc, s) => acc + s.value, 0);
  return { type: 'single', value: total };
};

// Maximum number of history points to keep for timeline charts
const MAX_HISTORY_POINTS = 60;

/**
 * MetricWidget Component - Renders appropriate visualization based on metric type
 */
const MetricWidget = ({ widgetId, config, metrics, metadata, catalog, onRemove, onUpdate }) => {
  const [showSettings, setShowSettings] = useState(false);
  const settingsButtonRef = useRef(null);

  // History tracking for timeline display mode
  const [timelineHistory, setTimelineHistory] = useState([]);
  const lastGroupByRef = useRef(config.groupBy);
  const lastTimeRef = useRef(null);

  const metricMeta = useMemo(() => {
    for (const group of catalog) {
      const found = group.metrics.find(m => m.name === config.metricName);
      if (found) return found;
    }
    return metadata.get(config.metricName) || { name: config.metricName, type: 'untyped', help: '', labels: [] };
  }, [catalog, metadata, config.metricName]);

  const widgetData = useMemo(() =>
    computeWidgetData(metrics, config.metricName, metricMeta.type, config),
    [metrics, config, metricMeta.type]
  );

  // Clear history when groupBy changes
  useEffect(() => {
    if (lastGroupByRef.current !== config.groupBy) {
      setTimelineHistory([]);
      lastTimeRef.current = null;
      lastGroupByRef.current = config.groupBy;
    }
  }, [config.groupBy]);

  // Track history for timeline display
  useEffect(() => {
    if (config.displayMode !== 'timeline') return;
    if (widgetData.type === 'empty') return;

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Skip if we already added a point at this exact timestamp
    if (lastTimeRef.current === timeStr) return;
    lastTimeRef.current = timeStr;

    let newPoint;
    if (widgetData.type === 'single') {
      // Single value mode - flat structure { time, value }
      newPoint = { time: timeStr, value: widgetData.value };
    } else if (widgetData.type === 'bar') {
      // Grouped mode - flat structure { time, groupName1: val1, groupName2: val2, ... }
      newPoint = { time: timeStr };
      widgetData.data.forEach(item => {
        newPoint[item.name] = item.value;
      });
    } else {
      return; // Don't track history for other types
    }

    setTimelineHistory(prev => {
      const updated = [...prev, newPoint];
      // Keep only the last MAX_HISTORY_POINTS entries
      return updated.slice(-MAX_HISTORY_POINTS);
    });
  }, [widgetData, config.displayMode]);

  const renderChart = () => {
    const unitFormat = config.unitFormat || 'raw';

    if (widgetData.type === 'empty') {
      return <div className="flex items-center justify-center h-full text-slate-400">No data available</div>;
    }

    // Handle timeline display mode for gauges (both single and bar types)
    if (metricMeta.type === 'gauge' && config.displayMode === 'timeline') {
      return <TimelineChart history={timelineHistory} unitFormat={unitFormat} />;
    }

    if (widgetData.type === 'single') {
      const displayMode = config.displayMode || 'value';
      if (metricMeta.type === 'gauge' && displayMode === 'doughnut') {
        const maxVal = config.maxValue || widgetData.value * 1.2 || 100;
        return <GaugeChart value={widgetData.value} max={maxVal} unitFormat={unitFormat} />;
      }
      // Handle bar display mode for single values - show as single bar chart
      if (metricMeta.type === 'gauge' && displayMode === 'bar') {
        const singleBarData = [{ name: 'Value', value: widgetData.value }];
        return (
          <ResponsiveContainer width="100%" height="100%" debounce={50}>
            <BarChart data={singleBarData} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => formatValue(v, unitFormat)} tick={{ fontSize: 10 }} width={50} />
              <RechartsTooltip content={<CustomTooltip unitFormat={unitFormat} />} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]} fill="#8b5cf6" />
            </BarChart>
          </ResponsiveContainer>
        );
      }
      return <SingleValueDisplay value={widgetData.value} unitFormat={unitFormat} />;
    }

    if (widgetData.type === 'bar') {
      const data = widgetData.data || [];
      const displayMode = config.displayMode || 'value';

      // For gauge metrics with grouped data, respect the display mode
      if (metricMeta.type === 'gauge') {
        if (displayMode === 'value') {
          return <MultiValueDisplay data={data} unitFormat={unitFormat} />;
        }
        if (displayMode === 'doughnut') {
          return <MultiGaugeDisplay data={data} unitFormat={unitFormat} maxValue={config.maxValue} />;
        }
        // displayMode === 'bar' falls through to bar chart below
      }

      return (
        <ResponsiveContainer width="100%" height="100%" debounce={50}>
          <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={60} />
            <YAxis tickFormatter={(v) => formatValue(v, unitFormat)} tick={{ fontSize: 10 }} width={50} />
            <RechartsTooltip content={<CustomTooltip unitFormat={unitFormat} />} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }

    if (widgetData.type === 'histogram') {
      const data = widgetData.data || [];
      const keys = widgetData.keys || ['value'];

      return (
        <ResponsiveContainer width="100%" height="100%" debounce={50}>
          <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
            <XAxis dataKey="range" tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={60} />
            <YAxis tickFormatter={(v) => formatValue(v, 'count')} tick={{ fontSize: 10 }} width={50} />
            <RechartsTooltip content={<CustomTooltip unitFormat="count" />} />
            {keys.map((k, i) => <Bar key={k} dataKey={k} fill={CHART_COLORS[i % CHART_COLORS.length]} stackId="a" />)}
          </BarChart>
        </ResponsiveContainer>
      );
    }

    if (widgetData.type === 'summary') {
      return (
        <div className="flex flex-col h-full">
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%" debounce={50}>
              <BarChart data={widgetData.data} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => formatValue(v, unitFormat)} tick={{ fontSize: 10 }} width={50} />
                <RechartsTooltip content={<CustomTooltip unitFormat={unitFormat} />} />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {widgetData.data.map((entry, i) => (
                    <Cell key={i} fill={entry.isAvg ? '#8b5cf6' : CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 text-center pt-1">
            Avg: {formatValue(widgetData.avg, unitFormat)} | Count: {formatCount(widgetData.count)}
          </div>
        </div>
      );
    }

    if (widgetData.type === 'summary-grouped') {
      const { data, keys } = widgetData;
      if (data.length === 0 || keys.length === 0) {
        return <div className="flex items-center justify-center h-full text-slate-400">No quantile data for grouping</div>;
      }
      return (
        <div className="flex flex-col h-full">
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%" debounce={50}>
              <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => formatValue(v, unitFormat)} tick={{ fontSize: 10 }} width={50} />
                <RechartsTooltip content={<CustomTooltip unitFormat={unitFormat} />} />
                {keys.map((k, i) => (
                  <Bar key={k} dataKey={k} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 text-center pt-1">
            Avg: {formatValue(widgetData.avg, unitFormat)} | Count: {formatCount(widgetData.count)}
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
      {/* Widget Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
        <GripVertical size={14} className="text-slate-400 cursor-grab drag-handle" />
        <TypeBadge type={metricMeta.type} />
        <span className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-200 truncate" title={config.metricName}>
          {config.metricName}
        </span>
        {metricMeta.help && (
          <Tooltip content={metricMeta.help}>
            <button className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded">
              <Info size={14} className="text-slate-400" />
            </button>
          </Tooltip>
        )}
        <button
          ref={settingsButtonRef}
          onClick={() => setShowSettings(!showSettings)}
          className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded"
        >
          <Settings size={14} className="text-slate-400" />
        </button>
        {showSettings && (
          <WidgetSettings
            config={config}
            metricMeta={metricMeta}
            onUpdate={(newConfig) => onUpdate(widgetId, newConfig)}
            onClose={() => setShowSettings(false)}
            anchorRef={settingsButtonRef}
          />
        )}
        <button onClick={() => onRemove(widgetId)} className="p-1 hover:bg-red-100 dark:hover:bg-red-900/30 rounded">
          <X size={14} className="text-slate-400 hover:text-red-500" />
        </button>
      </div>

      {/* Widget Body */}
      <div className="flex-1 p-2 min-h-0">
        {renderChart()}
      </div>
    </div>
  );
};

/**
 * Empty State Component
 */
const EmptyState = ({ onAddMetric }) => (
  <div className="flex flex-col items-center justify-center h-[60vh] text-center">
    <div className="w-20 h-20 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-6">
      <BarChart2 size={40} className="text-slate-400" />
    </div>
    <h3 className="text-xl font-semibold text-slate-700 dark:text-slate-200 mb-2">No metrics added yet</h3>
    <p className="text-slate-500 dark:text-slate-400 mb-6 max-w-md">
      Add your first metric to start building your custom dashboard. You can drag and resize widgets to create your perfect layout.
    </p>
    <button
      onClick={onAddMetric}
      className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
    >
      <Plus size={18} />
      Add Your First Metric
    </button>
    <div className="mt-8 grid grid-cols-3 gap-4 text-sm text-slate-500 dark:text-slate-400">
      <div className="flex items-center gap-2"><Gauge size={16} className="text-blue-500" /> Gauges</div>
      <div className="flex items-center gap-2"><TrendingUp size={16} className="text-green-500" /> Counters</div>
      <div className="flex items-center gap-2"><Activity size={16} className="text-purple-500" /> Histograms</div>
    </div>
  </div>
);

// Helper to load saved state from localStorage
const loadSavedState = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load dashboard state:', e);
  }
  return { widgets: [], layouts: {} };
};

/**
 * Main ExplorerDashboard Component
 */
const ExplorerDashboard = ({ metricsText }) => {
  // Load from localStorage during initial state (lazy initialization)
  const [widgets, setWidgets] = useState(() => loadSavedState().widgets);
  const [layouts, setLayouts] = useState(() => loadSavedState().layouts);
  const [showSelector, setShowSelector] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  // Parse metrics and build catalog
  const { metrics, metadata, catalog } = useMemo(() => {
    if (!metricsText) return { metrics: new Map(), metadata: new Map(), catalog: [] };
    const { metrics: m, metadata: meta } = parsePrometheusMetricsWithMetadata(metricsText);
    const cat = buildMetricsCatalog(meta, m);
    return { metrics: m, metadata: meta, catalog: cat };
  }, [metricsText]);

  // Save state to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ widgets, layouts }));
    } catch (e) {
      console.error('Failed to save dashboard state:', e);
    }
  }, [widgets, layouts]);

  const handleAddMetric = useCallback((metric) => {
    const newWidget = {
      id: `widget-${Date.now()}`,
      metricName: metric.name,
      displayMode: metric.type === 'gauge' ? 'value' : 'bar',
      unitFormat: inferUnitFromMetricName(metric.name),
      groupBy: 'none',
      maxValue: null
    };

    // Find the next available empty space for the new widget
    const existingItems = layouts.lg || [];
    const widgetW = 4;
    const widgetH = 2;
    const cols = 12;

    // Build a grid occupancy map
    const getOccupiedCells = (items) => {
      const occupied = new Set();
      items.forEach(item => {
        for (let row = item.y; row < item.y + item.h; row++) {
          for (let col = item.x; col < item.x + item.w; col++) {
            occupied.add(`${col},${row}`);
          }
        }
      });
      return occupied;
    };

    // Check if a position is available
    const canPlace = (x, y, w, h, occupied) => {
      if (x + w > cols) return false;
      for (let row = y; row < y + h; row++) {
        for (let col = x; col < x + w; col++) {
          if (occupied.has(`${col},${row}`)) return false;
        }
      }
      return true;
    };

    // Find the first available position (scan row by row, left to right)
    const findPosition = (items, w, h) => {
      const occupied = getOccupiedCells(items);
      const maxY = items.reduce((max, item) => Math.max(max, item.y + item.h), 0);

      for (let y = 0; y <= maxY + h; y++) {
        for (let x = 0; x <= cols - w; x++) {
          if (canPlace(x, y, w, h, occupied)) {
            return { x, y };
          }
        }
      }
      return { x: 0, y: maxY };
    };

    const { x, y } = findPosition(existingItems, widgetW, widgetH);

    const newLayout = {
      i: newWidget.id,
      x,
      y,
      w: widgetW,
      h: widgetH,
      minW: 2,
      minH: 2
    };

    setWidgets(prev => [...prev, newWidget]);
    setLayouts(prev => ({
      ...prev,
      lg: [...(prev.lg || []), newLayout],
      md: [...(prev.md || []), { ...newLayout, x: Math.min(x, 6), w: 4 }],
      sm: [...(prev.sm || []), { ...newLayout, x: 0, w: 4 }]
    }));
  }, [layouts]);

  const handleRemoveWidget = useCallback((widgetId) => {
    setWidgets(prev => prev.filter(w => w.id !== widgetId));
    setLayouts(prev => ({
      lg: (prev.lg || []).filter(l => l.i !== widgetId),
      md: (prev.md || []).filter(l => l.i !== widgetId),
      sm: (prev.sm || []).filter(l => l.i !== widgetId)
    }));
  }, []);

  const handleUpdateWidget = useCallback((widgetId, newConfig) => {
    setWidgets(prev => prev.map(w => w.id === widgetId ? { ...w, ...newConfig } : w));
  }, []);

  const handleLayoutChange = useCallback((_currentLayout, allLayouts) => {
    setLayouts(allLayouts);
  }, []);

  const handleClearAll = useCallback(() => {
    if (window.confirm('Are you sure you want to remove all widgets?')) {
      setWidgets([]);
      setLayouts({});
    }
  }, []);

  if (!metricsText) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 dark:text-slate-400">
        Connect to InfluxDB to start exploring metrics
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Actions Bar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative">
          <button
            onClick={() => setShowSelector(!showSelector)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            <Plus size={18} />
            Add Metric
          </button>
          <MetricSelector
            catalog={catalog}
            onSelect={handleAddMetric}
            isOpen={showSelector}
            onToggle={() => setShowSelector(false)}
          />
        </div>

        {widgets.length > 0 && (
          <>
            <button
              onClick={() => setIsLocked(!isLocked)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                isLocked
                  ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {isLocked ? <Lock size={16} /> : <Unlock size={16} />}
              {isLocked ? 'Locked' : 'Unlocked'}
            </button>

            <button
              onClick={handleClearAll}
              className="flex items-center gap-2 px-3 py-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400 rounded-lg transition-colors"
            >
              <Trash2 size={16} />
              Clear All
            </button>
          </>
        )}

        <div className="flex-1" />
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {catalog.reduce((acc, g) => acc + g.metrics.length, 0)} metrics available
        </span>
      </div>

      {/* Dashboard Grid or Empty State */}
      {widgets.length === 0 ? (
        <EmptyState onAddMetric={() => setShowSelector(true)} />
      ) : (
        <ResponsiveGridLayout
          className="layout"
          layouts={layouts}
          breakpoints={{ lg: 1200, md: 996, sm: 768 }}
          cols={{ lg: 12, md: 8, sm: 4 }}
          rowHeight={100}
          onLayoutChange={handleLayoutChange}
          isDraggable={!isLocked}
          isResizable={!isLocked}
          draggableHandle=".drag-handle"
          margin={[12, 12]}
          containerPadding={[0, 12]}
          compactType="vertical"
          preventCollision={false}
          useCSSTransforms={true}
        >
          {widgets.map(widget => (
            <div key={widget.id} className="h-full">
              <MetricWidget
                widgetId={widget.id}
                config={widget}
                metrics={metrics}
                metadata={metadata}
                catalog={catalog}
                onRemove={handleRemoveWidget}
                onUpdate={handleUpdateWidget}
              />
            </div>
          ))}
        </ResponsiveGridLayout>
      )}

      {/* Click outside to close selector */}
      {showSelector && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setShowSelector(false)}
        />
      )}
    </div>
  );
};

export default ExplorerDashboard;
