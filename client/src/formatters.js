/**
 * Number formatting utility functions for count, memory, and duration values.
 * These functions provide human-readable formatting with automatic unit selection.
 */

/**
 * Formats a count value with appropriate SI suffixes (k, M, B, T).
 * @param {number} count - The count value to format
 * @param {number} decimals - Number of decimal places (default: 1)
 * @returns {string} Formatted count string (e.g., "1.5M", "2.3k")
 */
export const formatCount = (count, decimals = 1) => {
  if (count === null || count === undefined || Number.isNaN(count)) return '--';
  if (!Number.isFinite(count)) return count > 0 ? '∞' : '-∞';
  if (count === 0) return '0';
  if (count < 0) return '-' + formatCount(-count, decimals);

  const dm = Math.max(0, decimals);
  const units = [
    { threshold: 1e12, suffix: 'T' },
    { threshold: 1e9, suffix: 'B' },
    { threshold: 1e6, suffix: 'M' },
    { threshold: 1e3, suffix: 'k' },
  ];

  for (const { threshold, suffix } of units) {
    if (count >= threshold) {
      return (count / threshold).toFixed(dm) + suffix;
    }
  }

  // For values < 1000, show as-is (with decimals if not an integer)
  return Number.isInteger(count) ? count.toString() : count.toFixed(dm);
};

/**
 * Formats a byte value with appropriate binary suffixes (B, KB, MB, GB, TB, PB, EB).
 * Uses 1024-based (binary) units.
 * @param {number} bytes - The byte value to format
 * @param {number} decimals - Number of decimal places (default: 2)
 * @returns {string} Formatted byte string (e.g., "1.5 GB", "256 MB")
 */
export const formatBytes = (bytes, decimals = 2) => {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '--';
  if (!Number.isFinite(bytes)) return bytes > 0 ? '∞' : '-∞';
  if (bytes === 0) return '0 B';
  if (bytes < 0) return '-' + formatBytes(-bytes, decimals);

  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

  return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

/**
 * Formats a duration value in seconds with appropriate time suffixes (ns, μs, ms, s, m, h, d).
 * Automatically selects the most appropriate unit based on magnitude.
 * @param {number} seconds - The duration in seconds
 * @returns {string} Formatted duration string (e.g., "1.5s", "250ms", "2h")
 */
export const formatDuration = (seconds) => {
  if (seconds === undefined || seconds === null || Number.isNaN(seconds)) return '--';
  if (!Number.isFinite(seconds)) return seconds > 0 ? '∞' : '-∞';
  if (seconds === 0) return '0s';
  if (seconds < 0) return '-' + formatDuration(-seconds);

  // Nanoseconds
  if (seconds < 0.000001) return (seconds * 1e9).toFixed(0) + 'ns';
  // Microseconds
  if (seconds < 0.001) return (seconds * 1e6).toFixed(0) + 'μs';
  // Milliseconds
  if (seconds < 1) return (seconds * 1000).toFixed(1) + 'ms';
  // Seconds
  if (seconds < 60) return seconds.toFixed(2) + 's';
  // Minutes
  if (seconds < 3600) return (seconds / 60).toFixed(1) + 'm';
  // Hours
  if (seconds < 86400) return (seconds / 3600).toFixed(1) + 'h';
  // Days
  return (seconds / 86400).toFixed(1) + 'd';
};

/**
 * Formats a percentage value.
 * @param {number} value - The value (0-1 or 0-100 depending on context)
 * @param {number} decimals - Number of decimal places (default: 1)
 * @param {boolean} isDecimal - If true, value is 0-1 and will be multiplied by 100 (default: true)
 * @returns {string} Formatted percentage string (e.g., "75.5%")
 */
export const formatPercent = (value, decimals = 1, isDecimal = true) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  if (!Number.isFinite(value)) return value > 0 ? '∞%' : '-∞%';

  const pct = isDecimal ? value * 100 : value;
  return pct.toFixed(decimals) + '%';
};

