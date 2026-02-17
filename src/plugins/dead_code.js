/**
 * 死代码删除插件
 *
 * 移除不可达代码和无效代码：
 * 1. if(false) { ... } → 删除
 * 2. if(true) { ... } else { ... } → 保留 if 块
 * 3. return 之后的代码 → 删除
 * 4. 未引用的变量声明 → 删除
 * 5. 空语句 → 删除
 * 6. while(false) { ... } → 删除
 * 7. for(;false;) { ... } → 删除
 * 8. 未调用的局部函数声明 → 删除
 */

const t = require("@babel/types");
const { removeDeclaratorAndCleanup, makeInc } = require("../utils");

/**
 * 判断 init 表达式是否为无副作用的纯表达式 (可安全删除)
 * 支持: null, 字面量, 标识符, 纯二元/一元表达式, 纯数组
 */
function isPureSafeInit(init, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 5) return false;
  if (init === null) return true;
  if (t.isLiteral(init)) return true;
  if (t.isIdentifier(init)) return true;
  if (t.isBinaryExpression(init)) {
    return isPureSafeInit(init.left, depth + 1) && isPureSafeInit(init.right, depth + 1);
  }
  if (t.isUnaryExpression(init) && init.operator !== "delete") {
    return isPureSafeInit(init.argument, depth + 1);
  }
  if (t.isArrayExpression(init)) {
    return init.elements.every((e) => e === null || isPureSafeInit(e, depth + 1));
  }
  return false;
}

module.exports = function deadCodeElimination(options = {}) {
  const inc = makeInc(options.counter);

  return {
    name: "dead-code-elimination",

    visitor: {
      // if(false){...} → 删除, if(true){...}else{...} → 保留 then 块
      IfStatement: {
        exit(path) {
          const { test, consequent, alternate } = path.node;

          if (t.isBooleanLiteral(test)) {
            if (test.value) {
              // if(true) → 保留 consequent
              if (t.isBlockStatement(consequent)) {
                path.replaceWithMultiple(consequent.body);
                inc();
              } else {
                path.replaceWith(consequent);
                inc();
              }
            } else {
              // if(false) → 保留 alternate 或删除
              if (alternate) {
                if (t.isBlockStatement(alternate)) {
                  path.replaceWithMultiple(alternate.body);
                  inc();
                } else {
                  path.replaceWith(alternate);
                  inc();
                }
              } else {
                path.remove();
                inc();
              }
            }
            return;
          }

          // if(!![]) / if(!0) 等已被 constant_folding 处理为 boolean
          if (t.isNumericLiteral(test)) {
            if (test.value) {
              if (t.isBlockStatement(consequent)) {
                path.replaceWithMultiple(consequent.body);
                inc();
              } else {
                path.replaceWith(consequent);
                inc();
              }
            } else {
              if (alternate) {
                if (t.isBlockStatement(alternate)) {
                  path.replaceWithMultiple(alternate.body);
                  inc();
                } else {
                  path.replaceWith(alternate);
                  inc();
                }
              } else {
                path.remove();
                inc();
              }
            }
          }
        },
      },

      // return / throw / break / continue 之后的语句 → 删除
      "ReturnStatement|ThrowStatement|BreakStatement|ContinueStatement"(path) {
        const siblings = path.getAllNextSiblings();
        if (siblings.length > 0) {
          siblings.forEach((s) => {
            s.remove();
            inc();
          });
        }
      },

      // while(false){...} → 删除
      WhileStatement(path) {
        const test = path.node.test;
        if (t.isBooleanLiteral(test, { value: false }) ||
            t.isNumericLiteral(test, { value: 0 })) {
          path.remove();
          inc();
        }
      },

      // for(;false;){...} → 删除
      ForStatement(path) {
        const test = path.node.test;
        if (!test) return;
        if (t.isBooleanLiteral(test, { value: false }) ||
            t.isNumericLiteral(test, { value: 0 })) {
          path.remove();
          inc();
        }
      },

      // do{...}while(false) → 保留 body (至少执行一次)
      DoWhileStatement(path) {
        const test = path.node.test;
        if (t.isBooleanLiteral(test, { value: false }) ||
            t.isNumericLiteral(test, { value: 0 })) {
          const body = path.node.body;
          if (t.isBlockStatement(body)) {
            path.replaceWithMultiple(body.body);
          } else {
            path.replaceWith(body);
          }
          inc();
        }
      },

      // 删除空语句
      EmptyStatement(path) {
        path.remove();
        inc();
      },

      // 删除未调用的局部函数声明 (保守: 只删除局部作用域且 0 引用)
      FunctionDeclaration: {
        exit(path) {
          const { id } = path.node;
          if (!id || !t.isIdentifier(id)) return;

          // 不删除全局作用域的函数
          if (path.parentPath.isProgram()) return;

          const binding = path.scope.getBinding(id.name);
          if (!binding) return;
          if (binding.referencePaths.length > 0) return;

          path.remove();
          inc();
        },
      },

      // 删除未引用的变量 (保守策略: 只删除没有副作用的初始化)
      VariableDeclarator: {
        exit(path) {
          const { id, init } = path.node;
          if (!t.isIdentifier(id)) return;

          const binding = path.scope.getBinding(id.name);
          if (!binding) return;

          // 只在引用次数为 0 时删除
          if (binding.referencePaths.length > 0) return;

          // 只删除无副作用的初始化值
          if (isPureSafeInit(init)) {
            removeDeclaratorAndCleanup(path, inc);
          }
        },
      },
    },
  };
};
