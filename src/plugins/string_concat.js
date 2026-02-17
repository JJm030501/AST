/**
 * 字符串拼接还原插件
 *
 * 将被拆散的字符串拼接链合并回单个字符串:
 *   var s = "ed"; s += "oNtn"; s += "era";
 *   → var s = "edoNtnera";
 *
 * 同时识别 .split("").reverse().join("") 反转模式:
 *   s = (s += "p").split("").reverse().join("");
 *   → 将整个拼接结果反转
 *
 * 常见于阿里 um.js 等自定义混淆器
 */

const t = require("@babel/types");
const { makeInc } = require("../utils");

/**
 * 检测 expr.split("").reverse().join("") 模式
 * 返回内部表达式 (去掉 split-reverse-join 链), 否则返回 null
 */
function extractSplitReverseJoin(node) {
  // node = X.split("").reverse().join("")
  // 结构: CallExpression { callee: MemberExpression { object: CallExpression { ... } } }
  if (!t.isCallExpression(node)) return null;
  if (!t.isMemberExpression(node.callee)) return null;
  if (!t.isIdentifier(node.callee.property, { name: "join" })) return null;
  if (node.arguments.length !== 1 || !t.isStringLiteral(node.arguments[0], { value: "" })) return null;

  const reverseCall = node.callee.object;
  if (!t.isCallExpression(reverseCall)) return null;
  if (!t.isMemberExpression(reverseCall.callee)) return null;
  if (!t.isIdentifier(reverseCall.callee.property, { name: "reverse" })) return null;
  if (reverseCall.arguments.length !== 0) return null;

  const splitCall = reverseCall.callee.object;
  if (!t.isCallExpression(splitCall)) return null;
  if (!t.isMemberExpression(splitCall.callee)) return null;
  if (!t.isIdentifier(splitCall.callee.property, { name: "split" })) return null;
  if (splitCall.arguments.length !== 1 || !t.isStringLiteral(splitCall.arguments[0], { value: "" })) return null;

  return splitCall.callee.object;
}

/**
 * 检测 (s += "xxx").split("").reverse().join("") 模式
 * 返回 { varName, appendStr, needReverse: true } 或 null
 */
function extractAppendWithReverse(node) {
  const inner = extractSplitReverseJoin(node);
  if (!inner) return null;

  // inner 应该是 (s += "xxx") 即 AssignmentExpression
  if (t.isAssignmentExpression(inner, { operator: "+=" })) {
    if (t.isIdentifier(inner.left) && t.isStringLiteral(inner.right)) {
      return { varName: inner.left.name, appendStr: inner.right.value, needReverse: true };
    }
  }

  // inner 可能是 s (直接 s.split("").reverse().join(""))
  if (t.isIdentifier(inner)) {
    return { varName: inner.name, appendStr: null, needReverse: true };
  }

  return null;
}

/**
 * 在表达式树中递归查找嵌入的 varName += "str" 赋值
 * 找到后将 += 替换为普通引用 (就地修改 AST)
 * 返回追加的字符串, 或 null
 *
 * 处理模式:
 *   Ue = Ge += "ring"           → Ue = Ge (返回 "ring")
 *   h[Ce = q += "n"](G)         → h[Ce = q](G) (返回 "n")
 *   Oa = U[m = I += "r"] ? ...  → Oa = U[m = I] ? ... (返回 "r")
 */
function findEmbeddedAppend(node, varName) {
  if (!node || typeof node !== "object") return null;

  // 直接匹配: varName += "str"
  if (
    t.isAssignmentExpression(node, { operator: "+=" }) &&
    t.isIdentifier(node.left, { name: varName }) &&
    t.isStringLiteral(node.right)
  ) {
    const val = node.right.value;
    // 就地将 += 改为引用: 父节点会看到 varName 而不是 varName += "str"
    // 但我们不能直接修改 node 类型, 所以返回值让调用方处理
    return val;
  }

  // 递归搜索子表达式
  // AssignmentExpression 的右侧: otherVar = (varName += "str")
  if (t.isAssignmentExpression(node)) {
    const found = findEmbeddedAppend(node.right, varName);
    if (found !== null) {
      // 将 right 从 varName += "str" 替换为 varName
      if (
        t.isAssignmentExpression(node.right, { operator: "+=" }) &&
        t.isIdentifier(node.right.left, { name: varName })
      ) {
        node.right = t.identifier(varName);
      }
      return found;
    }
  }

  // MemberExpression 的 property: obj[varName += "str"]
  if (t.isMemberExpression(node) && node.computed) {
    const found = findEmbeddedAppend(node.property, varName);
    if (found !== null) {
      if (
        t.isAssignmentExpression(node.property, { operator: "+=" }) &&
        t.isIdentifier(node.property.left, { name: varName })
      ) {
        node.property = t.identifier(varName);
      }
      return found;
    }
  }

  // CallExpression 的参数: fn(varName += "str")
  if (t.isCallExpression(node)) {
    for (let i = 0; i < node.arguments.length; i++) {
      const found = findEmbeddedAppend(node.arguments[i], varName);
      if (found !== null) {
        if (
          t.isAssignmentExpression(node.arguments[i], { operator: "+=" }) &&
          t.isIdentifier(node.arguments[i].left, { name: varName })
        ) {
          node.arguments[i] = t.identifier(varName);
        }
        return found;
      }
    }
  }

  // ConditionalExpression: cond ? a : b (搜索 test 部分)
  if (t.isConditionalExpression(node)) {
    const found = findEmbeddedAppend(node.test, varName);
    if (found !== null) return found;
  }

  return null;
}

