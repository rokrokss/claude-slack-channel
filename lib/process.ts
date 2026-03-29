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
 * Works on macOS/Linux (ps) and Windows (wmic).
 */
function findAncestorClaudeCommand(): string {
  const isWindows = process.platform === 'win32'
  try {
    let pid = process.ppid
    for (let i = 0; i < 5 && pid > 1; i++) {
      const { ppid, cmd } = isWindows
        ? getProcessInfoWindows(pid)
        : getProcessInfoUnix(pid)
      if (!cmd) break
      if (/\bclaude\b/.test(cmd)) return cmd
      pid = ppid
    }
  } catch { /* process query failure → return empty */ }
  return ''
}

function getProcessInfoUnix(pid: number): { ppid: number; cmd: string } {
  const line = execSync(`ps -o ppid=,command= -p ${pid}`, {
    encoding: 'utf-8',
    timeout: 3000,
  }).trim()
  const match = line.match(/^\s*(\d+)\s+(.+)$/)
  if (!match) return { ppid: 0, cmd: '' }
  return { ppid: Number(match[1]), cmd: match[2] }
}

function getProcessInfoWindows(pid: number): { ppid: number; cmd: string } {
  const line = execSync(
    `wmic process where ProcessId=${pid} get ParentProcessId,CommandLine /format:csv`,
    { encoding: 'utf-8', timeout: 3000 },
  ).trim()
  // CSV format: Node,CommandLine,ParentProcessId
  // First line is header, second line is data
  const rows = line.split(/\r?\n/).filter(Boolean)
  if (rows.length < 2) return { ppid: 0, cmd: '' }
  const parts = rows[1].split(',')
  if (parts.length < 3) return { ppid: 0, cmd: '' }
  const cmd = parts.slice(1, -1).join(',') // CommandLine may contain commas
  const ppid = Number(parts[parts.length - 1])
  return { ppid, cmd }
}
