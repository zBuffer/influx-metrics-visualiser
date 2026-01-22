import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, BarChart, Bar, Cell, PieChart, Pie
} from 'recharts';
import {
  Activity, Database, AlertCircle, Cpu, HardDrive, Clock, Play, Pause, FileText, Wifi, Layers, Timer, Zap, AlertTriangle, BarChart2, ListFilter, GripHorizontal, Hash
} from 'lucide-react';
import { formatCount, formatBytes, formatDuration, formatPercent } from './src/formatters';

// --- Parser Logic ---

const parsePrometheusMetrics = (text) => {
  const lines = text.split('\n');
  const metrics = new Map();

  // Regex to capture: 1=Name, 2=Labels(optional), 3=Value, 4=Timestamp(optional)
  const regex = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([0-9eE.+\-NaNInf]+)(?:\s+([0-9]+))?$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(regex);
    if (match) {
      const [, name, labelStr, valueStr] = match;
      let value = Number.parseFloat(valueStr);
      if (Number.isNaN(value)) {
          if (valueStr === "+Inf" || valueStr === "Inf") value = Infinity;
          else if (valueStr === "-Inf") value = -Infinity;
          else value = 0;
      }

      const labels = {};

      if (labelStr) {
        // Parse labels properly, handling escaped quotes and commas within quoted values
        const labelRegex = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
        let labelMatch;
        while ((labelMatch = labelRegex.exec(labelStr)) !== null) {
          const k = labelMatch[1];
          // Unescape escaped characters: \" -> ", \\ -> \, \n -> newline
          const v = labelMatch[2]
            .replaceAll(String.raw`\"`, '"')
            .replaceAll(String.raw`\\`, '\\')
            .replaceAll(String.raw`\n`, '\n');
          labels[k] = v;
        }
      }

      if (!metrics.has(name)) {
        metrics.set(name, []);
      }
      metrics.get(name).push({ labels, value });
    }
  }
  return metrics;
};

// --- Helper Functions ---

/**
 * Returns a user-friendly title for the given error type.
 */
const getErrorTitle = (errorType) => {
  switch (errorType) {
    case 'cors': return 'Connection Blocked (CORS/Network)';
    case 'timeout': return 'Request Timeout';
    case 'http': return 'HTTP Error';
    default: return 'Connection Error';
  }
};

/**
 * Generates a chart title with an optional groupBy suffix.
 */
const getChartTitle = (prefix, metricName, groupBy) => {
  const suffix = groupBy === 'All' ? '' : ` (by ${groupBy})`;
  return `${prefix}: ${metricName}${suffix}`;
};



const getMetricValue = (metrics, name, labelFilters = {}) => {
  const metricSeries = metrics.get(name);
  if (!metricSeries) return 0;

  const matches = metricSeries.filter(item => {
    return Object.entries(labelFilters).every(([k, v]) => item.labels[k] === v);
  });

  return matches.reduce((acc, curr) => acc + curr.value, 0);
};

// --- Histogram & Summary Helpers ---

/**
 * Determines the group key for a metric item based on the groupBy parameter.
 * Used by histogram and counter breakdown functions.
 */
const getGroupKey = (labels, groupBy) => {
    if (!groupBy) return 'All';
    if (groupBy === 'method + path') {
        const m = labels.method || '';
        const p = labels.path || '';
        return m && p ? `${m} ${p}` : (m || p || 'Other');
    }
    if (labels[groupBy]) return labels[groupBy];
    return 'Other';
};

const discoverDistributions = (metrics) => {
    const histograms = new Set();
    const summaries = new Set();
    const counters = new Set();

    for (const [name, series] of metrics.entries()) {
        if (name.endsWith('_bucket')) {
            const baseName = name.replace('_bucket', '');
            histograms.add(baseName);
            continue;
        }
        if (series.some(s => s.labels.quantile !== undefined)) {
            summaries.add(name);
            continue;
        }
        counters.add(name);
    }
    return { 
        histograms: Array.from(histograms).sort(), 
        summaries: Array.from(summaries).sort(),
        counters: Array.from(counters).sort()
    };
};

const computeHistogramData = (metrics, baseName, groupBy) => {
    const bucketName = `${baseName}_bucket`;
    const series = metrics.get(bucketName);
    if (!series) return { data: [], keys: [] };

    const groups = {}; 
    const allLe = new Set();

    series.forEach(item => {
        const le = item.labels.le;
        if (!le) return;

        allLe.add(le);
        const groupKey = getGroupKey(item.labels, groupBy);

        if (!groups[groupKey]) groups[groupKey] = {};
        groups[groupKey][le] = (groups[groupKey][le] || 0) + item.value;
    });

    const sortedLe = Array.from(allLe).map(l => l === '+Inf' ? Infinity : Number.parseFloat(l)).sort((a, b) => a - b);
    const sortedLeStr = sortedLe.map(l => l === Infinity ? '+Inf' : l.toString());

    const result = sortedLe.map((leVal, idx) => {
        const leStr = sortedLeStr[idx];
        
        let rangeLabel = "";
        const prevLeLabel = idx === 0 ? "0" : sortedLeStr[idx-1];
        if (leVal === Infinity) rangeLabel = `> ${prevLeLabel}s`;
        else if (idx === 0) rangeLabel = `< ${leStr}s`;
        else rangeLabel = `${prevLeLabel}-${leStr}s`;

        const row = { range: rangeLabel, le: leVal, sortIndex: idx };
        
        Object.keys(groups).forEach(gKey => {
            const currVal = groups[gKey][leStr] || 0;
            let prevVal = 0;
            if (idx > 0) {
                const prevLeStr = sortedLeStr[idx-1];
                prevVal = groups[gKey][prevLeStr] || 0;
            }
            
            const exclusive = currVal - prevVal;
            row[gKey] = Math.max(0, exclusive);
        });

        return row;
    }).filter(r => {
        return Object.keys(groups).some(k => r[k] > 0);
    });

    return { data: result, keys: Object.keys(groups) };
};

const computeCounterBreakdown = (metrics, metricName, groupBy) => {
    const series = metrics.get(metricName);
    if (!series) return [];

    const groups = {};

    series.forEach(item => {
        const groupKey = getGroupKey(item.labels, groupBy);
        groups[groupKey] = (groups[groupKey] || 0) + item.value;
    });

    return Object.entries(groups)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
};

const computeSummaryData = (metrics, name) => {
    const series = metrics.get(name);
    if (!series) return { data: [], keys: [] };

    const quantiles = series.filter(s => s.labels.quantile !== undefined);
    
    // Group data by label set
    const groups = {};
    const allQuantiles = new Set();

    quantiles.forEach(item => {
        const { quantile, ...otherLabels } = item.labels;
        allQuantiles.add(quantile);
        
        const labelParts = Object.entries(otherLabels).map(([k, v]) => `${k}: ${v}`);
        const key = labelParts.length > 0 ? labelParts.join(', ') : 'Global';

        if (!groups[key]) groups[key] = { max: 0 };
        groups[key][quantile] = item.value;
        if (item.value > groups[key].max) groups[key].max = item.value;
    });

    // Get sorted unique quantiles for X-axis
    const sortedQuantiles = Array.from(allQuantiles).sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b));

    // Identify Top N series by max value to reduce noise
    const topSeries = Object.entries(groups)
        .sort((a, b) => b[1].max - a[1].max)
        .slice(0, 5) // Top 5
        .map(e => e[0]);

    // Pivot for Recharts BarChart: [{ name: "0.5", series1: 10, series2: 20 }, { name: "0.9", ... }]
    const chartData = sortedQuantiles.map(q => {
        const row = { name: `P${Number.parseFloat(q) * 100}` }; // e.g., P50, P90
        topSeries.forEach(seriesName => {
            row[seriesName] = groups[seriesName][q] || 0;
        });
        return row;
    });

    return { data: chartData, keys: topSeries };
};

