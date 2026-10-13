# Security and local trust

Runtime is Preview software. It assumes a non-malicious single OS uid, an explicitly owned canonical workspace, and trusted code-injected providers. It is not a multi-user isolation boundary and cannot protect state from hostile code running as the same uid. Node SQLite is experimental.

Workspace identity, ownership checks, closed JSON envelopes, exact scopes, immutable pins, revision checks and durable receipts constrain supported operations. They do not make untrusted adapters safe. The standalone CLI does not load providers from requests and does not configure an executor. Only trusted host code may inject resolvers, execution and receipt inspection.

Use isolated workspaces for tests. Preserve daily data, credentials, exact requests and receipts. After uncertain execution, inspect and reconcile the original claim; do not infer permission to redispatch. Cancellation or timeout does not prove that external work stopped.

## Reporting

Do not put secrets, tokens, private paths, workspace databases, raw receipts or private authority evidence in public issues. For sensitive reports, contact the repository maintainer through an already established private channel and agree on a secure way to share a minimal reproduction. If no private channel is available, post only a nonsensitive request for contact; do not attach sensitive evidence.

Public reports should describe the affected version, local trust assumptions and a sanitized reproduction. Technical validation does not establish production readiness, acceptance or release authority. No security support lifetime is promised for this Preview.
