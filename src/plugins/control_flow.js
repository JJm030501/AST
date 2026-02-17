/**
 * 控制流平坦化还原插件
 *
 * 支持三种模式:
 *
 * 模式 A: 序列驱动 (OB 典型)
 *   var _seq = "2|0|1".split("|"), _idx = 0;
 *   while (true) { switch (_seq[_idx++]) { case "0": ...; case "1": ...; } break; }
 *   → 按 split 序列平铺
 *
 * 模式 B: 状态机驱动
 *   var state = 0;
 *   while (true) { switch (state) { case 0: doA(); state = 2; break; case 2: doB(); state = 1; break; ... } }
 *   → 从初始 state 追踪 transition 还原线性代码
 *   → 支持条件分支: state = cond ? A : B → if(cond){...}else{...}
 *
 * 模式 C: 位运算分发平坦化 (阿里 um.js 典型)
 *   for (var Oa = N; undefined !== Oa;) {
 *     var xa = Oa >> 5, Da = 31 & xa, Ga = 31 & xa >> 5;
 *     switch (31 & Oa) { case 0: !function(){ switch(Da){ ... } }(); break; ... }
 *   }
 *   → 将嵌套的 IIFE switch 平坦化为单级 switch(Oa)
 */

const t = require("@babel/types");
const { removeDeclaratorAndCleanup, makeInc } = require("../utils");

function isInfiniteTest(test) {
  return (
    t.isBooleanLiteral(test, { value: true }) ||
    t.isNumericLiteral(test, { value: 1 }) ||
    (t.isUnaryExpression(test, { operator: "!" }) &&
      t.isUnaryExpression(test.argument, { operator: "!" }))
  );
}

function extractOrderFromSeqInit(init) {
  if (!init) return null;

  if (t.isArrayExpression(init)) {
    const out = [];
    for (const el of init.elements) {
      if (!el) return null;
      if (t.isStringLiteral(el)) out.push(el.value);
      else if (t.isNumericLiteral(el)) out.push(String(el.value));
      else return null;
    }
    return out.length ? out : null;
  }

  if (
    t.isCallExpression(init) &&
    t.isMemberExpression(init.callee) &&
    t.isStringLiteral(init.callee.object)
  ) {
    const splitProp = init.callee.property;
    const isSplitCall =
      (!init.callee.computed && t.isIdentifier(splitProp, { name: "split" })) ||
      (init.callee.computed && t.isStringLiteral(splitProp, { value: "split" }));
    if (!isSplitCall) return null;

    const raw = init.callee.object.value;
    const sep = init.arguments[0] && t.isStringLiteral(init.arguments[0])
      ? init.arguments[0].value
      : "|";
    const arr = raw.split(sep);
    return arr.length ? arr : null;
  }

  return null;
}

function parseSeqIdxMember(expr) {
  if (!t.isMemberExpression(expr)) return null;
  if (!expr.computed) return null;
  if (!t.isIdentifier(expr.object)) return null;
  if (!t.isUpdateExpression(expr.property, { operator: "++", prefix: false })) return null;
  if (!t.isIdentifier(expr.property.argument)) return null;
  return { seqName: expr.object.name, idxName: expr.property.argument.name };
}

function findSwitchStatement(stmts) {
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (t.isSwitchStatement(s)) return { switchStmt: s, index: i };
  }
  return null;
}

function findStateAssignmentInWhile(bodyPaths, beforeIndex, stateName) {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const p = bodyPaths[i];
    if (p.isVariableDeclaration()) {
      const decls = p.get("declarations");
      for (const d of decls) {
        if (!d.isVariableDeclarator()) continue;
        if (!t.isIdentifier(d.node.id, { name: stateName })) continue;
        return { stmtPath: p, declaratorPath: d, rhs: d.node.init };
      }
    }
    if (p.isExpressionStatement()) {
      const e = p.node.expression;
      if (t.isAssignmentExpression(e, { operator: "=" }) && t.isIdentifier(e.left, { name: stateName })) {
        return { stmtPath: p, declaratorPath: null, rhs: e.right };
      }
    }
  }
  return null;
}

function findStateAssignmentInCases(cases, stateName) {
  for (const c of cases) {
    for (const stmt of c.consequent || []) {
      if (!t.isExpressionStatement(stmt)) continue;
      const expr = stmt.expression;
      if (!t.isAssignmentExpression(expr, { operator: "=" })) continue;
      if (!t.isIdentifier(expr.left, { name: stateName })) continue;
      const mem = parseSeqIdxMember(expr.right);
      if (mem) return mem;
    }
  }
  return null;
}

