/**
 * Build the reverse Bridge's permission-related defaults. Explicitly supplied
 * environment values take precedence; undefined values use conservative defaults.
 * Upstream loadBridgeConfig validates the resulting values and combinations.
 */
export function resolveReversePermissions(env = process.env) {
  return {
    CODEX_MCP_BRIDGE_DEFAULT_SANDBOX:
      env.CODEX_MCP_BRIDGE_DEFAULT_SANDBOX ?? 'read-only',
    CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY:
      env.CODEX_MCP_BRIDGE_DEFAULT_ACCESS_STRATEGY ?? 'read-only',
    CODEX_MCP_BRIDGE_ALLOW_WRITE:
      env.CODEX_MCP_BRIDGE_ALLOW_WRITE ?? '0',
    CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS:
      env.CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS ?? '0',
  };
}
