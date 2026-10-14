import assert from "node:assert/strict";
import test from "node:test";
import {
  collectFunctions,
  computeCrap,
  coverageFor,
} from "../scripts/crap-report.mjs";

test("CRAP formula matches the published metric", () => {
  // Minimum score: complexity 1, fully covered.
  assert.equal(computeCrap(1, 100), 1);
  // Complexity 5 with zero coverage lands exactly on the threshold of 30.
  assert.equal(computeCrap(5, 0), 30);
  // The metric's documented example: complexity 10 needs about 42%
  // coverage to drop below 30, but 41% leaves it above.
  assert.ok(computeCrap(10, 42) < 30);
  assert.ok(computeCrap(10, 41) > 30);
  // More coverage can never raise the score.
  assert.ok(computeCrap(8, 90) < computeCrap(8, 50));
});

const SNIPPET = `
function greet(name: string) {
  if (name && name.length > 0) {
    return "hi " + name;
  } else {
    return "hi";
  }
}
const outer = (x: number) => {
  if (x > 0) return 1;
  const inner = (y: number) => {
    if (y) return 1;
    if (y > 2) return 2;
    if (y > 3) return 3;
    return 0;
  };
  return inner(x);
};
`;

test("complexity counts decision points but not nested functions", () => {
  const functions = collectFunctions(SNIPPET, "snippet.ts");
  const byName = new Map(functions.map((f) => [f.name, f]));
  // greet: one if + one && => 3.
  assert.equal(byName.get("greet").complexity, 3);
  // outer: one if; the inner arrow's three ifs belong to inner, not outer.
  assert.equal(byName.get("outer").complexity, 2);
  assert.equal(byName.get("inner").complexity, 4);
});

test("coverage is attributed only to a function's own statements", () => {
  const functions = collectFunctions(SNIPPET, "snippet.ts");
  const outer = functions.find((f) => f.name === "outer");
  const inner = functions.find((f) => f.name === "inner");

  // Fake istanbul entry: outer's own if (missed) plus two statements
  // inside inner (one hit, one missed).
  const statementMap = {
    a: { start: { line: outer.startLine + 1, column: 0 }, end: { line: outer.startLine + 1, column: 10 } },
    b: { start: { line: inner.startLine + 1, column: 0 }, end: { line: inner.startLine + 1, column: 10 } },
    c: { start: { line: inner.startLine + 2, column: 0 }, end: { line: inner.startLine + 2, column: 10 } },
  };
  const entry = { statementMap, s: { a: 0, b: 5, c: 0 } };

  // Inner statements must not count toward outer: outer has only its
  // own missed statement => 0% coverage.
  assert.equal(coverageFor(entry, outer), 0);
  // Inner sees both of its statements, one covered => 50%.
  assert.equal(coverageFor(entry, inner), 50);
  // A file with no coverage data reports null (caller treats it as 0%).
  assert.equal(coverageFor(null, outer), null);
});

test("complexityOf scores loops, switches, catch, and ternaries", () => {
  const source = `
function demo(items: string[], flag: boolean) {
  try {
    for (const item of items) {
      if (item === "a") continue;
    }
    while (flag) break;
    switch (items[0]) {
      case "x":
        break;
      case "y":
        break;
      default:
        break;
    }
    return flag ? 1 : 0;
  } catch {
    return -1;
  }
}
`;
  const fn = collectFunctions(source, "demo.ts").find(
    (f) => f.name === "demo",
  );
  // 1 + for + if + while + 2 cases + ternary + catch = 8.
  assert.equal(fn.complexity, 8);
});
