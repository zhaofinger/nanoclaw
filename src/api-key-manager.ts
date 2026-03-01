/**
 * API Key Manager for NanoClaw
 *
 * Supports multiple API keys with automatic failover.
 * When one key fails (quota exhausted, rate limited, etc.),
 * it automatically switches to the next available key.
 *
 * Configuration format (in .env):
 * - Single key: ANTHROPIC_KEY_CONFIG='{"name":"kimi","baseUrl":"...","apiKey":"xxx"}'
 * - Multiple keys: ANTHROPIC_KEY_CONFIGS='[{...},{...}]'
 * - Legacy: ANTHROPIC_API_KEY, ANTHROPIC_API_KEY_1, etc. (for backward compatibility)
 *
 * Each key config supports:
 * - name: identifier for logging/notifications
 * - baseUrl: API endpoint (optional, defaults to Anthropic)
 * - apiKey: standard API key
 * - authToken: alternative auth token (some providers use this)
 * - model: default model override (optional)
 * - headers: additional headers (optional)
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { detectApiError } from './api-error.js';

export interface ApiKeyConfig {
  name: string;
  /** API endpoint URL */
  baseUrl?: string;
  /** Standard Anthropic API key */
  apiKey?: string;
  /** Alternative auth token (used by some providers like DashScope) */
  authToken?: string;
  /** Default model to use */
  model?: string;
  /** Additional headers */
  headers?: Record<string, string>;
}

export interface ApiKeyState {
  config: ApiKeyConfig;
  isAvailable: boolean;
  lastError?: string;
  errorCount: number;
  lastSuccess?: Date;
  cooldownUntil?: Date;
}

// Cooldown period after an API error (5 minutes)
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;
// Max errors before marking key as unavailable
const MAX_ERROR_COUNT = 3;

let keyStates: ApiKeyState[] = [];
let currentIndex = 0;
let onKeySwitchCallback: ((newKey: ApiKeyConfig, reason: string) => Promise<void>) | null = null;

/**
 * Load API keys from .env file.
 * Supports multiple formats (in order of priority):
 * 1. ANTHROPIC_KEY_CONFIGS - JSON array of key configs (recommended)
 * 2. ANTHROPIC_KEY_CONFIG - Single JSON key config
 * 3. ANTHROPIC_API_KEYS - Comma-separated keys (legacy)
 * 4. ANTHROPIC_API_KEY_1, ANTHROPIC_API_KEY_2, ... - Numbered keys (legacy)
 * 5. ANTHROPIC_API_KEY - Single key (legacy)
 */
export function loadApiKeys(): void {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    logger.warn('.env file not found, no API keys loaded');
    return;
  }

  const configs: ApiKeyConfig[] = [];

  // Priority 1: JSON array format (recommended)
  const jsonConfigs = parseEnvValue(content, 'ANTHROPIC_KEY_CONFIGS');
  if (jsonConfigs) {
    try {
      const parsed = JSON.parse(jsonConfigs);
      if (Array.isArray(parsed)) {
        configs.push(...parsed.filter(c => isValidConfig(c)));
        logger.info({ count: configs.length }, 'Loaded API keys from ANTHROPIC_KEY_CONFIGS');
      }
    } catch (e) {
      logger.warn({ err: e }, 'Failed to parse ANTHROPIC_KEY_CONFIGS');
    }
  }

  // Priority 2: Single JSON config
  if (configs.length === 0) {
    const jsonConfig = parseEnvValue(content, 'ANTHROPIC_KEY_CONFIG');
    if (jsonConfig) {
      try {
        const parsed = JSON.parse(jsonConfig);
        if (isValidConfig(parsed)) {
          configs.push(parsed);
          logger.info('Loaded API key from ANTHROPIC_KEY_CONFIG');
        }
      } catch (e) {
        logger.warn({ err: e }, 'Failed to parse ANTHROPIC_KEY_CONFIG');
      }
    }
  }

  // Priority 3-5: Legacy formats
  if (configs.length === 0) {
    const legacyConfigs = loadLegacyConfigs(content);
    configs.push(...legacyConfigs);
  }

  keyStates = configs.map(config => ({
    config,
    isAvailable: true,
    errorCount: 0,
  }));

  currentIndex = 0;

  if (keyStates.length === 0) {
    logger.warn('No API keys loaded');
  } else {
    logger.info(
      { keyCount: keyStates.length, keyNames: configs.map(c => c.name) },
      'API keys loaded',
    );
  }
}

/**
 * Validate API key config has required fields.
 */
function isValidConfig(config: unknown): config is ApiKeyConfig {
  if (!config || typeof config !== 'object') return false;
  const c = config as Record<string, unknown>;
  if (typeof c.name !== 'string' || !c.name) return false;
  // Must have at least one auth method
  if (!c.apiKey && !c.authToken) return false;
  return true;
}

/**
 * Load legacy format API keys.
 */
function loadLegacyConfigs(content: string): ApiKeyConfig[] {
  const configs: ApiKeyConfig[] = [];
  const baseUrl = parseEnvValue(content, 'ANTHROPIC_BASE_URL');

  // Check for comma-separated keys
  const keysList = parseEnvValue(content, 'ANTHROPIC_API_KEYS');
  if (keysList) {
    const keys = keysList.split(',').map(k => k.trim()).filter(Boolean);
    keys.forEach((key, i) => {
      configs.push({ name: `key-${i + 1}`, apiKey: key, baseUrl });
    });
    return configs;
  }

  // Check for numbered keys
  for (let i = 1; i <= 10; i++) {
    const key = parseEnvValue(content, `ANTHROPIC_API_KEY_${i}`);
    if (key) {
      configs.push({ name: `key-${i}`, apiKey: key, baseUrl });
    }
  }

  // Fall back to single key
  if (configs.length === 0) {
    const singleKey = parseEnvValue(content, 'ANTHROPIC_API_KEY');
    if (singleKey) {
      configs.push({ name: 'primary', apiKey: singleKey, baseUrl });
    }
  }

  return configs;
}

