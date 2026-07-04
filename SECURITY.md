# Security Policy

commons-keeper runs with a GitHub token (`GH_TOKEN`) scoped to labor-commons and, optionally, an inference provider key. No API keys, tokens, or credentials belong in this repository — they are deployment-specific and injected at runtime via environment or a secret store. Do not commit a usable secret under any circumstance.

## Reporting

For security concerns related to commons-keeper or the wider OLF platform, see the full policy in [open-labor-foundation](https://github.com/Open-Labor-Foundation/open-labor-foundation/blob/main/SECURITY.md).

Report vulnerabilities to **[security@openlabor.foundation](mailto:security@openlabor.foundation)**.
