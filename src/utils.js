/**
 * 公共工具函数
 *
 * 从多个插件中提取的通用逻辑，避免重复代码。
 */

const t = require("@babel/types");

// ── 字面量判断 ──

function isSafeLiteral(node) {
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node)
  );
}

function isSafeConst(node) {
  if (!node) return false;
  if (isSafeLiteral(node)) return true;

  if (
    t.isUnaryExpression(node) &&
    (node.operator === "-" || node.operator === "+") &&
    t.isNumericLiteral(node.argument)
  ) {
    return true;
  }

  if (t.isIdentifier(node)) {
    return (
      node.name === "undefined" ||
      node.name === "NaN" ||
      node.name === "Infinity"
    );
  }

  return false;
}

// ── AST 遍历 ──

/**
 * 简单递归遍历 AST 节点, 对每个节点调用 fn
 */
function visit(node, fn) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type !== "string") return;
  fn(node);

  if (t.isMemberExpression(node)) {
    visit(node.object, fn);
    if (node.computed) visit(node.property, fn);
    return;
  }

  if (t.isObjectProperty(node)) {
    if (node.computed) visit(node.key, fn);
    visit(node.value, fn);
    return;
  }

  if (t.isObjectMethod(node)) {
    if (node.computed) visit(node.key, fn);
    for (const p of node.params) visit(p, fn);
    visit(node.body, fn);
    return;
  }

  const keys = t.VISITOR_KEYS[node.type];
  if (!keys) return;
  for (const k of keys) {
    const v = node[k];
    if (Array.isArray(v)) {
      for (const item of v) visit(item, fn);
    } else {
      visit(v, fn);
    }
  }
}

/**
 * 收集节点内所有 Identifier 名称
 */
function collectIdentifiers(node, out) {
  if (!node) return;
  if (t.isIdentifier(node)) {
    out.add(node.name);
    return;
  }

  const keys = t.VISITOR_KEYS[node.type];
  if (!keys) return;
  for (const k of keys) {
    const v = node[k];
    if (Array.isArray(v)) {
      for (const item of v) collectIdentifiers(item, out);
    } else {
      collectIdentifiers(v, out);
    }
  }
}

// ── 声明清理 ──

/**
 * 移除一个 VariableDeclarator, 如果它是所属 VariableDeclaration 的最后一个则连声明一起删
 */
function removeDeclaratorAndCleanup(declPath, onChange) {
  if (!declPath || declPath.removed) return;
  const varDeclPath = declPath.parentPath;
  if (!varDeclPath || !varDeclPath.isVariableDeclaration()) {
    try {
      declPath.remove();
      if (typeof onChange === "function") onChange();
    } catch (e) {}
    return;
  }

  try {
    declPath.remove();
    if (typeof onChange === "function") onChange();
  } catch (e) {
    return;
  }
  if (varDeclPath.removed || !varDeclPath.node) return;
  if (!Array.isArray(varDeclPath.node.declarations)) return;
  if (varDeclPath.node.declarations.length === 0) {
    try {
      varDeclPath.remove();
      if (typeof onChange === "function") onChange();
    } catch (e) {}
  }
}

// ── 参数替换 (用于 IIFE/包装器内联) ──

/**
 * 将表达式中的参数标识符替换为对应的实参节点
 */
function substitute(node, paramMap) {
  if (!node) return null;

  if (t.isIdentifier(node) && paramMap.has(node.name)) {
    return t.cloneNode(paramMap.get(node.name), true);
  }

  if (isSafeLiteral(node)) return t.cloneNode(node, true);
  if (t.isIdentifier(node)) return t.cloneNode(node, true);

  if (t.isBinaryExpression(node)) {
    const left = substitute(node.left, paramMap);
    const right = substitute(node.right, paramMap);
    if (!left || !right) return null;
    return t.binaryExpression(node.operator, left, right);
  }

  if (t.isLogicalExpression(node)) {
    const left = substitute(node.left, paramMap);
    const right = substitute(node.right, paramMap);
    if (!left || !right) return null;
    return t.logicalExpression(node.operator, left, right);
  }

  if (t.isUnaryExpression(node)) {
    const arg = substitute(node.argument, paramMap);
    if (!arg) return null;
    return t.unaryExpression(node.operator, arg, node.prefix);
  }

  if (t.isConditionalExpression(node)) {
    const test = substitute(node.test, paramMap);
    const cons = substitute(node.consequent, paramMap);
    const alt = substitute(node.alternate, paramMap);
    if (!test || !cons || !alt) return null;
    return t.conditionalExpression(test, cons, alt);
  }

  if (t.isCallExpression(node)) {
    const callee = substitute(node.callee, paramMap);
    if (!callee) return null;
    const args = [];
    for (const a of node.arguments) {
      if (t.isSpreadElement(a)) return null;
      const na = substitute(a, paramMap);
      if (!na) return null;
      args.push(na);
    }
    return t.callExpression(callee, args);
  }

  if (t.isMemberExpression(node)) {
    const obj = substitute(node.object, paramMap);
    if (!obj) return null;

    let prop;
    if (node.computed) {
      prop = substitute(node.property, paramMap);
      if (!prop) return null;
    } else {
      prop = t.cloneNode(node.property, true);
    }

    return t.memberExpression(obj, prop, node.computed, node.optional);
  }

  if (t.isSequenceExpression(node)) {
    const exprs = node.expressions.map((e) => substitute(e, paramMap));
    if (exprs.some((e) => !e)) return null;
    return t.sequenceExpression(exprs);
  }

  return null;
}

// ── 函数体提取 ──

/**
 * 从简单函数中提取 return 表达式 (仅单条 return 语句或箭头函数表达式)
 */
function extractReturnExpr(fn) {
  if (!(t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn))) return null;
  if (t.isBlockStatement(fn.body)) {
    if (fn.body.body.length !== 1) return null;
    const stmt = fn.body.body[0];
    if (!t.isReturnStatement(stmt)) return null;
    if (!stmt.argument) return null;
    return stmt.argument;
  }
  return fn.body; // arrow fn expr
}

// ── 计数器 ──

/**
 * 创建标准的计数器 increment 函数
 */
function makeInc(counter) {
  return (n = 1) => {
    if (!counter) return;
    if (!Number.isFinite(counter.count)) counter.count = 0;
    counter.count += n;
  };
}

module.exports = {
  isSafeLiteral,
  isSafeConst,
  visit,
  collectIdentifiers,
  removeDeclaratorAndCleanup,
  substitute,
  extractReturnExpr,
  makeInc,
};
