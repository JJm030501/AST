/**
 * VM 混淆检测器
 *
 * 自动识别两种常见的 VM 混淆分发模式:
 *
 * 1. Switch-Dispatch: while(...) { var op = code[pc++]; switch(op) { case N: ... } }
 * 2. Handler-Table:   while(...) { var op = code[pc++]; handlers[op](stack, code, pc); }
 *
 * 检测标准:
 *   - Switch-Dispatch: while/for 循环内含 8+ case 的 switch, discriminant 来自 array[var++]
 *   - Handler-Table:   while/for 循环内用 obj[opcode](...) 间接调用, 且 obj 上有 5+ 函数赋值
 */

const t = require("@babel/types");
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;
const { visit } = require("../utils");

// ── 工具函数 ──

function isPostIncrement(node) {
  return (
    t.isUpdateExpression(node) &&
    node.operator === "++" &&
    !node.prefix
  );
}

function getIncrementTarget(node) {
  if (!isPostIncrement(node)) return null;
  const arg = node.argument;
  if (t.isIdentifier(arg)) return { type: "identifier", name: arg.name };
  if (t.isMemberExpression(arg)) {
    return { type: "member", code: generator(arg).code, node: arg };
  }
  return null;
}

/**
 * 匹配 arrayVar[pcExpr++] 模式
 * 返回 { arrayVar, pcTarget } 或 null
 */
function matchCodePCIncrement(node) {
  if (!t.isMemberExpression(node) || !node.computed) return null;
  if (!isPostIncrement(node.property)) return null;

  const arrayVar = t.isIdentifier(node.object) ? node.object.name : null;
  if (!arrayVar) return null;

  const pcTarget = getIncrementTarget(node.property);
  if (!pcTarget) return null;

  return { arrayVar, pcTarget };
}

/**
 * 检查 case 体内是否有 push/pop 调用模式 (stack 操作特征)
 */
function countStackOpsInCases(cases) {
  let pushCount = 0;
  let popCount = 0;
  for (const c of cases) {
    for (const stmt of c.consequent || []) {
      visit(stmt, (n) => {
        if (!t.isCallExpression(n)) return;
        if (!t.isMemberExpression(n.callee)) return;
        const prop = n.callee.property;
        const name = !n.callee.computed && t.isIdentifier(prop)
          ? prop.name
          : n.callee.computed && t.isStringLiteral(prop)
            ? prop.value
            : null;
        if (name === "push") pushCount++;
        if (name === "pop") popCount++;
      });
    }
  }
  return { pushCount, popCount };
}

/**
 * 检查 cases 中是否有修改 PC 变量的模式 (跳转指令特征)
 */
function hasJumpPattern(cases, pcVarName) {
  if (!pcVarName) return false;
  for (const c of cases) {
    for (const stmt of c.consequent || []) {
      let found = false;
      visit(stmt, (n) => {
        if (found) return;
        if (
          t.isAssignmentExpression(n) &&
          t.isIdentifier(n.left, { name: pcVarName })
        ) {
          found = true;
        }
      });
      if (found) return true;
    }
  }
  return false;
}

// ── Switch-Dispatch 检测 ──

function detectSwitchDispatchVM(ast) {
  const patterns = [];

  traverse(ast, {
    WhileStatement(path) { checkLoopForSwitchVM(path, patterns); },
    ForStatement(path) { checkLoopForSwitchVM(path, patterns); },
    DoWhileStatement(path) { checkLoopForSwitchVM(path, patterns); },
  });

  return patterns;
}

function checkLoopForSwitchVM(loopPath, patterns) {
  const body = loopPath.node.body;
  if (!t.isBlockStatement(body)) return;

  // 查找 switch 语句
  let switchNode = null;
  let switchIndex = -1;
  for (let i = 0; i < body.body.length; i++) {
    if (t.isSwitchStatement(body.body[i])) {
      switchNode = body.body[i];
      switchIndex = i;
      break;
    }
  }

  if (!switchNode) return;

  // case 数量门槛: 至少 8 个 (排除控制流平坦化的 3~5 个 case)
  const caseCount = switchNode.cases.filter((c) => c.test !== null).length;
  if (caseCount < 8) return;

  // 检查 switch 的 discriminant 是否来自 code[pc++] 模式
  const disc = switchNode.discriminant;
  let match = matchCodePCIncrement(disc);
  let opcodeVarName = null;

  if (!match && t.isIdentifier(disc)) {
    // 间接模式: var op = code[pc++]; switch(op) { ... }
    opcodeVarName = disc.name;
    for (let i = 0; i < switchIndex; i++) {
      const stmt = body.body[i];
      if (!t.isVariableDeclaration(stmt)) continue;
      for (const decl of stmt.declarations) {
        if (
          t.isIdentifier(decl.id, { name: opcodeVarName }) &&
          decl.init
        ) {
          match = matchCodePCIncrement(decl.init);
        }
      }
    }
  }

  if (!match) return;

  // 计算置信度
  const { pushCount, popCount } = countStackOpsInCases(switchNode.cases);
  const pcVarName =
    match.pcTarget.type === "identifier" ? match.pcTarget.name : null;
  const hasJump = hasJumpPattern(switchNode.cases, pcVarName);

  let confidence = 0.3; // 基础: 有 while+switch+code[pc++]
  if (caseCount >= 8) confidence += 0.1;
  if (caseCount >= 15) confidence += 0.15;
  if (caseCount >= 20) confidence += 0.1;
  if (pushCount >= 5 && popCount >= 3) confidence += 0.15;
  if (hasJump) confidence += 0.1;
  confidence = Math.min(confidence, 1.0);

  patterns.push({
    type: "switch-dispatch",
    loopPath,
    switchNode,
    codeVar: match.arrayVar,
    pcVar: pcVarName,
    pcTarget: match.pcTarget,
    opcodeVar: opcodeVarName,
    caseCount,
    confidence: Math.round(confidence * 100) / 100,
    stats: { pushCount, popCount, hasJump },
  });
}

