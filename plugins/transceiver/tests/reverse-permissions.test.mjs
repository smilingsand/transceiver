import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReversePermissions } from '../scripts/reverse-permissions.mjs';

const defaults = {
  CODEX_MCP_BRIDGE_DEFAULT_SANDBOX: 'read-only',
  CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY: 'read-only',
  CODEX_MCP_BRIDGE_ALLOW_WRITE: '0',
  CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: '0',
};

test('missing overrides preserve conservative defaults', () => {
  assert.deepEqual(resolveReversePermissions({}), defaults);
});

test('explicit environment settings override defaults', () => {
  assert.deepEqual(resolveReversePermissions({
    CODEX_MCP_BRIDGE_DEFAULT_SANDBOX: 'workspace-write',
    CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY: 'adaptive',
    CODEX_MCP_BRIDGE_ALLOW_WRITE: '1',
    CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: '0',
  }), {
    ...defaults,
    CODEX_MCP_BRIDGE_DEFAULT_SANDBOX: 'workspace-write',
    CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY: 'adaptive',
    CODEX_MCP_BRIDGE_ALLOW_WRITE: '1',
  });
});

test('explicit zero and read-only are never replaced by defaults', () => {
  const env = {
    CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY: 'read-only',
    CODEX_MCP_BRIDGE_ALLOW_WRITE: '0',
    CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: '0',
  };
  assert.deepEqual(resolveReversePermissions(env), defaults);
});

test('missing individual options fall back independently', () => {
  assert.deepEqual(resolveReversePermissions({CODEX_MCP_BRIDGE_ALLOW_WRITE: '1'}), {
    ...defaults,
    CODEX_MCP_BRIDGE_ALLOW_WRITE: '1',
  });
});

test('invalid values pass through for upstream validation instead of silent repair', () => {
  assert.equal(resolveReversePermissions({CODEX_MCP_BRIDGE_ALLOW_WRITE: 'invalid'}).CODEX_MCP_BRIDGE_ALLOW_WRITE, 'invalid');
});

test('does not mutate the supplied environment object', () => {
  const env = Object.freeze({CODEX_MCP_BRIDGE_ALLOW_WRITE: '1'});
  resolveReversePermissions(env);
  assert.deepEqual(env, {CODEX_MCP_BRIDGE_ALLOW_WRITE: '1'});
});
