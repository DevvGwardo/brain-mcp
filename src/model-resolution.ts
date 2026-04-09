import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getModels, getProviders } from '@mariozechner/pi-ai';

export interface HermesModelSelection {
  provider?: string;
  model?: string;
}

export interface ResolvedModelSpec {
  provider: string;
  id: string;
  source: 'explicit' | 'requested' | 'requested-normalized' | 'hermes-current' | 'fallback';
  hermesSelection: HermesModelSelection;
}

const KNOWN_PROVIDERS = new Set<string>(getProviders() as string[]);
const HERMES_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

function normalizeProvider(value?: string): string | undefined {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return undefined;
  return normalized;
}

function parseYamlScalar(raw: string): string | undefined {
  let value = raw.replace(/\s+#.*$/, '').trim();
  if (!value) return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    value = value.slice(1, -1);
  }
  return value.trim() || undefined;
}

function splitExplicitProvider(model: string): { provider: string; id: string } | undefined {
  const slash = model.indexOf('/');
  if (slash <= 0) return undefined;

  const provider = model.slice(0, slash).trim().toLowerCase();
  if (!KNOWN_PROVIDERS.has(provider)) return undefined;

  const id = model.slice(slash + 1).trim();
  if (!id) return undefined;

  return { provider, id };
}

function findCanonicalModelId(provider: string, model: string): string | undefined {
  const requested = model.trim().toLowerCase();
  return getModels(provider as any).find((entry) => entry.id.toLowerCase() === requested)?.id;
}

export function parseHermesModelSelection(yaml: string): HermesModelSelection {
  let provider: string | undefined;
  let model: string | undefined;
  let inModelBlock = false;
  let modelIndent = 0;

  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '    ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (inModelBlock && indent <= modelIndent) {
      inModelBlock = false;
    }

    if (inModelBlock) {
      const nestedMatch = trimmed.match(/^(default|model|provider):\s*(.*)$/);
      if (!nestedMatch) continue;
      const key = nestedMatch[1];
      const value = parseYamlScalar(nestedMatch[2]);
      if (!value) continue;
      if ((key === 'default' || key === 'model') && !model) model = value;
      if (key === 'provider' && !provider) provider = normalizeProvider(value);
      continue;
    }

    const modelMatch = line.match(/^model:\s*(.*)$/);
    if (modelMatch) {
      const value = parseYamlScalar(modelMatch[1]);
      if (value) {
        model = value;
      } else {
        inModelBlock = true;
        modelIndent = indent;
      }
      continue;
    }

    if (!provider) {
      const providerMatch = line.match(/^provider:\s*(.*)$/);
      const value = providerMatch ? parseYamlScalar(providerMatch[1]) : undefined;
      if (value) provider = normalizeProvider(value);
    }
  }

  const explicit = model ? splitExplicitProvider(model) : undefined;
  if (!provider && explicit) {
    provider = explicit.provider;
    model = explicit.id;
  } else if (explicit && explicit.provider === provider) {
    model = explicit.id;
  }

  return { provider, model };
}

function readHermesModelSelection(): HermesModelSelection {
  const hermesHome = process.env.HERMES_HOME || join(homedir(), '.hermes');
  const configPath = join(hermesHome, 'config.yaml');
  if (!existsSync(configPath)) return {};

  try {
    return parseHermesModelSelection(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

export function getHermesModelSelection(): HermesModelSelection {
  const fileSelection = readHermesModelSelection();
  const provider = normalizeProvider(process.env.HERMES_INFERENCE_PROVIDER) || fileSelection.provider;
  const envModel = (process.env.HERMES_MODEL || '').trim() || undefined;
  let model = envModel || fileSelection.model;

  const explicit = model ? splitExplicitProvider(model) : undefined;
  if (!provider && explicit) {
    return { provider: explicit.provider, model: explicit.id };
  }
  if (explicit && explicit.provider === provider) {
    model = explicit.id;
  }

  return { provider, model };
}

export function resolvePiModelSpec(
  model: string,
  options?: { hermesSelection?: HermesModelSelection },
): ResolvedModelSpec {
  const requested = model.trim();
  const hermesSelection = options?.hermesSelection ?? getHermesModelSelection();

  const explicit = splitExplicitProvider(requested);
  if (explicit) {
    return {
      provider: explicit.provider,
      id: findCanonicalModelId(explicit.provider, explicit.id) || explicit.id,
      source: 'explicit',
      hermesSelection,
    };
  }

  const provider = hermesSelection.provider || 'anthropic';
  const canonicalRequested = findCanonicalModelId(provider, requested);
  if (canonicalRequested) {
    return {
      provider,
      id: canonicalRequested,
      source: canonicalRequested === requested ? 'requested' : 'requested-normalized',
      hermesSelection,
    };
  }

  const requestedAlias = requested.toLowerCase();
  if (
    hermesSelection.model &&
    HERMES_MODEL_ALIASES.has(requestedAlias) &&
    (!hermesSelection.provider || hermesSelection.provider === provider)
  ) {
    const hermesModel = splitExplicitProvider(hermesSelection.model)?.id || hermesSelection.model;
    const canonicalHermesModel = findCanonicalModelId(provider, hermesModel);
    if (canonicalHermesModel) {
      return {
        provider,
        id: canonicalHermesModel,
        source: 'hermes-current',
        hermesSelection,
      };
    }
  }

  return {
    provider,
    id: requested,
    source: 'fallback',
    hermesSelection,
  };
}
