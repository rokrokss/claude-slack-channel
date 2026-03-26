export function buildPermalink(workspace: string, channel: string, ts: string, threadTs?: string): string {
  const tsNoDot = ts.replace('.', '')
  const base = `https://${workspace}.slack.com/archives/${channel}/p${tsNoDot}`
  if (threadTs) {
    return `${base}?thread_ts=${threadTs}&cid=${channel}`
  }
  return base
}
