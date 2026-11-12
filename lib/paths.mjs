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
