#!/usr/bin/env node
/**
 * CRAP (Change Risk Anti-Patterns) report.
 *
 * CRAP(m) = CC(m)^2 * (1 - cov(m)/100)^3 + CC(m)
 *
 * CC(m)   = cyclomatic complexity of the function.
 * cov(m)  = percentage of the function's own statements exercised by the
 *           unit test suite (statement coverage from the c8 report).
 *
 * Functions with a score above 30 are "CRAP-y": complex and not tested
 * enough to change safely. Threshold and formula origin: Bill Hetrick's
 * crap4j metric, as documented by NDepend and the Google Testing Blog.
 *
 * Reads coverage/coverage-final.json produced by `npm run test:coverage`
 * and analyzes TypeScript files (default: top-level *.ts package sources).
 *
 * Usage:
 *   node scripts/crap-report.mjs [--fail-above N] [--all] [files...]
 *
 *   --fail-above N  exit 1 when any function scores above N (advisory
 *                   report otherwise; no gate by default).
 *   --all           list every function, not only those scoring >= 30.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const CRAP_THRESHOLD = 30;
const DEFAULT_COVERAGE = "coverage/coverage-final.json";

/** CRAP score for a function with the given complexity and coverage %. */
export function computeCrap(complexity, coveragePct) {
  const uncovered = 1 - Math.min(Math.max(coveragePct, 0), 100) / 100;
  return complexity * complexity * uncovered ** 3 + complexity;
}

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function isFunctionLike(node) {
  return FUNCTION_LIKE.has(node.kind);
}

/** Cyclomatic complexity of one function, excluding nested functions. */
export function complexityOf(fnNode) {
  let complexity = 1;
  const visit = (node) => {
    if (isFunctionLike(node)) return; // nested functions score on their own
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CaseClause:
        complexity += 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = node.operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity += 1;
        }
        break;
      }
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };
  if (fnNode.body) visit(fnNode.body);
  return complexity;
}

function labelFor(fnNode, sourceFile) {
  if (fnNode.name && ts.isIdentifier(fnNode.name)) return fnNode.name.text;
  const parent = fnNode.parent;
  if (!parent) return "(anonymous)";
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent)) &&
    parent.name
  ) {
    return parent.name.getText(sourceFile);
  }
  if (ts.isCallExpression(parent)) {
    return "(inline callback)";
  }
  return "(anonymous)";
}

/**
 * Collect every function in a TypeScript source with its complexity,
 * line span, and line spans of nested functions (so their statements are
 * not credited to the enclosing function's coverage).
 */
export function collectFunctions(sourceText, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = [];
  const visit = (node) => {
    if (isFunctionLike(node)) {
      const start = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      functions.push({
        name: labelFor(node, sourceFile),
        complexity: complexityOf(node),
        startLine: start.line + 1,
        endLine: end.line + 1,
        nested: [],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  // Attribute nested-function statements to the nested function only.
  for (const fn of functions) {
    for (const other of functions) {
      if (other === fn) continue;
      if (other.startLine >= fn.startLine && other.endLine <= fn.endLine) {
        fn.nested.push([other.startLine, other.endLine]);
      }
    }
  }
  return functions;
}

function inNested(line, spans) {
  for (const [start, end] of spans) {
    if (line >= start && line <= end) return true;
  }
  return false;
}

/** Statement coverage % for a function's own statements, or null when the
 *  file has no coverage data (treated as 0% by the caller). */
export function coverageFor(coverageEntry, fn) {
  if (!coverageEntry || !coverageEntry.statementMap) return null;
  const map = coverageEntry.statementMap;
  const counts = coverageEntry.s;
  let total = 0;
  let covered = 0;
  for (const [id, loc] of Object.entries(map)) {
    const line = loc.start.line;
    if (line < fn.startLine || line > fn.endLine) continue;
    if (inNested(line, fn.nested)) continue;
    total += 1;
    if ((counts[id] ?? 0) > 0) covered += 1;
  }
  if (total === 0) return 100; // no statements of its own (e.g. empty body)
  return (covered / total) * 100;
}

function loadCoverage(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function targetFiles(argvFiles) {
  if (argvFiles.length > 0) {
    return argvFiles.map((f) => path.resolve(f));
  }
  return fs
    .readdirSync(".")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => path.resolve(f));
}

function formatRow(row) {
  return [
    row.crap.toFixed(1).padStart(6),
    String(row.complexity).padStart(3),
    `${row.coverage.toFixed(0)}%`.padStart(5),
    row.location.padEnd(42),
    row.name,
  ].join("  ");
}

function main() {
  const args = process.argv.slice(2);
  let failAbove = null;
  let showAll = false;
  const files = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--fail-above") {
      failAbove = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === "--all") {
      showAll = true;
    } else {
      files.push(args[i]);
    }
  }

  const coverage = loadCoverage(DEFAULT_COVERAGE);
  if (!coverage) {
    console.error(
      `No coverage data at ${DEFAULT_COVERAGE}. Run: npm run test:coverage`,
    );
    process.exit(2);
  }

  const rows = [];
  for (const file of targetFiles(files)) {
    const sourceText = fs.readFileSync(file, "utf8");
    const entry = coverage[path.resolve(file)] ?? null;
    const rel = path.relative(process.cwd(), file);
    for (const fn of collectFunctions(sourceText, file)) {
      const cov = coverageFor(entry, fn);
      const effectiveCov = cov === null ? 0 : cov;
      rows.push({
        name: fn.name,
        complexity: fn.complexity,
        coverage: effectiveCov,
        crap: computeCrap(fn.complexity, effectiveCov),
        location: `${rel}:${fn.startLine}`,
      });
    }
  }

  rows.sort((a, b) => b.crap - a.crap);
  const flagged = rows.filter((r) => r.crap >= CRAP_THRESHOLD);
  const listed = showAll ? rows : flagged;

  console.log(
    `CRAP analysis: ${rows.length} functions in ${targetFiles(files).length} files ` +
      `(${Object.keys(coverage).length} files in coverage data)`,
  );
  console.log("");
  if (listed.length === 0) {
    console.log(
      showAll
        ? ""
        : `No function scores >= ${CRAP_THRESHOLD}. Minimum score: ` +
            Math.min(...rows.map((r) => r.crap)).toFixed(1),
    );
  } else {
    console.log(" CRAP    CC   Cov%  Location                               Function");
    console.log("------ ---- -----  -------------------------------------  --------");
    for (const row of listed) console.log(formatRow(row));
  }
  console.log("");
  console.log(
    `Summary: ${flagged.length}/${rows.length} functions at or above the ` +
      `CRAP threshold of ${CRAP_THRESHOLD}; max score ` +
      (rows.length > 0 ? rows[0].crap.toFixed(1) : "n/a") +
      ".",
  );
  console.log(
    "Formula: CC^2 * (1 - coverage)^3 + CC. Coverage is statement-level " +
      "from the unit test run; files absent from coverage count as 0%.",
  );

  if (failAbove !== null) {
    const failing = rows.filter((r) => r.crap > failAbove);
    if (failing.length > 0) {
      console.error(
        `\nFAIL: ${failing.length} function(s) score above ${failAbove}.`,
      );
      process.exit(1);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
