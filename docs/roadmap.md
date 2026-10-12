# runtime local roadmap

Version 0.1.0 is under construction within the approved local v0.1 scope. This document records implementation status; it does not alter the parent governance roadmap, approve additional work or assert M1 completion.

Implemented: immutable exact Ontology and Harness reference inspection using the owned pinned compatibility contract; M2 Runtime-owned SQLite WAL/FULL state, scoped CAS receipts/audit, immutable project goals and reviewed run plans, code-injected durable dispatch, UNKNOWN recovery and receipt-only reconciliation. See the [service API](service.md). Storage patterns were adapted from the verified new-product reference into owned code with packaged provenance.

The owned standalone CLI now validates closed JSON requests before initialization and routes explicit dispatch/reconcile to the durable service. Help, version, capabilities and imports are read-only. Resolvers and executors are absent in the standalone CLI; external provider wiring remains parent M3 work. See the [CLI contract](cli.md). This adds no production or Host pass.

Independent source check/build commands validate this product without a parent generator. Tests and local packed-artifact rehearsal are technical checks, not product acceptance. Retained legacy libraries do not imply completed operational migration.

Pending: operator filesystem verification, M3 shared HTTP broker, actual owning-product composition adapter, MCP transport, unified Expert/Codex experience, operational migration and applicable E01–E19 evidence. GitHub publication is a later separately authorized stage. Stable 1.0, production readiness and full acceptance are not claimed.

See the [product entry and API links](../README.md).

