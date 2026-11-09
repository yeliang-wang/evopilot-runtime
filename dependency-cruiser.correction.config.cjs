module.exports = {
  forbidden: [
    { name: 'correction-unresolved', severity: 'error', from: {}, to: { couldNotResolve: true } },
    { name: 'correction-cycle', severity: 'error', from: {}, to: { circular: true } }
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' }, tsPreCompilationDeps: true, maxDepth: 2,
    doNotFollow: { path: '^(?!src/lifecycle/(?:correction(?:-contract|-planner)?|evidence-qualification)\\.ts$)' }
  }
};
