# Architecture

HuaweiCloud DevKit is an agent guidance and safety package, not a service encyclopedia.

## Layers

1. Plugin manifests make the package discoverable by agent clients.
2. Skills compress Huawei Cloud operating knowledge into small routing workflows.
3. MCP tools expose safe local planning and read-only inspection.
4. Hooks block high-risk tool calls before execution on platforms that support them.
5. The shared safety policy keeps Node MCP tools and Python hooks aligned.

## Capability Sources

- Huawei Cloud Skills: scenario workflows and recipes.
- KooCLI `hcloud`: local inspection and reviewed command execution.
- API documentation: exact endpoint, request body, pagination, project_id, and error behavior.
- SDK documentation: application integration.
- MCP: structured tools when official or approved servers exist.
- Terraform Provider: lower-priority V1 path for reviewed IaC.

## Design Principle

The plugin should help an agent choose the shortest safe path. It should not copy every service document or become a stale mirror of Huawei Cloud documentation.