const computeRateDistribution = (currMetrics, prevMetrics, metricName, filterFn, timeDiff) => {
    if (!currMetrics || !prevMetrics || timeDiff <= 0) return [];

    const getBuckets = (metrics) => {
        const series = metrics.get(metricName) || [];
        const buckets = {};
        series.filter(filterFn).forEach(item => {
            const le = item.labels.le;
            if (!le) return;
            buckets[le] = (buckets[le] || 0) + item.value;
        });
        return buckets;
    };

    const currBuckets = getBuckets(currMetrics);
    const prevBuckets = getBuckets(prevMetrics);

    const rates = [];
    Object.keys(currBuckets).forEach(le => {
        const curr = currBuckets[le];
        const prev = prevBuckets[le] || 0;
        const rate = Math.max(0, (curr - prev) / timeDiff);
        rates.push({ le: le === '+Inf' ? Infinity : Number.parseFloat(le), rate, leLabel: le });
    });

    rates.sort((a, b) => a.le - b.le);

    return rates.map((bucket, idx) => {
        const prevRate = idx === 0 ? 0 : rates[idx - 1].rate;
        const exclusiveRate = bucket.rate - prevRate;

        let rangeLabel = "";
        const prevLeLabel = idx > 0 ? rates[idx - 1].leLabel : '0';
        if (bucket.le === Infinity) rangeLabel = `> ${prevLeLabel}s`;
        else if (idx === 0) rangeLabel = `< ${bucket.leLabel}s`;
        else rangeLabel = `${prevLeLabel}-${bucket.leLabel}s`;

        return {
            range: rangeLabel,
            count: Math.max(0, exclusiveRate),
            le: bucket.le
        };
    }).filter(b => b.le !== Infinity && b.count > 0.001);
};

// --- Go Memstats Breakdown Helpers ---

const computeGoMemstatsBreakdown = (metrics) => {
  if (!metrics) return null;

  // Core memory metrics
  const heapAlloc = getMetricValue(metrics, 'go_memstats_heap_alloc_bytes') || getMetricValue(metrics, 'go_memstats_alloc_bytes');
  const heapIdle = getMetricValue(metrics, 'go_memstats_heap_idle_bytes');
  const heapInuse = getMetricValue(metrics, 'go_memstats_heap_inuse_bytes');
  const heapSys = getMetricValue(metrics, 'go_memstats_heap_sys_bytes');

  const stackInuse = getMetricValue(metrics, 'go_memstats_stack_inuse_bytes');

  const mspanInuse = getMetricValue(metrics, 'go_memstats_mspan_inuse_bytes');
  const mcacheInuse = getMetricValue(metrics, 'go_memstats_mcache_inuse_bytes');
  const buckHashSys = getMetricValue(metrics, 'go_memstats_buck_hash_sys_bytes');
  const gcSys = getMetricValue(metrics, 'go_memstats_gc_sys_bytes');
  const otherSys = getMetricValue(metrics, 'go_memstats_other_sys_bytes');

  const sysTotal = getMetricValue(metrics, 'go_memstats_sys_bytes');
  const allocTotal = getMetricValue(metrics, 'go_memstats_alloc_bytes');
  const nextGC = getMetricValue(metrics, 'go_memstats_next_gc_bytes');

  // Pie chart data for memory types breakdown
  const breakdownData = [
    { name: 'Heap In-Use', value: heapInuse || heapAlloc || 0, color: '#8b5cf6' },
    { name: 'Heap Idle', value: heapIdle || 0, color: '#c4b5fd' },
    { name: 'Stack', value: stackInuse || 0, color: '#10b981' },
    { name: 'GC Metadata', value: gcSys || 0, color: '#f59e0b' },
    { name: 'MSpan/MCache', value: (mspanInuse || 0) + (mcacheInuse || 0), color: '#06b6d4' },
    { name: 'Other', value: (buckHashSys || 0) + (otherSys || 0), color: '#94a3b8' },
  ].filter(item => item.value > 0);

  // Gauge data (heap usage percentage)
  const heapUsedPercent = heapSys > 0 ? ((heapInuse || heapAlloc) / heapSys) * 100 : 0;
  const memoryPressure = sysTotal > 0 ? (allocTotal / sysTotal) * 100 : 0;

  return {
    heapAlloc,
    heapIdle,
    heapInuse,
    heapSys,
    stackInuse,
    gcSys,
    sysTotal,
    allocTotal,
    nextGC,
    heapUsedPercent,
    memoryPressure,
    breakdownData,
  };
};

// Semi-doughnut gauge component for memory usage
const MemoryGauge = ({ value, max, label, sublabel, color = '#8b5cf6' }) => {
  const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const circumference = Math.PI * 120; // Half circle
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  // Color based on usage level
  const getColor = (pct) => {
    if (pct >= 90) return '#ef4444';
    if (pct >= 70) return '#f59e0b';
    return color;
  };

  return (
    <div className="flex flex-col items-center justify-center">
      <svg width="160" height="90" viewBox="0 0 160 90">
        {/* Background arc */}
        <path
          d="M 20 80 A 60 60 0 0 1 140 80"
          fill="none"
          stroke="#e2e8f0"
          strokeWidth="12"
          strokeLinecap="round"
          className="dark:stroke-slate-700"
        />
        {/* Foreground arc */}
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
        {/* Center text */}
        <text x="80" y="60" textAnchor="middle" className="fill-slate-800 dark:fill-white text-xl font-bold">
          {formatPercent(percentage, 1, false)}
        </text>
        <text x="80" y="78" textAnchor="middle" className="fill-slate-500 dark:fill-slate-400 text-xs">
          {formatBytes(value, 1)}
        </text>
      </svg>
      <div className="text-center mt-1">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</p>
        {sublabel && <p className="text-xs text-slate-400">{sublabel}</p>}
      </div>
    </div>
  );
};

// Custom label for pie chart
const renderCustomPieLabel = ({ cx, cy, midAngle, outerRadius, percent, name }) => {
  if (percent < 0.05) return null; // Don't show labels for tiny slices
  const RADIAN = Math.PI / 180;
  const radius = outerRadius + 25;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);

  return (
    <text
      x={x}
      y={y}
      textAnchor={x > cx ? 'start' : 'end'}
      dominantBaseline="central"
      className="fill-slate-600 dark:fill-slate-300 text-xs"
    >
      {name} ({formatPercent(percent, 0)})
    </text>
  );
};

// --- Components ---

/**
 * Mini stat box with white background - used for throughput stats
 */
const MiniStat = ({ label, value, subtext, colorClass = "text-slate-700 dark:text-slate-300" }) => (
  <div className="bg-white dark:bg-slate-800 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
    <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">{label}</p>
    <p className={`text-lg font-bold ${colorClass}`}>{value}</p>
    {subtext && <p className="text-xs text-slate-400">{subtext}</p>}
  </div>
);

/**
 * Centered stat box for inside cards - used for resource counts
 */
const CenteredStat = ({ value, label, colorClass = "text-slate-700 dark:text-slate-300" }) => (
  <div className="text-center p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
    <p className={`text-2xl font-bold ${colorClass}`}>{value}</p>
    <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
  </div>
);

const Card = ({ title, children, icon: Icon, className = "" }) => (
  <div className={`bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-5 flex flex-col ${className}`}>
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-slate-500 dark:text-slate-400 font-medium text-sm uppercase tracking-wider flex items-center gap-2">
        {Icon && <Icon size={16} />}
        {title}
      </h3>
    </div>
    <div className="flex-1 min-h-0">
      {children}
    </div>
  </div>
);