function isStateAdvanceStatement(stmt, stateName, seqName, idxName) {
  if (!stateName) return false;
  if (!t.isExpressionStatement(stmt)) return false;
  const expr = stmt.expression;
  if (!t.isAssignmentExpression(expr, { operator: "=" })) return false;
  if (!t.isIdentifier(expr.left, { name: stateName })) return false;
  const mem = parseSeqIdxMember(expr.right);
  if (!mem) return false;
  return mem.seqName === seqName && mem.idxName === idxName;
}

// ── 模式 B: 状态机型控制流 ──

/**
 * 从 case 语句体中提取 state 赋值:
 *   state = 2;           → { type: 'direct', value: '2' }
 *   state = x ? 2 : 3;   → { type: 'conditional', test, consequent: '2', alternate: '3' }
 */
function extractStateTransition(consequent, stateName) {
  for (let i = consequent.length - 1; i >= 0; i--) {
    const stmt = consequent[i];
    if (t.isBreakStatement(stmt) || t.isContinueStatement(stmt)) continue;
    if (!t.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;
    if (!t.isAssignmentExpression(expr, { operator: "=" })) continue;
    if (!t.isIdentifier(expr.left, { name: stateName })) continue;

    // state = N (直接赋值)
    if (t.isNumericLiteral(expr.right)) {
      return { type: "direct", value: String(expr.right.value), stmtIndex: i };
    }
    if (t.isStringLiteral(expr.right)) {
      return { type: "direct", value: expr.right.value, stmtIndex: i };
    }

    // state = cond ? A : B (条件赋值)
    if (t.isConditionalExpression(expr.right)) {
      const { test, consequent: cons, alternate: alt } = expr.right;
      let consVal = null;
      let altVal = null;
      if (t.isNumericLiteral(cons)) consVal = String(cons.value);
      else if (t.isStringLiteral(cons)) consVal = cons.value;
      if (t.isNumericLiteral(alt)) altVal = String(alt.value);
      else if (t.isStringLiteral(alt)) altVal = alt.value;

      if (consVal !== null && altVal !== null) {
        return {
          type: "conditional",
          test: test,
          consequent: consVal,
          alternate: altVal,
          stmtIndex: i,
        };
      }
    }

    break;
  }
  return null;
}

/**
 * 获取 case 的语句体 (去掉 break/continue 和 state 赋值)
 */
function getCaseBodyStmts(consequent, stateName, transitionStmtIndex) {
  return consequent.filter((s, i) => {
    if (t.isBreakStatement(s) || t.isContinueStatement(s)) return false;
    if (i === transitionStmtIndex) return false;
    return true;
  });
}

/**
 * 检查是否是终止 case (含 return/throw, 或无后续 state 赋值)
 */
function isTerminalCase(consequent, stateName) {
  for (const s of consequent) {
    if (t.isReturnStatement(s) || t.isThrowStatement(s)) return true;
  }
  return false;
}

/**
 * 尝试状态机型还原:
 * 从 initState 开始, 沿 state transition 链按顺序展开
 */
function tryStateMachineUnflatten(cases, stateName, initStateValue) {
  // 构建 caseMap: stateValue → { consequent, transition }
  const caseMap = {};
  for (const c of cases) {
    if (!c.test) continue;
    let key;
    if (t.isNumericLiteral(c.test)) key = String(c.test.value);
    else if (t.isStringLiteral(c.test)) key = c.test.value;
    else continue;

    const transition = extractStateTransition(c.consequent, stateName);
    caseMap[key] = {
      consequent: c.consequent,
      transition,
    };
  }

  // 从 initState 开始追踪
  const flatStatements = [];
  const visited = new Set();
  let currentState = String(initStateValue);
  const MAX_STEPS = Object.keys(caseMap).length + 5;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (visited.has(currentState)) break;
    visited.add(currentState);

    const entry = caseMap[currentState];
    if (!entry) break;

    const { consequent, transition } = entry;

    if (!transition) {
      // 没有 state 赋值 → 终止节点, 直接添加语句体
      const bodyStmts = consequent.filter((s) => {
        return !t.isBreakStatement(s) && !t.isContinueStatement(s);
      });
      flatStatements.push(...bodyStmts);
      break;
    }

    if (transition.type === "direct") {
      const bodyStmts = getCaseBodyStmts(consequent, stateName, transition.stmtIndex);
      flatStatements.push(...bodyStmts);
      currentState = transition.value;
      continue;
    }

    if (transition.type === "conditional") {
      // 条件分支: 递归展开两个分支
      const bodyStmts = getCaseBodyStmts(consequent, stateName, transition.stmtIndex);
      flatStatements.push(...bodyStmts);

      const thenBranch = tryStateMachineUnflatten(cases, stateName, transition.consequent);
      const elseBranch = tryStateMachineUnflatten(cases, stateName, transition.alternate);

      if (thenBranch && elseBranch) {
        const ifStmt = t.ifStatement(
          t.cloneNode(transition.test, true),
          t.blockStatement(thenBranch),
          t.blockStatement(elseBranch)
        );
        flatStatements.push(ifStmt);
      } else if (thenBranch) {
        const ifStmt = t.ifStatement(
          t.cloneNode(transition.test, true),
          t.blockStatement(thenBranch)
        );
        flatStatements.push(ifStmt);
      }
      break;
    }
  }

  return flatStatements.length > 0 ? flatStatements : null;
}

