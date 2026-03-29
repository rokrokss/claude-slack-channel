import { execSync } from 'child_process'

/**
 * Check if a command line string contains channels-related flags.
 */
export function hasChannelsFlag(commandLine?: string): boolean {
  // Environment variable override — always wins
  if (process.env['SLACK_FORCE_SOCKET_MODE'] === '1') return true

  const cmd = commandLine ?? findAncestorClaudeCommand()
  return (
    cmd.includes('dangerously-load-development-channels') ||
    /--channels\b/.test(cmd)
  )
}

/**
 * Walk up the process tree from ppid to find a `claude` ancestor.
 * Returns its command line, or '' if not found.
 * Stops after 5 levels to avoid runaway traversal.
 */
function findAncestorClaudeCommand(): string {
  try {
    let pid = process.ppid
    for (let i = 0; i < 5 && pid > 1; i++) {
      const line = execSync(`ps -o ppid=,command= -p ${pid}`, {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim()
      const match = line.match(/^\s*(\d+)\s+(.+)$/)
      if (!match) break
      const [, parentPid, command] = match
      if (/\bclaude\b/.test(command)) return command
      pid = Number(parentPid)
    }
  } catch { /* ps failure → return empty */ }
  return ''
}