function parseEnvValue(content: string, key: string): string | undefined {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.startsWith(`${key}=`)) continue;
    let value = trimmed.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

/**
 * Get the current active API key configuration.
 */
export function getCurrentKey(): ApiKeyConfig | null {
  if (keyStates.length === 0) {
    loadApiKeys();
  }

  // Find an available key starting from current index
  for (let i = 0; i < keyStates.length; i++) {
    const idx = (currentIndex + i) % keyStates.length;
    const state = keyStates[idx];

    if (state.isAvailable) {
      // Check if cooldown has expired
      if (state.cooldownUntil && new Date() < state.cooldownUntil) {
        continue;
      }
      currentIndex = idx;
      return state.config;
    }
  }

  logger.error('No available API keys');
  return null;
}

/**
 * Report an error with the current API key.
 * This may trigger a switch to the next key.
 */
export async function reportError(error: string): Promise<boolean> {
  if (keyStates.length === 0) return false;

  const state = keyStates[currentIndex];
  const apiError = detectApiError(error);

  if (!apiError.isApiError) {
    // Not an API error, don't switch
    return false;
  }

  state.errorCount++;
  state.lastError = error;

  logger.warn(
    {
      keyName: state.config.name,
      errorCount: state.errorCount,
      errorType: apiError.errorType,
    },
    'API key error reported',
  );

  // Set cooldown
  state.cooldownUntil = new Date(Date.now() + ERROR_COOLDOWN_MS);

  // Mark as unavailable if too many errors
  if (state.errorCount >= MAX_ERROR_COUNT) {
    state.isAvailable = false;
    logger.warn(
      { keyName: state.config.name },
      'API key marked as unavailable after max errors',
    );
  }

  // Try to switch to next key
  const switched = await switchToNextKey(apiError.errorType);
  return switched;
}

/**
 * Report success with the current API key.
 */
export function reportSuccess(): void {
  if (keyStates.length === 0) return;

  const state = keyStates[currentIndex];
  state.errorCount = 0;
  state.lastError = undefined;
  state.lastSuccess = new Date();
  state.isAvailable = true;
  state.cooldownUntil = undefined;
}

/**
 * Switch to the next available API key.
 */
async function switchToNextKey(reason: string): Promise<boolean> {
  const startIndex = currentIndex;

  for (let i = 1; i < keyStates.length; i++) {
    const nextIdx = (startIndex + i) % keyStates.length;
    const nextState = keyStates[nextIdx];

    if (nextState.isAvailable) {
      if (nextState.cooldownUntil && new Date() < nextState.cooldownUntil) {
        continue;
      }

      const oldKey = keyStates[currentIndex].config;
      const newKey = nextState.config;
      currentIndex = nextIdx;

      logger.info(
        {
          oldKey: oldKey.name,
          newKey: newKey.name,
          reason,
        },
        'Switched to next API key',
      );

      // Notify via callback
      if (onKeySwitchCallback) {
        await onKeySwitchCallback(newKey, reason);
      }

      return true;
    }
  }

  // No available keys, try to reset all keys
  logger.warn('All API keys exhausted, resetting availability');
  resetKeys();
  return false;
}

/**
 * Reset all keys to available state.
 */
export function resetKeys(): void {
  for (const state of keyStates) {
    state.isAvailable = true;
    state.errorCount = 0;
    state.cooldownUntil = undefined;
  }
}

/**
 * Set callback for key switch events.
 */
export function onKeySwitch(
  callback: (newKey: ApiKeyConfig, reason: string) => Promise<void>,
): void {
  onKeySwitchCallback = callback;
}

/**
 * Get current API key state summary.
 */
export function getKeyStatus(): {
  currentKey: string;
  totalKeys: number;
  availableKeys: number;
  keys: Array<{ name: string; available: boolean; errors: number }>;
} {
  return {
    currentKey: keyStates[currentIndex]?.config.name || 'none',
    totalKeys: keyStates.length,
    availableKeys: keyStates.filter(s => s.isAvailable).length,
    keys: keyStates.map(s => ({
      name: s.config.name,
      available: s.isAvailable,
      errors: s.errorCount,
    })),
  };
}

/**
 * Get secrets to pass to container (current key only).
 * Handles both apiKey and authToken authentication methods.
 */
export function getSecretsForContainer(): Record<string, string> {
  const current = getCurrentKey();
  if (!current) return {};

  const secrets: Record<string, string> = {};

  // Set auth credentials based on provider type
  if (current.authToken) {
    // Some providers use ANTHROPIC_AUTH_TOKEN instead of API key
    secrets.ANTHROPIC_AUTH_TOKEN = current.authToken;
  }
  if (current.apiKey) {
    secrets.ANTHROPIC_API_KEY = current.apiKey;
  }

  // Set base URL if configured
  if (current.baseUrl) {
    secrets.ANTHROPIC_BASE_URL = current.baseUrl;
  }

  // Set model override if configured
  if (current.model) {
    secrets.ANTHROPIC_MODEL = current.model;
  }

  return secrets;
}

/**
 * Get additional headers for the current key.
 */
export function getHeadersForContainer(): Record<string, string> {
  const current = getCurrentKey();
  if (!current?.headers) return {};
  return { ...current.headers };
}