// ── 模式 C: 位运算分发平坦化 ──

/**
 * 检测 for 循环的 test 部分是否是 "undefined !== X" 或 "void 0 !== X"
 * 返回状态变量名或 null
 */
function parseForTestStateVar(test) {
  if (!t.isBinaryExpression(test, { operator: "!==" }) &&
      !t.isBinaryExpression(test, { operator: "!=" })) return null;

  let stateNode = null;
  const { left, right } = test;

  // undefined !== Oa  或  void 0 !== Oa
  if (isUndefinedNode(left) && t.isIdentifier(right)) stateNode = right;
  // Oa !== undefined  或  Oa != void 0
  if (isUndefinedNode(right) && t.isIdentifier(left)) stateNode = left;

  return stateNode ? stateNode.name : null;
}

function isUndefinedNode(node) {
  if (t.isIdentifier(node, { name: "undefined" })) return true;
  if (t.isUnaryExpression(node, { operator: "void" }) && t.isNumericLiteral(node.argument)) return true;
  return false;
}

/**
 * 从 switch 的 discriminant 中提取 mask & stateVar 模式
 * 例: 31 & Oa → { mask: 31, varName: "Oa" }
 */
function parseMaskAndOperand(expr) {
  if (!t.isBinaryExpression(expr, { operator: "&" })) return null;
  const { left, right } = expr;

  // mask & var  或  var & mask
  if (t.isNumericLiteral(left) && t.isIdentifier(right)) {
    return { mask: left.value, varName: right.name };
  }
  if (t.isIdentifier(left) && t.isNumericLiteral(right)) {
    return { mask: right.value, varName: left.name };
  }
  return null;
}

/**
 * 从 case 的 consequent 中提取 IIFE 内的 switch
 * !function(){ switch(X){...} }()  →  该 switch 的 cases
 */
function extractIIFESwitch(consequent) {
  for (const stmt of consequent) {
    if (t.isBreakStatement(stmt) || t.isContinueStatement(stmt)) continue;

    // ExpressionStatement: !function(){ switch(X){...} }()
    if (t.isExpressionStatement(stmt)) {
      const expr = stmt.expression;
      let callExpr = null;

      // !function(){...}()
      if (t.isUnaryExpression(expr, { operator: "!" }) && t.isCallExpression(expr.argument)) {
        callExpr = expr.argument;
      }
      // (function(){...})()
      if (t.isCallExpression(expr)) {
        callExpr = expr;
      }

      if (!callExpr) continue;
      if (callExpr.arguments.length !== 0) continue;

      const callee = callExpr.callee;
      if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) continue;

      const body = callee.body;
      if (!t.isBlockStatement(body)) continue;

      // 找 switch 语句
      for (const innerStmt of body.body) {
        if (t.isSwitchStatement(innerStmt)) {
          return innerStmt;
        }
      }
    }
  }
  return null;
}

/**
 * 递归收集嵌套 switch 的叶子 case 及其计算出的状态值
 *
 * @param {Array} cases - 当前 switch 的 case 列表
 * @param {number} levelShift - 当前层级的位移量 (0, bitsPerLevel, 2*bitsPerLevel, ...)
 * @param {number} bitsPerLevel - 每级的位数 (如 5, 对应 mask=31)
 * @param {number} parentValue - 父级已累计的状态值
 * @param {Array} result - 收集结果 [{ oaValue, bodyStmts }]
 */
