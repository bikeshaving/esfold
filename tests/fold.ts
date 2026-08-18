import { Linter } from 'eslint';
import type { Linter as LinterTypes } from 'eslint';
import tseslint from 'typescript-eslint';
import fold from '../src/index.js';

const linter = new Linter();

export interface FoldOptions {
  maxWidth?: number;
  tabWidth?: number;
  ts?: boolean;
  sourceType?: 'module' | 'commonjs';
}

function configFor({
  maxWidth = 80,
  tabWidth = 2,
  ts = false,
  sourceType = 'module',
}: FoldOptions): LinterTypes.Config {
  return {
    plugins: { esfold: fold },
    // Flat config reports unused disable directives by default, and
    // `verifyAndFix` applies that fix — which deletes the comment. Every
    // `eslint-disable` in a corpus file is unused under a config running one
    // rule, so leaving this on makes ESLint edit the source and the change
    // gets attributed here.
    linterOptions: { reportUnusedDisableDirectives: 'off' as const },
    rules: {
      'esfold/breaks': ['error', { maxWidth, tabWidth }] as LinterTypes.RuleEntry,
    },
    languageOptions: {
      ...(ts ? { parser: tseslint.parser } : {}),
      ecmaVersion: 'latest' as const,
      sourceType,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  };
}

/**
 * Run the plugin the way a user does: ESLint applies the fixes, so this
 * exercises multipass convergence rather than a single formatting pass.
 */
export function fold_(source: string, options: FoldOptions = {}): string {
  const result = linter.verifyAndFix(source, configFor(options));
  const fatal = result.messages.filter((m) => m.fatal);
  if (fatal.length > 0) {
    throw new Error(`parse failed: ${fatal.map((m) => m.message).join('; ')}`);
  }
  return result.output;
}

/**
 * The rule's own reports for a source, without applying them. The rule
 * reports an over-width line only when it has a legal break position, so an
 * empty result on already-folded output means every remaining long line is
 * genuinely unbreakable.
 */
export function report(source: string, options: FoldOptions = {}) {
  return linter
    .verify(source, configFor(options))
    .filter((message) => message.ruleId === 'esfold/breaks');
}

/**
 * The AST as ESLint built it, from whichever parser the config selected —
 * the same one the rule saw. Tests never pick a parser of their own, so an
 * AST-identity check cannot pass by comparing something fold never ran on.
 */
export function parse(source: string, options: FoldOptions = {}) {
  const sourceType = options.sourceType ?? detectSourceType(source, options);
  if (!sourceType) return null;
  linter.verify(source, { ...configFor({ ...options, sourceType }), rules: {} });
  return linter.getSourceCode().ast;
}

/**
 * Which goal a file parses under. Callers must thread the result through both
 * `fold` and `parse`: letting each decide independently lets a file be folded
 * as a module and compared as a script, which shows up as a phantom AST
 * difference rather than as the configuration mistake it is.
 */
export function detectSourceType(
  source: string,
  options: FoldOptions = {},
): 'module' | 'commonjs' | null {
  for (const sourceType of ['module', 'commonjs'] as const) {
    const messages = linter.verify(source, {
      ...configFor({ ...options, sourceType }),
      rules: {},
    });
    if (!messages.some((m) => m.fatal)) return sourceType;
  }
  return null;
}

export { fold_ as fold };
