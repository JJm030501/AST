const t = require("@babel/types");
const { isSafeLiteral, visit, collectIdentifiers, substitute, extractReturnExpr, makeInc } = require("../utils");

function isSafeArg(node) {
  if (!node) return false;
  if (isSafeLiteral(node)) return true;
  if (t.isIdentifier(node)) return true;

  if (t.isUnaryExpression(node)) {
    if (node.operator === "delete") return false;
    if (node.operator !== "+" && node.operator !== "-") return false;
    return isSafeArg(node.argument);
  }

  return false;
}

function extractReturnExprStrict(fn) {
  if (!(t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn))) return null;
  if (fn.async) return null;
  if (fn.generator) return null;

  return extractReturnExpr(fn);
}

function hasDisallowedSyntax(node) {
  let bad = false;
  visit(node, (n) => {
    if (bad) return;
    if (t.isThisExpression(n)) bad = true;
    if (t.isSuper(n)) bad = true;
    if (t.isMetaProperty(n)) bad = true;
    if (t.isAwaitExpression(n)) bad = true;
    if (t.isYieldExpression(n)) bad = true;
    if (t.isNewExpression(n)) bad = true;
    if (t.isUpdateExpression(n)) bad = true;
    if (t.isAssignmentExpression(n)) bad = true;
    if (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: "eval" })) bad = true;
    if (t.isIdentifier(n, { name: "arguments" })) bad = true;
  });
  return bad;
}

function collectIdentifierCounts(node, counts) {
  visit(node, (n) => {
    if (t.isIdentifier(n)) {
      counts.set(n.name, (counts.get(n.name) || 0) + 1);
    }
  });
}

function tryInlineIIFE(fnNode, callArgs) {
  if (!fnNode.params.every((p) => t.isIdentifier(p))) return null;
  if (callArgs.some((a) => t.isSpreadElement(a))) return null;
  if (callArgs.length !== fnNode.params.length) return null;

  const returnExpr = extractReturnExprStrict(fnNode);
  if (!returnExpr) return null;
  if (hasDisallowedSyntax(returnExpr)) return null;

  const params = fnNode.params;
  const paramNames = params.map((p) => p.name);

  const paramSet = new Set(paramNames);
  const ids = new Set();
  visit(returnExpr, (n) => {
    if (t.isIdentifier(n)) ids.add(n.name);
  });
  for (const name of ids) {
    if (paramSet.has(name)) continue;
    if (
      name === "undefined" ||
      name === "NaN" ||
      name === "Infinity" ||
      name === "Math" ||
      name === "String" ||
      name === "parseInt" ||
      name === "parseFloat" ||
      name === "atob" ||
      name === "btoa"
    ) {
      continue;
    }
    return null;
  }

  const counts = new Map();
  collectIdentifierCounts(returnExpr, counts);

  for (let i = 0; i < params.length; i++) {
    const name = params[i].name;
    const used = counts.get(name) || 0;
    if (used === 0) return null;
  }

  for (let i = 0; i < params.length; i++) {
    const name = params[i].name;
    const used = counts.get(name) || 0;
    if (used <= 1) continue;
    if (!isSafeArg(callArgs[i])) return null;
  }

  const paramMap = new Map();
  for (let i = 0; i < params.length; i++) {
    const arg = callArgs[i];
    if (!arg) return null;
    paramMap.set(params[i].name, arg);
  }

  return substitute(returnExpr, paramMap);
}

module.exports = function iifeInline(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "iife-inline",

    visitor: {
      CallExpression: {
        exit(path) {
          const { callee, arguments: args } = path.node;
          if (!(t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee))) return;

          const inlined = tryInlineIIFE(callee, args);
          if (!inlined) return;

          path.replaceWith(inlined);
          inc();
        },
      },
    },
  };
};
