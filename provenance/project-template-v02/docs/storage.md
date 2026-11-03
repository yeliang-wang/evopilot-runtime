# Storage and recovery

`workspace-project.json` describes this editable project and the v1 asset specifications. It is not a runtime identity or execution approval.

Ontology, Harness and Runtime own their state in a separate protected data directory. Use `workspace_inspect` through the EvoPilot plugin to find its actual location. The local installation binding records the relationship; portable project files do not include machine paths.

Do not copy or edit `workspace.json`, database files or historical receipts to move a Workspace. Use the product's checked backup and migration workflow. A snapshot taken while execution is uncertain cannot resolve that execution; query the retained receipt first.

Template upgrades must preserve customized files. Asset source changes create drafts, and only reviewed deliveries become inputs for a new Runtime evaluation. Existing runs retain their old source revision and asset pins.
