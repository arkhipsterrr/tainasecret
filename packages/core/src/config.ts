import 'dotenv/config';

export interface Config {
  baseUrl: string;
  port: number;
  storageStatePath: string;
  ledgerPath: string;
  apiToken: string | null;
  researchLogPath: string;
  runsDir: string;
  proxyUrl: string | null;
  // When true, preview/buy run over plain HTTP (RawJsubClient) instead of a
  // browser. Browser is the default/fallback. See RawJsubClient.
  rawHttp: boolean;
  credentials: { username: string; password: string };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    baseUrl: process.env.JSUB_BASE_URL ?? 'https://www.j-subculture.com',
    port: Number(process.env.PORT ?? 8787),
    storageStatePath: process.env.STORAGE_STATE_PATH ?? '.pw-user/storageState.json',
    ledgerPath: process.env.LEDGER_PATH ?? 'data/ledger.json',
    apiToken: process.env.API_TOKEN ?? null,
    researchLogPath: process.env.RESEARCH_LOG_PATH ?? 'data/log.ndjson',
    runsDir: process.env.RUNS_DIR ?? 'artifacts/runs',
    proxyUrl: process.env.PROXY_URL ?? null,
    rawHttp: process.env.RAW_HTTP === '1',
    credentials: {
      username: required('JSUB_USERNAME'),
      password: required('JSUB_PASSWORD'),
    },
  };
}