const StatBadge = ({ label, value, subtext, icon: Icon, color = "blue", alert = false }) => {
  const colors = {
    blue: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    green: "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    purple: "bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
    red: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  };

  const activeColor = alert ? 'red' : color;

  return (
    <div className={`bg-white dark:bg-slate-800 p-4 rounded-xl border ${alert ? 'border-red-300 dark:border-red-800 ring-1 ring-red-100 dark:ring-red-900/20' : 'border-slate-200 dark:border-slate-700'} shadow-sm flex items-center gap-4`}>
      <div className={`p-3 rounded-lg ${colors[activeColor]}`}>
        {alert ? <AlertTriangle size={24} /> : <Icon size={24} />}
      </div>
      <div>
        <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p>
        <p className={`text-2xl font-bold ${alert ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-white'}`}>{value}</p>
        {subtext && <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{subtext}</p>}
      </div>
    </div>
  );
};

/**
 * Reusable metric selector list component for explorer tab.
 * Displays a scrollable list of metric buttons.
 */
const MetricSelectorList = ({
  label,
  items,
  selectedItem,
  onSelect,
  selectedColorClass = "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  maxHeight = "max-h-64",
  id
}) => (
  <div>
    <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">{label}</label>
    <div id={id} className={`space-y-1 ${maxHeight} overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-lg p-2 bg-white dark:bg-slate-800`}>
      {items.map(item => (
        <button
          key={item}
          onClick={() => onSelect(item)}
          className={`w-full text-left px-3 py-2 rounded-md text-sm truncate ${
            selectedItem === item
              ? `${selectedColorClass} font-medium`
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'
          }`}
        >
          {item}
        </button>
      ))}
    </div>
  </div>
);

// --- Main App ---

