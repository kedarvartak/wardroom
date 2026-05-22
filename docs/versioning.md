# Versioning

## Strategy

This project uses **Semantic Versioning** (`MAJOR.MINOR.PATCH`).

| Bump | When |
|------|------|
| MAJOR | Breaking change to MCP tool signatures or `AGENTS.md` format |
| MINOR | New tool added, new config option, backward-compatible |
| PATCH | Bug fix, doc update, internal refactor |

## Format Version

The `AGENTS.md` log format is versioned independently as `format: N` in its header. If the format changes in a breaking way (e.g. session structure changes), the format version bumps. Older MCP versions will refuse to write to a newer format to avoid corruption.

## Changelog

### v0.1.0 — 2026-05-22
- Initial release
- Tools: `start_session`, `append_message`, `read_memory`, `get_context`
- Format version: 1

## MCP Protocol Compatibility

| MCP Server Version | MCP Protocol | Notes |
|--------------------|--------------|-------|
| 0.1.x | 2024-11-05 | Initial support |

## Upgrade Notes

### v0.1.0
First version. No migration needed.
