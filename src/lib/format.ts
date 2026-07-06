export function formatRelativeTime(date: Date, suffix = ""): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);

  if (diffSecs < 60) return `${diffSecs}s${suffix}`;
  if (diffMins < 60) return `${diffMins}m${suffix}`;
  return `${diffHours}h${suffix}`;
}