function collectLeafCases(cases, levelShift, bitsPerLevel, parentValue, result) {
  for (const c of cases) {
    if (!c.test || !t.isNumericLiteral(c.test)) continue;
    const caseVal = c.test.value;
    const stateContrib = caseVal << levelShift;
    const currentValue = parentValue | stateContrib;

    // 尝试提取内部 IIFE switch
    const innerSwitch = extractIIFESwitch(c.consequent);
    if (innerSwitch) {
      // 递归进入下一级
      collectLeafCases(
        innerSwitch.cases,
        levelShift + bitsPerLevel,
        bitsPerLevel,
        currentValue,
        result
      );
    } else {
      // 叶子节点: 收集 body (过滤 break/continue)
      const bodyStmts = c.consequent.filter(
        (s) => !t.isBreakStatement(s) && !t.isContinueStatement(s)
      );
      if (bodyStmts.length > 0) {
        result.push({ oaValue: currentValue, bodyStmts });
      }
    }
  }
}

/**
 * 尝试对 for 循环进行位运算分发平坦化
 */
function tryBitwiseDispatchFlatten(forPath) {
  const { init, test, update, body } = forPath.node;

  // 检测: for(var X = N; undefined !== X;) — 无 update
  if (update) return false;
  if (!test) return false;

  const stateVarName = parseForTestStateVar(test);
  if (!stateVarName) return false;

  // 检测 init: var X = N
  if (!t.isVariableDeclaration(init)) return false;
  const stateDecl = init.declarations.find(
    (d) => t.isIdentifier(d.id, { name: stateVarName }) && t.isNumericLiteral(d.init)
  );
  if (!stateDecl) return false;

  if (!t.isBlockStatement(body)) return false;
  const bodyStmts = body.body;

  // 在 body 中找到主 switch
  let mainSwitch = null;
  for (const s of bodyStmts) {
    if (t.isSwitchStatement(s)) {
      mainSwitch = s;
      break;
    }
  }
  if (!mainSwitch) return false;

  // 检测 discriminant 是否为 mask & stateVar
  const maskInfo = parseMaskAndOperand(mainSwitch.discriminant);
  if (!maskInfo) return false;
  if (maskInfo.varName !== stateVarName) return false;

  const mask = maskInfo.mask;
  // mask 应该是 2^n - 1 的形式
  const bitsPerLevel = Math.log2(mask + 1);
  if (!Number.isInteger(bitsPerLevel) || bitsPerLevel < 1) return false;

  // 检测是否有嵌套 IIFE switch (至少一个 case 有)
  let hasNestedIIFE = false;
  for (const c of mainSwitch.cases) {
    if (extractIIFESwitch(c.consequent)) {
      hasNestedIIFE = true;
      break;
    }
  }
  if (!hasNestedIIFE) return false;

  // 收集所有叶子 case
  const leafCases = [];
  collectLeafCases(mainSwitch.cases, 0, bitsPerLevel, 0, leafCases);

  if (leafCases.length < 3) return false;

  // 构建平坦化的 switch
  const flatCases = leafCases.map(({ oaValue, bodyStmts }) => {
    return t.switchCase(
      t.numericLiteral(oaValue),
      [...bodyStmts, t.breakStatement()]
    );
  });

  const flatSwitch = t.switchStatement(
    t.identifier(stateVarName),
    flatCases
  );

  // 替换 for 循环体
  forPath.node.body = t.blockStatement([flatSwitch]);

  return true;
}