export default function App() {
  const [url, setUrl] = useState('http://localhost:8086/metrics');
  const [useProxy, setUseProxy] = useState(true); // Use CORS proxy by default
  const [polling, setPolling] = useState(false);
  const [intervalMs, setIntervalMs] = useState(2000);
  const [metricsHistory, setMetricsHistory] = useState([]);
  const [error, setError] = useState(null);
  const [errorType, setErrorType] = useState(null); // 'cors', 'network', 'timeout', 'http', 'parse'
  const [activeTab, setActiveTab] = useState('dashboard');
  const [rawInput, setRawInput] = useState('');
  const [lastFetchTime, setLastFetchTime] = useState(null);

  // Discovery State
  const [discovered, setDiscovered] = useState({ histograms: [], summaries: [], counters: [] });
  
  // Histogram State
  const [selectedHist, setSelectedHist] = useState('');
  const [selectedHistGroupBy, setSelectedHistGroupBy] = useState('All');
  const [availableHistLabels, setAvailableHistLabels] = useState([]);

  // Summary State
  const [selectedSummary, setSelectedSummary] = useState('');

  // Counter/Gauge State
  const [selectedCounter, setSelectedCounter] = useState('');
  const [selectedCounterGroupBy, setSelectedCounterGroupBy] = useState('All');
  const [availableCounterLabels, setAvailableCounterLabels] = useState([]);

  // Poll Logic
  const fetchMetrics = useCallback(async () => {
    const maxRetries = 5;
    let lastError = null;
    let lastErrorType = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), intervalMs);

      try {
        // Use proxy endpoint if enabled, otherwise fetch directly
        const fetchUrl = useProxy
          ? `/api/proxy?url=${encodeURIComponent(url)}`
          : url;

        const response = await fetch(fetchUrl, { signal: controller.signal });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const text = await response.text();

        const parsed = parsePrometheusMetrics(text);
        const timestamp = Date.now();

        setMetricsHistory(prev => {
          const newHistory = [...prev, { timestamp, metrics: parsed }];
          if (newHistory.length > 60) return newHistory.slice(-60);
          return newHistory;
        });
        setError(null);
        setErrorType(null);
        setLastFetchTime(new Date());
        return; // Success - exit the retry loop
      } catch (e) {
        clearTimeout(timeoutId);
        console.error(`Fetch error (attempt ${attempt}/${maxRetries}):`, e);

        // Determine error type for better user guidance
        let errType = 'network';
        let errMsg = e.message || 'Unknown error';

        if (e.name === 'AbortError') {
          errType = 'timeout';
          errMsg = 'Request timed out';
        } else if (e.name === 'TypeError' || e.message?.toLowerCase().includes('failed to fetch')) {
          // TypeError with "Failed to fetch" is the typical CORS or network error signature
          // When CORS blocks a request, the browser throws TypeError without detailed info
          errType = 'cors';
          errMsg = 'Network request failed (likely CORS or connection issue)';
        } else if (e.message?.includes('HTTP error')) {
          errType = 'http';
        }

        lastError = errMsg;
        lastErrorType = errType;

        // If this was the last attempt, don't wait before exiting
        if (attempt < maxRetries) {
          // Wait before retrying (exponential backoff: 100ms, 200ms, 400ms, 800ms)
          await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // All retries exhausted - set error state
    setError(`${lastError} (after ${maxRetries} attempts)`);
    setErrorType(lastErrorType);
    setPolling(false);
  }, [url, intervalMs, useProxy]);

  const handleManualParse = () => {
    try {
      const parsed = parsePrometheusMetrics(rawInput);
      const timestamp = Date.now();
      setMetricsHistory(prev => [...prev, { timestamp, metrics: parsed }].slice(-60));
      
      // Auto-discover
      const disc = discoverDistributions(parsed);
      setDiscovered(disc);
      
      if (disc.histograms.length > 0) setSelectedHist(disc.histograms[0]);
      if (disc.summaries.length > 0) setSelectedSummary(disc.summaries[0]);
      if (disc.counters.length > 0) setSelectedCounter(disc.counters[0]);

      setError(null);
      setErrorType(null);
      setActiveTab('explorer');
      setLastFetchTime(new Date());
    } catch (e) {
      setError("Failed to parse input text");
      setErrorType('parse');
    }
  };

  useEffect(() => {
    let interval;
    if (polling) {
      fetchMetrics(); // Initial fetch
      interval = setInterval(fetchMetrics, intervalMs);
    }
    return () => clearInterval(interval);
  }, [polling, intervalMs, fetchMetrics]);

  // Auto-discover metrics from live data as well as manual input
  useEffect(() => {
    const currentSnapshot = metricsHistory[metricsHistory.length - 1]?.metrics;
    if (!currentSnapshot) return;

    const disc = discoverDistributions(currentSnapshot);

    // Only update if we discovered new metrics
    setDiscovered(prev => {
      const hasChanges =
        disc.histograms.length !== prev.histograms.length ||
        disc.summaries.length !== prev.summaries.length ||
        disc.counters.length !== prev.counters.length;

      if (hasChanges) {
        // Auto-select first item if none selected
        if (disc.histograms.length > 0 && !selectedHist) {
          setSelectedHist(disc.histograms[0]);
        }
        if (disc.summaries.length > 0 && !selectedSummary) {
          setSelectedSummary(disc.summaries[0]);
        }
        if (disc.counters.length > 0 && !selectedCounter) {
          setSelectedCounter(disc.counters[0]);
        }
        return disc;
      }
      return prev;
    });
  }, [metricsHistory, selectedHist, selectedSummary, selectedCounter]);

  // Refs to track previous selected metrics (to detect actual selection changes)
  const prevSelectedHistRef = useRef(selectedHist);
  const prevSelectedCounterRef = useRef(selectedCounter);

  // Update available labels for Histogram
  useEffect(() => {
      const currentSnapshot = metricsHistory[metricsHistory.length - 1]?.metrics;
      if (!currentSnapshot || !selectedHist) {
          setAvailableHistLabels([]);
          return;
      }
      const bucketName = `${selectedHist}_bucket`;
      const series = currentSnapshot.get(bucketName);
      if (series && series.length > 0) {
          const keys = new Set();
          series.forEach(s => {
              Object.keys(s.labels).forEach(k => {
                  if (k !== 'le') keys.add(k);
              });
          });
          const newLabels = Array.from(keys);
          setAvailableHistLabels(newLabels);

          // Only reset groupBy if the selected histogram actually changed
          if (prevSelectedHistRef.current !== selectedHist) {
              setSelectedHistGroupBy('All');
              prevSelectedHistRef.current = selectedHist;
          }
      }
  }, [selectedHist, metricsHistory]);

  // Update available labels for Counter
  useEffect(() => {
    const currentSnapshot = metricsHistory[metricsHistory.length - 1]?.metrics;
    if (!currentSnapshot || !selectedCounter) {
        setAvailableCounterLabels([]);
        return;
    }
    const series = currentSnapshot.get(selectedCounter);
    if (series && series.length > 0) {
        const keys = new Set();
        series.forEach(s => {
            Object.keys(s.labels).forEach(k => keys.add(k));
        });
        const newLabels = Array.from(keys);
        setAvailableCounterLabels(newLabels);

        // Only reset groupBy if the selected counter actually changed
        if (prevSelectedCounterRef.current !== selectedCounter) {
            setSelectedCounterGroupBy('All');
            prevSelectedCounterRef.current = selectedCounter;
        }
    }
  }, [selectedCounter, metricsHistory]);

  // --- Derived Data ---

  const currentSnapshot = metricsHistory[metricsHistory.length - 1]?.metrics;
  const prevSnapshot = metricsHistory.length > 1 ? metricsHistory[metricsHistory.length - 2]?.metrics : null;
  
  const timeDiff = (metricsHistory.length > 1) 
    ? (metricsHistory[metricsHistory.length - 1].timestamp - metricsHistory[metricsHistory.length - 2].timestamp) / 1000 
    : 0;

  // 1. Basic Rates
  const memoryData = metricsHistory.map(entry => ({
    time: new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    heap: getMetricValue(entry.metrics, 'go_memstats_alloc_bytes'),
    sys: getMetricValue(entry.metrics, 'go_memstats_sys_bytes'),
  }));

  // 2. Dashboard Histograms (Rate-based with cumulative fallback)
  const writeLatencyRate = useMemo(() => {
      return computeRateDistribution(
          currentSnapshot, prevSnapshot, 'http_api_request_duration_seconds_bucket',
          (item) => item.labels.path?.includes('/write'), timeDiff
      );
  }, [currentSnapshot, prevSnapshot, timeDiff]);

  // Cumulative write latency distribution (always shows data if there have been requests)
  const writeLatencyCumulative = useMemo(() => {
      if (!currentSnapshot) return [];
      const series = currentSnapshot.get('http_api_request_duration_seconds_bucket') || [];
      const writeSeries = series.filter(item => item.labels.path?.includes('/write'));

      if (writeSeries.length === 0) return [];

      const buckets = {};
      writeSeries.forEach(item => {
          const le = item.labels.le;
          if (!le) return;
          buckets[le] = (buckets[le] || 0) + item.value;
      });

      const sortedLe = Object.keys(buckets)
          .map(l => ({ le: l === '+Inf' ? Infinity : Number.parseFloat(l), leLabel: l }))
          .sort((a, b) => a.le - b.le);

      return sortedLe.map((bucket, idx) => {
          const currVal = buckets[bucket.leLabel] || 0;
          const prevVal = idx > 0 ? buckets[sortedLe[idx-1].leLabel] || 0 : 0;
          const exclusive = Math.max(0, currVal - prevVal);

          let rangeLabel = "";
          const prevLeLabel = idx > 0 ? sortedLe[idx-1].leLabel : '0';
          if (bucket.le === Infinity) rangeLabel = `> ${prevLeLabel}s`;
          else if (idx === 0) rangeLabel = `< ${bucket.leLabel}s`;
          else rangeLabel = `${prevLeLabel}-${bucket.leLabel}s`;

          return { range: rangeLabel, count: exclusive, le: bucket.le };
      }).filter(b => b.le !== Infinity && b.count > 0);
  }, [currentSnapshot]);

  // Use rate data if available, otherwise fall back to cumulative
  const writeLatencyDist = writeLatencyRate.length > 0 ? writeLatencyRate : writeLatencyCumulative;
  const writeLatencyIsRate = writeLatencyRate.length > 0;

  // 3. Explorer Data
  const activeHistResult = useMemo(() => {
      if (!currentSnapshot || !selectedHist) return { data: [], keys: [] };
      const groupBy = selectedHistGroupBy === 'All' ? null : selectedHistGroupBy;
      return computeHistogramData(currentSnapshot, selectedHist, groupBy);
  }, [currentSnapshot, selectedHist, selectedHistGroupBy]);

  const activeSummaryResult = useMemo(() => {
      if (!currentSnapshot || !selectedSummary) return { data: [], keys: [] };
      return computeSummaryData(currentSnapshot, selectedSummary);
  }, [currentSnapshot, selectedSummary]);

  const activeCounterData = useMemo(() => {
    if (!currentSnapshot || !selectedCounter) return [];
    const groupBy = selectedCounterGroupBy === 'All' ? null : selectedCounterGroupBy;
    return computeCounterBreakdown(currentSnapshot, selectedCounter, groupBy);
  }, [currentSnapshot, selectedCounter, selectedCounterGroupBy]);

  // 4. Stats
  const uptime = currentSnapshot ? getMetricValue(currentSnapshot, 'influxdb_uptime_seconds') : 0;
  const activeQueries = currentSnapshot ? (getMetricValue(currentSnapshot, 'query_control_queries_active') || getMetricValue(currentSnapshot, 'influxdb_query_executor_queries_active')) : 0;
  const queuedQueries = currentSnapshot ? (getMetricValue(currentSnapshot, 'query_control_queries_queued') || getMetricValue(currentSnapshot, 'influxdb_query_executor_queries_queued')) : 0;
  const goroutines = currentSnapshot ? getMetricValue(currentSnapshot, 'go_goroutines') : 0;
  const formatUptime = (sec) => {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  };

  const boltdbReads = currentSnapshot ? getMetricValue(currentSnapshot, 'boltdb_reads_total') : 0;
  const boltdbWrites = currentSnapshot ? getMetricValue(currentSnapshot, 'boltdb_writes_total') : 0;

  const schedulerDelaySum = currentSnapshot ? getMetricValue(currentSnapshot, 'task_scheduler_schedule_delay_sum') : 0;
  const schedulerDelayCount = currentSnapshot ? getMetricValue(currentSnapshot, 'task_scheduler_schedule_delay_count') : 0;
  const avgSchedulerDelay = schedulerDelayCount > 0 ? (schedulerDelaySum / schedulerDelayCount) : 0;

  const schedulerExecSum = currentSnapshot ? getMetricValue(currentSnapshot, 'task_scheduler_execute_delta_sum') : 0;
  const schedulerExecCount = currentSnapshot ? getMetricValue(currentSnapshot, 'task_scheduler_execute_delta_count') : 0;
  const avgExecDelta = schedulerExecCount > 0 ? (schedulerExecSum / schedulerExecCount) : 0;

  // Query Controller Metrics (qc_*)
  const qcMemoryUnused = currentSnapshot ? getMetricValue(currentSnapshot, 'qc_memory_unused_bytes') : 0;
  const qcRequestsSuccess = currentSnapshot ? getMetricValue(currentSnapshot, 'qc_requests_total', { result: 'success' }) : 0;
  const qcRequestsError = currentSnapshot ? getMetricValue(currentSnapshot, 'qc_requests_total', { result: 'error' }) : 0;
  const qcCompilingActive = currentSnapshot ? getMetricValue(currentSnapshot, 'qc_compiling_active') : 0;
  const qcExecutingActive = currentSnapshot ? getMetricValue(currentSnapshot, 'qc_executing_active') : 0;
  const qcQueueingActive = currentSnapshot ? getMetricValue(currentSnapshot, 'qc_queueing_active') : 0;

  // HTTP Write/Query Stats
  const httpWriteCount = currentSnapshot ? getMetricValue(currentSnapshot, 'http_write_request_count') : 0;
  const httpWriteBytes = currentSnapshot ? getMetricValue(currentSnapshot, 'http_write_request_bytes') : 0;
  const httpQueryCount = currentSnapshot ? getMetricValue(currentSnapshot, 'http_query_request_count') : 0;
  const httpQueryResponseBytes = currentSnapshot ? getMetricValue(currentSnapshot, 'http_query_response_bytes') : 0;

  // InfluxDB Resource Counts
  const bucketsTotal = currentSnapshot ? getMetricValue(currentSnapshot, 'influxdb_buckets_total') : 0;
  const orgsTotal = currentSnapshot ? getMetricValue(currentSnapshot, 'influxdb_organizations_total') : 0;
  const usersTotal = currentSnapshot ? getMetricValue(currentSnapshot, 'influxdb_users_total') : 0;
  const tokensTotal = currentSnapshot ? getMetricValue(currentSnapshot, 'influxdb_tokens_total') : 0;
  const dashboardsTotal = currentSnapshot ? getMetricValue(currentSnapshot, 'influxdb_dashboards_total') : 0;

  // GC Performance Metrics
  const gcCpuFraction = currentSnapshot ? getMetricValue(currentSnapshot, 'go_memstats_gc_cpu_fraction') : 0;
  const goThreads = currentSnapshot ? getMetricValue(currentSnapshot, 'go_threads') : 0;
  const heapObjects = currentSnapshot ? getMetricValue(currentSnapshot, 'go_memstats_heap_objects') : 0;
  const gcDurationSum = currentSnapshot ? getMetricValue(currentSnapshot, 'go_gc_duration_seconds_sum') : 0;
  const gcDurationCount = currentSnapshot ? getMetricValue(currentSnapshot, 'go_gc_duration_seconds_count') : 0;
  const avgGcDuration = gcDurationCount > 0 ? (gcDurationSum / gcDurationCount) : 0;

  // Storage Metrics (aggregated across shards)
  const storageBucketSeries = currentSnapshot ? getMetricValue(currentSnapshot, 'storage_bucket_series_num') : 0;
  const storageBucketMeasurements = currentSnapshot ? getMetricValue(currentSnapshot, 'storage_bucket_measurement_num') : 0;
  const storageShardDiskSize = currentSnapshot ? getMetricValue(currentSnapshot, 'storage_shard_disk_size') : 0;
  const storageTsmFiles = currentSnapshot ? getMetricValue(currentSnapshot, 'storage_tsm_files_total') : 0;
  const storageWalSize = currentSnapshot ? getMetricValue(currentSnapshot, 'storage_wal_size') : 0;
  const storageCompactionsActive = currentSnapshot ? getMetricValue(currentSnapshot, 'storage_compactions_active') : 0;
  const storageCompactionsFailed = currentSnapshot ? getMetricValue(currentSnapshot, 'storage_compactions_failed') : 0;
  const storageWriterTimeouts = currentSnapshot ? getMetricValue(currentSnapshot, 'storage_writer_timeouts') : 0;

  // Task Executor Metrics
  const taskRunsSuccess = currentSnapshot ? getMetricValue(currentSnapshot, 'task_executor_total_runs_complete', { status: 'success' }) : 0;
  const taskRunsFailed = currentSnapshot ? getMetricValue(currentSnapshot, 'task_executor_total_runs_complete', { status: 'failed' }) : 0;
  const taskErrors = currentSnapshot ? getMetricValue(currentSnapshot, 'task_executor_errors_counter') : 0;
  const taskQueueUsage = currentSnapshot ? getMetricValue(currentSnapshot, 'task_executor_promise_queue_usage') : 0;
  const taskWorkersBusy = currentSnapshot ? getMetricValue(currentSnapshot, 'task_executor_workers_busy') : 0;
  const taskRunsActive = currentSnapshot ? getMetricValue(currentSnapshot, 'task_executor_total_runs_active') : 0;
  const currentExecution = currentSnapshot ? getMetricValue(currentSnapshot, 'task_scheduler_current_execution') : 0;

  // 5. Go Memstats Breakdown
  const memstatsBreakdown = useMemo(() => {
    return computeGoMemstatsBreakdown(currentSnapshot);
  }, [currentSnapshot]);

  // Chart Colors (Cyclic)
  const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

  // --- UI Render ---

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-sans transition-colors duration-200">
      
      {/* Header */}
      <header className="bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Activity className="text-white" size={20} />
            </div>
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400">
              InfluxDB Visualiser
            </h1>
          </div>
          
          <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-1 overflow-x-auto">
            {['dashboard', 'explorer', 'internals', 'settings'].map(tab => (
                 <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all capitalize whitespace-nowrap ${
                    activeTab === tab 
                        ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm' 
                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-700'
                    }`}
                >
                    {tab === 'explorer' ? 'Explorer' : tab}
                </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        
        {/* Connection Bar */}
        <div className="mb-8 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
            <div className="flex items-center gap-2 w-full sm:w-auto">
                <div className={`w-3 h-3 rounded-full animate-pulse ${polling ? 'bg-green-500' : 'bg-slate-400'}`}></div>
                <span className="text-sm font-medium text-slate-600 dark:text-slate-300">
                    {polling ? 'Live Monitoring' : 'Snapshot Mode'}
                </span>
                {lastFetchTime && (
                    <span className="text-xs text-slate-400 ml-2">
                        Data from: {lastFetchTime.toLocaleTimeString()}
                    </span>
                )}
            </div>
            
            <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                    onClick={() => setPolling(!polling)}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        polling
                        ? 'bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-300'
                        : 'bg-blue-600 text-white hover:bg-blue-700'
                    }`}
                >
                    {polling ? <><Pause size={16} /> Pause</> : <><Play size={16} /> Start Live</>}
                </button>
            </div>
        </div>

        {error && (
            <div className="mb-8 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl flex items-start gap-3">
                <AlertCircle className="text-red-600 dark:text-red-400 mt-0.5" size={20} />
                <div>
                    <h3 className="text-sm font-semibold text-red-800 dark:text-red-300">
                        {getErrorTitle(errorType)}
                    </h3>
                    <p className="text-sm text-red-600 dark:text-red-400 mt-1">{error}</p>
                    {errorType === 'cors' && (
                        <div className="mt-3 p-3 bg-red-100 dark:bg-red-900/40 rounded-lg">
                            <p className="text-xs font-medium text-red-700 dark:text-red-300 mb-2">To fix CORS issues, try one of these:</p>
                            <ul className="text-xs text-red-600 dark:text-red-400 space-y-1 list-disc list-inside">
                                <li><strong>Enable CORS Proxy</strong> in Settings (recommended) - routes requests through the server</li>
                                <li><strong>Use Manual Input</strong> in Settings - paste output from <code className="bg-red-200 dark:bg-red-800 px-1 rounded">curl {url}</code></li>
                                <li>If InfluxDB is local, ensure it's running and the URL is correct</li>
                            </ul>
                        </div>
                    )}
                    {errorType === 'timeout' && (
                        <p className="text-xs text-red-500 dark:text-red-400 mt-2">The server took too long to respond. Check if the metrics endpoint is accessible.</p>
                    )}
                    {errorType === 'http' && (
                        <p className="text-xs text-red-500 dark:text-red-400 mt-2">The server returned an error. Check the URL and server status.</p>
                    )}
                    {!errorType && (
                        <p className="text-xs text-red-500 dark:text-red-400 mt-2">Check connection settings or use "Settings &gt; Manual Input".</p>
                    )}
                </div>
            </div>
        )}

        {/* --- TABS --- */}

        {activeTab === 'settings' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 <Card title="Connection Settings" icon={Wifi} className="h-full">
                    <div className="space-y-4">
                        <div>
                            <label htmlFor="metrics-url" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Metrics URL</label>
                            <input
                                id="metrics-url"
                                type="text"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                        </div>
                        <div>
                            <label htmlFor="poll-interval" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Poll Interval (ms)</label>
                            <input
                                id="poll-interval"
                                type="number"
                                min="100"
                                max="60000"
                                value={intervalMs}
                                onChange={(e) => {
                                    const val = Number.parseInt(e.target.value, 10);
                                    if (Number.isNaN(val)) return;
                                    // Clamp to reasonable range: 100ms - 60000ms
                                    setIntervalMs(Math.min(60000, Math.max(100, val)));
                                }}
                                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-sm outline-none"
                            />
                            <p className="text-xs text-slate-400 mt-1">Min: 100ms, Max: 60000ms</p>
                        </div>
                        <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                            <div>
                                <label htmlFor="cors-proxy-toggle" className="block text-sm font-medium text-slate-700 dark:text-slate-300">Use CORS Proxy</label>
                                <p className="text-xs text-slate-400 mt-0.5">Route requests through server to bypass CORS restrictions</p>
                            </div>
                            <button
                                id="cors-proxy-toggle"
                                onClick={() => setUseProxy(!useProxy)}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                    useProxy ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600'
                                }`}
                            >
                                <span
                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                        useProxy ? 'translate-x-6' : 'translate-x-1'
                                    }`}
                                />
                            </button>
                        </div>
                    </div>
                </Card>

                <Card title="Manual Input (CORS Bypass / File Analysis)" icon={FileText} className="h-full">
                    <div className="flex flex-col h-full">
                        <textarea 
                            value={rawInput}
                            onChange={(e) => setRawInput(e.target.value)}
                            className="flex-1 w-full min-h-[200px] p-3 font-mono text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                            placeholder="# Paste raw Prometheus metrics here (e.g., from curl localhost:8086/metrics or a file)..."
                        />
                        <button 
                            onClick={handleManualParse}
                            className="mt-4 w-full py-2 bg-slate-800 hover:bg-slate-900 dark:bg-slate-700 dark:hover:bg-slate-600 text-white text-sm font-medium rounded-lg transition-colors"
                        >
                            Parse Data & Explore
                        </button>
                    </div>
                </Card>
            </div>
        )}

        {activeTab === 'dashboard' && (
            <div className="space-y-6">
                {/* Primary Stats Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatBadge label="Active Queries" value={activeQueries} subtext="Currently executing" icon={Activity} color={activeQueries > 10 ? "red" : "blue"} />
                    <StatBadge label="Queued Queries" value={queuedQueries} subtext="Waiting for scheduler" icon={Layers} color={queuedQueries > 0 ? "amber" : "green"} />
                    <StatBadge label="Uptime" value={uptime ? formatUptime(uptime) : '--'} icon={Clock} color="purple" />
                    <StatBadge
                        label="Goroutines"
                        value={goroutines}
                        subtext={`${goThreads} OS threads`}
                        icon={Cpu}
                        color="blue"
                        alert={goroutines > 5000}
                    />
                </div>

                {/* Query & Write Throughput Stats */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    <MiniStat label="Total Writes" value={formatCount(httpWriteCount, 2)} subtext={formatBytes(httpWriteBytes)} colorClass="text-emerald-600 dark:text-emerald-400" />
                    <MiniStat label="Total Queries" value={formatCount(httpQueryCount)} subtext={`${formatBytes(httpQueryResponseBytes)} sent`} colorClass="text-blue-600 dark:text-blue-400" />
                    <MiniStat label="Query Success" value={formatCount(qcRequestsSuccess)} subtext={`${qcRequestsError} errors`} colorClass="text-green-600 dark:text-green-400" />
                    <MiniStat label="QC Memory Free" value={formatBytes(qcMemoryUnused)} subtext="Query buffer" colorClass="text-violet-600 dark:text-violet-400" />
                    <MiniStat label="Avg GC Pause" value={formatDuration(avgGcDuration)} subtext={formatPercent(gcCpuFraction, 2) + ' CPU'} colorClass="text-amber-600 dark:text-amber-400" />
                    <MiniStat label="Heap Objects" value={formatCount(heapObjects)} subtext="Live allocations" />
                </div>

                {/* Resource Inventory */}
                <Card title="InfluxDB Resources" icon={Database} className="h-auto">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
                        <CenteredStat value={bucketsTotal} label="Buckets" colorClass="text-blue-600 dark:text-blue-400" />
                        <CenteredStat value={orgsTotal} label="Organizations" colorClass="text-purple-600 dark:text-purple-400" />
                        <CenteredStat value={usersTotal} label="Users" colorClass="text-green-600 dark:text-green-400" />
                        <CenteredStat value={tokensTotal} label="API Tokens" colorClass="text-amber-600 dark:text-amber-400" />
                        <CenteredStat value={dashboardsTotal} label="Dashboards" colorClass="text-cyan-600 dark:text-cyan-400" />
                    </div>
                </Card>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <Card
                        title={writeLatencyIsRate ? "Live Write Latency (req/s)" : "Write Latency Distribution (cumulative)"}
                        icon={Timer}
                        className="h-80"
                    >
                         {writeLatencyDist.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={writeLatencyDist} margin={{bottom: 20}}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                    <XAxis
                                        dataKey="range"
                                        stroke="#94a3b8"
                                        angle={-45}
                                        textAnchor="end"
                                        height={60}
                                        fontSize={10}
                                    />
                                    <YAxis stroke="#94a3b8" />
                                    <RechartsTooltip cursor={{fill: 'transparent'}} contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} />
                                    <Bar dataKey="count" fill="#10b981" />
                                </BarChart>
                            </ResponsiveContainer>
                         ) : <div className="h-full flex items-center justify-center text-slate-400">No write requests recorded yet</div>}
                    </Card>

                    <Card title="Go Memory Overview" icon={Database} className="h-80">
                        {memstatsBreakdown && memstatsBreakdown.breakdownData.length > 0 ? (
                            <div className="h-full flex items-center gap-4">
                                {/* Semi-doughnut Gauge */}
                                <div className="flex-shrink-0">
                                    <MemoryGauge
                                        value={memstatsBreakdown.heapInuse || memstatsBreakdown.heapAlloc || 0}
                                        max={memstatsBreakdown.heapSys || memstatsBreakdown.sysTotal || 1}
                                        label="Heap Usage"
                                        sublabel={`of ${formatBytes(memstatsBreakdown.heapSys || memstatsBreakdown.sysTotal, 1)}`}
                                    />
                                </div>
                                {/* Pie Chart */}
                                <div className="flex-1 h-full min-w-0">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <PieChart>
                                            <Pie
                                                data={memstatsBreakdown.breakdownData}
                                                cx="50%"
                                                cy="50%"
                                                innerRadius={40}
                                                outerRadius={70}
                                                paddingAngle={2}
                                                dataKey="value"
                                                labelLine={false}
                                                label={renderCustomPieLabel}
                                            >
                                                {memstatsBreakdown.breakdownData.map((entry, index) => (
                                                    <Cell key={`cell-${index}`} fill={entry.color} />
                                                ))}
                                            </Pie>
                                            <RechartsTooltip
                                                contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }}
                                                formatter={(val) => formatBytes(val)}
                                            />
                                        </PieChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        ) : <div className="h-full flex items-center justify-center text-slate-400">Waiting for data...</div>}
                    </Card>
                </div>

                {/* Memory Timeline (moved below as secondary view) */}
                <Card title="Memory Timeline" icon={Activity} className="h-64">
                    {memoryData.length > 0 ? (
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={memoryData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                                <XAxis dataKey="time" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
                                <YAxis stroke="#94a3b8" fontSize={11} tickFormatter={(val) => formatBytes(val, 0)} tickLine={false} axisLine={false} />
                                <RechartsTooltip contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} formatter={(val) => formatBytes(val)} />
                                <Legend />
                                <Area type="monotone" dataKey="sys" stroke="#94a3b8" fill="#e2e8f0" fillOpacity={0.4} name="Sys Total" />
                                <Area type="monotone" dataKey="heap" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.6} name="Heap In-Use" />
                            </AreaChart>
                        </ResponsiveContainer>
                    ) : <div className="h-full flex items-center justify-center text-slate-400">Waiting for data...</div>}
                </Card>

                {/* Memory Stats Grid */}
                {memstatsBreakdown && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                        <MiniStat label="Heap Allocated" value={formatBytes(memstatsBreakdown.heapAlloc || 0)} colorClass="text-purple-600 dark:text-purple-400" />
                        <MiniStat label="Heap Idle" value={formatBytes(memstatsBreakdown.heapIdle || 0)} colorClass="text-violet-400" />
                        <MiniStat label="Stack In-Use" value={formatBytes(memstatsBreakdown.stackInuse || 0)} colorClass="text-emerald-600 dark:text-emerald-400" />
                        <MiniStat label="System Total" value={formatBytes(memstatsBreakdown.sysTotal || 0)} colorClass="text-slate-700 dark:text-slate-200" />
                    </div>
                )}
            </div>
        )}

        {activeTab === 'internals' && (
             <div className="space-y-6">
                <div className="p-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-100 dark:border-orange-800 rounded-lg text-sm text-orange-800 dark:text-orange-300 flex items-start gap-3">
                    <Zap size={18} className="mt-0.5" />
                    <div>
                        <p className="font-semibold">Performance Analysis</p>
                        <p>Based on current metrics: Goroutine count is {goroutines}, and average task scheduling delay is {formatDuration(avgSchedulerDelay)}. Large scheduling delays often indicate resource contention or blocking tasks.</p>
                    </div>
                </div>

                {/* Scheduler & BoltDB Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatBadge
                        label="Avg Schedule Delay"
                        value={formatDuration(avgSchedulerDelay)}
                        subtext="Wait time before exec"
                        icon={Clock}
                        alert={avgSchedulerDelay > 60}
                    />
                    <StatBadge
                        label="Avg Exec Delta"
                        value={formatDuration(avgExecDelta)}
                        subtext="Execution overhead"
                        icon={Zap}
                        color="amber"
                    />
                     <StatBadge
                        label="BoltDB Reads"
                        value={formatCount(boltdbReads)}
                        subtext="Total reads"
                        icon={HardDrive}
                        color="blue"
                    />
                     <StatBadge
                        label="BoltDB Writes"
                        value={formatCount(boltdbWrites)}
                        subtext="Total writes"
                        icon={HardDrive}
                        color="green"
                    />
                </div>

                {/* Storage Engine Section */}
                <Card title="Storage Engine" icon={HardDrive}>
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
                        <CenteredStat value={formatCount(storageBucketSeries)} label="Total Series" colorClass="text-blue-600 dark:text-blue-400" />
                        <CenteredStat value={formatCount(storageBucketMeasurements)} label="Measurements" colorClass="text-purple-600 dark:text-purple-400" />
                        <CenteredStat value={formatBytes(storageShardDiskSize)} label="Shard Disk Size" colorClass="text-emerald-600 dark:text-emerald-400" />
                        <CenteredStat value={formatCount(storageTsmFiles)} label="TSM Files" colorClass="text-amber-600 dark:text-amber-400" />
                        <CenteredStat value={formatBytes(storageWalSize)} label="WAL Size" colorClass="text-cyan-600 dark:text-cyan-400" />
                        <CenteredStat value={formatCount(storageCompactionsActive)} label="Compactions Active" colorClass={storageCompactionsActive > 0 ? 'text-orange-600 dark:text-orange-400' : 'text-slate-600 dark:text-slate-400'} />
                    </div>
                    {(storageCompactionsFailed > 0 || storageWriterTimeouts > 0) && (
                        <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                            <p className="text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
                                <AlertTriangle size={16} />
                                <span><strong>{storageCompactionsFailed}</strong> compaction failures, <strong>{storageWriterTimeouts}</strong> writer timeouts</span>
                            </p>
                        </div>
                    )}
                </Card>

                {/* Query Controller Pipeline */}
                <Card title="Query Pipeline Status" icon={Activity}>
                    <div className="grid grid-cols-3 gap-4">
                        <div className="text-center p-4 bg-gradient-to-b from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 rounded-lg border border-blue-200 dark:border-blue-800">
                            <p className="text-3xl font-bold text-blue-700 dark:text-blue-300">{qcQueueingActive}</p>
                            <p className="text-sm font-medium text-blue-600 dark:text-blue-400">Queueing</p>
                            <p className="text-xs text-blue-500 dark:text-blue-500 mt-1">Waiting in queue</p>
                        </div>
                        <div className="text-center p-4 bg-gradient-to-b from-amber-50 to-amber-100 dark:from-amber-900/30 dark:to-amber-800/20 rounded-lg border border-amber-200 dark:border-amber-800">
                            <p className="text-3xl font-bold text-amber-700 dark:text-amber-300">{qcCompilingActive}</p>
                            <p className="text-sm font-medium text-amber-600 dark:text-amber-400">Compiling</p>
                            <p className="text-xs text-amber-500 dark:text-amber-500 mt-1">Parsing Flux</p>
                        </div>
                        <div className="text-center p-4 bg-gradient-to-b from-green-50 to-green-100 dark:from-green-900/30 dark:to-green-800/20 rounded-lg border border-green-200 dark:border-green-800">
                            <p className="text-3xl font-bold text-green-700 dark:text-green-300">{qcExecutingActive}</p>
                            <p className="text-sm font-medium text-green-600 dark:text-green-400">Executing</p>
                            <p className="text-xs text-green-500 dark:text-green-500 mt-1">Running query</p>
                        </div>
                    </div>
                </Card>

                {/* Task Executor Section */}
                <Card title="Task Executor" icon={Timer}>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                        <CenteredStat value={formatCount(taskRunsSuccess)} label="Successful Runs" colorClass="text-green-600 dark:text-green-400" />
                        <CenteredStat value={formatCount(taskRunsFailed)} label="Failed Runs" colorClass={taskRunsFailed > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-400'} />
                        <CenteredStat value={taskErrors} label="Errors" colorClass={taskErrors > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-400'} />
                        <CenteredStat value={taskRunsActive} label="Active Workers" colorClass="text-blue-600 dark:text-blue-400" />
                        <CenteredStat value={currentExecution} label="In Scheduler" colorClass="text-amber-600 dark:text-amber-400" />
                        <CenteredStat value={formatPercent(taskQueueUsage, 0)} label="Queue Usage" colorClass="text-purple-600 dark:text-purple-400" />
                    </div>
                    {(taskWorkersBusy > 0.8) && (
                        <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                            <p className="text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2">
                                <AlertTriangle size={16} />
                                <span>Workers are {formatPercent(taskWorkersBusy, 0)} busy - consider scaling</span>
                            </p>
                        </div>
                    )}
                </Card>
             </div>
        )}

        {/* --- EXPLORER TAB --- */}
        {activeTab === 'explorer' && (
            <div className="space-y-8">
                <div className="p-4 bg-slate-100 dark:bg-slate-800 rounded-lg text-sm text-slate-600 dark:text-slate-300">
                    <p className="font-semibold flex items-center gap-2"><ListFilter size={16}/> Auto-Discovered Metrics</p>
                    <p>Found <strong>{discovered.histograms.length}</strong> Histograms, <strong>{discovered.summaries.length}</strong> Summaries, and <strong>{discovered.counters.length}</strong> Standard Counters.</p>
                </div>

                {/* Counter Breakdown Section */}
                <div>
                    <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
                         <Hash size={20}/> Counters & Gauges Breakdown
                    </h2>
                    {discovered.counters.length > 0 ? (
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                            <div className="lg:col-span-1 space-y-4">
                                <MetricSelectorList
                                    label="Select Metric"
                                    items={discovered.counters}
                                    selectedItem={selectedCounter}
                                    onSelect={setSelectedCounter}
                                    selectedColorClass="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300"
                                    id="counter-selector"
                                />

                                {selectedCounter && (
                                    <div className="p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
                                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-2">
                                            <GripHorizontal size={16} /> Group By
                                        </label>
                                        <select 
                                            value={selectedCounterGroupBy}
                                            onChange={(e) => setSelectedCounterGroupBy(e.target.value)}
                                            className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-sm outline-none"
                                        >
                                            <option value="All">All (Total)</option>
                                            {availableCounterLabels.includes('method') && availableCounterLabels.includes('path') && (
                                                <option value="method + path">Method + Path (Combined)</option>
                                            )}
                                            {availableCounterLabels.map(label => (
                                                <option key={label} value={label}>{label}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>
                            
                            <div className="lg:col-span-2">
                                <Card title={getChartTitle('Breakdown', selectedCounter, selectedCounterGroupBy)} className="h-96">
                                     {activeCounterData.length > 0 ? (
                                        <ResponsiveContainer width="100%" height="100%">
                                            <BarChart data={activeCounterData} layout="vertical" margin={{ left: 40, right: 40, bottom: 20 }}>
                                                <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={true} />
                                                <XAxis type="number" stroke="#94a3b8" />
                                                <YAxis 
                                                    dataKey="name" 
                                                    type="category" 
                                                    width={100} 
                                                    stroke="#94a3b8" 
                                                    tick={{fontSize: 10}}
                                                />
                                                <RechartsTooltip 
                                                    cursor={{fill: 'transparent'}} 
                                                    contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }}
                                                />
                                                <Bar dataKey="value" fill="#10b981" barSize={20} radius={[0, 4, 4, 0]}>
                                                    {activeCounterData.map((_, index) => (
                                                        <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                                                    ))}
                                                </Bar>
                                            </BarChart>
                                        </ResponsiveContainer>
                                     ) : <div className="flex items-center justify-center h-full text-slate-400">Select a counter</div>}
                                </Card>
                            </div>
                        </div>
                    ) : <p className="text-slate-500 italic">No standard counters found.</p>}
                </div>


                {/* Histogram Section */}
                <div className="border-t border-slate-200 dark:border-slate-700 pt-8">
                    <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
                        <BarChart2 size={20}/> Histograms (Frequency Distribution)
                    </h2>
                    {discovered.histograms.length > 0 ? (
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                            <div className="lg:col-span-1 space-y-4">
                                <MetricSelectorList
                                    label="Select Metric"
                                    items={discovered.histograms}
                                    selectedItem={selectedHist}
                                    onSelect={setSelectedHist}
                                    selectedColorClass="bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
                                    id="histogram-selector"
                                />

                                {selectedHist && (
                                    <div className="p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
                                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-2">
                                            <GripHorizontal size={16} /> Group By
                                        </label>
                                        <select 
                                            value={selectedHistGroupBy}
                                            onChange={(e) => setSelectedHistGroupBy(e.target.value)}
                                            className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-sm outline-none"
                                        >
                                            <option value="All">All (Total)</option>
                                            {/* Smart option specifically requested by user */}
                                            {availableHistLabels.includes('method') && availableHistLabels.includes('path') && (
                                                <option value="method + path">Method + Path (Combined)</option>
                                            )}
                                            {availableHistLabels.map(label => (
                                                <option key={label} value={label}>{label}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>

                            <div className="lg:col-span-2">
                                <Card title={getChartTitle('Distribution', selectedHist, selectedHistGroupBy)} className="h-96">
                                     {activeHistResult.data.length > 0 ? (
                                        <div className="flex flex-col h-full">
                                            <div className="flex-1 min-h-0">
                                                <ResponsiveContainer width="100%" height="100%">
                                                    <BarChart data={activeHistResult.data} margin={{bottom: 20}}>
                                                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                                        <XAxis
                                                            dataKey="range"
                                                            stroke="#94a3b8"
                                                            angle={-45}
                                                            textAnchor="end"
                                                            height={60}
                                                            fontSize={10}
                                                        />
                                                        <YAxis stroke="#94a3b8" />
                                                        <RechartsTooltip
                                                            cursor={{fill: 'transparent'}}
                                                            contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }}
                                                        />
                                                        {activeHistResult.keys.map((key, index) => (
                                                            <Bar
                                                                key={key}
                                                                dataKey={key}
                                                                stackId="a"
                                                                fill={CHART_COLORS[index % CHART_COLORS.length]}
                                                                name={key}
                                                            />
                                                        ))}
                                                    </BarChart>
                                                </ResponsiveContainer>
                                            </div>
                                            {activeHistResult.keys.length > 0 && (
                                                <div className={`flex-shrink-0 pt-2 border-t border-slate-200 dark:border-slate-700 ${activeHistResult.keys.length > 6 ? 'max-h-20 overflow-y-auto' : ''}`}>
                                                    <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center">
                                                        {activeHistResult.keys.map((key, index) => (
                                                            <div key={key} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                                                                <span
                                                                    className="w-3 h-3 rounded-sm flex-shrink-0"
                                                                    style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                                                                />
                                                                <span className="truncate max-w-[120px]" title={key}>{key}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                     ) : <div className="flex items-center justify-center h-full text-slate-400">Select a histogram</div>}
                                </Card>
                            </div>
                        </div>
                    ) : <p className="text-slate-500 italic">No histograms found in the data.</p>}
                </div>

                {/* Summary Section */}
                <div className="border-t border-slate-200 dark:border-slate-700 pt-8">
                    <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
                        <Activity size={20}/> Summaries (Percentiles)
                    </h2>
                    {discovered.summaries.length > 0 ? (
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                            <div className="lg:col-span-1">
                                <MetricSelectorList
                                    label="Select Summary"
                                    items={discovered.summaries}
                                    selectedItem={selectedSummary}
                                    onSelect={setSelectedSummary}
                                    selectedColorClass="bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300"
                                    maxHeight="max-h-96"
                                    id="summary-selector"
                                />
                            </div>
                            <div className="lg:col-span-2">
                                <Card title={`Percentiles: ${selectedSummary} (Top 5 Slowest)`} className="h-96">
                                     {activeSummaryResult.data.length > 0 ? (
                                        <ResponsiveContainer width="100%" height="100%">
                                            <BarChart data={activeSummaryResult.data} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                                <XAxis dataKey="name" stroke="#94a3b8" />
                                                <YAxis stroke="#94a3b8" tickFormatter={(val) => formatDuration(val)} />
                                                <RechartsTooltip 
                                                    cursor={{fill: 'transparent'}} 
                                                    contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff' }} 
                                                    formatter={(val) => formatDuration(val)}
                                                />
                                                <Legend />
                                                {activeSummaryResult.keys.map((key, index) => (
                                                     <Bar 
                                                        key={key} 
                                                        dataKey={key} 
                                                        fill={CHART_COLORS[index % CHART_COLORS.length]} 
                                                        name={key}
                                                     />
                                                ))}
                                            </BarChart>
                                        </ResponsiveContainer>
                                     ) : <div className="flex items-center justify-center h-full text-slate-400">Select a summary</div>}
                                </Card>
                            </div>
                        </div>
                    ) : <p className="text-slate-500 italic">No summaries found in the data.</p>}
                </div>
            </div>
        )}
      </main>
    </div>
  );
}
