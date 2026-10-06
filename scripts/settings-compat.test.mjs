import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('\t\tconst inject = [');
const end = source.indexOf('\t\tfunction applyActivityPresentation', start);
assert.ok(start !== -1 && end > start);
const registrations = [];
const { inject, applyRuntimeSettings } = runInNewContext(
  source.slice(start, end) + '\n({ inject, applyRuntimeSettings });',
  {
    CODEX_SETTINGS_NAMESPACE: 'relay-codex',
    CodexCard: {},
    CodexCardController: class {
      constructor(scope) { this.scope = scope; }
      inject() { return this.scope; }
    },
  },
);

test('0.1.7 boots without the removed settingsScope service', () => {
  assert.ok(!inject.includes('settingsScope'));
  assert.doesNotThrow(() => applyRuntimeSettings({ get: () => undefined }));
});

test('older engines retain the settings card when the service is available', () => {
  const scope = { value: 'configured' };
  applyRuntimeSettings({
    get: (name) => name === 'settingsScope' ? {
      bind: ({ namespace }) => {
        assert.equal(namespace, 'relay-codex');
        return scope;
      },
    } : undefined,
    slots: {
      inject: (name, register) => register(),
      register: (row) => registrations.push(row),
    },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].key, 'relay-codex');
  assert.equal(registrations[0].inject(), scope);
});