module.exports = function controlFlowUnflattening(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "control-flow-unflattening",

    visitor: {
      WhileStatement(path) {
        const { test, body } = path.node;

        if (!isInfiniteTest(test)) return;
        if (!t.isBlockStatement(body)) return;

        const stmts = body.body;
        if (stmts.length < 1) return;

        const sw = findSwitchStatement(stmts);
        if (!sw) return;
        const switchStmt = sw.switchStmt;
        const switchIndex = sw.index;

        const { discriminant, cases } = switchStmt;

        // ── 模式 A: 序列驱动 (split/array + idx++) ──
        let seqName = null;
        let idxName = null;
        let stateName = null;

        let stateStmtPath = null;
        let stateDeclaratorPath = null;

        const direct = parseSeqIdxMember(discriminant);
        if (direct) {
          seqName = direct.seqName;
          idxName = direct.idxName;
        } else if (t.isIdentifier(discriminant)) {
          stateName = discriminant.name;
          const whileBodyPaths = path.get("body");
          if (!whileBodyPaths.isBlockStatement()) {
            // 尝试模式 B
          } else {
            const bodyPaths = whileBodyPaths.get("body");
            const assignInfo = findStateAssignmentInWhile(bodyPaths, switchIndex, discriminant.name);
            if (assignInfo) {
              const mem = parseSeqIdxMember(assignInfo.rhs);
              if (mem) {
                seqName = mem.seqName;
                idxName = mem.idxName;
                stateStmtPath = assignInfo.stmtPath;
                stateDeclaratorPath = assignInfo.declaratorPath;
              }
            } else {
              const mem = findStateAssignmentInCases(cases, stateName);
              if (mem) {
                seqName = mem.seqName;
                idxName = mem.idxName;
              }
            }
          }
        }

        // 模式 A 匹配成功
        if (seqName && idxName) {
          const parent = path.parentPath;
          if (!parent.isBlockStatement() && !parent.isProgram()) return;

          const siblings = parent.get("body");
          const myIndex = siblings.findIndex((s) => s.node === path.node);
          if (myIndex < 1) return;

          let orderArray = null;
          let seqDeclPath = null;
          let idxDeclPath = null;

          for (let i = myIndex - 1; i >= 0; i--) {
            const sib = siblings[i];
            if (!sib.isVariableDeclaration()) continue;

            for (const decl of sib.get("declarations")) {
              const init = decl.node.init;
              const name = decl.node.id.name;

              if (name === seqName) {
                const arr = extractOrderFromSeqInit(init);
                if (arr) {
                  orderArray = arr;
                  seqDeclPath = decl;
                }
              }

              if (name === idxName && t.isNumericLiteral(init, { value: 0 })) {
                idxDeclPath = decl;
              }
            }
          }

          if (!orderArray || orderArray.length === 0) return;

          const caseMap = {};
          for (const c of cases) {
            if (!c.test) continue;
            let key;
            if (t.isStringLiteral(c.test)) key = c.test.value;
            else if (t.isNumericLiteral(c.test)) key = String(c.test.value);
            else continue;
            const body = c.consequent.filter((s) => {
              if (t.isContinueStatement(s) || t.isBreakStatement(s)) return false;
              if (isStateAdvanceStatement(s, stateName, seqName, idxName)) return false;
              return true;
            });
            caseMap[key] = body;
          }

          const flatStatements = [];
          for (const key of orderArray) {
            if (caseMap[key]) {
              flatStatements.push(...caseMap[key]);
            }
          }

          if (flatStatements.length === 0) return;

          path.replaceWithMultiple(flatStatements);
          inc();

          if (stateDeclaratorPath) {
            removeDeclaratorAndCleanup(stateDeclaratorPath, inc);
          } else if (stateStmtPath) {
            try {
              stateStmtPath.remove();
              inc();
            } catch (e) {}
          }

          if (seqDeclPath) removeDeclaratorAndCleanup(seqDeclPath, inc);
          if (idxDeclPath) removeDeclaratorAndCleanup(idxDeclPath, inc);
          return;
        }

        // ── 模式 B: 状态机驱动 (switch(state) + state = N) ──
        if (!t.isIdentifier(discriminant)) return;
        stateName = discriminant.name;

        // 在 while 之前找 state 的初始值
        const parent = path.parentPath;
        if (!parent.isBlockStatement() && !parent.isProgram()) return;

        const siblings = parent.get("body");
        const myIndex = siblings.findIndex((s) => s.node === path.node);
        if (myIndex < 0) return;

        let initStateValue = null;
        let stateDeclPath = null;

        for (let i = myIndex - 1; i >= 0; i--) {
          const sib = siblings[i];
          if (sib.isVariableDeclaration()) {
            for (const decl of sib.get("declarations")) {
              if (!t.isIdentifier(decl.node.id, { name: stateName })) continue;
              if (t.isNumericLiteral(decl.node.init)) {
                initStateValue = String(decl.node.init.value);
                stateDeclPath = decl;
              } else if (t.isStringLiteral(decl.node.init)) {
                initStateValue = decl.node.init.value;
                stateDeclPath = decl;
              }
            }
          }
          if (sib.isExpressionStatement()) {
            const e = sib.node.expression;
            if (
              t.isAssignmentExpression(e, { operator: "=" }) &&
              t.isIdentifier(e.left, { name: stateName })
            ) {
              if (t.isNumericLiteral(e.right)) {
                initStateValue = String(e.right.value);
              } else if (t.isStringLiteral(e.right)) {
                initStateValue = e.right.value;
              }
            }
          }
          if (initStateValue !== null) break;
        }

        if (initStateValue === null) return;

        const flatStatements = tryStateMachineUnflatten(cases, stateName, initStateValue);
        if (!flatStatements || flatStatements.length === 0) return;

        path.replaceWithMultiple(flatStatements);
        inc();

        if (stateDeclPath) removeDeclaratorAndCleanup(stateDeclPath, inc);
      },

      // ── 模式 C: 位运算分发平坦化 (ForStatement) ──
      ForStatement(path) {
        if (tryBitwiseDispatchFlatten(path)) {
          inc();
        }
      },
    },
  };
};
