export { formatRelativeTime } from "../../lib/format";

export function shortenCwd(cwd: string): string {
  const home = process.env.HOME ?? "";
  return home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

export function formatVersion(version: string | null): string {
  if (!version) return "";
  // Strip prerelease/platform suffixes (e.g. "0.104.0-darwin-arm64" → "0.104.0")
  const semver = version.replace(/^v?/, "").replace(/[-+].*$/, "");
  return semver ? `v${semver}` : `v${version}`;
}
