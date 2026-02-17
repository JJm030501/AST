/**
 * VM 分析器
 *
 * 给定检测到的 VM 模式, 提取:
 *   - bytecodeArray: 字节码数组的值 (尝试静态解析)
 *   - stackVar: 栈变量名
 *   - regsVar: 寄存器变量名
 *   - opcodeHandlers: 每个 opcode 对应的 handler 代码
 */

const t = require("@babel/types");
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;
const { visit } = require("../utils");

function getMethodName(prop, computed) {
  if (!computed && t.isIdentifier(prop)) return prop.name;
  if (computed && t.isStringLiteral(prop)) return prop.value;
  return null;
}

/**
 * 尝试静态解析数组表达式的值
 */
function resolveArrayElements(node) {
  if (!t.isArrayExpression(node)) return null;
  const out = [];
  for (const el of node.elements) {
    if (!el) { out.push(null); continue; }
    if (t.isNumericLiteral(el)) { out.push(el.value); continue; }
    if (t.isStringLiteral(el)) { out.push(el.value); continue; }
    if (t.isBooleanLiteral(el)) { out.push(el.value); continue; }
    if (t.isNullLiteral(el)) { out.push(null); continue; }
    if (t.isUnaryExpression(el, { operator: "-" }) && t.isNumericLiteral(el.argument)) {
      out.push(-el.argument.value); continue;
    }
    // 无法静态解析的元素标记为 Symbol
    out.push({ __dynamic: true, code: generator(el).code });
  }
  return out;
}

// ── Switch-Dispatch VM 分析 ──

function analyzeSwitchDispatchVM(ast, pattern) {
  const { switchNode, codeVar, pcVar, loopPath } = pattern;

  // 1. 识别 stack 和 regs 变量
  const varUsage = {};

  function trackVar(name) {
    if (!varUsage[name]) {
      varUsage[name] = { pushCount: 0, popCount: 0, bracketRead: 0, bracketWrite: 0 };
    }
    return varUsage[name];
  }

  for (const c of switchNode.cases) {
    for (const stmt of c.consequent || []) {
      visit(stmt, (n) => {
        // push/pop 调用
        if (t.isCallExpression(n) && t.isMemberExpression(n.callee)) {
          const objName = t.isIdentifier(n.callee.object) ? n.callee.object.name : null;
          if (!objName) return;
          const method = getMethodName(n.callee.property, n.callee.computed);
          if (method === "push") trackVar(objName).pushCount++;
          if (method === "pop") trackVar(objName).popCount++;
        }

        // 中括号读: regs[x]
        if (t.isMemberExpression(n) && n.computed) {
          const objName = t.isIdentifier(n.object) ? n.object.name : null;
          if (objName && objName !== codeVar) {
            trackVar(objName).bracketRead++;
          }
        }

        // 中括号写: regs[x] = ...
        if (t.isAssignmentExpression(n) && t.isMemberExpression(n.left) && n.left.computed) {
          const objName = t.isIdentifier(n.left.object) ? n.left.object.name : null;
          if (objName && objName !== codeVar) {
            trackVar(objName).bracketWrite++;
          }
        }
      });
    }
  }

  // 识别 stack: push+pop 都最多的变量
  let stackVar = null;
  let maxStackOps = 0;
  for (const [name, u] of Object.entries(varUsage)) {
    if (name === codeVar || name === pcVar) continue;
    const total = u.pushCount + u.popCount;
    if (u.pushCount > 0 && u.popCount > 0 && total > maxStackOps) {
      maxStackOps = total;
      stackVar = name;
    }
  }

  // 识别 regs: 中括号读+写都有, 且不是 stack 也不是 code
  let regsVar = null;
  for (const [name, u] of Object.entries(varUsage)) {
    if (name === codeVar || name === pcVar || name === stackVar) continue;
    if (u.bracketRead > 0 && u.bracketWrite > 0) {
      regsVar = name;
      break;
    }
  }

  // 2. 提取每个 opcode handler
  const opcodeHandlers = [];
  for (const c of switchNode.cases) {
    if (!c.test) continue; // skip default

    let opcodeValue = null;
    if (t.isNumericLiteral(c.test)) opcodeValue = c.test.value;
    else if (t.isStringLiteral(c.test)) opcodeValue = c.test.value;
    else continue;

    const handlerStmts = (c.consequent || []).filter(
      (s) => !t.isBreakStatement(s) && !t.isContinueStatement(s)
    );
    const handlerCode = handlerStmts
      .map((s) => generator(s).code)
      .join("\n");

    opcodeHandlers.push({
      opcode: opcodeValue,
      stmts: handlerStmts,
      code: handlerCode,
    });
  }

  // 3. 尝试解析字节码数组
  const bytecodeInfo = resolveBytecode(ast, codeVar, loopPath);

  return {
    type: "switch-dispatch",
    codeVar,
    pcVar,
    stackVar,
    regsVar,
    opcodeHandlers,
    bytecodeInfo,
    caseCount: pattern.caseCount,
    varUsage,
  };
}

