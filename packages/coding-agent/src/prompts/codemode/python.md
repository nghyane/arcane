# Python

Persistent IPython kernel. State survives across calls.
- Variables, imports, and state persist between executions
- Use for: data analysis, visualization, complex computation, prototyping
- Kernel auto-starts on first call
{{#if categories}}
Available helpers:
{{#each categories}}
**{{@key}}**: {{#each this}}{{name}}{{#unless @last}}, {{/unless}}{{/each}}
{{/each}}
{{/if}}