// ── Handler-Table 检测 ──

function detectHandlerTableVM(ast, funcAssignCounts) {
  const patterns = [];

  // 至少 5 个函数赋值才算 handler table 候选
  const handlerCandidates = new Set();
  for (const [name, count] of Object.entries(funcAssignCounts)) {
    if (count >= 5) handlerCandidates.add(name);
  }

  if (handlerCandidates.size === 0) return patterns;

  // 查找使用 handlers[op](...) 分发的 while 循环
  traverse(ast, {
    WhileStatement(path) {
      checkLoopForHandlerTable(path, handlerCandidates, funcAssignCounts, patterns);
    },
    ForStatement(path) {
      checkLoopForHandlerTable(path, handlerCandidates, funcAssignCounts, patterns);
    },
  });

  return patterns;
}

function checkLoopForHandlerTable(loopPath, handlerCandidates, funcAssignCounts, patterns) {
  const body = loopPath.node.body;
  if (!t.isBlockStatement(body)) return;

  // 查找 handlers[op](...) 调用
  let dispatchCall = null;
  let handlerVar = null;

  for (const stmt of body.body) {
    visit(stmt, (n) => {
      if (dispatchCall) return;
      if (!t.isCallExpression(n)) return;
      if (!t.isMemberExpression(n.callee) || !n.callee.computed) return;
      if (!t.isIdentifier(n.callee.object)) return;
      if (!handlerCandidates.has(n.callee.object.name)) return;

      dispatchCall = n;
      handlerVar = n.callee.object.name;
    });
    if (dispatchCall) break;
  }

  if (!dispatchCall || !handlerVar) return;

  // 查找 code[pc++] 模式 (opcode 读取)
  let codeMatch = null;
  for (const stmt of body.body) {
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (decl.init) {
          const m = matchCodePCIncrement(decl.init);
          if (m) codeMatch = m;
        }
      }
    }
    // 也检查直接在 dispatch 调用中内联的模式
    if (!codeMatch && dispatchCall) {
      const prop = dispatchCall.callee.property;
      if (prop) {
        const m = matchCodePCIncrement(
          t.isMemberExpression(dispatchCall.callee)
            ? dispatchCall.callee.property
            : null
        );
        // 间接通过变量
        // handlers[code[pc++]](...) → property 就是 code[pc++]
      }
    }
  }

  // 如果没找到显式的 code[pc++] 但有 handler table 调用, 仍然标记 (较低置信度)
  const handlerCount = funcAssignCounts[handlerVar] || 0;
  let confidence = 0.4;
  if (codeMatch) confidence += 0.2;
  if (handlerCount >= 5) confidence += 0.1;
  if (handlerCount >= 8) confidence += 0.1;
  confidence = Math.min(confidence, 1.0);

  patterns.push({
    type: "handler-table",
    loopPath,
    handlerVar,
    codeVar: codeMatch ? codeMatch.arrayVar : null,
    pcTarget: codeMatch ? codeMatch.pcTarget : null,
    handlerCount: handlerCount || 0,
    confidence: Math.round(confidence * 100) / 100,
  });
}

// ── 主入口 ──

function collectFuncAssignCounts(ast) {
  const counts = {};
  traverse(ast, {
    ExpressionStatement(path) {
      const expr = path.node.expression;
      if (!t.isAssignmentExpression(expr, { operator: "=" })) return;
      if (!t.isMemberExpression(expr.left)) return;
      if (!t.isIdentifier(expr.left.object)) return;
      if (
        !(
          t.isFunctionExpression(expr.right) ||
          t.isArrowFunctionExpression(expr.right)
        )
      ) {
        return;
      }
      const name = expr.left.object.name;
      if (!counts[name]) counts[name] = 0;
      counts[name]++;
    },
  });
  return counts;
}

function detectVM(ast) {
  const funcAssignCounts = collectFuncAssignCounts(ast);

  const switchVMs = detectSwitchDispatchVM(ast);
  const tableVMs = detectHandlerTableVM(ast, funcAssignCounts);
  const all = [...switchVMs, ...tableVMs];

  return {
    found: all.length > 0,
    count: all.length,
    patterns: all,
  };
}

module.exports = { detectVM, detectSwitchDispatchVM, detectHandlerTableVM };
