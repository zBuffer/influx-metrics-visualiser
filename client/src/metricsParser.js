/**
 * Enhanced Prometheus metrics parser that extracts HELP/TYPE metadata
 */

/**
 * Parse Prometheus metrics text and extract both data and metadata
 * @param {string} text - Raw Prometheus metrics text
 * @returns {{ metrics: Map, metadata: Map }} - metrics data and metadata catalog
 */
export const parsePrometheusMetricsWithMetadata = (text) => {
  const lines = text.split('\n');
  const metrics = new Map();
  const metadata = new Map(); // { name: { help: string, type: string } }

  // Regex patterns
  const helpRegex = /^#\s*HELP\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(.*)$/;
  const typeRegex = /^#\s*TYPE\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(counter|gauge|histogram|summary|untyped)$/i;
  const dataRegex = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([0-9eE.+\-NaNInf]+)(?:\s+([0-9]+))?$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Parse HELP comment
    const helpMatch = trimmed.match(helpRegex);
    if (helpMatch) {
      const [, name, help] = helpMatch;
      if (!metadata.has(name)) {
        metadata.set(name, { help: '', type: 'untyped' });
      }
      metadata.get(name).help = help;
      continue;
    }

    // Parse TYPE comment
    const typeMatch = trimmed.match(typeRegex);
    if (typeMatch) {
      const [, name, type] = typeMatch;
      if (!metadata.has(name)) {
        metadata.set(name, { help: '', type: 'untyped' });
      }
      metadata.get(name).type = type.toLowerCase();
      continue;
    }

    // Skip other comments
    if (trimmed.startsWith('#')) continue;

    // Parse data line
    const dataMatch = trimmed.match(dataRegex);
    if (dataMatch) {
      const [, name, labelStr, valueStr] = dataMatch;
      let value = Number.parseFloat(valueStr);
      if (Number.isNaN(value)) {
        if (valueStr === "+Inf" || valueStr === "Inf") value = Infinity;
        else if (valueStr === "-Inf") value = -Infinity;
        else value = 0;
      }

      const labels = {};
      if (labelStr) {
        const labelRegex = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
        let labelMatch;
        while ((labelMatch = labelRegex.exec(labelStr)) !== null) {
          const k = labelMatch[1];
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

  return { metrics, metadata };
};

/**
 * Build a catalog of metrics grouped by prefix
 * @param {Map} metadata - Metadata map from parser
 * @param {Map} metrics - Metrics data map
 * @returns {Array} - Array of { prefix, metrics: [{ name, help, type, labels }] }
 */
export const buildMetricsCatalog = (metadata, metrics) => {
  const catalog = new Map(); // prefix -> metrics[]

  // Collect all unique metric base names (strip _bucket, _sum, _count, _total suffixes for grouping)
  const processedNames = new Set();
  
  for (const [name] of metrics) {
    // Get base name for histograms and summaries
    let baseName = name;
    if (name.endsWith('_bucket')) baseName = name.replace('_bucket', '');
    else if (name.endsWith('_count') && metadata.has(name.replace('_count', ''))) baseName = name.replace('_count', '');
    else if (name.endsWith('_sum') && metadata.has(name.replace('_sum', ''))) baseName = name.replace('_sum', '');
    
    if (processedNames.has(baseName)) continue;
    processedNames.add(baseName);

    // Get metadata (might be under base name for histograms/summaries)
    const meta = metadata.get(baseName) || metadata.get(name) || { help: '', type: 'untyped' };
    
    // Determine actual type from data if not in metadata
    let actualType = meta.type;
    if (actualType === 'untyped') {
      if (metrics.has(`${baseName}_bucket`)) actualType = 'histogram';
      else if (metrics.get(baseName)?.some(s => s.labels.quantile !== undefined)) actualType = 'summary';
    }

    // Extract prefix (first part before underscore, or first two parts for common prefixes)
    const parts = baseName.split('_');
    let prefix = parts[0];
    // Common two-part prefixes
    if (['go', 'http', 'storage', 'task', 'service', 'qc', 'influxdb'].includes(parts[0]) && parts.length > 1) {
      prefix = `${parts[0]}_${parts[1]}`;
    }

    // Collect available labels (excluding le, quantile)
    const labelSet = new Set();
    const series = metrics.get(baseName) || metrics.get(`${baseName}_bucket`) || [];
    series.forEach(s => {
      Object.keys(s.labels).forEach(k => {
        if (k !== 'le' && k !== 'quantile') labelSet.add(k);
      });
    });

    if (!catalog.has(prefix)) {
      catalog.set(prefix, []);
    }
    catalog.get(prefix).push({
      name: baseName,
      help: meta.help,
      type: actualType,
      labels: Array.from(labelSet)
    });
  }

  // Convert to sorted array
  return Array.from(catalog.entries())
    .map(([prefix, items]) => ({
      prefix,
      metrics: items.sort((a, b) => a.name.localeCompare(b.name))
    }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
};

