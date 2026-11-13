import os from 'node:os';
import path from 'node:path';

export function homeDir(env = process.env) {
  const set = env.T3ORQ_HOME;
  if (!set) return path.join(os.homedir(), '.t3orq');
  if (!path.isAbsolute(set)) throw new Error('T3ORQ_HOME must be an absolute path');
  return set;
}

export const projectDir = (cwd = process.cwd()) => path.join(cwd, '.orq');

export const registryPath = (env = process.env) => path.join(homeDir(env), 'registry.json');
export const leasesDir = (env = process.env) => path.join(homeDir(env), 'leases');
export const machineConfigPath = (env = process.env) => path.join(homeDir(env), 'config.json');

export const projectConfigPath = (cwd = process.cwd()) => path.join(projectDir(cwd), 'config.json');
export const ledgerPath = (cwd = process.cwd()) => path.join(projectDir(cwd), 'ledger.jsonl');

export const toolsPath = (env = process.env) => path.join(homeDir(env), 'tools.json');
export const machineLockPath = (env = process.env) => path.join(homeDir(env), 'lock');
export const planPath = (cwd = process.cwd()) => path.join(projectDir(cwd), 'plan.json');
export const projectLockPath = (cwd = process.cwd()) => path.join(projectDir(cwd), 'lock');
export const runnerLockPath = (cwd = process.cwd()) => path.join(projectDir(cwd), 'runner.lock');
export const integrationDir = (cwd = process.cwd()) => path.join(projectDir(cwd), 'integration');
export const gateWorkDir = (cwd, unit) => path.join(projectDir(cwd), 'gate', unit);
export const unitDir = (cwd, unit) => path.join(projectDir(cwd), 'units', unit);
export const gateFile = (cwd, unit, attempt, ext) => path.join(unitDir(cwd, unit), `gate-${attempt}.${ext}`);
export const reviewsPath = (cwd = process.cwd()) => path.join(projectDir(cwd), 'reviews.json');
export const asksPath = (cwd = process.cwd()) => path.join(projectDir(cwd), 'asks.json');
export const summaryPath = (cwd = process.cwd()) => path.join(projectDir(cwd), 'summary.md');
export const archivingPath = (cwd = process.cwd()) => path.join(projectDir(cwd), 'archiving.json');
export const archiveRoot = (cwd = process.cwd()) => path.join(projectDir(cwd), 'archive');
