# runtime local roadmap

Version 0.1.0 is currently at M2 owned-service implementation within the approved local v0.1 scope. This document records implementation status; it does not alter the parent governance roadmap or approve additional work.

Implemented: immutable exact Ontology and Harness reference inspection using the owned pinned compatibility contract; M2 Runtime-owned SQLite WAL/FULL state, scoped CAS receipts/audit, immutable project goals and reviewed run plans, code-injected durable dispatch, UNKNOWN recovery and receipt-only reconciliation. See the [service API](service.md). Storage patterns were adapted from the verified new-product reference into owned code with packaged provenance.

The owned standalone CLI now validates closed JSON requests before initialization and routes explicit dispatch/reconcile to the durable service. Help, version, capabilities and imports are read-only. Resolvers and executors are absent in the standalone CLI; external provider wiring remains parent M3 work. See the [CLI contract](cli.md). This adds no production or Host pass.

Independent source check/build commands validate this product without a parent generator. Tests and local packed-artifact rehearsal are technical checks, not product acceptance. Retained legacy libraries do not imply completed operational migration.

Retained R37 verification reports all 29 owned tests plus check/build passing, including CLI and service filesystem contracts; see the [verification scope](service.md). The earlier three-owning-service protocol test passed. Parent composition adapter R41 repair remains ongoing and unaccepted.

Pending M3: shared service/HTTP broker, actual owning-product composition adapter integration and real E2E repair, MCP transport, unified Expert/Codex experience and Host validation. Operational migration and applicable E01–E19 evidence remain pending. GitHub publication is a later separately authorized stage. Stable 1.0, production readiness and full acceptance are not claimed.

See the [product entry and API links](../README.md).