/**
 * 尝试找到并解析字节码数组变量的值
 */
function resolveBytecode(ast, codeVar, loopPath) {
  if (!codeVar) return null;

  // 情况 1: 函数参数 — 追溯到 IIFE 调用的实参
  const funcParent = loopPath.getFunctionParent();
  if (funcParent) {
    const params = funcParent.node.params;
    const paramIndex = params.findIndex(
      (p) => t.isIdentifier(p, { name: codeVar })
    );
    if (paramIndex >= 0) {
      // 找 IIFE 调用
      const callExpr = funcParent.parentPath;
      if (
        callExpr &&
        callExpr.isCallExpression &&
        callExpr.isCallExpression()
      ) {
        const args = callExpr.node.arguments;
        if (args && args[paramIndex]) {
          const argNode = args[paramIndex];
          // 直接是数组
          if (t.isArrayExpression(argNode)) {
            return {
              source: "iife-argument",
              elements: resolveArrayElements(argNode),
              length: argNode.elements.length,
            };
          }
          // 是变量引用 — 在程序作用域中查找
          if (t.isIdentifier(argNode)) {
            return resolveVarArray(ast, argNode.name);
          }
        }
      }
    }
  }

  // 情况 2: 程序作用域中的变量
  return resolveVarArray(ast, codeVar);
}

function resolveVarArray(ast, varName) {
  let result = null;

  traverse(ast, {
    VariableDeclarator(path) {
      if (result) return;
      if (!t.isIdentifier(path.node.id, { name: varName })) return;
      if (!t.isArrayExpression(path.node.init)) return;
      result = {
        source: "variable",
        varName,
        elements: resolveArrayElements(path.node.init),
        length: path.node.init.elements.length,
      };
    },
  });

  return result;
}

// ── Handler-Table VM 分析 ──

function analyzeHandlerTableVM(ast, pattern) {
  const { handlerVar, codeVar, pcTarget, loopPath } = pattern;

  // 收集 handler 函数: handlerVar[key] = function(...) { ... }
  const opcodeHandlers = [];

  traverse(ast, {
    ExpressionStatement(path) {
      const expr = path.node.expression;
      if (!t.isAssignmentExpression(expr, { operator: "=" })) return;
      if (!t.isMemberExpression(expr.left)) return;
      if (!t.isIdentifier(expr.left.object, { name: handlerVar })) return;
      if (
        !(
          t.isFunctionExpression(expr.right) ||
          t.isArrowFunctionExpression(expr.right)
        )
      ) {
        return;
      }

      let opcodeValue = null;
      const prop = expr.left.property;
      if (expr.left.computed) {
        if (t.isNumericLiteral(prop)) opcodeValue = prop.value;
        else if (t.isStringLiteral(prop)) opcodeValue = prop.value;
      } else {
        if (t.isIdentifier(prop)) opcodeValue = prop.name;
      }

      if (opcodeValue === null) return;

      const fnNode = expr.right;
      const bodyStmts = t.isBlockStatement(fnNode.body)
        ? fnNode.body.body
        : [t.returnStatement(fnNode.body)];
      const handlerCode = bodyStmts
        .map((s) => generator(s).code)
        .join("\n");

      // 推断参数角色
      const paramNames = fnNode.params.map((p) =>
        t.isIdentifier(p) ? p.name : generator(p).code
      );

      opcodeHandlers.push({
        opcode: opcodeValue,
        stmts: bodyStmts,
        code: handlerCode,
        params: paramNames,
      });
    },
  });

  // 识别 stack/regs (从 handler 函数的第一个参数推断)
  let stackVar = null;
  if (opcodeHandlers.length > 0 && opcodeHandlers[0].params.length > 0) {
    stackVar = opcodeHandlers[0].params[0];
  }

  // 尝试解析字节码
  const bytecodeInfo = codeVar ? resolveVarArray(ast, codeVar) : null;

  return {
    type: "handler-table",
    handlerVar,
    codeVar,
    pcTarget,
    stackVar,
    regsVar: null,
    opcodeHandlers,
    bytecodeInfo,
    handlerCount: opcodeHandlers.length,
  };
}

// ── 主入口 ──

function analyzeVM(ast, pattern) {
  if (pattern.type === "switch-dispatch") {
    return analyzeSwitchDispatchVM(ast, pattern);
  }
  if (pattern.type === "handler-table") {
    return analyzeHandlerTableVM(ast, pattern);
  }
  return null;
}

module.exports = { analyzeVM };
