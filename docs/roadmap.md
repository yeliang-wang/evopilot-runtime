# Runtime roadmap

Runtime 0.1.0 implements the generic durable service and standalone CLI within the approved local 0.1.x scope. This roadmap describes current implementation and remaining validation; it creates no new capability scope or release authorization.

The original M0–M4 baseline is retained. A subsequent explicit M5 user decision authorizes source, CI and public release preparation for `yeliang-wang/evopilot`, `yeliang-wang/evopilot-runtime`, `yeliang-wang/evopilot-harness` and `yeliang-wang/evopilot-ontology`, superseding the earlier local-only GitHub restriction within that scope. This bounded Runtime task adds no feature implementation or acceptance claim and performs no actual Release, tag, remote operation or daily install. Preparation defaults to `publish=false`; publication remains subject to external M5 target validation and a separate explicit user decision.

Implemented Runtime functions include scoped projects, immutable goals, exact published Ontology/Harness pins, immutable reviewed plans, scoped human decisions, SQLite WAL/FULL persistence, global revision CAS, idempotent receipts and atomic audit. Dispatch commits one durable claim before invoking trusted code. UNKNOWN recovery uses receipt inspection without redispatch. See the [service API](service.md).

The [standalone CLI](cli.md) validates closed JSON requests before explicit workspace initialization and routes dispatch/reconcile to the service. Discovery and imports are read-only. The standalone CLI supplies no resolvers, executor or receipt inspector.

Parent EvoPilot Preview provides actual native published Ontology/Harness resolvers and execution/receipt inspection for representative quality and business validation. Actual three-product composition and installed two-MCP-adapter shared-service, lost-response, restart and uninstall-preservation checks have passed as technical evidence. No arbitrary coding agent, new LLM or credential adapter is configured. The separately distributed parent Preview product entry documents that composed experience.

The operator-reported technical baseline is 29 Runtime tests passing plus check/build, and 394 full parent tests passing with zero skipped. The [verification scope](service.md) distinguishes these retained results from final acceptance. The root capability stage remains `M2_OWNED_SERVICE`; it describes this package's implemented API, not the parent's integration status.

Next work remains within approved 0.1.x: gather real-project feedback on the current functions and address reproducible issues within that scope. Current Desktop E01–E19 acceptance status comes from a separate exact-candidate-bound acceptance report; without that report, no Host acceptance claim may be made; its status belongs in the separate candidate-bound acceptance report. Technical tests do not establish Host PASS, old 6.3 feature parity, operational migration completeness, production readiness or release authority. Publication remains a separately authorized action.

Return to the [product entry](../README.md).

