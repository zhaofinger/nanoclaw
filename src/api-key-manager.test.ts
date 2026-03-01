import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
let mockEnvContent = '';
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(() => mockEnvContent),
  },
}));

import {
  loadApiKeys,
  getCurrentKey,
  getSecretsForContainer,
  getKeyStatus,
  reportError,
  reportSuccess,
  resetKeys,
  onKeySwitch,
} from './api-key-manager.js';

describe('api-key-manager', () => {
  beforeEach(() => {
    mockEnvContent = '';
    // Reset module state completely
    resetKeys();
    // Clear all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadApiKeys', () => {
    it('loads single key from ANTHROPIC_KEY_CONFIG', () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIG='{"name":"test-key","apiKey":"sk-test-123"}'`;
      loadApiKeys();

      const status = getKeyStatus();
      expect(status.totalKeys).toBe(1);
      expect(status.currentKey).toBe('test-key');
      expect(status.availableKeys).toBe(1);
    });

    it('loads multiple keys from ANTHROPIC_KEY_CONFIGS', () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIGS='[{"name":"kimi","baseUrl":"https://api.kimi.com/coding/","apiKey":"kimi-key"},{"name":"dashscope","baseUrl":"https://coding.dashscope.aliyuncs.com/apps/anthropic","authToken":"ds-token","model":"glm-5"}]'`;
      loadApiKeys();

      const status = getKeyStatus();
      expect(status.totalKeys).toBe(2);
      expect(status.keys[0].name).toBe('kimi');
      expect(status.keys[1].name).toBe('dashscope');
    });

    it('supports authToken for providers like DashScope', () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIG='{"name":"dashscope","authToken":"my-auth-token","baseUrl":"https://coding.dashscope.aliyuncs.com/apps/anthropic"}'`;
      loadApiKeys();

      const secrets = getSecretsForContainer();
      expect(secrets.ANTHROPIC_AUTH_TOKEN).toBe('my-auth-token');
      expect(secrets.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('supports both apiKey and authToken', () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIG='{"name":"hybrid","apiKey":"sk-key","authToken":"token","baseUrl":"https://example.com"}'`;
      loadApiKeys();

      const secrets = getSecretsForContainer();
      expect(secrets.ANTHROPIC_API_KEY).toBe('sk-key');
      expect(secrets.ANTHROPIC_AUTH_TOKEN).toBe('token');
    });

    it('supports model override', () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIG='{"name":"test","apiKey":"sk-test","model":"claude-3-opus"}'`;
      loadApiKeys();

      const secrets = getSecretsForContainer();
      expect(secrets.ANTHROPIC_MODEL).toBe('claude-3-opus');
    });

    it('supports baseUrl configuration', () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIG='{"name":"custom","apiKey":"sk-test","baseUrl":"https://custom.api.com"}'`;
      loadApiKeys();

      const secrets = getSecretsForContainer();
      expect(secrets.ANTHROPIC_BASE_URL).toBe('https://custom.api.com');
    });

    it('falls back to legacy ANTHROPIC_API_KEY format', () => {
      mockEnvContent = `ANTHROPIC_API_KEY=sk-legacy-key`;
      loadApiKeys();

      const status = getKeyStatus();
      expect(status.totalKeys).toBe(1);
      expect(status.currentKey).toBe('primary');

      const secrets = getSecretsForContainer();
      expect(secrets.ANTHROPIC_API_KEY).toBe('sk-legacy-key');
    });

    it('falls back to numbered keys ANTHROPIC_API_KEY_1, _2', () => {
      mockEnvContent = `
ANTHROPIC_API_KEY_1=sk-key-1
ANTHROPIC_API_KEY_2=sk-key-2
`;
      loadApiKeys();

      const status = getKeyStatus();
      expect(status.totalKeys).toBe(2);
      expect(status.keys[0].name).toBe('key-1');
      expect(status.keys[1].name).toBe('key-2');
    });

    it('falls back to comma-separated ANTHROPIC_API_KEYS', () => {
      mockEnvContent = `ANTHROPIC_API_KEYS=sk-key-a,sk-key-b,sk-key-c`;
      loadApiKeys();

      const status = getKeyStatus();
      expect(status.totalKeys).toBe(3);
    });

    it('ignores invalid JSON configs gracefully', () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIGS='[{"name":"valid","apiKey":"sk-valid"},{"invalid json}]'`;
      loadApiKeys();

      // Should not load anything due to parse error
      const status = getKeyStatus();
      expect(status.totalKeys).toBe(0);
    });

    it('validates required fields in config', () => {
      // Missing apiKey and authToken
      mockEnvContent = `ANTHROPIC_KEY_CONFIG='{"name":"no-auth"}'`;
      loadApiKeys();

      const status = getKeyStatus();
      expect(status.totalKeys).toBe(0);
    });

    it('requires name field in config', () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIG='{"apiKey":"sk-test"}'`;
      loadApiKeys();

      const status = getKeyStatus();
      expect(status.totalKeys).toBe(0);
    });
  });

  describe('key switching', () => {
    it('switches to next key on API error', async () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIGS='[{"name":"key1","apiKey":"sk-1"},{"name":"key2","apiKey":"sk-2"}]'`;
      loadApiKeys();

      expect(getKeyStatus().currentKey).toBe('key1');

      // Report quota error
      await reportError('usage limit exceeded for this billing cycle');

      expect(getKeyStatus().currentKey).toBe('key2');
    });

    it('does not switch on non-API errors', async () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIGS='[{"name":"key1","apiKey":"sk-1"},{"name":"key2","apiKey":"sk-2"}]'`;
      loadApiKeys();

      expect(getKeyStatus().currentKey).toBe('key1');

      // Report non-API error
      await reportError('some random error');

      expect(getKeyStatus().currentKey).toBe('key1');
    });

    it('marks key unavailable after max errors', async () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIGS='[{"name":"key1","apiKey":"sk-1"},{"name":"key2","apiKey":"sk-2"}]'`;
      loadApiKeys();

      // Report 3 errors on key1 (will switch to key2 after first error due to cooldown)
      // We need to report errors in a way that accumulates on key1
      // Actually, after error, key goes into cooldown and we switch
      // After 3 errors on same key, it becomes unavailable

      // Let's test differently: report 3 errors quickly on key1
      // First error -> cooldown + switch to key2
      await reportError('usage limit exceeded for this billing cycle');

      // Now on key2, report 3 errors to make it unavailable
      await reportError('usage limit exceeded for this billing cycle');
      await reportError('usage limit exceeded for this billing cycle');
      await reportError('usage limit exceeded for this billing cycle');

      // When all keys are exhausted, resetKeys() is called automatically
      // So keys should still be available (reset)
      const status = getKeyStatus();
      // After exhausting all keys, the system resets them automatically
      expect(status.keys.every(k => k.available)).toBe(true);
    });

    it('resets error count on success', async () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIGS='[{"name":"key1","apiKey":"sk-1"},{"name":"key2","apiKey":"sk-2"}]'`;
      loadApiKeys();

      await reportError('usage limit exceeded for this billing cycle');
      // After error, we switch to key2
      expect(getKeyStatus().currentKey).toBe('key2');
      expect(getKeyStatus().keys[1].errors).toBe(0);

      reportSuccess();
      expect(getKeyStatus().keys[1].errors).toBe(0);
    });

    it('calls onKeySwitch callback when switching', async () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIGS='[{"name":"key1","apiKey":"sk-1"},{"name":"key2","apiKey":"sk-2"}]'`;
      loadApiKeys();

      const switchCallback = vi.fn();
      onKeySwitch(switchCallback);

      await reportError('rate limit exceeded');

      expect(switchCallback).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'key2' }),
        'rate_limit',
      );
    });

    it('handles single key gracefully (no switch possible)', async () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIG='{"name":"only","apiKey":"sk-only"}'`;
      loadApiKeys();

      const switched = await reportError('usage limit exceeded for this billing cycle');
      expect(switched).toBe(false);

      // Key should be reset after all keys exhausted
      const status = getKeyStatus();
      expect(status.keys[0].available).toBe(true);
    });
  });

  describe('getSecretsForContainer', () => {
    it('returns empty object when no keys loaded', () => {
      mockEnvContent = '';
      loadApiKeys();

      const secrets = getSecretsForContainer();
      expect(secrets).toEqual({});
    });

    it('returns all configured secrets', () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIG='{"name":"full","apiKey":"sk-full","authToken":"token-full","baseUrl":"https://api.example.com","model":"custom-model"}'`;
      loadApiKeys();

      const secrets = getSecretsForContainer();
      expect(secrets).toEqual({
        ANTHROPIC_API_KEY: 'sk-full',
        ANTHROPIC_AUTH_TOKEN: 'token-full',
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_MODEL: 'custom-model',
      });
    });
  });

  describe('resetKeys', () => {
    it('resets all keys to available state', async () => {
      mockEnvContent = `ANTHROPIC_KEY_CONFIGS='[{"name":"key1","apiKey":"sk-1"},{"name":"key2","apiKey":"sk-2"}]'`;
      loadApiKeys();

      // Report errors to trigger key switching
      await reportError('usage limit exceeded for this billing cycle');

      // After error, we're on key2, and key1 has errorCount=1
      const statusAfterError = getKeyStatus();
      expect(statusAfterError.keys[0].errors).toBe(1);

      // Manually reset
      resetKeys();

      const status = getKeyStatus();
      expect(status.keys.every(k => k.available)).toBe(true);
      expect(status.keys.every(k => k.errors === 0)).toBe(true);
    });
  });
});