module.exports = function stringConcat(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "string-concat",

    visitor: {
      // 处理 BlockStatement / Program 中的语句序列
      "BlockStatement|Program": {
        exit(path) {
          foldBody(path.node.body);
        },
      },

      // 处理 SwitchCase 的 consequent (um.js 的拼接发生在 case 块内)
      SwitchCase: {
        exit(path) {
          foldBody(path.node.consequent);
        },
      },
    },
  };

  function foldBody(body) {
    if (!body || !Array.isArray(body)) return;
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < body.length; i++) {
        const result = tryFoldConcat(body, i);
        if (result) {
          changed = true;
          inc();
        }
      }
    }
  }

  /**
   * 从 body[startIdx] 开始, 尝试折叠连续的字符串 += 赋值
   * 返回 true 如果做了折叠
   */
  function tryFoldConcat(body, startIdx) {
    const firstStmt = body[startIdx];
    if (!firstStmt) return false;

    let varName = null;
    let accumulated = null;
    let isDeclaration = false;
    let declaratorIndex = -1;

    // 情况 1: var s = "str";
    if (t.isVariableDeclaration(firstStmt)) {
      const decl = firstStmt.declarations;
      // 找到字符串初始化的 declarator
      for (let d = 0; d < decl.length; d++) {
        if (t.isIdentifier(decl[d].id) && t.isStringLiteral(decl[d].init)) {
          varName = decl[d].id.name;
          accumulated = decl[d].init.value;
          isDeclaration = true;
          declaratorIndex = d;
          break;
        }
      }
    }

    // 情况 2: s = "str";
    if (!varName && t.isExpressionStatement(firstStmt)) {
      const expr = firstStmt.expression;
      if (t.isAssignmentExpression(expr, { operator: "=" })) {
        if (t.isIdentifier(expr.left) && t.isStringLiteral(expr.right)) {
          varName = expr.left.name;
          accumulated = expr.right.value;
        }
      }
    }

    if (varName === null || accumulated === null) return false;

    // 向后扫描连续的 varName += "..." 语句
    let endIdx = startIdx;
    let needReverse = false;
    let keepLastStmt = false;

    for (let j = startIdx + 1; j < body.length; j++) {
      const stmt = body[j];
      if (!t.isExpressionStatement(stmt)) break;
      const expr = stmt.expression;

      // varName += "str"
      if (
        t.isAssignmentExpression(expr, { operator: "+=" }) &&
        t.isIdentifier(expr.left, { name: varName }) &&
        t.isStringLiteral(expr.right)
      ) {
        accumulated += expr.right.value;
        endIdx = j;
        continue;
      }

      // varName = varName += "str" (即 varName = (varName += "str"))
      if (
        t.isAssignmentExpression(expr, { operator: "=" }) &&
        t.isIdentifier(expr.left, { name: varName })
      ) {
        // 右侧是 (varName += "str").split("").reverse().join("")
        const rev = extractAppendWithReverse(expr.right);
        if (rev && rev.varName === varName) {
          if (rev.appendStr !== null) {
            accumulated += rev.appendStr;
          }
          if (rev.needReverse) {
            accumulated = accumulated.split("").reverse().join("");
          }
          needReverse = false;
          endIdx = j;
          break;
        }

        // 右侧是 varName += "str" (嵌套赋值表达式)
        if (
          t.isAssignmentExpression(expr.right, { operator: "+=" }) &&
          t.isIdentifier(expr.right.left, { name: varName }) &&
          t.isStringLiteral(expr.right.right)
        ) {
          accumulated += expr.right.right.value;
          endIdx = j;
          continue;
        }

        // 右侧是 varName.split("").reverse().join("") (无 +=)
        const revDirect = extractSplitReverseJoin(expr.right);
        if (revDirect && t.isIdentifier(revDirect, { name: varName })) {
          accumulated = accumulated.split("").reverse().join("");
          endIdx = j;
          break;
        }

        break;
      }

      // 交叉赋值: otherVar = varName += "str"
      // 例: Ue = Ge += "ring"  →  Ge 被折叠, 语句变为 Ue = Ge
      if (t.isExpressionStatement(stmt)) {
        const appended = findEmbeddedAppend(expr, varName);
        if (appended) {
          accumulated += appended;
          endIdx = j;
          keepLastStmt = true;
          break;
        }
      }

      break;
    }

    // 至少需要折叠 1 个 += 语句
    if (endIdx <= startIdx) return false;

    // 替换: 更新第一个语句的字符串值, 删除后续语句
    if (isDeclaration) {
      firstStmt.declarations[declaratorIndex].init = t.stringLiteral(accumulated);
    } else {
      firstStmt.expression.right = t.stringLiteral(accumulated);
    }

    // 删除中间语句 (keepLastStmt 时保留 endIdx 处的语句)
    const removeCount = keepLastStmt ? endIdx - startIdx - 1 : endIdx - startIdx;
    if (removeCount > 0) {
      body.splice(startIdx + 1, removeCount);
    }

    return true;
  }
};
