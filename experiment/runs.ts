import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Run } from '../src/agent.js'

export interface Row extends Run { task: string; set: string; trap: string; condition: string; threshold?: number; round: number; success: boolean; finalPath: string }

export async function readRuns(dirs: string[]): Promise<Row[]> {
  if (!dirs.length) throw new Error('Name at least one run directory.')
  const rows: Row[] = []
  for (const dir of dirs) for (const line of (await readFile(join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n')) rows.push(JSON.parse(line) as Row)
  return rows
}
