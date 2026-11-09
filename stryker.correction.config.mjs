import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Stryker 10 uses execaCommand without a shell: quotes are literal; escaped spaces are supported.
const commandArg = value => {
  if (/[\r\n\t]/.test(value)) throw new Error('Unsupported compiler path whitespace');
  return value.replaceAll(' ', '\\ ');
};
if (require('typescript/package.json').version !== '5.9.3') throw new Error('Mutation compiler must be TypeScript 5.9.3');
const compiler = require.resolve('typescript/bin/tsc');
const source = readFileSync(new URL('./src/lifecycle/correction-planner.ts', import.meta.url), 'utf8');
const lines = source.split('\n');
const indexes = lines.flatMap((line, index) => line.includes('expected[key] !== observed[key]') ? [index + 1] : []);
if (indexes.length !== 1) throw new Error('Known binding comparison must occur exactly once');
const line = indexes[0];
const expression = 'expected[key] !== observed[key]';
const column = lines[line - 1].indexOf(expression);
// A finite meaningful comparison pilot; its exact source bytes are bound by the driver.
export default {
  mutate: [`src/lifecycle/correction-planner.ts:${line}:${column}-${line}:${column + expression.length}`],
  testRunner: 'tap', plugins: ['@stryker-mutator/tap-runner'], concurrency: 1,
  coverageAnalysis: 'off',
  // Only the one !== comparison is mutated in this first known-kill pilot.
  mutator: { excludedMutations: ['ArithmeticOperator', 'ArrayDeclaration', 'ArrowFunction', 'AssignmentOperator', 'BlockStatement', 'BooleanLiteral', 'CallExpression', 'ConditionalExpression', 'LogicalOperator', 'MethodExpression', 'ObjectLiteral', 'OptionalChaining', 'Regex', 'StringLiteral', 'UnaryOperator', 'UpdateOperator'] },
  tap: {
    testFiles: ['tests/e2e/lifecycle-correction-planner-v090.test.mjs'],
    // Each TAP file already has its own process; keep the hook and tests together.
    // Keep this pilot on the three original comparison/mapping regressions;
    // full collector integration runs in the ordinary source suite.
    nodeArgs: ['--test', '--test-isolation=none', '--test-name-pattern=^(phase-specific bindings|preflight rejects observed|fixed mapping rejects)', '--test-reporter=tap', '-r', '{{hookFile}}', '{{testFile}}'], forceBail: false
  },
  // Stryker runs the build before creating its inner node_modules symlink.
  buildCommand: `${commandArg(process.execPath)} ${commandArg(compiler)} -p tsconfig.correction-pilot.json`,
  timeoutMS: 5000, timeoutFactor: 1.5, dryRunTimeoutMinutes: 1,
  reporters: ['clear-text', 'json'], jsonReporter: { fileName: 'reports/correction-mutation.json' },
  thresholds: { high: 80, low: 60, break: null }, cleanTempDir: true
};
